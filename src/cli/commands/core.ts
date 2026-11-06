import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { primeContext } from "../../core/context.js";
import { FlowError } from "../../core/errors.js";
import { currentBranch, worktreeTop } from "../../core/paths.js";
import { applyAction, branchFor, checkDod, claimTicket, submitTicket } from "../../core/service.js";
import type { Action } from "../../core/states.js";
import { STATUSES, type Status } from "../../core/config.js";
import { initWorkspace } from "../../core/workspace.js";
import type { DepKind, Verdict } from "../../core/types.js";
import { applyPlan, buildPlan, type ImportFormat } from "../../importers/index.js";
import { bold, dim, eventRow, status, ticketDetail, ticketRow, ticketTable } from "../format.js";
import { bool, int, list, multi, register, str, type CommandCtx } from "../registry.js";

function need(ctx: CommandCtx, index: number, what: string): string {
  const v = ctx.positionals[index];
  if (!v) throw new FlowError("INVALID_ARGUMENT", `missing ${what}`, { nextSteps: [`agent-flow help ${ctx.name}`] });
  return v;
}

function bodyFrom(ctx: CommandCtx): string | undefined {
  const file = str(ctx.values["body-file"]);
  if (file) return readFileSync(file === "-" ? 0 : file, "utf8");
  return str(ctx.values.body);
}

function statuses(v: unknown): Status[] | undefined {
  const l = list(v);
  if (!l.length) return undefined;
  for (const s of l) if (!STATUSES.includes(s as Status)) throw new FlowError("INVALID_ARGUMENT", `unknown status ${s}`);
  return l as Status[];
}

/** Resolve the ticket id: explicit positional, else the ticket bound to the current branch. */
function ticketArg(ctx: CommandCtx, index = 0): string {
  const explicit = ctx.positionals[index];
  if (explicit) return explicit;
  const ws = ctx.ws();
  const branch = currentBranch(ctx.cwd);
  const ctxRes = primeContext(ws.store, { branch, actor: ctx.actor });
  if (ctxRes.ticket) return ctxRes.ticket.id;
  throw new FlowError("INVALID_ARGUMENT", "no ticket id given and none bound to this branch/actor", {
    nextSteps: ["agent-flow ready", "agent-flow claim --next"],
  });
}

const lifecycle = (name: Action, summary: string, extra: Partial<Parameters<typeof register>[0]> = {}) => ({
  name,
  group: "lifecycle",
  summary,
  usage: `${name} [<id>]${name === "block" ? " --reason <why> [--until <unblock condition>]" : ["reject", "reopen"].includes(name) ? " --reason <why>" : ""}`,
  options: {
    reason: { type: "string" as const, short: "r" },
    until: { type: "string" as const },
    force: { type: "boolean" as const },
  },
  async run(ctx: CommandCtx) {
    const ws = ctx.ws();
    const id = ticketArg(ctx);
    const t = await applyAction(ws, id, name, ctx.actor, {
      reason: str(ctx.values.reason),
      unblockCondition: str(ctx.values.until),
      force: bool(ctx.values.force),
      cwd: ctx.cwd,
    });
    ctx.print(t, () => `${ticketRow(t)}`);
  },
  ...extra,
});

