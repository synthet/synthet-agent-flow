import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { redactHome, redactSecrets } from "../core/redaction.js";
import type { TicketDetail } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { binArgv, defaultRunner, type Runner } from "./exec.js";

/**
 * LLM Wiki export: a finished ticket becomes a markdown *source* in a synthet-llm-wiki root, so the
 * spec, acceptance evidence and handoff notes outlive the tracker. agent-flow only writes the file and
 * optionally runs `llmwiki ingest`; compiling and reviewing claims stays in the wiki's own workflow.
 */

/** Events that trigger an automatic export when `wiki.enabled` is on. */
export const WIKI_EVENTS = new Set(["ticket.approved", "ticket.closed"]);

const KEY_EVENTS = new Set([
  "ticket.created",
  "ticket.claimed",
  "ticket.started",
  "ticket.blocked",
  "ticket.submitted",
  "ticket.rejected",
  "ticket.approved",
  "ticket.closed",
  "ticket.reopened",
  "ticket.cancelled",
]);

const clean = (text: string): string => redactHome(redactSecrets(text), os.homedir());
const cell = (text: string | null | undefined): string => clean(text ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
const yamlStr = (text: string): string => JSON.stringify(clean(text));

export function repoName(ws: Workspace): string {
  return path.basename(ws.paths.root);
}

/** Render one ticket as a self-contained, redacted markdown source. */
export function renderTicketSource(ws: Workspace, t: TicketDetail): string {
  const repo = repoName(ws);
  const verified = t.acceptance.filter((a) => a.verdict === "Verified").length;
  const lines: string[] = [
    "---",
    "type: Report",
    `title: ${yamlStr(`${t.id}: ${t.title}`)}`,
    `description: ${yamlStr(`agent-flow ticket ${t.id} in ${repo}, ${t.status}, ${verified}/${t.acceptance.length} acceptance criteria verified.`)}`,
    `tags: [agent-flow, ticket, ${repo}, ${t.type}]`,
    `timestamp: ${t.closed_at ?? t.updated_at}`,
    "okf_version: 0.1",
    "source: agent-flow",
    `ticket: ${t.id}`,
    `repo: ${repo}`,
    `status: ${t.status}`,
    "---",
    "",
    `# ${clean(t.title)}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Ticket | \`${t.id}\` (${t.type}, ${t.priority}, ${t.lane}) |`,
    `| Repo | \`${repo}\` |`,
    `| Status | ${t.status} |`,
    `| Created | ${t.created_at} by ${cell(t.created_by)} |`,
    `| Closed | ${t.closed_at ?? "—"} |`,
    `| Branch | ${t.branch ? `\`${cell(t.branch)}\`` : "—"} |`,
    `| PR | ${t.pr_url ? cell(t.pr_url) : "—"} |`,
    `| Spec ref | ${t.spec_ref ? cell(t.spec_ref) : "—"} |`,
    `| Labels | ${t.labels.length ? t.labels.map(cell).join(", ") : "—"} |`,
    `| Scope | ${t.scope_paths.length ? t.scope_paths.map((p) => `\`${cell(p)}\``).join(", ") : "—"} |`,
    "",
    "## Spec",
    "",
    clean(t.body.trim()) || "_No body._",
    "",
    "## Acceptance criteria",
    "",
  ];
  if (t.acceptance.length) {
    lines.push("| AC | Criterion | Verdict | Evidence |", "|---|---|---|---|");
    for (const a of t.acceptance) lines.push(`| ${a.ac_id} | ${cell(a.text)} | ${a.verdict} | ${cell(a.evidence) || "—"} |`);
  } else {
    lines.push("_None recorded._");
  }
  const notes = t.comments.filter((c) => c.kind === "handoff" || c.kind === "review" || c.kind === "note");
  lines.push("", "## Handoffs, reviews and notes", "");
  if (notes.length) {
    for (const c of notes) lines.push(`### ${c.kind} — ${c.created_at} — ${cell(c.actor)}`, "", clean(c.body.trim()), "");
  } else {
    lines.push("_None recorded._", "");
  }
  const deps = [...t.depends_on.map((d) => ["depends on", d] as const), ...t.dependents.map((d) => ["needed by", d] as const)];
  if (deps.length) {
    lines.push("## Dependencies", "", "| Relation | Ticket | Kind | Status |", "|---|---|---|---|");
    for (const [rel, d] of deps) lines.push(`| ${rel} | \`${d.id}\` ${cell(d.title)} | ${d.kind} | ${d.status} |`);
    lines.push("");
  }
  const events = t.events.filter((e) => KEY_EVENTS.has(e.action));
  if (events.length) {
    lines.push("## Timeline", "", "| When | Event | Actor |", "|---|---|---|");
    for (const e of events) lines.push(`| ${e.ts} | ${e.action.replace(/^ticket\./, "")} | ${cell(e.actor)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface WikiExportResult {
  id: string;
  file: string;
  ingested: boolean;
  revision?: unknown;
}

function wikiRoot(ws: Workspace, override?: string): string {
  const root = override ?? ws.config.wiki.root;
  if (!root) {
    throw new FlowError("INVALID_ARGUMENT", "wiki.root is not set", {
      nextSteps: ["agent-flow config set wiki.root '\"../synthet-llm-wiki\"'", "or pass --root <wiki root>"],
    });
  }
  return path.resolve(ws.paths.root, root);
}

/** Write the ticket's source file and, when asked, ingest it with `llmwiki`. */
export async function exportTicket(
  ws: Workspace,
  id: string,
  opts: { root?: string; ingest?: boolean; run?: Runner } = {},
): Promise<WikiExportResult> {
  const root = wikiRoot(ws, opts.root);
  const t = ws.store.detail(id, { events: 200 });
  const dir = path.join(root, ws.config.wiki.outDir, repoName(ws));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${t.id}.md`);
  writeFileSync(file, renderTicketSource(ws, t), "utf8");
  const ingest = opts.ingest ?? ws.config.wiki.ingest;
  if (!ingest) return { id: t.id, file, ingested: false };
  const run = opts.run ?? defaultRunner;
  const res = await run([...binArgv(ws.config.wiki.bin), "--root", root, "ingest", file, "--json"], { timeoutMs: 120_000 });
  if (res.code !== 0) {
    throw new FlowError("EXTERNAL_FAILURE", `llmwiki ingest failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 400)}`, {
      nextSteps: ["check wiki.root and that the file is under one of the wiki's allowed_roots", "agent-flow wiki export <id> --no-ingest writes the file only"],
    });
  }
  let revision: unknown;
  try {
    revision = (JSON.parse(res.stdout) as { result?: unknown }).result;
  } catch {
    revision = undefined;
  }
  return { id: t.id, file, ingested: true, revision };
}

/** Ids of finished tickets, for `wiki export --done`. */
export function doneTicketIds(ws: Workspace): string[] {
  return ws.store.list({ status: "done", includeClosed: true }).map((t) => t.id);
}
