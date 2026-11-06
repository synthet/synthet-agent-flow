import { redactSecrets, clip } from "../core/redaction.js";
import type { FlowEvent } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { FlowError } from "../core/errors.js";
import { binArgv, defaultRunner, type Runner } from "./exec.js";
import { openStdioMcp, type McpOpener, type McpSession } from "./mcp-client.js";

/**
 * synthet-agent-mailbox notifier. agent-flow owns tickets; the mailbox only carries notifications.
 * Same-host publishing goes through the mailbox journal's MCP tools (see MailboxSession).
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

/** argv to launch the mailbox CLI (`agent-mail`, or `$AGENT_MAIL_BIN`, e.g. `node /path/dist/cli.js`). */
export function mailboxBin(ws: Workspace): string[] {
  return binArgv(process.env.AGENT_MAIL_BIN ?? ws.config.mailbox.bin);
}

function explain(err: unknown): FlowError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/identity\.json/.test(msg) || /ENOENT/.test(msg)) {
    return new FlowError("EXTERNAL_FAILURE", "synthet-agent-mailbox has no identity on this machine", {
      retryable: false,
      nextSteps: ["agent-mail init --name <this-pc>", "or set AGENT_MAIL_HOME to an initialised mailbox home"],
    });
  }
  if (/not a member/.test(msg)) {
    return new FlowError("EXTERNAL_FAILURE", `mailbox refused the publish: ${msg}`, { retryable: true, nextSteps: ["check mailbox.scope in .agent-flow/config.json"] });
  }
  return err instanceof FlowError ? err : new FlowError("EXTERNAL_FAILURE", msg, { retryable: true });
}

/**
 * A delivery session: one `agent-mail mcp --no-listen` process for a whole outbox flush.
 * The journal requires scope membership before a group/topic publish, and only the MCP surface
 * exposes `mailbox_subscribe` (the CLI has `register` and `publish` but no `subscribe`), so the
 * journal path goes through MCP. Direct peer messages (`send`) stay on the CLI.
 */
export class MailboxSession {
  private session: McpSession | null = null;
  private ready = false;

  constructor(
    private readonly ws: Workspace,
    private readonly open: McpOpener = openStdioMcp,
    private readonly run: Runner = defaultRunner,
  ) {}

  private async journal(): Promise<McpSession> {
    const m = this.ws.config.mailbox;
    if (!this.session) {
      const [command, ...args] = mailboxBin(this.ws);
      this.session = await this.open({
        name: "synthet-agent-mailbox",
        command,
        args: [...args, "mcp", "--no-listen", "--harness", "agent-flow", "--agent-name", "agent-flow"],
        timeoutMs: 20_000,
      });
    }
    if (!this.ready) {
      if (!m.scope && m.audience !== "broadcast") {
        throw new FlowError("INVALID_ARGUMENT", "mailbox.scope is not set", { nextSteps: ['agent-flow config set mailbox.scope \'"team-flow"\''] });
      }
      try {
        await this.session.call("mailbox_register_session", { session_id: m.session, alias: "agent-flow", harness: "agent-flow" });
        if (m.scope) await this.session.call("mailbox_subscribe", { session_id: m.session, scope_id: m.scope });
      } catch (err) {
        throw explain(err);
      }
      this.ready = true;
    }
    return this.session;
  }

  async deliver(job: MailboxJob, idempotencyKey?: string): Promise<void> {
    const m = this.ws.config.mailbox;
    const journal = await this.journal();
    try {
      await journal.call("mailbox_publish", {
        session_id: m.session,
        audience: m.audience,
        ...(m.scope ? { scope_id: m.scope } : {}),
        subject: job.subject,
        body: job.text,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    } catch (err) {
      throw explain(err);
    }
    if (job.peer) {
      // Direct, encrypted peer message to the reviewer's machine. Exit 2 = queued in the mailbox outbox: fine.
      const s = await this.run([...mailboxBin(this.ws), "send", job.peer, "--text", job.text, "--harness", "agent-flow", "--agent-name", "agent-flow"], { timeoutMs: 20_000 });
      if (s.code !== 0 && s.code !== 2) throw explain(new Error(`agent-mail send failed (${s.code}): ${(s.stderr || s.stdout).slice(0, 300)}`));
    }
  }

  async close(): Promise<void> {
    await this.session?.close().catch(() => undefined);
    this.session = null;
    this.ready = false;
  }
}

/** One-off delivery (used by `agent-flow mailbox test`). */
export async function deliver(ws: Workspace, job: MailboxJob, open: McpOpener = openStdioMcp, run: Runner = defaultRunner): Promise<void> {
  const s = new MailboxSession(ws, open, run);
  try {
    await s.deliver(job);
  } finally {
    await s.close();
  }
}
