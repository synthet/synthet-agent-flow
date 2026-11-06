import { existsSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { run as runProc } from "../core/proc.js";
import { clip, redactSecrets } from "../core/redaction.js";
import type { Workspace } from "../core/workspace.js";
import { defaultRunner, type Runner } from "./exec.js";

/**
 * Multi-harness review via synthet-agent-swarm (read-only judges: Codex, Claude Code, Antigravity, …).
 * The swarm reports strict-majority agreement; ties stay disputed. Votes are evidence, not ground truth:
 * by default the result is recorded as a review comment and a human/peer still approves.
 */

const ACTOR = "system:swarm";

export interface SwarmReview {
  verdict: "approve" | "reject" | "disputed";
  ac: Record<string, { value: string | null; counts: Record<string, number> }>;
  parsed: string[];
  unparsed: string[];
  harnesses: Array<{ harness: string; ok: boolean; summary: string }>;
  approved: boolean;
}

export function swarmEntry(ws: Workspace): string {
  const base = process.env.AGENT_FLOW_SWARM_PATH ?? ws.config.swarm.path;
  if (!base) {
    throw new FlowError("INVALID_ARGUMENT", "set swarm.path in .agent-flow/config.json (or AGENT_FLOW_SWARM_PATH) to your synthet-agent-swarm checkout", {
      nextSteps: ['agent-flow config set swarm.path "/path/to/synthet-agent-swarm"'],
    });
  }
  const candidates = [path.join(base, "agent-orchestrator", "dist", "index.js"), path.join(base, "dist", "index.js"), base];
  const entry = candidates.find((c) => c.endsWith(".js") && existsSync(c));
  if (!entry) throw new FlowError("NOT_FOUND", `synthet-agent-swarm build not found under ${base}`, { nextSteps: ["cd agent-orchestrator && npm install && npm run build"] });
  return entry;
}

export async function buildReviewTask(ws: Workspace, id: string, cwd: string): Promise<{ task: string; files: string[] }> {
  const t = ws.store.detail(id, { events: 0 });
  let diffStat = "";
  if (t.branch) {
    const r = await runProc(["git", "diff", "--stat", `${ws.config.defaultBranch}...${t.branch}`], { cwd, timeoutMs: 20_000 });
    if (r.code === 0) diffStat = clip(r.stdout.trim(), 1500);
  }
  const handoff = [...t.comments].reverse().find((c) => c.kind === "handoff");
  const acList = t.acceptance.map((a) => `- ${a.ac_id}: ${a.text}${a.evidence ? ` (claimed evidence: ${clip(a.evidence, 200)})` : ""}`).join("\n");
  const fields = ['"verdict": "approve" | "reject"', ...t.acceptance.map((a) => `"${a.ac_id}": "pass" | "fail" | "unknown"`), '"reason": "<one paragraph>"'];
  const task = redactSecrets(
    clip(
      [
        `Review agent-flow ticket ${t.id}: ${t.title}`,
        `Branch ${t.branch ?? "(none)"} against ${ws.config.defaultBranch}. Read-only: inspect the code and tests in the files given; do not modify anything.`,
        "",
        "Spec:",
        clip(t.body.trim() || "(none)", 2500),
        "",
        "Acceptance criteria:",
        acList || "(none listed)",
        handoff ? `\nAuthor's handoff note:\n${clip(handoff.body, 800)}` : "",
        diffStat ? `\nDiff stat:\n${diffStat}` : "",
        "",
        "Judge each criterion against the code and tests (not the author's claims). End your reply with exactly one flat JSON object with string fields:",
        `{ ${fields.join(", ")} }`,
      ].join("\n"),
      7800,
    ),
  );
  const files = t.scope_paths.filter((p) => existsSync(path.join(cwd, p))).slice(0, 20);
  return { task, files };
}

interface SwarmJson {
  ok?: boolean;
  /** Legacy `swarm` CLI shape (runJudgeSwarm): one row per judge. */
  judges?: Array<{ agent?: string; ok?: boolean; summary?: string; error?: string }>;
  /** `swarm_run` MCP shape. */
  harnesses?: Array<{ id?: string; ok?: boolean; summary?: string; error?: { message?: string } }>;
  agreement?: { parsedAgents?: string[]; unparsedAgents?: string[]; items?: Record<string, { fields?: Record<string, { value: string | null; counts: Record<string, number> }> }> };
}

export function parseSwarm(out: SwarmJson, acIds: string[]): Omit<SwarmReview, "approved"> {
  const item = out.agreement?.items?.["_reply"]?.fields ?? {};
  const verdictValue = item.verdict?.value;
  const verdict: SwarmReview["verdict"] = verdictValue === "approve" ? "approve" : verdictValue === "reject" ? "reject" : "disputed";
  const ac: SwarmReview["ac"] = {};
  for (const id of acIds) ac[id] = { value: item[id]?.value ?? null, counts: item[id]?.counts ?? {} };
  const rows: Array<Record<string, unknown>> = (out.judges ?? out.harnesses ?? []) as Array<Record<string, unknown>>;
  return {
    verdict,
    ac,
    parsed: out.agreement?.parsedAgents ?? [],
    unparsed: out.agreement?.unparsedAgents ?? [],
    harnesses: rows.map((r) => ({
      harness: String(r.agent ?? r.id ?? "?"),
      ok: r.ok !== false,
      summary: clip(String(r.summary ?? r.error ?? (r.ok === false ? "failed" : "ok")), 240),
    })),
  };
}

export async function swarmReview(ws: Workspace, id: string, opts: { cwd: string; harnesses?: string[]; dryRun?: boolean } , run: Runner = defaultRunner): Promise<SwarmReview> {
  const t = ws.store.get(id);
  if (t.status !== "review" && !opts.dryRun) throw new FlowError("INVALID_TRANSITION", `${id} is ${t.status}; swarm review runs on tickets in review`);
  const { task, files } = await buildReviewTask(ws, id, opts.cwd);
  const argv = [process.execPath, swarmEntry(ws), "swarm", "--task", task, "--timeout-ms", String(ws.config.swarm.timeoutMs)];
  if (files.length) argv.push("--files", files.join(","));
  const harnesses = opts.harnesses?.length ? opts.harnesses : ws.config.swarm.harnesses;
  if (harnesses.length) argv.push("--agents", harnesses.join(","));
  if (opts.dryRun) argv.push("--dry-run");
  const r = await run(argv, { cwd: opts.cwd, timeoutMs: ws.config.swarm.timeoutMs + 60_000, env: { ...process.env, WORKSPACE_ROOT: opts.cwd } });
  let parsed: SwarmJson;
  try {
    parsed = JSON.parse(r.stdout) as SwarmJson;
  } catch {
    throw new FlowError("EXTERNAL_FAILURE", `swarm did not return JSON (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  const detail = ws.store.detail(id, { events: 0 });
  const review = parseSwarm(parsed, detail.acceptance.map((a) => a.ac_id));
  if (opts.dryRun) return { ...review, approved: false };
  const lines = [
    `Swarm review: **${review.verdict}** (parsed: ${review.parsed.join(", ") || "none"}${review.unparsed.length ? `; unparsed: ${review.unparsed.join(", ")}` : ""})`,
    ...Object.entries(review.ac).map(([k, v]) => `- ${k}: ${v.value ?? "disputed"} ${JSON.stringify(v.counts)}`),
    "Votes are evidence, not ground truth.",
  ];
  ws.store.comment(id, "review", lines.join("\n"), ACTOR);
  ws.store.record("swarm.reviewed", ACTOR, id, { verdict: review.verdict, parsed: review.parsed.length });
  let approved = false;
  const allPass = detail.acceptance.every((a) => review.ac[a.ac_id]?.value === "pass");
  if (ws.config.swarm.autoApproveOnMajority && review.verdict === "approve" && allPass) {
    for (const a of detail.acceptance) {
      if (a.verdict !== "Verified") ws.store.verifyAcceptance(id, a.ac_id, "Verified", `swarm majority pass ${JSON.stringify(review.ac[a.ac_id].counts)}`, ACTOR);
    }
    ws.store.transition(id, "approve", ACTOR);
    approved = true;
  }
  return { ...review, approved };
}
