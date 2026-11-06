import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlowError } from "../core/errors.js";
import { TICKET_ID_RE, ticketIdFromBranch } from "../core/ids.js";
import { redactSecrets } from "../core/redaction.js";
import type { Status } from "../core/config.js";
import type { Ticket } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { defaultRunner, type Runner } from "./exec.js";

/**
 * One-way GitHub mirror via the `gh` CLI (no tokens in agent-flow itself).
 * - agent-flow is master for agent state (status, claims, AC, notes).
 * - GitHub is master for the issue's title/body after creation — we never overwrite them.
 * - PR state flows back (reconcile / webhook): merged → done, changes requested / closed → back to in_progress.
 */

const ACTOR = "system:github";

async function gh(run: Runner, args: string[], input?: string): Promise<string> {
  const r = await run(["gh", ...args], { timeoutMs: 60_000, input });
  if (r.code !== 0) {
    throw new FlowError("EXTERNAL_FAILURE", `gh ${args.slice(0, 3).join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`, {
      retryable: true,
      nextSteps: ["gh auth status", "check github.repo in .agent-flow/config.json"],
    });
  }
  return r.stdout;
}

export async function resolveRepo(ws: Workspace, run: Runner = defaultRunner): Promise<string> {
  if (ws.config.github.repo) return ws.config.github.repo;
  const out = await gh(run, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const repo = out.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new FlowError("EXTERNAL_FAILURE", `could not resolve the GitHub repo (got "${repo}")`);
  return repo;
}

function statusLabel(ws: Workspace, s: Status): string {
  return `${ws.config.github.labelPrefix}${s.replace("_", "-")}`;
}

function issueBody(t: Ticket & { acceptance?: Array<{ ac_id: string; text: string; verdict: string }> }, epicIssue: number | null): string {
  const ac = (t.acceptance ?? []).map((a) => `- [${a.verdict === "Verified" ? "x" : " "}] **${a.ac_id}** ${a.text}`).join("\n");
  return redactSecrets(
    [
      `<!-- agent-flow:${t.id} -->`,
      `> Mirrored from agent-flow ticket \`${t.id}\` — agent state (status, claims, AC verdicts) lives in agent-flow; this issue is a one-way projection.`,
      epicIssue ? `Part of #${epicIssue}` : "",
      "",
      t.body.trim(),
      ac ? `\n### Acceptance criteria\n${ac}` : "",
      t.scope_paths.length ? `\n**Scope:** ${t.scope_paths.map((p) => `\`${p}\``).join(", ")}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  );
}

async function ensureLabels(ws: Workspace, repo: string, run: Runner): Promise<void> {
  if (ws.store.getKv(`gh:labels:${repo}`) === "1") return;
  const labels: Array<[string, string]> = [
    [ws.config.github.issueLabel, "5319e7"],
    ...(["backlog", "ready", "claimed", "in_progress", "blocked", "review", "done"] as Status[]).map((s) => [statusLabel(ws, s), "c5def5"] as [string, string]),
  ];
  for (const [name, color] of labels) await gh(run, ["label", "create", name, "--repo", repo, "--color", color, "--force"]);
  ws.store.setKv(`gh:labels:${repo}`, "1");
}

export interface PushResult {
  created: Array<{ id: string; issue: number }>;
  updated: string[];
  skipped: string[];
}

/** Create/update issues for tickets (epics first so children can be attached as sub-issues). */
export async function pushIssues(ws: Workspace, ids: string[] | null, run: Runner = defaultRunner): Promise<PushResult> {
  const repo = await resolveRepo(ws, run);
  await ensureLabels(ws, repo, run);
  const all = ids ? ids.map((id) => ws.store.get(id)) : ws.store.list({}).filter((t) => t.status !== "backlog" || t.type === "epic");
  all.sort((a, b) => (a.type === "epic" ? 0 : 1) - (b.type === "epic" ? 0 : 1));
  const res: PushResult = { created: [], updated: [], skipped: [] };
  for (const t0 of all) {
    const t = ws.store.detail(t0.id, { events: 0 });
    if (t.status === "cancelled" && !t.github_issue) {
      res.skipped.push(t.id);
      continue;
    }
    const epic = t.parent ? ws.store.get(t.parent) : null;
    const label = statusLabel(ws, t.status);
    if (!t.github_issue) {
      const url = (
        await gh(run, ["issue", "create", "--repo", repo, "--title", `${t.title} [${t.id}]`, "--body-file", "-", "--label", `${ws.config.github.issueLabel},${label}`], issueBody(t, epic?.github_issue ?? null))
      ).trim();
      const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
      if (!n) throw new FlowError("EXTERNAL_FAILURE", `unexpected gh issue create output: ${url.slice(0, 200)}`);
      ws.store.update(t.id, { github_issue: n }, ACTOR);
      res.created.push({ id: t.id, issue: n });
      if (epic?.github_issue) {
        // Sub-issues need the child's database id, not its number.
        const childId = (await gh(run, ["api", `repos/${repo}/issues/${n}`, "--jq", ".id"])).trim();
        await gh(run, ["api", "-X", "POST", `repos/${repo}/issues/${epic.github_issue}/sub_issues`, "-F", `sub_issue_id=${childId}`]);
      }
    } else {
      await syncIssueState(ws, repo, t, run);
      res.updated.push(t.id);
    }
  }
  ws.store.record("github.pushed", ACTOR, null, { repo, created: res.created.length, updated: res.updated.length });
  return res;
}

