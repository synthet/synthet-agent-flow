import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { LANES, PRIORITIES, STATUSES, TICKET_TYPES } from "../core/config.js";
import { primeContext } from "../core/context.js";
import { FlowError, toFlowError } from "../core/errors.js";
import { currentBranch } from "../core/paths.js";
import { applyAction, claimTicket } from "../core/service.js";
import type { Action } from "../core/states.js";
import { openWorkspace, resolveActor, type Workspace } from "../core/workspace.js";
import { applyPlan, buildPlan, type ImportFormat } from "../importers/index.js";
import { WORKFLOW_OVERVIEW } from "./overview.js";
import { attachNotifiers, flushOutbox } from "../integrations/notify.js";

export const TOOL_NAMES = [
  "flow_ready",
  "flow_list",
  "flow_get",
  "flow_board",
  "flow_events",
  "flow_context",
  "flow_stats",
  "flow_create",
  "flow_update",
  "flow_claim",
  "flow_heartbeat",
  "flow_release",
  "flow_transition",
  "flow_comment",
  "flow_ac",
  "flow_dep",
  "flow_cancel",
  "flow_reopen",
  "flow_import_tasks",
] as const;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const actor = z.string().min(3).max(120).optional().describe("Acting agent id, e.g. claude:<session>. Defaults to the server's actor.");
const id = z.string().min(3).max(40).describe("Ticket id, e.g. af-k3x9q");

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const fe = toFlowError(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: fe.toJSON() }, null, 2) }], isError: true };
}

function requireConfirmed(confirmed: boolean | undefined, what: string): void {
  if (!confirmed) {
    throw new FlowError("CONFIRMATION_REQUIRED", `${what} is destructive or bulk; repeat the call with confirmed: true after the user agrees`, {
      nextSteps: ["ask the user to confirm, then pass confirmed: true"],
    });
  }
}

export interface FlowMcpOptions {
  cwd?: string;
  actor?: string;
  /** Inject an already-open workspace (tests). */
  workspace?: Workspace;
}

