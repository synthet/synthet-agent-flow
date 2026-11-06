import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { run as runProc } from "../core/proc.js";
import { clip, redactSecrets } from "../core/redaction.js";
import type { Workspace } from "../core/workspace.js";
import { openStdioMcp, type McpOpener } from "./mcp-client.js";

/**
 * Multi-harness review via synthet-agent-swarm's `swarm_run` MCP tool (mode "review"; read-only judges:
 * Codex, Claude Code, Antigravity, Cursor, Grok — whichever are installed).
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

interface SwarmRow {
  id?: string;
  agent?: string;
  ok?: boolean;
  summary?: string;
  outputFile?: string;
  error?: { message?: string } | string;
}

interface SwarmJson {
  ok?: boolean;
  dryRun?: boolean;
  /** `swarm_run` rows. */
  harnesses?: SwarmRow[];
  /** Legacy `swarm` CLI rows. */
  judges?: SwarmRow[];
  agreement?: { parsedAgents?: string[]; unparsedAgents?: string[]; items?: Record<string, { fields?: Record<string, { value: string | null; counts: Record<string, number> }> }> };
  error?: { code?: string; message?: string; next_steps?: string[] };
}

/** Last balanced top-level JSON object in a reply (same rule as the swarm's own vote parser). */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(i, end + 1)) as unknown;
            if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Normalise a swarm response. Two or more harnesses → the swarm's strict-majority `agreement`.
 * One harness → no agreement is returned, so that harness's reply (`outputFile`) is read directly.
 */
export function parseSwarm(out: SwarmJson, acIds: string[], readReply?: (row: SwarmRow) => string | null): Omit<SwarmReview, "approved"> {
  const rows = out.harnesses ?? out.judges ?? [];
  let fields = out.agreement?.items?.["_reply"]?.fields;
  let parsed = out.agreement?.parsedAgents ?? [];
  let unparsed = out.agreement?.unparsedAgents ?? [];
  if (!out.agreement && readReply) {
    const ok = rows.filter((r) => r.ok !== false);
    if (ok.length === 1) {
      const reply = lastJsonObject(readReply(ok[0]) ?? "");
      const name = String(ok[0].id ?? ok[0].agent ?? "?");
      if (reply) {
        fields = Object.fromEntries(Object.entries(reply).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, { value: v as string, counts: { [v as string]: 1 } }]));
        parsed = [name];
      } else unparsed = [name];
    }
  }
  const f = fields ?? {};
  const verdictValue = f.verdict?.value;
  const verdict: SwarmReview["verdict"] = verdictValue === "approve" ? "approve" : verdictValue === "reject" ? "reject" : "disputed";
  const ac: SwarmReview["ac"] = {};
  for (const id of acIds) ac[id] = { value: f[id]?.value ?? null, counts: f[id]?.counts ?? {} };
  return {
    verdict,
    ac,
    parsed,
    unparsed,
    harnesses: rows.map((r) => ({
      harness: String(r.id ?? r.agent ?? "?"),
      ok: r.ok !== false,
      summary: clip(String(r.summary ?? (typeof r.error === "string" ? r.error : r.error?.message) ?? (r.ok === false ? "failed" : "ok")), 240),
    })),
  };
}

export async function swarmReview(
  ws: Workspace,
  id: string,
  opts: { cwd: string; harnesses?: string[]; dryRun?: boolean },
  open: McpOpener = openStdioMcp,
): Promise<SwarmReview & { dry_run?: SwarmJson }> {
  const t = ws.store.get(id);
  if (t.status !== "review" && !opts.dryRun) throw new FlowError("INVALID_TRANSITION", `${id} is ${t.status}; swarm review runs on tickets in review`);
  const { task, files } = await buildReviewTask(ws, id, opts.cwd);
  const harnesses = opts.harnesses?.length ? opts.harnesses : ws.config.swarm.harnesses;
  const session = await open({
    name: "synthet-agent-swarm",
    command: process.execPath,
    args: [swarmEntry(ws)],
    env: { WORKSPACE_ROOT: opts.cwd },
    cwd: opts.cwd,
    timeoutMs: ws.config.swarm.timeoutMs + 60_000,
  });
  let out: SwarmJson;
  try {
    out = (await session.call("swarm_run", {
      task,
      mode: "review",
      ...(files.length ? { files } : {}),
      ...(harnesses.length ? { harnesses } : {}),
      timeoutMs: ws.config.swarm.timeoutMs,
      dryRun: !!opts.dryRun,
    })) as SwarmJson;
  } finally {
    await session.close();
  }
  if (!out || typeof out !== "object") throw new FlowError("EXTERNAL_FAILURE", "swarm_run returned no JSON");
  if (out.ok === false && out.error) {
    throw new FlowError("EXTERNAL_FAILURE", `swarm_run: ${out.error.code ?? "error"}: ${out.error.message ?? ""}`, { nextSteps: out.error.next_steps ?? [] });
  }
  const detail = ws.store.detail(id, { events: 0 });
  const readReply = (row: SwarmRow) => {
    if (!row.outputFile) return null;
    const file = path.resolve(opts.cwd, row.outputFile);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const review = parseSwarm(out, detail.acceptance.map((a) => a.ac_id), readReply);
  if (opts.dryRun) return { ...review, approved: false, dry_run: out };
  const lines = [
    `Swarm review: **${review.verdict}** (parsed: ${review.parsed.join(", ") || "none"}${review.unparsed.length ? `; unparsed: ${review.unparsed.join(", ")}` : ""})`,
    ...Object.entries(review.ac).map(([k, v]) => `- ${k}: ${v.value ?? "disputed"} ${JSON.stringify(v.counts)}`),
    ...review.harnesses.map((h) => `- ${h.harness}: ${h.ok ? "ok" : "failed"} — ${h.summary}`),
    review.parsed.length === 1 ? "Single harness: no majority; treat as one reviewer's opinion." : "Votes are evidence, not ground truth.",
  ];
  ws.store.comment(id, "review", lines.join("\n"), ACTOR);
  ws.store.record("swarm.reviewed", ACTOR, id, { verdict: review.verdict, parsed: review.parsed.length });
  let approved = false;
  const allPass = detail.acceptance.every((a) => review.ac[a.ac_id]?.value === "pass");
  // Auto-approval needs a real majority (≥2 parsed judges), never a single harness.
  if (ws.config.swarm.autoApproveOnMajority && review.verdict === "approve" && allPass && review.parsed.length >= 2) {
    for (const a of detail.acceptance) {
      if (a.verdict !== "Verified") ws.store.verifyAcceptance(id, a.ac_id, "Verified", `swarm majority pass ${JSON.stringify(review.ac[a.ac_id].counts)}`, ACTOR);
    }
    ws.store.transition(id, "approve", ACTOR);
    approved = true;
  }
  return { ...review, approved };
}
