import type { Ticket, TicketDetail, FlowEvent } from "../core/types.js";

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);

const STATUS_COLOR: Record<string, string> = {
  backlog: "90",
  ready: "36",
  claimed: "35",
  in_progress: "34",
  blocked: "31",
  review: "33",
  done: "32",
  cancelled: "90",
};

export const status = (s: string) => c(STATUS_COLOR[s] ?? "0", s);

export function leaseLeft(t: Ticket): string {
  if (!t.lease_until) return "";
  const m = Math.round((Date.parse(t.lease_until) - Date.now()) / 60000);
  return m >= 0 ? `${m}m` : "expired";
}

export function ticketRow(t: Ticket): string {
  const flags = [
    t.blocked_by.length ? `⛔${t.blocked_by.length}` : "",
    t.ac_total ? `AC ${t.ac_verified}/${t.ac_total}` : "",
    t.owner ? `@${t.owner}${t.lease_until ? ` ${leaseLeft(t)}` : ""}` : "",
    t.labels.length ? dim(`{${t.labels.join(",")}}`) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${bold(t.id)}  ${status(t.status.padEnd(11))} ${t.priority} ${t.lane.padEnd(11)} ${t.title}${flags ? `  ${flags}` : ""}`;
}

export function ticketTable(tickets: Ticket[]): string {
  return tickets.length ? tickets.map(ticketRow).join("\n") : dim("(none)");
}

export function ticketDetail(t: TicketDetail): string {
  const out: string[] = [
    `${bold(t.id)} ${t.title}`,
    `${status(t.status)} · ${t.type} · ${t.priority} · lane ${t.lane} · v${t.version}`,
  ];
  if (t.owner) out.push(`owner ${t.owner}${t.lease_until ? ` · lease ${leaseLeft(t)} (${t.lease_until})` : ""}`);
  if (t.parent) out.push(`epic ${t.parent}`);
  if (t.labels.length) out.push(`labels ${t.labels.join(", ")}`);
  if (t.scope_paths.length) out.push(`scope ${t.scope_paths.join(", ")}`);
  if (t.spec_ref) out.push(`spec ${t.spec_ref}`);
  if (t.branch) out.push(`branch ${t.branch}`);
  if (t.pr_url || t.github_issue) out.push(`github ${t.github_issue ? `#${t.github_issue}` : ""} ${t.pr_url ?? ""}`.trim());
  if (t.blocked_reason) out.push(`${status("blocked")}: ${t.blocked_reason}${t.unblock_condition ? ` — unblock when ${t.unblock_condition}` : ""}`);
  if (t.attempts || t.rework_count) out.push(`attempts ${t.attempts} · rework ${t.rework_count}`);
  if (t.body.trim()) out.push("", t.body.trim());
  if (t.acceptance.length) {
    out.push("", bold("Acceptance criteria"));
    for (const a of t.acceptance) {
      const mark = a.verdict === "Verified" ? "✔" : a.verdict === "Failed" ? "✘" : "·";
      out.push(`  ${mark} ${a.ac_id} ${a.text}${a.evidence ? dim(` — ${a.evidence}`) : ""}`);
    }
  }
  const deps = [...t.depends_on.map((d) => `  → ${d.kind} ${d.id} (${d.status}) ${d.title}`), ...t.dependents.map((d) => `  ← ${d.kind} ${d.id} (${d.status}) ${d.title}`)];
  if (deps.length) out.push("", bold("Dependencies"), ...deps);
  if (t.children.length) out.push("", bold("Children"), ...t.children.map((d) => `  ${d.id} (${d.status}) ${d.title}`));
  if (t.comments.length) {
    out.push("", bold("Notes"));
    for (const cm of t.comments.slice(-10)) out.push(`  [${cm.kind}] ${dim(`${cm.actor} ${cm.created_at}`)}\n    ${cm.body.replace(/\n/g, "\n    ")}`);
  }
  if (t.sessions.length) {
    out.push("", bold("Sessions"));
    for (const s of t.sessions.slice(-5)) out.push(`  ${s.session_id} ${s.harness ?? ""} ${s.transcript_path ?? ""} ${s.ended_at ? "(ended)" : ""}`);
  }
  return out.join("\n");
}

export function eventRow(e: FlowEvent): string {
  const p = Object.entries(e.payload)
    .filter(([k]) => !["changed"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${dim(`#${e.seq} ${e.ts}`)} ${e.actor} ${bold(e.action)}${e.ticket_id ? ` ${e.ticket_id}` : ""}${p ? dim(` ${p}`) : ""}`;
}
