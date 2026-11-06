import type { FlowStore } from "./store.js";
import type { Ticket, TicketDetail } from "./types.js";
import { ticketIdFromBranch } from "./ids.js";

/** Markdown context block for an agent: current ticket (if any) or the ready queue. */
export function primeContext(
  store: FlowStore,
  opts: { branch?: string | null; actor?: string | null; ticketId?: string | null; maxChars?: number; label?: string | null } = {},
): { text: string; ticket: TicketDetail | null } {
  const max = opts.maxChars ?? 6000;
  let ticket: TicketDetail | null = null;
  const fromBranch = opts.branch ? ticketIdFromBranch(opts.branch, store.config.prefix) : null;
  const id = opts.ticketId ?? fromBranch;
  if (id && store.exists(id)) ticket = store.detail(id, { events: 10 });
  if (!ticket && opts.actor) {
    const mine = store.list({ owner: opts.actor, status: ["claimed", "in_progress", "review", "blocked"] });
    if (mine[0]) ticket = store.detail(mine[0].id, { events: 10 });
  }
  const lines: string[] = ["# agent-flow"];
  if (ticket) {
    lines.push(...ticketBlock(ticket));
  } else {
    lines.push("No ticket is bound to this branch/session.");
  }
  const ready = store.ready({ limit: 8, label: opts.label ?? undefined });
  lines.push("", `## Ready queue (${ready.length}${ready.length === 8 ? "+" : ""})`);
  if (ready.length === 0) lines.push("_empty — do not invent work; ask the maintainer to promote tickets._");
  for (const t of ready) lines.push(`- ${t.id} [${t.priority}/${t.lane}] ${t.title}${t.labels.length ? ` {${t.labels.join(", ")}}` : ""}`);
  lines.push(
    "",
    "Workflow: `agent-flow claim --next` → work on branch from `agent-flow branch <id>` → verify AC (`agent-flow ac verify`) →",
    "`agent-flow note <id> --handoff \"...\"` → `agent-flow submit <id>`. File discovered work with `agent-flow create --discovered-from <id>`.",
    "Never track work in TODO.md files.",
  );
  let text = lines.join("\n");
  if (text.length > max) text = `${text.slice(0, max - 40)}\n…[context truncated]`;
  return { text, ticket };
}

export function ticketBlock(t: TicketDetail): string[] {
  const out = [
    `## Current ticket: ${t.id} — ${t.title}`,
    `status: **${t.status}** · owner: ${t.owner ?? "-"} · priority: ${t.priority} · lane: ${t.lane}${t.lease_until ? ` · lease until ${t.lease_until}` : ""}`,
  ];
  if (t.parent) out.push(`epic: ${t.parent}`);
  if (t.spec_ref) out.push(`spec: ${t.spec_ref}`);
  if (t.scope_paths.length) out.push(`scope: ${t.scope_paths.join(", ")}`);
  if (t.blocked_reason) out.push(`blocked: ${t.blocked_reason}${t.unblock_condition ? ` (unblock when: ${t.unblock_condition})` : ""}`);
  if (t.body.trim()) out.push("", "### Spec", t.body.trim());
  if (t.acceptance.length) {
    out.push("", "### Acceptance criteria (Done when)");
    for (const a of t.acceptance) out.push(`- [${a.verdict === "Verified" ? "x" : a.verdict === "Failed" ? "!" : " "}] ${a.ac_id}: ${a.text}${a.evidence ? ` — evidence: ${a.evidence}` : ""}`);
  }
  const open = t.depends_on.filter((d) => d.kind === "blocks" && d.status !== "done" && d.status !== "cancelled");
  if (open.length) out.push("", `Waiting on: ${open.map((d) => `${d.id} (${d.status})`).join(", ")}`);
  const handoff = [...t.comments].reverse().find((c) => c.kind === "handoff");
  if (handoff) out.push("", `### Last handoff (${handoff.actor}, ${handoff.created_at})`, handoff.body);
  const review = [...t.comments].reverse().find((c) => c.kind === "review");
  if (review && t.rework_count > 0) out.push("", `### Last review (${review.actor})`, review.body);
  return out;
}

export function oneLine(t: Ticket): string {
  const lease = t.lease_until ? ` lease ${Math.max(0, Math.round((Date.parse(t.lease_until) - Date.now()) / 60000))}m` : "";
  return `${t.id} · ${t.status}${t.owner ? ` · ${t.owner}` : ""}${lease} · ${t.title}`;
}