register(
  {
    name: "init",
    group: "setup",
    summary: "Create .agent-flow/ (config, snapshot, gitignore) in the repo root",
    usage: "init [--prefix af] [--dod 'npm test' ...] [--no-review]",
    options: { prefix: { type: "string" }, dod: { type: "string", multiple: true }, "no-review": { type: "boolean" } },
    run(ctx) {
      const overrides: Record<string, unknown> = {};
      if (str(ctx.values.prefix)) overrides.prefix = str(ctx.values.prefix);
      if (multi(ctx.values.dod).length) overrides.dod = multi(ctx.values.dod);
      if (bool(ctx.values["no-review"])) overrides.requireReview = false;
      const { paths, created } = initWorkspace(ctx.cwd, overrides);
      ctx.print({ root: paths.root, dir: paths.dir, created }, () =>
        created
          ? `Initialized agent-flow in ${paths.dir}\nNext: agent-flow create "First ticket" --ready --ac "..."  ·  agent-flow serve  ·  agent-flow install --harness claude`
          : `agent-flow already initialized in ${paths.dir}`,
      );
    },
  },
  {
    name: "create",
    aliases: ["new", "add"],
    group: "tickets",
    summary: "Create a ticket (backlog unless --ready)",
    usage:
      "create <title> [--body ..|--body-file f] [--type feature|bug|chore|spike|docs|epic] [--priority p0-p3] [--lane ..] [--label l]... [--scope path]... [--ac 'criterion']... [--parent epic] [--dep id]... [--discovered-from id] [--ready]",
    options: {
      body: { type: "string", short: "b" },
      "body-file": { type: "string" },
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      lane: { type: "string" },
      label: { type: "string", short: "l", multiple: true },
      scope: { type: "string", multiple: true },
      ac: { type: "string", multiple: true },
      parent: { type: "string" },
      dep: { type: "string", multiple: true },
      "discovered-from": { type: "string" },
      ready: { type: "boolean" },
      "spec-ref": { type: "string" },
    },
    run(ctx) {
      const title = ctx.positionals.join(" ").trim();
      const t = ctx.ws().store.create(
        {
          title,
          body: bodyFrom(ctx),
          type: str(ctx.values.type),
          priority: str(ctx.values.priority),
          lane: str(ctx.values.lane),
          labels: list(ctx.values.label),
          scope_paths: multi(ctx.values.scope),
          acceptance: multi(ctx.values.ac),
          parent: str(ctx.values.parent),
          depends_on: list(ctx.values.dep),
          discovered_from: str(ctx.values["discovered-from"]),
          status: bool(ctx.values.ready) ? "ready" : "backlog",
          spec_ref: str(ctx.values["spec-ref"]),
        },
        ctx.actor,
      );
      ctx.print(t, () => `Created ${ticketRow(t)}`);
    },
  },
  {
    name: "edit",
    aliases: ["update"],
    group: "tickets",
    summary: "Edit ticket fields",
    usage: "edit <id> [--title ..] [--body ..|--body-file f] [--priority ..] [--lane ..] [--type ..] [--label l]... [--add-label l] [--remove-label l] [--scope p]... [--spec-ref ..] [--expect-version n]",
    options: {
      title: { type: "string" },
      body: { type: "string", short: "b" },
      "body-file": { type: "string" },
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      lane: { type: "string" },
      label: { type: "string", multiple: true },
      "add-label": { type: "string", multiple: true },
      "remove-label": { type: "string", multiple: true },
      scope: { type: "string", multiple: true },
      "spec-ref": { type: "string" },
      "expect-version": { type: "string" },
    },
    run(ctx) {
      const id = need(ctx, 0, "ticket id");
      const t = ctx.ws().store.update(
        id,
        {
          title: str(ctx.values.title),
          body: bodyFrom(ctx),
          type: str(ctx.values.type),
          priority: str(ctx.values.priority),
          lane: str(ctx.values.lane),
          labels: ctx.values.label ? list(ctx.values.label) : undefined,
          add_labels: list(ctx.values["add-label"]),
          remove_labels: list(ctx.values["remove-label"]),
          scope_paths: ctx.values.scope ? multi(ctx.values.scope) : undefined,
          spec_ref: str(ctx.values["spec-ref"]),
        },
        ctx.actor,
        int(ctx.values["expect-version"]),
      );
      ctx.print(t, () => ticketRow(t));
    },
  },
  {
    name: "show",
    aliases: ["get", "view"],
    group: "tickets",
    summary: "Show a ticket with AC, deps, notes, sessions and recent events",
    usage: "show [<id>] [--events n]",
    options: { events: { type: "string" } },
    run(ctx) {
      const d = ctx.ws().store.detail(ticketArg(ctx), { events: int(ctx.values.events) ?? 20 });
      ctx.print(d, () => ticketDetail(d));
    },
  },
  {
    name: "list",
    aliases: ["ls"],
    group: "tickets",
    summary: "List tickets",
    usage: "list [--status s1,s2] [--owner a] [--label l] [--lane l] [--epic id] [--type t] [-q text] [--all] [--limit n]",
    options: {
      status: { type: "string", short: "s" },
      owner: { type: "string" },
      label: { type: "string" },
      lane: { type: "string" },
      epic: { type: "string" },
      type: { type: "string" },
      query: { type: "string", short: "q" },
      all: { type: "boolean", short: "a" },
      limit: { type: "string" },
      mine: { type: "boolean" },
    },
    run(ctx) {
      const tickets = ctx.ws().store.list({
        status: statuses(ctx.values.status),
        owner: bool(ctx.values.mine) ? ctx.actor : str(ctx.values.owner),
        label: str(ctx.values.label),
        lane: str(ctx.values.lane),
        epic: str(ctx.values.epic),
        type: str(ctx.values.type),
        query: str(ctx.values.query),
        includeClosed: bool(ctx.values.all),
        limit: int(ctx.values.limit),
      });
      ctx.print(tickets, () => ticketTable(tickets));
    },
  },
  {
    name: "ready",
    aliases: ["next"],
    group: "tickets",
    summary: "The ready queue: unblocked, unclaimed work in pull order",
    usage: "ready [--label l] [--epic id] [--lane l] [--skills a,b] [--limit n]",
    options: {
      label: { type: "string" },
      epic: { type: "string" },
      lane: { type: "string" },
      skills: { type: "string" },
      limit: { type: "string" },
    },
    run(ctx) {
      const tickets = ctx.ws().store.ready({
        label: str(ctx.values.label),
        epic: str(ctx.values.epic),
        lane: str(ctx.values.lane),
        skills: list(ctx.values.skills),
        limit: int(ctx.values.limit),
      });
      ctx.print(tickets, () => ticketTable(tickets));
    },
  },
  {
    name: "board",
    group: "tickets",
    summary: "Kanban columns in the terminal",
    usage: "board [--epic id] [--label l]",
    options: { epic: { type: "string" }, label: { type: "string" } },
    run(ctx) {
      const raw = ctx.ws().store.board({ epic: str(ctx.values.epic), label: str(ctx.values.label) });
      const board = { columns: raw.columns.map((c) => ({ ...c, tickets: c.tickets.filter((t) => t.type !== "epic") })) };
      ctx.print(board, () =>
        board.columns
          .map(
            (col) =>
              `${bold(status(col.status).toUpperCase())} ${dim(`${col.tickets.length}${col.wip_limit ? `/${col.wip_limit}` : ""}`)}\n${
                col.tickets.map((t) => `  ${ticketRow(t)}`).join("\n") || dim("  —")
              }`,
          )
          .join("\n\n"),
      );
    },
  },
  {
    name: "claim",
    group: "lifecycle",
    summary: "Atomically claim a ticket (or the head of the ready queue with --next)",
    usage: "claim [<id>] [--next] [--label l] [--epic id] [--skills a,b] [--lease minutes]",
    options: {
      next: { type: "boolean", short: "n" },
      label: { type: "string" },
      epic: { type: "string" },
      lane: { type: "string" },
      skills: { type: "string" },
      lease: { type: "string" },
    },
    run(ctx) {
      const id = ctx.positionals[0] ?? null;
      if (!id && !bool(ctx.values.next)) throw new FlowError("INVALID_ARGUMENT", "give a ticket id or --next");
      const ws = ctx.ws();
      const t = claimTicket(ws, id, ctx.actor, {
        filter: { label: str(ctx.values.label), epic: str(ctx.values.epic), lane: str(ctx.values.lane), skills: list(ctx.values.skills) },
        leaseMinutes: int(ctx.values.lease),
      });
      ctx.print(t, () => `Claimed ${ticketRow(t)}\nbranch: ${t.branch}\nNext: git switch -c ${t.branch}  (or: agent-flow worktree create ${t.id})`);
    },
  },
  {
    name: "heartbeat",
    aliases: ["hb"],
    group: "lifecycle",
    summary: "Extend the lease on a claimed ticket",
    usage: "heartbeat [<id>] [--lease minutes]",
    options: { lease: { type: "string" } },
    run(ctx) {
      const t = ctx.ws().store.heartbeat(ticketArg(ctx), ctx.actor, int(ctx.values.lease));
      ctx.print(t, () => `lease extended: ${ticketRow(t)}`);
    },
  },
  lifecycle("start", "Mark a claimed ticket in progress (automatic on first commit with the hooks)"),
  lifecycle("release", "Give a claimed ticket back to the ready queue (--reason counts a failed attempt)"),
  lifecycle("block", "Block with a reason and an unblock condition"),
  lifecycle("unblock", "Unblock (back to in_progress if owned, else ready)"),
  {
    name: "submit",
    group: "lifecycle",
    summary: "Run DoD, then move to review (needs a handoff note since claim)",
    usage: "submit [<id>] [--skip-dod] [--force]",
    options: { "skip-dod": { type: "boolean" }, force: { type: "boolean" } },
    async run(ctx) {
      const ws = ctx.ws();
      const id = ticketArg(ctx);
      try {
        const { ticket, dod } = await submitTicket(ws, id, ctx.actor, {
          skipDod: bool(ctx.values["skip-dod"]),
          force: bool(ctx.values.force),
          cwd: ctx.cwd,
        });
        ctx.print({ ticket, dod }, () => `${dod ? `${dod.summary}\n` : ""}Submitted for review: ${ticketRow(ticket)}`);
      } catch (err) {
        throw err;
      }
    },
  },
  lifecycle("approve", "Approve a ticket in review (all AC must be Verified; no self-approval by default)"),
  lifecycle("reject", "Send a ticket in review back to in_progress with a reason"),
  lifecycle("close", "Close without review (only when requireReview is off, or --force by a human)"),
  lifecycle("reopen", "Reopen a done ticket"),
  lifecycle("cancel", "Cancel a ticket"),
  lifecycle("demote", "Move a ready ticket back to the backlog"),
  {
    name: "promote",
    group: "lifecycle",
    summary: "Move backlog tickets to ready",
    usage: "promote <id>...",
    run(ctx) {
      if (!ctx.positionals.length) throw new FlowError("INVALID_ARGUMENT", "give ticket ids");
      const ws = ctx.ws();
      const out = ctx.positionals.map((id) => ws.store.transition(id, "promote", ctx.actor));
      ctx.print(out, () => out.map(ticketRow).join("\n"));
    },
  },
  {
    name: "comment",
    group: "tickets",
    summary: "Add a comment (kind note|handoff|review)",
    usage: "comment <id> <text...> [--kind note|handoff|review] [--file f]",
    options: { kind: { type: "string", short: "k" }, file: { type: "string" } },
    async run(ctx) {
      const id = need(ctx, 0, "ticket id");
      const file = str(ctx.values.file);
      const text = file ? readFileSync(file === "-" ? 0 : file, "utf8") : ctx.positionals.slice(1).join(" ");
      const c = ctx.ws().store.comment(id, (str(ctx.values.kind) ?? "note") as never, text, ctx.actor);
      ctx.print(c, () => `comment #${c.id} added to ${id}`);
    },
  },
  {
    name: "note",
    group: "tickets",
    summary: "Add a note; --handoff marks it as the session handoff (what changed, decisions, what's left, gotchas)",
    usage: "note [<id>] <text...> [--handoff] [--file f|-]",
    options: { handoff: { type: "boolean", short: "H" }, file: { type: "string" }, ticket: { type: "string" } },
    async run(ctx) {
      const ws = ctx.ws();
      let id = str(ctx.values.ticket);
      let words = ctx.positionals;
      if (!id && words[0] && ws.store.exists(words[0])) {
        id = words[0];
        words = words.slice(1);
      }
      if (!id) id = ticketArg({ ...ctx, positionals: [] } as CommandCtx);
      const file = str(ctx.values.file);
      const text = file ? (file === "-" ? await ctx.readStdin() : readFileSync(file, "utf8")) : words.join(" ");
      const c = ws.store.comment(id, bool(ctx.values.handoff) ? "handoff" : "note", text, ctx.actor);
      ctx.print(c, () => `${c.kind} #${c.id} added to ${id}`);
    },
  },
  {
    name: "ac",
    group: "tickets",
    summary: "Acceptance criteria: add | verify | list",
    usage: "ac add <id> <text> | ac verify <id> <AC-n> --verdict Verified|Failed|Unknown --evidence '...' | ac list <id>",
    options: { verdict: { type: "string", short: "v" }, evidence: { type: "string", short: "e" }, id: { type: "string" } },
    run(ctx) {
      const [sub, id] = ctx.positionals;
      const store = ctx.ws().store;
      if (sub === "add") {
        const a = store.addAcceptance(need(ctx, 1, "ticket id"), ctx.positionals.slice(2).join(" "), ctx.actor, str(ctx.values.id));
        return ctx.print(a, () => `${a.ac_id} added`);
      }
      if (sub === "verify") {
        const acId = need(ctx, 2, "AC id");
        const a = store.verifyAcceptance(need(ctx, 1, "ticket id"), acId, (str(ctx.values.verdict) ?? "Verified") as Verdict, str(ctx.values.evidence) ?? null, ctx.actor);
        return ctx.print(a, () => `${a.ac_id} → ${a.verdict}`);
      }
      if (sub === "list") {
        const d = store.detail(need(ctx, 1, "ticket id"));
        return ctx.print(d.acceptance, () => d.acceptance.map((a) => `${a.verdict.padEnd(8)} ${a.ac_id} ${a.text}`).join("\n"));
      }
      void id;
      throw new FlowError("INVALID_ARGUMENT", "usage: ac add|verify|list");
    },
  },
  {
    name: "dep",
    group: "tickets",
    summary: "Dependencies: dep add <id> <depends-on> [--kind blocks|parent|discovered-from] | dep rm ...",
    usage: "dep add|rm <id> <depends-on> [--kind blocks]",
    options: { kind: { type: "string", short: "k" } },
    run(ctx) {
      const [sub] = ctx.positionals;
      const id = need(ctx, 1, "ticket id");
      const on = need(ctx, 2, "depends-on id");
      const kind = (str(ctx.values.kind) ?? "blocks") as DepKind;
      const store = ctx.ws().store;
      if (sub === "add") store.addDep(id, on, kind, ctx.actor);
      else if (sub === "rm" || sub === "remove") store.removeDep(id, on, kind, ctx.actor);
      else throw new FlowError("INVALID_ARGUMENT", "usage: dep add|rm <id> <depends-on>");
      const t = store.get(id);
      ctx.print(t, () => `${sub === "add" ? "added" : "removed"} ${id} ${kind} ${on}`);
    },
  },
  {
    name: "tree",
    aliases: ["graph"],
    group: "tickets",
    summary: "Epics with their children and blockers",
    usage: "tree [<epic>]",
    run(ctx) {
      const store = ctx.ws().store;
      const epics = ctx.positionals[0] ? [store.get(ctx.positionals[0])] : store.list({ type: "epic", includeClosed: true });
      const orphans = store.list({}).filter((t) => t.type !== "epic" && !t.parent);
      const data = epics.map((e) => ({ epic: e, children: store.list({ epic: e.id, includeClosed: true }) }));
      ctx.print({ epics: data, orphans: ctx.positionals[0] ? [] : orphans }, () => {
        const lines: string[] = [];
        for (const { epic, children } of data) {
          lines.push(`${bold(epic.id)} ${status(epic.status)} ${epic.title}`);
          children.forEach((c, i) => {
            const branch = i === children.length - 1 ? "└─" : "├─";
            lines.push(`  ${branch} ${c.id} ${status(c.status)} ${c.title}${c.blocked_by.length ? dim(` ⟵ ${c.blocked_by.join(", ")}`) : ""}`);
          });
        }
        if (!ctx.positionals[0] && orphans.length) {
          lines.push(dim("(no epic)"));
          for (const o of orphans) lines.push(`  ${o.id} ${status(o.status)} ${o.title}${o.blocked_by.length ? dim(` ⟵ ${o.blocked_by.join(", ")}`) : ""}`);
        }
        return lines.join("\n") || dim("(no tickets)");
      });
    },
  },
  {
    name: "log",
    aliases: ["events"],
    group: "tickets",
    summary: "Audit log (append-only, hash-chained)",
    usage: "log [<id>] [--since seq] [--limit n]",
    options: { since: { type: "string" }, limit: { type: "string" } },
    run(ctx) {
      const store = ctx.ws().store;
      const since = int(ctx.values.since);
      const limit = int(ctx.values.limit) ?? 50;
      const events = since !== undefined
        ? store.events({ since, ticketId: ctx.positionals[0], limit })
        : store.events({ ticketId: ctx.positionals[0], limit, order: "desc" }).reverse();
      ctx.print(events, () => events.map(eventRow).join("\n") || dim("(no events)"));
    },
  },
  {
    name: "stats",
    group: "tickets",
    summary: "Counts, throughput, cycle time, rework rate",
    usage: "stats",
    run(ctx) {
      const s = ctx.ws().store.stats();
      ctx.print(s, () => JSON.stringify(s, null, 2));
    },
  },
  {
    name: "prime",
    aliases: ["context"],
    group: "agents",
    summary: "Markdown context for an agent: bound ticket (branch/actor) + ready queue",
    usage: "prime [--ticket id] [--branch b] [--label l] [--max-chars n]",
    options: { ticket: { type: "string" }, branch: { type: "string" }, label: { type: "string" }, "max-chars": { type: "string" } },
    run(ctx) {
      const ws = ctx.ws();
      ws.store.reap();
      const res = primeContext(ws.store, {
        ticketId: str(ctx.values.ticket),
        branch: str(ctx.values.branch) ?? currentBranch(ctx.cwd),
        actor: ctx.actor,
        label: str(ctx.values.label),
        maxChars: int(ctx.values["max-chars"]),
      });
      ctx.print({ ticket: res.ticket?.id ?? null, text: res.text }, res.text);
    },
  },
  {
    name: "branch",
    group: "agents",
    summary: "Print (and record) the branch name for a ticket",
    usage: "branch <id>",
    run(ctx) {
      const ws = ctx.ws();
      const t = ws.store.get(ticketArg(ctx));
      const name = t.branch ?? branchFor(ws.config.branchPattern, t);
      if (!t.branch) ws.store.update(t.id, { branch: name }, ctx.actor);
      ctx.print({ id: t.id, branch: name }, name);
    },
  },
  {
    name: "dod",
    group: "agents",
    summary: "Run the Definition-of-Done commands from config",
    usage: "dod",
    async run(ctx) {
      const res = await checkDod(ctx.ws(), ctx.cwd);
      ctx.print(res, res.summary);
      return res.passed ? 0 : 2;
    },
  },
  {
    name: "agent",
    group: "agents",
    summary: "agent register --harness claude --skills a,b | agent list",
    usage: "agent register [--harness h] [--skills a,b] | agent list",
    options: { harness: { type: "string" }, skills: { type: "string" } },
    run(ctx) {
      const store = ctx.ws().store;
      if (ctx.positionals[0] === "register") {
        const a = store.registerAgent(ctx.actor, str(ctx.values.harness) ?? null, list(ctx.values.skills));
        return ctx.print(a, () => `registered ${a.id} (${a.skills.join(", ") || "no skills"})`);
      }
      const agents = store.agents();
      ctx.print(agents, () =>
        agents.map((a) => `${bold(a.id)} ${dim(a.last_seen)} ${a.skills.join(",")}\n${a.active.map((t) => `   ${t.id} ${status(t.status)} ${t.title}`).join("\n")}`).join("\n") ||
        dim("(no agents yet)"),
      );
    },
  },
  {
    name: "import-tasks",
    group: "sdd",
    summary: "Import SDD tasks (framework /tasks T-n table, Spec Kit tasks.md, OpenSpec change) as an epic + tickets",
    usage: "import-tasks <file|openspec-change-dir> [--format auto|framework|speckit|openspec|checklist] [--spec spec.md] [--epic-title t] [--epic id] [--no-epic] [--backlog] [--label l]... [--dry-run]",
    options: {
      format: { type: "string", short: "f" },
      spec: { type: "string" },
      "epic-title": { type: "string" },
      epic: { type: "string" },
      "no-epic": { type: "boolean" },
      backlog: { type: "boolean" },
      label: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
    },
    run(ctx) {
      const file = path.resolve(ctx.cwd, need(ctx, 0, "file"));
      const ws = ctx.ws();
      const plan = buildPlan(file, (str(ctx.values.format) ?? "auto") as ImportFormat, {
        specFile: str(ctx.values.spec) ? path.resolve(ctx.cwd, str(ctx.values.spec)!) : undefined,
      });
      const res = applyPlan(ws.store, plan, ctx.actor, {
        status: bool(ctx.values.backlog) ? "backlog" : "ready",
        epicTitle: str(ctx.values["epic-title"]),
        epicId: str(ctx.values.epic),
        noEpic: bool(ctx.values["no-epic"]),
        labels: list(ctx.values.label),
        root: ws.paths.root,
        dryRun: bool(ctx.values["dry-run"]),
      });
      ctx.print(
        bool(ctx.values["dry-run"]) ? { plan } : { epic: res.epic, created: res.created, existing: res.existing.map((t) => t.id), warnings: res.warnings },
        () => {
          if (bool(ctx.values["dry-run"])) {
            return [`${plan.format}: ${plan.tasks.length} task(s)${plan.epic ? ` under epic "${plan.epic.title}"` : ""}`, ...plan.tasks.map((t) => `  ${t.key} ${t.title}${t.deps?.length ? dim(` ⟵ ${t.deps.join(",")}`) : ""}`), ...plan.warnings.map((w) => `warning: ${w}`)].join("\n");
          }
          return [
            res.epic ? `epic ${ticketRow(res.epic)}` : "",
            `created ${res.created.length}, already present ${res.existing.length}`,
            ...res.created.map((t) => `  ${ticketRow(t)}`),
            ...res.warnings.map((w) => `warning: ${w}`),
          ]
            .filter(Boolean)
            .join("\n");
        },
      );
    },
  },
  {
    name: "import-backlog",
    group: "sdd",
    summary: "Migrate a framework Local Markdown backlog (.agent/backlog/items.md)",
    usage: "import-backlog [<file>] [--dry-run]",
    options: { "dry-run": { type: "boolean" } },
    run(ctx) {
      const file = path.resolve(ctx.cwd, ctx.positionals[0] ?? ".agent/backlog/items.md");
      const ws = ctx.ws();
      const plan = buildPlan(file, "local-markdown");
      const res = applyPlan(ws.store, plan, ctx.actor.startsWith("human:") || ctx.actor.startsWith("system:") ? ctx.actor : "system:import", {
        noEpic: true,
        root: ws.paths.root,
        dryRun: bool(ctx.values["dry-run"]),
      });
      ctx.print({ created: res.created, existing: res.existing.map((t) => t.id), warnings: res.warnings }, () =>
        [`migrated ${res.created.length} item(s), ${res.existing.length} already present`, ...res.created.map((t) => `  ${ticketRow(t)}`), ...res.warnings.map((w) => `warning: ${w}`)].join("\n"),
      );
    },
  },
  {
    name: "export",
    group: "data",
    summary: "Write tickets.jsonl (or --stdout / --out file)",
    usage: "export [--out file] [--stdout]",
    options: { out: { type: "string", short: "o" }, stdout: { type: "boolean" } },
    run(ctx) {
      const ws = ctx.ws();
      if (bool(ctx.values.stdout)) return ctx.stdout(ws.store.exportSnapshot());
      const out = str(ctx.values.out) ? path.resolve(ctx.cwd, str(ctx.values.out)!) : ws.paths.snapshot;
      if (out === ws.paths.snapshot) ws.store.writeSnapshot(out);
      else writeFileSync(out, ws.store.exportSnapshot());
      ctx.print({ file: out }, `wrote ${out}`);
    },
  },
  {
    name: "import",
    group: "data",
    summary: "Merge a tickets.jsonl snapshot (newer updated_at wins)",
    usage: "import [<file>]",
    run(ctx) {
      const ws = ctx.ws();
      const file = ctx.positionals[0] ? path.resolve(ctx.cwd, ctx.positionals[0]) : ws.paths.snapshot;
      const res = ws.store.importSnapshot(readFileSync(file, "utf8"), ctx.actor);
      ctx.print(res, () => `inserted ${res.inserted}, updated ${res.updated}, skipped ${res.skipped}`);
    },
  },
  {
    name: "reap",
    group: "data",
    summary: "Return expired leases to the ready queue",
    usage: "reap",
    run(ctx) {
      const ids = ctx.ws().store.reap();
      ctx.print({ reaped: ids }, ids.length ? `reaped ${ids.join(", ")}` : "no expired leases");
    },
  },
  {
    name: "audit",
    group: "data",
    summary: "audit verify: re-hash the event chain",
    usage: "audit verify",
    run(ctx) {
      const res = ctx.ws().store.verifyAudit();
      ctx.print(res, () => (res.ok ? `audit OK: ${res.events} events, head ${res.head.slice(0, 16)}…` : `AUDIT BROKEN at event #${res.broken_at}`));
      return res.ok ? 0 : 2;
    },
  },
  {
    name: "where",
    group: "setup",
    summary: "Show resolved root / DB / config paths",
    usage: "where",
    run(ctx) {
      const ws = ctx.ws();
      ctx.print({ ...ws.paths, worktree: worktreeTop(ctx.cwd), branch: currentBranch(ctx.cwd), actor: ctx.actor }, () =>
        Object.entries({ ...ws.paths, worktree: worktreeTop(ctx.cwd), branch: currentBranch(ctx.cwd), actor: ctx.actor })
          .map(([k, v]) => `${k.padEnd(10)} ${v}`)
          .join("\n"),
      );
    },
  },
);