/** Project a ticket's status onto its issue: one status label; closed when done/cancelled. */
export async function syncIssueState(ws: Workspace, repo: string, t: Ticket, run: Runner = defaultRunner): Promise<void> {
  if (!t.github_issue) return;
  const remove = (["backlog", "ready", "claimed", "in_progress", "blocked", "review", "done"] as Status[]).filter((s) => s !== t.status).map((s) => statusLabel(ws, s));
  const args = ["issue", "edit", String(t.github_issue), "--repo", repo];
  if (t.status !== "cancelled") args.push("--add-label", statusLabel(ws, t.status));
  args.push("--remove-label", remove.join(","));
  await gh(run, args);
  if (t.status === "done") await gh(run, ["issue", "close", String(t.github_issue), "--repo", repo, "--reason", "completed"]).catch(() => undefined);
  else if (t.status === "cancelled") await gh(run, ["issue", "close", String(t.github_issue), "--repo", repo, "--reason", "not planned"]).catch(() => undefined);
}

export interface PrInfo {
  number: number;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision?: string | null;
  body?: string;
  url?: string;
}

export function ticketForPr(ws: Workspace, pr: PrInfo): string | null {
  const fromBranch = ticketIdFromBranch(pr.headRefName, ws.config.prefix);
  if (fromBranch && ws.store.exists(fromBranch)) return fromBranch;
  const refs = new RegExp(`Refs\\s+(${ws.config.prefix}-[0-9a-z]{4,8})`, "i").exec(pr.body ?? "") ?? TICKET_ID_RE.exec(pr.body ?? "");
  return refs && ws.store.exists(refs[1]) ? refs[1] : null;
}

/** Apply one PR's state to its ticket. Idempotent per (PR, state, decision). */
export function applyPrState(ws: Workspace, pr: PrInfo): { ticket: string; action: string } | null {
  const id = ticketForPr(ws, pr);
  if (!id) return null;
  const key = `gh:pr:${pr.number}:${pr.state}:${pr.reviewDecision ?? ""}`;
  if (ws.store.getKv(key)) return null;
  let t = ws.store.get(id);
  let action = "noop";
  if (pr.url && t.pr_url !== pr.url) t = ws.store.update(id, { pr_url: pr.url }, ACTOR);
  if (pr.state === "MERGED") {
    if (t.status === "review") {
      ws.store.comment(id, "review", `PR #${pr.number} merged on GitHub.`, ACTOR);
      ws.store.transition(id, "approve", ACTOR, { force: true }); // a human merged it: that is the approval
      action = "approved";
    } else if (!["done", "cancelled"].includes(t.status)) {
      ws.store.setStatusAdmin(id, "done", ACTOR, `PR #${pr.number} merged`);
      action = "done";
    }
  } else if (pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED" && t.status === "review") {
    ws.store.transition(id, "reject", ACTOR, { reason: `changes requested on PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}` });
    action = "rejected";
  } else if (pr.state === "CLOSED" && t.status === "review") {
    ws.store.transition(id, "reject", ACTOR, { reason: `PR #${pr.number} was closed without merging` });
    action = "rejected";
  } else if (pr.state === "OPEN") {
    action = "linked";
  }
  ws.store.setKv(key, new Date().toISOString());
  if (action !== "noop") ws.store.record("github.pr_synced", ACTOR, id, { pr: pr.number, state: pr.state, review: pr.reviewDecision ?? null, action });
  return { ticket: id, action };
}

