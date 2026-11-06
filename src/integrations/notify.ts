import type { FlowEvent } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { defaultRunner, type Runner } from "./exec.js";
import { deliver, jobForEvent, type MailboxJob } from "./mailbox.js";

/**
 * Side effects of tracker events go through the outbox (retry with backoff, never blocking a write):
 * - `mailbox`: synthet-agent-mailbox notifications,
 * - `github`: status-label projection onto mirrored issues.
 */

const STATUS_EVENTS = new Set([
  "ticket.claimed",
  "ticket.started",
  "ticket.released",
  "ticket.blocked",
  "ticket.unblocked",
  "ticket.submitted",
  "ticket.approved",
  "ticket.rejected",
  "ticket.escalated",
  "ticket.closed",
  "ticket.reopened",
  "ticket.cancelled",
  "ticket.promoted",
  "ticket.status_set",
  "lease.expired",
]);

export function attachNotifiers(ws: Workspace): () => void {
  if (!ws.config.mailbox.enabled && !ws.config.github.enabled) return () => undefined;
  return ws.store.onEvent((e: FlowEvent) => {
    if (ws.config.mailbox.enabled && !e.actor.startsWith("system:mailbox")) {
      const job = jobForEvent(ws, e);
      if (job) ws.store.enqueue("mailbox", job as unknown as Record<string, unknown>);
    }
    if (ws.config.github.enabled && e.ticket_id && STATUS_EVENTS.has(e.action) && e.actor !== "system:github") {
      const t = ws.store.exists(e.ticket_id) ? ws.store.get(e.ticket_id) : null;
      if (t?.github_issue) ws.store.enqueue("github", { op: "status", ticket_id: t.id });
    }
  });
}

/** Deliver due outbox jobs. Bounded by `budgetMs` so a CLI command never hangs on a slow side effect. */
export async function flushOutbox(ws: Workspace, opts: { budgetMs?: number; run?: Runner } = {}): Promise<{ sent: number; failed: number }> {
  const run = opts.run ?? defaultRunner;
  const deadline = Date.now() + (opts.budgetMs ?? 8000);
  let sent = 0;
  let failed = 0;
  let repo: string | null = null;
  for (const job of ws.store.dueOutbox(undefined, 25)) {
    if (Date.now() > deadline) break;
    try {
      if (job.target === "mailbox") {
        if (!ws.config.mailbox.enabled) {
          ws.store.outboxResult(job.id, true);
          continue;
        }
        await deliver(ws, job.payload as unknown as MailboxJob, run);
      } else if (job.target === "github") {
        const { resolveRepo, syncIssueState } = await import("./github.js");
        repo ??= await resolveRepo(ws, run);
        const id = String(job.payload.ticket_id);
        if (ws.store.exists(id)) await syncIssueState(ws, repo, ws.store.get(id), run);
      }
      ws.store.outboxResult(job.id, true);
      sent++;
    } catch (err) {
      ws.store.outboxResult(job.id, false, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }
  return { sent, failed };
}
