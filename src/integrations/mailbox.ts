import { redactSecrets, clip } from "../core/redaction.js";
import type { FlowEvent } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { binArgv, defaultRunner, type Runner } from "./exec.js";

/**
 * synthet-agent-mailbox notifier. agent-flow owns tickets; the mailbox only carries notifications.
 * Same-host publishing goes through the `agent-mail` CLI (the mailbox daemon has no publish endpoint).
 * Messages carry ids, titles and reasons — never ticket bodies (mailbox bodies are untrusted on the far side,
 * and specs may contain sensitive context).
 */

/** Map audit events to notification kinds (config.mailbox.notifyOn uses these names). */
export const EVENT_KINDS: Record<string, string> = {
  "ticket.claimed": "claimed",
  "ticket.submitted": "review",
  "ticket.rejected": "rejected",
  "ticket.blocked": "blocked",
  "ticket.escalated": "needs_human",
  "ticket.approved": "done",
  "ticket.closed": "done",
  "lease.expired": "lease_expired",
};

export interface MailboxJob {
  kind: string;
  ticket_id: string | null;
  subject: string;
  text: string;
  peer?: string | null;
}

export function jobForEvent(ws: Workspace, e: FlowEvent): MailboxJob | null {
  const kind = EVENT_KINDS[e.action];
  if (!kind || !ws.config.mailbox.notifyOn.includes(kind)) return null;
  const t = e.ticket_id && ws.store.exists(e.ticket_id) ? ws.store.get(e.ticket_id) : null;
  const title = t ? clip(t.title, 120) : "";
  const reason = typeof e.payload.reason === "string" ? clip(e.payload.reason, 500) : "";
  const verb: Record<string, string> = {
    claimed: `claimed by ${e.actor}`,
    review: `ready for review (by ${e.actor})`,
    rejected: `rejected by ${e.actor}`,
    blocked: `blocked by ${e.actor}`,
    needs_human: "escalated: needs a human",
    done: `done (${e.actor})`,
    lease_expired: `lease expired (was ${String(e.payload.owner ?? "?")}) — back in the ready queue`,
  };
  const lines = [
    `[agent-flow] ${e.ticket_id ?? ""} ${verb[kind] ?? kind}`,
    title ? `title: ${title}` : "",
    reason ? `reason: ${reason}` : "",
    typeof e.payload.unblock_condition === "string" ? `unblock when: ${clip(e.payload.unblock_condition, 300)}` : "",
    t?.branch ? `branch: ${t.branch}` : "",
    `project: ${ws.paths.root}`,
    `event: #${e.seq} ${e.ts}`,
  ].filter(Boolean);
  return {
    kind,
    ticket_id: e.ticket_id,
    subject: clip(`[flow] ${e.ticket_id ?? ""} ${kind}`, 160),
    text: redactSecrets(lines.join("\n")),
    peer: kind === "review" ? ws.config.mailbox.reviewPeer : null,
  };
}

async function ensureRegistered(ws: Workspace, run: Runner): Promise<void> {
  if (ws.store.getKv("mailbox:registered") === ws.config.mailbox.session) return;
  const m = ws.config.mailbox;
  const r = await run([...binArgv(process.env.AGENT_MAIL_BIN ?? m.bin), "register", "--session", m.session, "--agent-name", "agent-flow", "--harness", "agent-flow"], {
    timeoutMs: 15_000,
  });
  if (r.code !== 0) throw new Error(`agent-mail register failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
  ws.store.setKv("mailbox:registered", m.session);
}

export async function deliver(ws: Workspace, job: MailboxJob, run: Runner = defaultRunner): Promise<void> {
  const m = ws.config.mailbox;
  const bin = binArgv(process.env.AGENT_MAIL_BIN ?? m.bin);
  await ensureRegistered(ws, run);
  const argv = [...bin, "publish", "--session", m.session, "--audience", m.audience, "--subject", job.subject, "--text", job.text];
  if (m.scope) argv.splice(argv.indexOf("--subject"), 0, "--scope", m.scope);
  const r = await run(argv, { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`agent-mail publish failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
  if (job.peer) {
    // Direct, encrypted peer message to the reviewer's machine. Exit 2 = queued in the mailbox outbox: fine.
    const s = await run([...bin, "send", job.peer, "--text", job.text], { timeoutMs: 20_000 });
    if (s.code !== 0 && s.code !== 2) throw new Error(`agent-mail send failed (${s.code}): ${(s.stderr || s.stdout).slice(0, 300)}`);
  }
}