export function createFlowMcpServer(opts: FlowMcpOptions = {}): { server: McpServer; workspace: () => Workspace; close: () => void } {
  const cwd = opts.cwd ?? process.cwd();
  const defaultActor = resolveActor(opts.actor ?? null);
  let ws: Workspace | null = opts.workspace ?? null;
  const workspace = () => {
    if (!ws) {
      ws = openWorkspace(cwd);
      attachNotifiers(ws);
    }
    return ws;
  };
  const who = (a?: string) => a ?? defaultActor;
  const server = new McpServer(
    { name: "agent-flow", version: "0.1.0" },
    {
      instructions:
        "agent-flow is the project's ticket tracker for agents. Read flow://workflow/overview first. Pick with flow_ready, claim with flow_claim, " +
        "verify acceptance criteria with evidence (flow_ac), write a handoff (flow_comment kind=handoff), then flow_transition action=submit.",
    },
  );

  const wrap =
    <A>(fn: (args: A) => unknown | Promise<unknown>) =>
    async (args: A) => {
      try {
        const w = workspace();
        w.store.reap();
        const result = ok(await fn(args));
        if (w.store.outboxStats().pending > 0) void flushOutbox(w, { budgetMs: 5000 }).catch(() => undefined);
        return result;
      } catch (err) {
        return fail(err);
      }
    };

  // ───────────── read tools ─────────────
  server.registerTool(
    "flow_ready",
    {
      title: "Ready queue",
      description: "Unblocked, unclaimed tickets in pull order (expedite lane, priority, age). Start here to pick work.",
      inputSchema: {
        label: z.string().optional().describe("Only tickets with this label (e.g. agent-ok)"),
        epic: z.string().optional(),
        lane: z.enum(LANES).optional(),
        skills: z.array(z.string()).max(20).optional().describe("Your skills; tickets labelled skill:<x> need x"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    wrap((a) => workspace().store.ready(a)),
  );

  server.registerTool(
    "flow_list",
    {
      title: "List tickets",
      description: "Filter tickets by status, owner, label, epic or text. Closed (cancelled) tickets are hidden unless include_closed.",
      inputSchema: {
        status: z.array(z.enum(STATUSES)).optional(),
        owner: z.string().optional(),
        label: z.string().optional(),
        epic: z.string().optional(),
        type: z.enum(TICKET_TYPES).optional(),
        query: z.string().max(200).optional(),
        include_closed: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ,
    },
    wrap((a) =>
      workspace().store.list({ status: a.status, owner: a.owner, label: a.label, epic: a.epic, type: a.type, query: a.query, includeClosed: a.include_closed, limit: a.limit }),
    ),
  );

  server.registerTool(
    "flow_get",
    {
      title: "Get ticket",
      description: "Full ticket: spec, acceptance criteria with verdicts, dependencies, children, notes/handoffs, sessions and recent events.",
      inputSchema: { id, events: z.number().int().min(0).max(200).default(20) },
      annotations: READ,
    },
    wrap((a) => workspace().store.detail(a.id, { events: a.events })),
  );

  server.registerTool(
    "flow_board",
    {
      title: "Board",
      description: "Kanban columns (backlog…done) with WIP limits.",
      inputSchema: { epic: z.string().optional(), label: z.string().optional() },
      annotations: READ,
    },
    wrap((a) => workspace().store.board(a)),
  );

  server.registerTool(
    "flow_events",
    {
      title: "Audit events",
      description: "Append-only, hash-chained activity log. Use since=<seq> to tail.",
      inputSchema: { since: z.number().int().min(0).optional(), ticket_id: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) },
      annotations: READ,
    },
    wrap((a) => workspace().store.events({ since: a.since, ticketId: a.ticket_id, limit: a.limit, order: a.since === undefined ? "desc" : "asc" })),
  );

  server.registerTool(
    "flow_context",
    {
      title: "Agent context",
      description: "Markdown context: the ticket bound to a branch/actor (spec, AC, last handoff) plus the ready queue.",
      inputSchema: { branch: z.string().optional(), ticket_id: z.string().optional(), actor, label: z.string().optional() },
      annotations: READ,
    },
    wrap((a) => {
      const res = primeContext(workspace().store, {
        branch: a.branch ?? currentBranch(cwd),
        ticketId: a.ticket_id,
        actor: who(a.actor),
        label: a.label,
      });
      return { ticket: res.ticket?.id ?? null, text: res.text };
    }),
  );

  server.registerTool(
    "flow_stats",
    { title: "Stats", description: "Counts per status, throughput, cycle time, rework rate, outbox.", inputSchema: {}, annotations: READ },
    wrap(() => workspace().store.stats()),
  );

  // ───────────── write tools ─────────────
  server.registerTool(
    "flow_create",
    {
      title: "Create ticket",
      description:
        "Create a ticket written as an agent prompt: title, body (spec / pattern to follow), scope_paths, acceptance criteria ('Done when'). " +
        "Use discovered_from to file work found while on another ticket.",
      inputSchema: {
        title: z.string().min(3).max(200),
        body: z.string().max(20000).optional(),
        type: z.enum(TICKET_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        lane: z.enum(LANES).optional(),
        labels: z.array(z.string().max(60)).max(20).optional(),
        scope_paths: z.array(z.string().max(300)).max(50).optional(),
        acceptance: z.array(z.string().max(1000)).max(30).optional(),
        parent: z.string().optional().describe("Epic id"),
        depends_on: z.array(z.string()).max(30).optional(),
        discovered_from: z.string().optional(),
        ready: z.boolean().default(false).describe("Put straight into the ready queue"),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) =>
      workspace().store.create(
        {
          title: a.title,
          body: a.body,
          type: a.type,
          priority: a.priority,
          lane: a.lane,
          labels: a.labels,
          scope_paths: a.scope_paths,
          acceptance: a.acceptance,
          parent: a.parent,
          depends_on: a.depends_on,
          discovered_from: a.discovered_from,
          status: a.ready ? "ready" : "backlog",
        },
        who(a.actor),
      ),
    ),
  );

  server.registerTool(
    "flow_update",
    {
      title: "Update ticket",
      description: "Edit ticket fields. Pass expected_version for optimistic concurrency.",
      inputSchema: {
        id,
        title: z.string().min(3).max(200).optional(),
        body: z.string().max(20000).optional(),
        type: z.enum(TICKET_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        lane: z.enum(LANES).optional(),
        add_labels: z.array(z.string()).max(20).optional(),
        remove_labels: z.array(z.string()).max(20).optional(),
        scope_paths: z.array(z.string()).max(50).optional(),
        spec_ref: z.string().optional(),
        pr_url: z.string().url().optional(),
        expected_version: z.number().int().optional(),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) => {
      const { id: tid, actor: who_, expected_version, ...patch } = a;
      return workspace().store.update(tid, patch, who(who_), expected_version);
    }),
  );

  server.registerTool(
    "flow_claim",
    {
      title: "Claim ticket",
      description:
        "Atomically claim a ticket (id) or the head of the ready queue (next: true). Returns the ticket with its lease and branch name. " +
        "CLAIM_CONFLICT means someone else won — pick again. WIP_LIMIT means finish or release your current ticket first.",
      inputSchema: {
        id: id.optional(),
        next: z.boolean().optional(),
        label: z.string().optional(),
        epic: z.string().optional(),
        skills: z.array(z.string()).max(20).optional(),
        lease_minutes: z.number().int().min(1).max(480).optional(),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) => {
      if (!a.id && !a.next) throw new FlowError("INVALID_ARGUMENT", "pass id or next: true");
      return claimTicket(workspace(), a.id ?? null, who(a.actor), {
        filter: { label: a.label, epic: a.epic, skills: a.skills },
        leaseMinutes: a.lease_minutes,
      });
    }),
  );

  server.registerTool(
    "flow_heartbeat",
    {
      title: "Heartbeat",
      description: "Extend your lease on a claimed / in-progress ticket.",
      inputSchema: { id, lease_minutes: z.number().int().min(1).max(480).optional(), actor },
      annotations: { ...WRITE, idempotentHint: true },
    },
    wrap((a) => workspace().store.heartbeat(a.id, who(a.actor), a.lease_minutes)),
  );

  server.registerTool(
    "flow_release",
    {
      title: "Release claim",
      description: "Give the ticket back to the ready queue. A reason records a failed attempt.",
      inputSchema: { id, reason: z.string().max(2000).optional(), actor },
      annotations: WRITE,
    },
    wrap((a) => workspace().store.transition(a.id, "release", who(a.actor), { reason: a.reason })),
  );

  server.registerTool(
    "flow_transition",
    {
      title: "Lifecycle transition",
      description:
        "start | block (reason + unblock_condition) | unblock | submit (runs DoD; needs a handoff note) | approve (needs all AC Verified; not by the owner) | " +
        "reject (reason) | close (only without review gate) | promote (backlog→ready) | demote.",
      inputSchema: {
        id,
        action: z.enum(["start", "block", "unblock", "submit", "approve", "reject", "close", "promote", "demote"]),
        reason: z.string().max(4000).optional(),
        unblock_condition: z.string().max(1000).optional(),
        skip_dod: z.boolean().optional().describe("Skip DoD commands on submit (recorded in the event)"),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) =>
      applyAction(workspace(), a.id, a.action as Action, who(a.actor), {
        reason: a.reason,
        unblockCondition: a.unblock_condition,
        skipDod: a.skip_dod,
        cwd,
      }),
    ),
  );

  server.registerTool(
    "flow_comment",
    {
      title: "Comment / handoff",
      description:
        "Add a note, a review comment, or a handoff (kind=handoff): what changed, decisions and why, what's left, gotchas. Required before submit.",
      inputSchema: { id, body: z.string().min(1).max(20000), kind: z.enum(["note", "handoff", "review"]).default("note"), actor },
      annotations: WRITE,
    },
    wrap((a) => workspace().store.comment(a.id, a.kind, a.body, who(a.actor))),
  );

  server.registerTool(
    "flow_ac",
    {
      title: "Acceptance criteria",
      description: "op=add (text) or op=verify (ac_id, verdict Verified|Failed|Unknown, evidence — required for Verified).",
      inputSchema: {
        id,
        op: z.enum(["add", "verify"]),
        ac_id: z.string().regex(/^AC-\d+$/).optional(),
        text: z.string().max(1000).optional(),
        verdict: z.enum(["Verified", "Failed", "Unknown"]).optional(),
        evidence: z.string().max(4000).optional(),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) => {
      const store = workspace().store;
      if (a.op === "add") {
        if (!a.text) throw new FlowError("INVALID_ARGUMENT", "text is required for op=add");
        return store.addAcceptance(a.id, a.text, who(a.actor), a.ac_id);
      }
      if (!a.ac_id || !a.verdict) throw new FlowError("INVALID_ARGUMENT", "ac_id and verdict are required for op=verify");
      return store.verifyAcceptance(a.id, a.ac_id, a.verdict, a.evidence ?? null, who(a.actor));
    }),
  );

  server.registerTool(
    "flow_dep",
    {
      title: "Dependency",
      description: "Add (or remove) an edge: id depends on depends_on. kind blocks (default) | parent (epic) | discovered-from. Cycles are rejected.",
      inputSchema: {
        id,
        depends_on: z.string(),
        kind: z.enum(["blocks", "parent", "discovered-from"]).default("blocks"),
        remove: z.boolean().optional(),
        actor,
      },
      annotations: WRITE,
    },
    wrap((a) => {
      const store = workspace().store;
      if (a.remove) store.removeDep(a.id, a.depends_on, a.kind, who(a.actor));
      else store.addDep(a.id, a.depends_on, a.kind, who(a.actor));
      return store.get(a.id);
    }),
  );

  // ───────────── destructive / bulk (confirmation required) ─────────────
  server.registerTool(
    "flow_cancel",
    {
      title: "Cancel ticket",
      description: "Cancel a ticket. Destructive: requires confirmed: true after the user agrees.",
      inputSchema: { id, reason: z.string().max(2000).optional(), confirmed: z.boolean().optional(), actor },
      annotations: DESTRUCTIVE,
    },
    wrap((a) => {
      requireConfirmed(a.confirmed, "cancel");
      return workspace().store.transition(a.id, "cancel", who(a.actor), { reason: a.reason });
    }),
  );

  server.registerTool(
    "flow_reopen",
    {
      title: "Reopen ticket",
      description: "Reopen a done ticket (back to ready). Requires a reason and confirmed: true.",
      inputSchema: { id, reason: z.string().min(3).max(2000), confirmed: z.boolean().optional(), actor },
      annotations: DESTRUCTIVE,
    },
    wrap((a) => {
      requireConfirmed(a.confirmed, "reopen");
      return workspace().store.transition(a.id, "reopen", who(a.actor), { reason: a.reason });
    }),
  );

  server.registerTool(
    "flow_import_tasks",
    {
      title: "Import SDD tasks",
      description:
        "Turn a spec-driven task list into an epic + tickets with dependencies: framework /tasks T-n table, Spec Kit tasks.md, or an OpenSpec change folder. " +
        "Run with dry_run: true first; the real import requires confirmed: true. Re-imports are idempotent.",
      inputSchema: {
        path: z.string().min(1).describe("Path relative to the project root"),
        format: z.enum(["auto", "framework", "speckit", "openspec", "checklist"]).default("auto"),
        spec: z.string().optional().describe("Spec file with AC-n lines (framework format)"),
        epic_title: z.string().optional(),
        no_epic: z.boolean().optional(),
        backlog: z.boolean().optional().describe("Import into backlog instead of ready"),
        dry_run: z.boolean().optional(),
        confirmed: z.boolean().optional(),
        actor,
      },
      annotations: DESTRUCTIVE,
    },
    wrap((a) => {
      const w = workspace();
      const file = path.resolve(w.paths.root, a.path);
      const plan = buildPlan(file, a.format as ImportFormat, { specFile: a.spec ? path.resolve(w.paths.root, a.spec) : undefined });
      if (a.dry_run) return { dry_run: true, format: plan.format, epic: plan.epic?.title, tasks: plan.tasks, warnings: plan.warnings };
      requireConfirmed(a.confirmed, "import");
      const res = applyPlan(w.store, plan, who(a.actor), { status: a.backlog ? "backlog" : "ready", epicTitle: a.epic_title, noEpic: a.no_epic, root: w.paths.root });
      return { epic: res.epic, created: res.created.map((t) => ({ id: t.id, title: t.title, blocked_by: t.blocked_by })), existing: res.existing.map((t) => t.id), warnings: res.warnings };
    }),
  );

  // ───────────── resources ─────────────
  server.registerResource(
    "workflow-overview",
    "flow://workflow/overview",
    { title: "agent-flow workflow", description: "Read first: states, the five-step loop, gates and conventions.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: WORKFLOW_OVERVIEW }] }),
  );

  server.registerResource(
    "board",
    "flow://board",
    { title: "Board", description: "Current Kanban board as JSON", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(workspace().store.board()) }] }),
  );

  server.registerResource(
    "ticket",
    new ResourceTemplate("flow://ticket/{id}", {
      list: async () => ({
        resources: workspace()
          .store.list({ status: ["ready", "claimed", "in_progress", "review", "blocked"], limit: 100 })
          .map((t) => ({ uri: `flow://ticket/${t.id}`, name: `${t.id} ${t.title}`, mimeType: "text/markdown" })),
      }),
    }),
    { title: "Ticket", description: "A ticket rendered as markdown context", mimeType: "text/markdown" },
    async (uri, vars) => {
      const tid = String(vars.id);
      const res = primeContext(workspace().store, { ticketId: tid, maxChars: 20000 });
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: res.text }] };
    },
  );

  return { server, workspace, close: () => (ws as Workspace | null)?.close() };
}

export async function runStdioServer(opts: FlowMcpOptions = {}): Promise<void> {
  const { server, close } = createFlowMcpServer(opts);
  const transport = new StdioServerTransport();
  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}