/** Pull PR state from GitHub (`gh pr list`) and apply it. */
export async function reconcile(ws: Workspace, run: Runner = defaultRunner): Promise<Array<{ ticket: string; action: string; pr: number }>> {
  const repo = await resolveRepo(ws, run);
  const out = await gh(run, ["pr", "list", "--repo", repo, "--state", "all", "--limit", "100", "--json", "number,headRefName,state,reviewDecision,body,url"]);
  const prs = JSON.parse(out) as PrInfo[];
  const results: Array<{ ticket: string; action: string; pr: number }> = [];
  for (const pr of prs) {
    const r = applyPrState(ws, pr);
    if (r) results.push({ ...r, pr: pr.number });
  }
  ws.store.setKv("gh:last_reconcile", String(Date.now()));
  return results;
}

/** Rate-limited reconcile for SessionStart. Never throws. */
export async function maybeReconcile(ws: Workspace, run: Runner = defaultRunner): Promise<number> {
  if (!ws.config.github.enabled || ws.config.github.reconcileMinutes === 0) return 0;
  const last = Number(ws.store.getKv("gh:last_reconcile") ?? 0);
  if (Date.now() - last < ws.config.github.reconcileMinutes * 60_000) return 0;
  try {
    return (await reconcile(ws, run)).length;
  } catch {
    ws.store.setKv("gh:last_reconcile", String(Date.now()));
    return 0;
  }
}

/** Webhook entry point (POST /hooks/github): pull_request + pull_request_review events. */
export async function githubWebhookHandler(event: string, payload: unknown, ws: Workspace): Promise<unknown> {
  if (event !== "pull_request" && event !== "pull_request_review") return { ignored: event };
  const p = payload as { pull_request?: { number: number; head?: { ref?: string }; state?: string; merged?: boolean; body?: string; html_url?: string }; review?: { state?: string } };
  const pr = p.pull_request;
  if (!pr) return { ignored: "no pull_request" };
  const info: PrInfo = {
    number: pr.number,
    headRefName: pr.head?.ref ?? "",
    state: pr.merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
    reviewDecision: p.review?.state?.toUpperCase() === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : p.review?.state?.toUpperCase() === "APPROVED" ? "APPROVED" : null,
    body: pr.body ?? "",
    url: pr.html_url,
  };
  return applyPrState(ws, info) ?? { ignored: "no matching ticket" };
}

// ─────────────────────────────── PR creation ───────────────────────────────

function templatePath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", "..", "templates", "pr-body.md"), path.join(here, "..", "templates", "pr-body.md")]) if (existsSync(p)) return p;
  return null;
}

/** Tiny mustache subset: {{x}}, {{#list}}…{{/list}}, {{#flag}}…{{/flag}}. */
export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  const section = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  const render = (text: string, ctx: Record<string, unknown>): string =>
    text
      .replace(section, (_m, key: string, inner: string) => {
        const v = ctx[key];
        if (Array.isArray(v)) return v.map((item) => render(inner, { ...ctx, ...(item as Record<string, unknown>) })).join("");
        return v ? render(inner, ctx) : "";
      })
      .replace(/\{\{(\w+)\}\}/g, (_m, key: string) => (ctx[key] === undefined || ctx[key] === null ? "" : String(ctx[key])));
  return render(tpl, data);
}

export function prBody(ws: Workspace, id: string): string {
  const t = ws.store.detail(id, { events: 0 });
  const file = templatePath();
  const tpl = file ? readFileSync(file, "utf8") : "Refs {{id}}\n\n{{title}}\n";
  return redactSecrets(
    renderTemplate(tpl, {
      id: t.id,
      title: t.title,
      issue: t.github_issue,
      branch: t.branch ?? "",
      spec_ref: t.spec_ref,
      acceptance: t.acceptance.map((a) => ({ ...a, check: a.verdict === "Verified" ? "x" : " " })),
    }),
  );
}

export async function createPr(ws: Workspace, id: string, opts: { base?: string; draft?: boolean } = {}, run: Runner = defaultRunner): Promise<string> {
  const t = ws.store.get(id);
  if (!t.branch) throw new FlowError("INVALID_ARGUMENT", `${id} has no branch yet`, { nextSteps: [`agent-flow branch ${id}`] });
  const repo = await resolveRepo(ws, run);
  const prefix = t.type === "bug" ? "fix" : t.type === "docs" ? "docs" : t.type === "chore" ? "chore" : "feat";
  const args = ["pr", "create", "--repo", repo, "--head", t.branch, "--base", opts.base ?? ws.config.defaultBranch, "--title", `${prefix}: ${t.title}`, "--body-file", "-"];
  if (opts.draft) args.push("--draft");
  const url = (await gh(run, args, prBody(ws, id))).trim().split("\n").pop() ?? "";
  if (/^https?:\/\//.test(url)) ws.store.update(id, { pr_url: url }, ACTOR);
  return url;
}
