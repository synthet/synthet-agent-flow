import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { canonical } from "./canonical.js";
import { LANES, PRIORITIES, STATUSES, TICKET_TYPES, type FlowConfig, type Status } from "./config.js";
import { openDatabase } from "./db.js";
import { FlowError } from "./errors.js";
import { newTicketId } from "./ids.js";
import { RULES, canTransition, type Action } from "./states.js";
import type {
  AcceptanceCriterion,
  ActorKind,
  AgentRecord,
  Comment,
  CommentKind,
  CreateTicketInput,
  DepKind,
  DepRef,
  FlowEvent,
  ListFilter,
  ReadyFilter,
  SessionRecord,
  Ticket,
  TicketDetail,
  UpdateTicketInput,
  Verdict,
} from "./types.js";

type Row = Record<string, SQLInputValue>;

export const GENESIS_HASH = "0".repeat(64);
const ACTIVE: Status[] = ["claimed", "in_progress"];
const CLOSED: Status[] = ["done", "cancelled"];

export interface StoreOptions {
  config: FlowConfig;
  /** Where `tickets.jsonl` is written when `config.autoExport` is on. */
  snapshotPath?: string | null;
  now?: () => number;
}

export interface TransitionOptions {
  reason?: string;
  unblockCondition?: string;
  /** Bypass owner / handoff / AC gates (humans and `system:` actors only). */
  force?: boolean;
  /** Evidence that DoD passed (filled in by the caller that ran the commands). */
  dod?: { passed: boolean; summary: string };
}

export type EventListener = (event: FlowEvent) => void;

export function actorKind(actor: string): ActorKind {
  if (actor.startsWith("human:")) return "human";
  if (actor.startsWith("system:")) return "system";
  return "agent";
}

const iso = (ms: unknown): string | null => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const json = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/**
 * The tracker. All mutations run inside `BEGIN IMMEDIATE` transactions, so concurrent agents
 * (separate processes on one SQLite file) serialise on the write lock: a claim is atomic.
 */
export class FlowStore {
  readonly db: DatabaseSync;
  readonly config: FlowConfig;
  private readonly snapshotPath: string | null;
  private readonly now: () => number;
  private readonly listeners = new Set<EventListener>();
  private pending: FlowEvent[] = [];
  private depth = 0;
  private dirty = false;

  constructor(db: DatabaseSync, opts: StoreOptions) {
    this.db = db;
    this.config = opts.config;
    this.snapshotPath = opts.snapshotPath ?? null;
    this.now = opts.now ?? Date.now;
  }

  static open(file: string, opts: StoreOptions): FlowStore {
    return new FlowStore(openDatabase(file), opts);
  }

  close(): void {
    this.db.close();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ───────────────────────────── transactions & events ─────────────────────────────

  /** Run `fn` in one write transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.pending = [];
      this.dirty = false;
      throw err;
    } finally {
      this.depth = 0;
    }
    const events = this.pending;
    this.pending = [];
    const dirty = this.dirty;
    this.dirty = false;
    if (dirty && this.config.autoExport && this.snapshotPath) this.writeSnapshot(this.snapshotPath);
    for (const event of events) for (const l of this.listeners) safeCall(l, event);
    return result;
  }

  private emit(action: string, actor: string, ticketId: string | null, payload: Record<string, unknown> = {}): FlowEvent {
    const last = this.db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    const prev = last?.hash ?? GENESIS_HASH;
    const seq = (last?.seq ?? 0) + 1;
    const ts = this.now();
    const kind = actorKind(actor);
    const hash = eventHash(prev, { seq, ts, actor, actor_kind: kind, action, ticket_id: ticketId, payload });
    this.db
      .prepare(
        "INSERT INTO events (seq, ts, actor, actor_kind, action, ticket_id, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(seq, ts, actor, kind, action, ticketId, JSON.stringify(payload), prev, hash);
    const event: FlowEvent = {
      seq,
      ts: new Date(ts).toISOString(),
      actor,
      actor_kind: kind,
      action,
      ticket_id: ticketId,
      payload,
      prev_hash: prev,
      hash,
    };
    this.pending.push(event);
    this.dirty = true;
    return event;
  }

  // ───────────────────────────────── reads ─────────────────────────────────

  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new FlowError("NOT_FOUND", `ticket ${id} not found`, { nextSteps: ["agent-flow list"] });
    return row;
  }

  exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(id);
  }

  private hydrate(rows: Row[]): Ticket[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => String(r.id));
    const marks = ids.map(() => "?").join(",");
    const deps = this.db
      .prepare(
        `SELECT d.ticket_id, d.depends_on, d.kind, t.status FROM deps d JOIN tickets t ON t.id = d.depends_on
         WHERE d.ticket_id IN (${marks})`,
      )
      .all(...ids) as Array<{ ticket_id: string; depends_on: string; kind: string; status: string }>;
    const acs = this.db
      .prepare(
        `SELECT ticket_id, COUNT(*) AS total, SUM(verdict = 'Verified') AS verified FROM acceptance_criteria
         WHERE ticket_id IN (${marks}) GROUP BY ticket_id`,
      )
      .all(...ids) as Array<{ ticket_id: string; total: number; verified: number }>;
    const acMap = new Map(acs.map((a) => [a.ticket_id, a]));
    return rows.map((r) => {
      const id = String(r.id);
      const mine = deps.filter((d) => d.ticket_id === id);
      const ac = acMap.get(id);
      return {
        id,
        type: String(r.type),
        title: String(r.title),
        body: String(r.body ?? ""),
        status: r.status as Status,
        priority: String(r.priority),
        lane: String(r.lane),
        labels: json<string[]>(r.labels, []),
        scope_paths: json<string[]>(r.scope_paths, []),
        owner: (r.owner as string | null) ?? null,
        lease_until: iso(r.lease_until),
        claimed_at: iso(r.claimed_at),
        attempts: Number(r.attempts ?? 0),
        rework_count: Number(r.rework_count ?? 0),
        blocked_reason: (r.blocked_reason as string | null) ?? null,
        unblock_condition: (r.unblock_condition as string | null) ?? null,
        spec_ref: (r.spec_ref as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        github_issue: (r.github_issue as number | null) ?? null,
        pr_url: (r.pr_url as string | null) ?? null,
        external_key: (r.external_key as string | null) ?? null,
        created_by: String(r.created_by),
        created_at: iso(r.created_at) ?? "",
        updated_at: iso(r.updated_at) ?? "",
        closed_at: iso(r.closed_at),
        version: Number(r.version ?? 1),
        parent: mine.find((d) => d.kind === "parent")?.depends_on ?? null,
        blocked_by: mine
          .filter((d) => d.kind === "blocks" && !CLOSED.includes(d.status as Status))
          .map((d) => d.depends_on),
        ac_total: Number(ac?.total ?? 0),
        ac_verified: Number(ac?.verified ?? 0),
      };
    });
  }

  get(id: string): Ticket {
    return this.hydrate([this.row(id)])[0];
  }

  detail(id: string, opts: { events?: number } = {}): TicketDetail {
    const ticket = this.get(id);
    const acceptance = (
      this.db
        .prepare("SELECT ac_id, text, verdict, evidence, updated_at FROM acceptance_criteria WHERE ticket_id = ? ORDER BY rowid")
        .all(id) as Row[]
    ).map((r) => ({
      ac_id: String(r.ac_id),
      text: String(r.text),
      verdict: r.verdict as Verdict,
      evidence: (r.evidence as string | null) ?? null,
      updated_at: iso(r.updated_at) ?? "",
    }));
    const ref = (sql: string): DepRef[] =>
      (this.db.prepare(sql).all(id) as Row[]).map((r) => ({
        id: String(r.id),
        kind: r.kind as DepKind,
        title: String(r.title),
        status: r.status as Status,
      }));
    const depends_on = ref(
      "SELECT t.id, d.kind, t.title, t.status FROM deps d JOIN tickets t ON t.id = d.depends_on WHERE d.ticket_id = ? AND d.kind != 'parent'",
    );
    const dependents = ref(
      "SELECT t.id, d.kind, t.title, t.status FROM deps d JOIN tickets t ON t.id = d.ticket_id WHERE d.depends_on = ? AND d.kind != 'parent'",
    );
    const children = ref(
      "SELECT t.id, d.kind, t.title, t.status FROM deps d JOIN tickets t ON t.id = d.ticket_id WHERE d.depends_on = ? AND d.kind = 'parent'",
    );
    const comments = this.comments(id);
    const sessions = this.sessions(id);
    const events = this.events({ ticketId: id, limit: opts.events ?? 100, order: "desc" }).reverse();
    return { ...ticket, acceptance, depends_on, dependents, children, comments, sessions, events };
  }

  comments(id: string): Comment[] {
    return (this.db.prepare("SELECT * FROM comments WHERE ticket_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      id: Number(r.id),
      kind: r.kind as CommentKind,
      actor: String(r.actor),
      body: String(r.body),
      created_at: iso(r.created_at) ?? "",
    }));
  }

  sessions(id?: string): SessionRecord[] {
    const rows = (
      id
        ? this.db.prepare("SELECT * FROM sessions WHERE ticket_id = ? ORDER BY id").all(id)
        : this.db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 200").all()
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      ticket_id: (r.ticket_id as string | null) ?? null,
      session_id: String(r.session_id),
      harness: (r.harness as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
      transcript_path: (r.transcript_path as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      commit_range: (r.commit_range as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      started_at: iso(r.started_at) ?? "",
      ended_at: iso(r.ended_at),
    }));
  }

  list(filter: ListFilter = {}): Ticket[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    } else if (!filter.includeClosed) {
      where.push("status != 'cancelled'");
    }
    if (filter.owner) {
      where.push("owner = ?");
      args.push(filter.owner);
    }
    if (filter.lane) {
      where.push("lane = ?");
      args.push(filter.lane);
    }
    if (filter.type) {
      where.push("type = ?");
      args.push(filter.type);
    }
    if (filter.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(tickets.labels) WHERE value = ?)");
      args.push(filter.label);
    }
    if (filter.epic) {
      where.push("EXISTS (SELECT 1 FROM deps WHERE deps.ticket_id = tickets.id AND deps.kind = 'parent' AND deps.depends_on = ?)");
      args.push(filter.epic);
    }
    if (filter.query) {
      where.push("(title LIKE ? OR body LIKE ? OR id = ?)");
      args.push(`%${filter.query}%`, `%${filter.query}%`, filter.query);
    }
    const sql = `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE lane WHEN 'expedite' THEN 0 ELSE 1 END, priority, created_at LIMIT ?`;
    args.push(filter.limit ?? 1000);
    return this.hydrate(this.db.prepare(sql).all(...args) as Row[]);
  }

  /** The ready queue: `ready`, not an epic, every `blocks` dependency closed, no live lease. */
  ready(filter: ReadyFilter = {}): Ticket[] {
    const now = this.now();
    const where = [
      "t.status = 'ready'",
      "t.type != 'epic'",
      "(t.owner IS NULL OR t.lease_until IS NULL OR t.lease_until < ?)",
      `NOT EXISTS (SELECT 1 FROM deps d JOIN tickets b ON b.id = d.depends_on
        WHERE d.ticket_id = t.id AND d.kind = 'blocks' AND b.status NOT IN ('done','cancelled'))`,
    ];
    const args: SQLInputValue[] = [now];
    if (filter.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)");
      args.push(filter.label);
    }
    if (filter.lane) {
      where.push("t.lane = ?");
      args.push(filter.lane);
    }
    if (filter.epic) {
      where.push("EXISTS (SELECT 1 FROM deps p WHERE p.ticket_id = t.id AND p.kind = 'parent' AND p.depends_on = ?)");
      args.push(filter.epic);
    }
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tickets t WHERE ${where.join(" AND ")}
         ORDER BY CASE t.lane WHEN 'expedite' THEN 0 ELSE 1 END, t.priority, t.created_at LIMIT ?`,
      )
      .all(...args, filter.limit ?? 100) as Row[];
    let tickets = this.hydrate(rows);
    if (filter.skills && filter.skills.length > 0) {
      // Skill routing: a ticket labelled `skill:<x>` only goes to agents that advertise <x>.
      const skills = new Set(filter.skills);
      tickets = tickets.filter((t) => {
        const needed = t.labels.filter((l) => l.startsWith("skill:")).map((l) => l.slice(6));
        return needed.every((s) => skills.has(s));
      });
    }
    return tickets;
  }

  events(opts: { since?: number; ticketId?: string; limit?: number; order?: "asc" | "desc" } = {}): FlowEvent[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (opts.since !== undefined) {
      where.push("seq > ?");
      args.push(opts.since);
    }
    if (opts.ticketId) {
      where.push("ticket_id = ?");
      args.push(opts.ticketId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${opts.order === "desc" ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(...args, opts.limit ?? 200) as Row[];
    return rows.map(eventFromRow);
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  // ───────────────────────────────── writes ─────────────────────────────────

  create(input: CreateTicketInput, actor: string): Ticket {
    const title = input.title?.trim();
    if (!title) throw new FlowError("INVALID_ARGUMENT", "title is required");
    checkEnum("type", input.type, TICKET_TYPES);
    checkEnum("priority", input.priority, PRIORITIES);
    checkEnum("lane", input.lane, LANES);
    return this.tx(() => {
      if (input.external_key) {
        const existing = this.db.prepare("SELECT id FROM tickets WHERE external_key = ?").get(input.external_key) as
          | { id: string }
          | undefined;
        if (existing) return this.get(existing.id);
      }
      let id = input.id ?? newTicketId(this.config.prefix);
      if (input.id && this.exists(input.id)) throw new FlowError("INVALID_ARGUMENT", `ticket ${input.id} already exists`);
      while (this.exists(id)) id = newTicketId(this.config.prefix);
      const now = this.now();
      const type = input.type ?? "feature";
      const lane = input.lane ?? (type === "bug" ? "bug" : type === "chore" ? "maintenance" : "feature");
      this.db
        .prepare(
          `INSERT INTO tickets (id, type, title, body, status, priority, lane, labels, scope_paths, spec_ref, external_key,
             created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          type,
          title,
          input.body ?? "",
          input.status ?? "backlog",
          input.priority ?? "p2",
          lane,
          JSON.stringify(uniq(input.labels ?? [])),
          JSON.stringify(uniq(input.scope_paths ?? [])),
          input.spec_ref ?? null,
          input.external_key ?? null,
          actor,
          now,
          now,
        );
      (input.acceptance ?? []).forEach((ac, i) => {
        const text = typeof ac === "string" ? ac : ac.text;
        const acId = (typeof ac === "string" ? undefined : ac.ac_id) ?? `AC-${i + 1}`;
        this.db
          .prepare("INSERT INTO acceptance_criteria (ticket_id, ac_id, text, updated_at) VALUES (?,?,?,?)")
          .run(id, acId, text, now);
      });
      this.emit("ticket.created", actor, id, { title, type, status: input.status ?? "backlog" });
      if (input.parent) this.addDep(id, input.parent, "parent", actor);
      for (const dep of input.depends_on ?? []) this.addDep(id, dep, "blocks", actor);
      if (input.discovered_from) {
        this.addDep(id, input.discovered_from, "discovered-from", actor);
        this.insertComment(input.discovered_from, "system", actor, `Discovered follow-up work: ${id} — ${title}`);
      }
      return this.get(id);
    });
  }

  update(id: string, patch: UpdateTicketInput, actor: string, expectedVersion?: number): Ticket {
    checkEnum("type", patch.type, TICKET_TYPES);
    checkEnum("priority", patch.priority, PRIORITIES);
    checkEnum("lane", patch.lane, LANES);
    return this.tx(() => {
      const row = this.row(id);
      if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) {
        throw new FlowError("VERSION_CONFLICT", `ticket ${id} is at version ${row.version}, expected ${expectedVersion}`, {
          retryable: true,
          nextSteps: [`agent-flow show ${id}`],
        });
      }
      const sets: string[] = [];
      const args: SQLInputValue[] = [];
      const changed: Record<string, unknown> = {};
      const set = (col: string, value: SQLInputValue, display: unknown = value) => {
        sets.push(`${col} = ?`);
        args.push(value);
        changed[col] = display;
      };
      for (const col of ["title", "body", "type", "priority", "lane", "spec_ref", "branch", "github_issue", "pr_url"] as const) {
        const v = patch[col];
        if (v !== undefined) set(col, v as SQLInputValue, col === "body" ? `${String(v).length} chars` : v);
      }
      if (patch.scope_paths) set("scope_paths", JSON.stringify(uniq(patch.scope_paths)), patch.scope_paths);
      if (patch.labels || patch.add_labels || patch.remove_labels) {
        let labels = patch.labels ?? json<string[]>(row.labels, []);
        labels = uniq([...labels, ...(patch.add_labels ?? [])]).filter((l) => !(patch.remove_labels ?? []).includes(l));
        set("labels", JSON.stringify(labels), labels);
      }
      if (sets.length === 0) return this.get(id);
      sets.push("updated_at = ?", "version = version + 1");
      args.push(this.now());
      this.db.prepare(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
      this.emit("ticket.updated", actor, id, { changed });
      return this.get(id);
    });
  }

  addAcceptance(id: string, text: string, actor: string, acId?: string): AcceptanceCriterion {
    return this.tx(() => {
      this.row(id);
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM acceptance_criteria WHERE ticket_id = ?").get(id) as { n: number }).n;
      const ac = acId ?? `AC-${count + 1}`;
      this.db
        .prepare("INSERT OR REPLACE INTO acceptance_criteria (ticket_id, ac_id, text, updated_at) VALUES (?,?,?,?)")
        .run(id, ac, text, this.now());
      this.touch(id);
      this.emit("ac.added", actor, id, { ac_id: ac, text });
      return this.detail(id).acceptance.find((a) => a.ac_id === ac)!;
    });
  }

  /** Record a verdict. `Verified` requires evidence (framework validate-implementation rule). */
  verifyAcceptance(id: string, acId: string, verdict: Verdict, evidence: string | null, actor: string): AcceptanceCriterion {
    if (!["Verified", "Failed", "Unknown"].includes(verdict)) throw new FlowError("INVALID_ARGUMENT", `bad verdict ${verdict}`);
    if (verdict === "Verified" && !evidence?.trim()) {
      throw new FlowError("INVALID_ARGUMENT", "Verified needs evidence (test output, command, file:line)");
    }
    return this.tx(() => {
      const res = this.db
        .prepare("UPDATE acceptance_criteria SET verdict = ?, evidence = ?, updated_at = ? WHERE ticket_id = ? AND ac_id = ?")
        .run(verdict, evidence, this.now(), id, acId);
      if (res.changes !== 1) throw new FlowError("NOT_FOUND", `${acId} not found on ${id}`);
      this.touch(id);
      this.emit("ac.verified", actor, id, { ac_id: acId, verdict });
      return this.detail(id).acceptance.find((a) => a.ac_id === acId)!;
    });
  }

  addDep(id: string, dependsOn: string, kind: DepKind, actor: string): void {
    if (id === dependsOn) throw new FlowError("CYCLE", "a ticket cannot depend on itself");
    if (!["blocks", "parent", "discovered-from"].includes(kind)) throw new FlowError("INVALID_ARGUMENT", `bad dep kind ${kind}`);
    this.tx(() => {
      this.row(id);
      this.row(dependsOn);
      if (kind !== "discovered-from" && this.reaches(dependsOn, id, kind)) {
        throw new FlowError("CYCLE", `${id} → ${dependsOn} would create a ${kind} cycle`);
      }
      if (kind === "parent") this.db.prepare("DELETE FROM deps WHERE ticket_id = ? AND kind = 'parent'").run(id);
      const res = this.db
        .prepare("INSERT OR IGNORE INTO deps (ticket_id, depends_on, kind, created_at) VALUES (?,?,?,?)")
        .run(id, dependsOn, kind, this.now());
      if (res.changes === 1) {
        this.touch(id);
        this.emit("dep.added", actor, id, { depends_on: dependsOn, kind });
      }
    });
  }

  removeDep(id: string, dependsOn: string, kind: DepKind, actor: string): void {
    this.tx(() => {
      const res = this.db.prepare("DELETE FROM deps WHERE ticket_id = ? AND depends_on = ? AND kind = ?").run(id, dependsOn, kind);
      if (res.changes === 1) {
        this.touch(id);
        this.emit("dep.removed", actor, id, { depends_on: dependsOn, kind });
      }
    });
  }

  /** Does `from` reach `to` following edges of `kind`? */
  private reaches(from: string, to: string, kind: DepKind): boolean {
    const seen = new Set<string>();
    const stack = [from];
    const next = this.db.prepare("SELECT depends_on FROM deps WHERE ticket_id = ? AND kind = ?");
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of next.all(cur, kind) as Array<{ depends_on: string }>) stack.push(r.depends_on);
    }
    return false;
  }

  comment(id: string, kind: CommentKind, body: string, actor: string): Comment {
    if (!body.trim()) throw new FlowError("INVALID_ARGUMENT", "comment body is empty");
    if (!["note", "handoff", "review", "system"].includes(kind)) throw new FlowError("INVALID_ARGUMENT", `bad comment kind ${kind}`);
    return this.tx(() => {
      this.row(id);
      const c = this.insertComment(id, kind, actor, body);
      this.touch(id);
      this.emit(kind === "handoff" ? "handoff.written" : "comment.added", actor, id, { kind, comment_id: c.id, length: body.length });
      return c;
    });
  }

  private insertComment(id: string, kind: CommentKind, actor: string, body: string): Comment {
    const now = this.now();
    const res = this.db
      .prepare("INSERT INTO comments (ticket_id, kind, actor, body, created_at) VALUES (?,?,?,?,?)")
      .run(id, kind, actor, body, now);
    return { id: Number(res.lastInsertRowid), kind, actor, body, created_at: new Date(now).toISOString() };
  }

  private touch(id: string): void {
    this.db.prepare("UPDATE tickets SET updated_at = ?, version = version + 1 WHERE id = ?").run(this.now(), id);
  }

  // ─────────────────────────────── lifecycle ───────────────────────────────

  private activeCount(owner: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE owner = ? AND status IN ('claimed','in_progress')`)
        .get(owner) as { n: number }
    ).n;
  }

  private columnCount(status: Status): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = ?").get(status) as { n: number }).n;
  }

  /**
   * Atomically claim `id`, or (when `id` is null) the head of the ready queue.
   * Fails with CLAIM_CONFLICT if another agent won, WIP_LIMIT if the agent is at its limit.
   */
  claim(id: string | null, actor: string, opts: { filter?: ReadyFilter; leaseMinutes?: number } = {}): Ticket {
    return this.tx(() => {
      this.reapInTx();
      const perAgent = this.config.wip.perAgent;
      if (actorKind(actor) === "agent" && this.activeCount(actor) >= perAgent) {
        const mine = this.list({ owner: actor, status: ACTIVE }).map((t) => t.id);
        throw new FlowError("WIP_LIMIT", `${actor} already holds ${mine.length} active ticket(s) (limit ${perAgent})`, {
          details: { active: mine },
          nextSteps: mine.map((t) => `agent-flow submit ${t}  # or: agent-flow release ${t}`),
        });
      }
      const claimedLimit = this.config.wip.columns.in_progress;
      if (claimedLimit !== undefined && this.columnCount("claimed") + this.columnCount("in_progress") >= claimedLimit) {
        throw new FlowError("WIP_LIMIT", `in-progress column is at its WIP limit (${claimedLimit})`, {
          retryable: true,
          nextSteps: ["review or finish in-flight work first"],
        });
      }
      let target = id;
      if (!target) {
        const head = this.ready({ ...opts.filter, limit: 1 })[0];
        if (!head) throw new FlowError("NOT_FOUND", "ready queue is empty", { nextSteps: ["agent-flow list --status backlog", "agent-flow promote <id>"] });
        target = head.id;
      } else {
        const t = this.get(target);
        if (t.status !== "ready") {
          throw new FlowError(t.status === "claimed" || t.status === "in_progress" ? "CLAIM_CONFLICT" : "INVALID_TRANSITION",
            `${target} is ${t.status}${t.owner ? ` (owner ${t.owner})` : ""}, not ready`, { details: { owner: t.owner } });
        }
        if (t.blocked_by.length) {
          throw new FlowError("BLOCKED_BY_DEPENDENCY", `${target} is blocked by ${t.blocked_by.join(", ")}`, {
            details: { blocked_by: t.blocked_by },
          });
        }
        if (t.type === "epic") throw new FlowError("INVALID_ARGUMENT", "epics are not claimable; claim a child ticket");
      }
      const now = this.now();
      const lease = now + (opts.leaseMinutes ?? this.config.leaseMinutes) * 60_000;
      // Compare-and-set: only one writer can flip ready → claimed.
      const res = this.db
        .prepare(
          `UPDATE tickets SET status = 'claimed', owner = ?, lease_until = ?, claimed_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND status = 'ready' AND (owner IS NULL OR lease_until IS NULL OR lease_until < ?)`,
        )
        .run(actor, lease, now, now, target, now);
      if (res.changes !== 1) throw new FlowError("CLAIM_CONFLICT", `${target} was claimed by someone else`, { retryable: true });
      this.seenAgent(actor);
      this.emit("ticket.claimed", actor, target, { lease_until: new Date(lease).toISOString() });
      this.recomputeParent(target, actor);
      return this.get(target);
    });
  }

  heartbeat(id: string, actor: string, leaseMinutes?: number): Ticket {
    return this.tx(() => {
      const t = this.get(id);
      if (!ACTIVE.includes(t.status)) throw new FlowError("INVALID_TRANSITION", `${id} is ${t.status}; nothing to heartbeat`);
      if (t.owner !== actor) throw new FlowError("NOT_OWNER", `${id} is owned by ${t.owner}`);
      const lease = this.now() + (leaseMinutes ?? this.config.leaseMinutes) * 60_000;
      this.db.prepare("UPDATE tickets SET lease_until = ? WHERE id = ?").run(lease, id);
      this.seenAgent(actor);
      // Heartbeats are not audit-worthy individually; no event (keeps the log readable).
      return this.get(id);
    });
  }

  /** Apply a lifecycle action. See `states.ts` for the transition table. */
  transition(id: string, action: Action, actor: string, opts: TransitionOptions = {}): Ticket {
    if (action === "claim") return this.claim(id, actor);
    const rule = RULES[action];
    if (!rule) throw new FlowError("INVALID_ARGUMENT", `unknown action ${action}`);
    return this.tx(() => {
      const t = this.get(id);
      const privileged = actorKind(actor) !== "agent";
      const force = !!opts.force && privileged;
      if (opts.force && !privileged) throw new FlowError("UNAUTHORIZED", "only human:/system: actors may --force");
      if (!canTransition(action, t.status)) {
        throw new FlowError("INVALID_TRANSITION", `cannot ${action} ${id}: it is ${t.status}`, {
          details: { from: t.status, allowed_from: rule.from },
        });
      }
      if (rule.ownerOnly && t.owner && t.owner !== actor && !privileged) {
        throw new FlowError("NOT_OWNER", `${id} is owned by ${t.owner}; ${actor} cannot ${action} it`);
      }
      if (rule.needsReason && !opts.reason?.trim()) throw new FlowError("INVALID_ARGUMENT", `${action} requires a reason`);
      if (t.type === "epic" && ["submit", "close", "start", "release"].includes(action)) {
        throw new FlowError("INVALID_ARGUMENT", `epics move automatically from their children; cannot ${action}`);
      }
      const now = this.now();
      const sets: Record<string, SQLInputValue> = { updated_at: now };
      let to: Status = rule.to === "dynamic" ? (t.owner ? "in_progress" : "ready") : rule.to;
      let event = `ticket.${pastTense(action)}`;
      const payload: Record<string, unknown> = { from: t.status };
      if (opts.reason) payload.reason = opts.reason;

      switch (action) {
        case "start":
          sets.lease_until = now + this.config.leaseMinutes * 60_000;
          break;
        case "release":
          Object.assign(sets, { owner: null, lease_until: null, claimed_at: null });
          if (opts.reason) sets.attempts = t.attempts + 1;
          break;
        case "block":
          Object.assign(sets, { blocked_reason: opts.reason ?? null, unblock_condition: opts.unblockCondition ?? null, lease_until: null });
          if (opts.unblockCondition) payload.unblock_condition = opts.unblockCondition;
          break;
        case "unblock":
          Object.assign(sets, { blocked_reason: null, unblock_condition: null });
          if (t.owner) sets.lease_until = now + this.config.leaseMinutes * 60_000;
          break;
        case "submit":
        case "close": {
          if (action === "close" && this.config.requireReview && !force) {
            throw new FlowError("GATE_FAILED", "this project requires review: use `submit`, then a reviewer approves", {
              nextSteps: [`agent-flow submit ${id}`],
            });
          }
          if (!force) this.checkSubmitGates(t, opts);
          if (opts.dod) payload.dod = opts.dod;
          sets.lease_until = null;
          if (action === "close") sets.closed_at = now;
          break;
        }
        case "approve": {
          if (!this.config.allowSelfApprove && t.owner === actor && !force) {
            throw new FlowError("GATE_FAILED", "self-approval is disabled; another agent or a human must approve", {
              nextSteps: ["ask a reviewer (flow-reviewer subagent, swarm review, or a human on the dashboard)"],
            });
          }
          const unverified = this.detail(id).acceptance.filter((a) => a.verdict !== "Verified");
          if (unverified.length && !force) {
            throw new FlowError("GATE_FAILED", `acceptance criteria not verified: ${unverified.map((a) => a.ac_id).join(", ")}`, {
              details: { unverified: unverified.map((a) => a.ac_id) },
              nextSteps: unverified.map((a) => `agent-flow ac verify ${id} ${a.ac_id} --verdict Verified --evidence "..."`),
            });
          }
          Object.assign(sets, { closed_at: now, lease_until: null });
          break;
        }
        case "reject": {
          const rework = t.rework_count + 1;
          sets.rework_count = rework;
          sets.lease_until = now + this.config.leaseMinutes * 60_000;
          if (rework >= this.config.maxAttempts) {
            to = "blocked";
            event = "ticket.escalated";
            const labels = uniq([...t.labels, "needs-human"]);
            Object.assign(sets, {
              labels: JSON.stringify(labels),
              blocked_reason: `rejected ${rework} times: ${opts.reason}`,
              unblock_condition: "a human reviews the approach and unblocks",
              lease_until: null,
            });
            payload.rework_count = rework;
          }
          this.insertComment(id, "review", actor, `Rejected: ${opts.reason}`);
          break;
        }
        case "reopen":
          Object.assign(sets, { owner: null, lease_until: null, claimed_at: null, closed_at: null });
          this.insertComment(id, "system", actor, `Reopened: ${opts.reason}`);
          break;
        case "cancel":
          Object.assign(sets, { owner: null, lease_until: null, closed_at: now });
          break;
        case "promote":
        case "demote":
          break;
      }
      sets.status = to;
      const cols = Object.keys(sets);
      this.db
        .prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(", ")}, version = version + 1 WHERE id = ?`)
        .run(...cols.map((c) => sets[c]), id);
      payload.to = to;
      this.emit(event, actor, id, payload);
      this.recomputeParent(id, actor);
      return this.get(id);
    });
  }

  private checkSubmitGates(t: Ticket, opts: TransitionOptions): void {
    if (opts.dod && !opts.dod.passed) {
      throw new FlowError("GATE_FAILED", `Definition of Done failed:\n${opts.dod.summary}`, {
        nextSteps: ["fix the failures, then submit again"],
      });
    }
    const failed = this.detail(t.id).acceptance.filter((a) => a.verdict === "Failed");
    if (failed.length) {
      throw new FlowError("GATE_FAILED", `acceptance criteria marked Failed: ${failed.map((a) => a.ac_id).join(", ")}`);
    }
    if (this.config.requireHandoff) {
      const since = t.claimed_at ? Date.parse(t.claimed_at) : 0;
      const handoff = this.db
        .prepare("SELECT 1 FROM comments WHERE ticket_id = ? AND kind = 'handoff' AND created_at >= ? LIMIT 1")
        .get(t.id, since);
      if (!handoff) {
        throw new FlowError("GATE_FAILED", "write a handoff note first (what changed, decisions, what's left, gotchas)", {
          nextSteps: [`agent-flow note ${t.id} --handoff "..."`],
        });
      }
    }
  }

  /** Epics follow their children: all closed → done; any active → in_progress; else ready. */
  private recomputeParent(childId: string, actor: string): void {
    const parent = this.db.prepare("SELECT depends_on FROM deps WHERE ticket_id = ? AND kind = 'parent'").get(childId) as
      | { depends_on: string }
      | undefined;
    if (!parent) return;
    const epic = this.get(parent.depends_on);
    if (epic.type !== "epic" || epic.status === "cancelled") return;
    const kids = this.db
      .prepare("SELECT t.status FROM deps d JOIN tickets t ON t.id = d.ticket_id WHERE d.depends_on = ? AND d.kind = 'parent'")
      .all(epic.id) as Array<{ status: Status }>;
    if (kids.length === 0) return;
    let next: Status;
    if (kids.every((k) => CLOSED.includes(k.status))) next = "done";
    else if (kids.some((k) => !["backlog", "ready"].includes(k.status))) next = "in_progress";
    else next = kids.some((k) => k.status === "ready") ? "ready" : "backlog";
    if (next === epic.status) return;
    this.db
      .prepare("UPDATE tickets SET status = ?, closed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(next, next === "done" ? this.now() : null, this.now(), epic.id);
    this.emit("epic.rollup", "system:flow", epic.id, { from: epic.status, to: next, child: childId, by: actor });
  }

  /** Return expired leases to the ready queue. */
  reap(): string[] {
    return this.tx(() => this.reapInTx());
  }

  private reapInTx(): string[] {
    const now = this.now();
    const rows = this.db
      .prepare("SELECT id, owner, status FROM tickets WHERE status IN ('claimed','in_progress') AND lease_until IS NOT NULL AND lease_until < ?")
      .all(now) as Array<{ id: string; owner: string; status: string }>;
    for (const r of rows) {
      this.db
        .prepare(
          `UPDATE tickets SET status = 'ready', owner = NULL, lease_until = NULL, claimed_at = NULL, attempts = attempts + 1,
           updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(now, r.id);
      this.emit("lease.expired", "system:reaper", r.id, { owner: r.owner, from: r.status });
    }
    return rows.map((r) => r.id);
  }

  /** Record (or close) a harness session linked to a ticket. Stores a pointer, never the transcript. */
  recordSession(input: {
    session_id: string;
    ticket_id?: string | null;
    harness?: string | null;
    actor?: string | null;
    transcript_path?: string | null;
    branch?: string | null;
    commit_range?: string | null;
    reason?: string | null;
    end?: boolean;
  }): SessionRecord {
    return this.tx(() => {
      const now = this.now();
      const existing = this.db
        .prepare("SELECT id FROM sessions WHERE session_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
        .get(input.session_id) as { id: number } | undefined;
      let rowId: number;
      if (existing) {
        this.db
          .prepare(
            `UPDATE sessions SET ticket_id = COALESCE(?, ticket_id), transcript_path = COALESCE(?, transcript_path),
             branch = COALESCE(?, branch), commit_range = COALESCE(?, commit_range), reason = COALESCE(?, reason),
             ended_at = ? WHERE id = ?`,
          )
          .run(
            input.ticket_id ?? null,
            input.transcript_path ?? null,
            input.branch ?? null,
            input.commit_range ?? null,
            input.reason ?? null,
            input.end ? now : null,
            existing.id,
          );
        rowId = existing.id;
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO sessions (ticket_id, session_id, harness, actor, transcript_path, branch, commit_range, reason, started_at, ended_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.ticket_id && this.exists(input.ticket_id) ? input.ticket_id : null,
            input.session_id,
            input.harness ?? null,
            input.actor ?? null,
            input.transcript_path ?? null,
            input.branch ?? null,
            input.commit_range ?? null,
            input.reason ?? null,
            now,
            input.end ? now : null,
          );
        rowId = Number(res.lastInsertRowid);
      }
      if (input.ticket_id && this.exists(input.ticket_id)) {
        this.emit(input.end ? "session.ended" : "session.linked", input.actor ?? "system:hook", input.ticket_id, {
          session_id: input.session_id,
          reason: input.reason ?? undefined,
        });
      }
      return this.sessions().find((s) => s.id === rowId)!;
    });
  }

  seenAgent(actor: string, harness?: string | null, skills?: string[]): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agents (id, harness, skills, last_seen) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
           harness = COALESCE(excluded.harness, agents.harness),
           skills = CASE WHEN excluded.skills = '[]' THEN agents.skills ELSE excluded.skills END`,
      )
      .run(actor, harness ?? (actor.includes(":") ? actor.split(":")[0] : null), JSON.stringify(skills ?? []), now);
  }

  registerAgent(actor: string, harness: string | null, skills: string[]): AgentRecord {
    this.tx(() => {
      this.seenAgent(actor, harness, skills);
      this.emit("agent.registered", actor, null, { harness, skills });
    });
    return this.agents().find((a) => a.id === actor)!;
  }

  agents(): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all() as Row[];
    const active = this.list({ status: ACTIVE });
    return rows.map((r) => ({
      id: String(r.id),
      harness: (r.harness as string | null) ?? null,
      skills: json<string[]>(r.skills, []),
      last_seen: iso(r.last_seen) ?? "",
      active: active
        .filter((t) => t.owner === r.id)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, lease_until: t.lease_until })),
    }));
  }

  // ─────────────────────────────── locks & kv ───────────────────────────────

  /** Named advisory lock with TTL (used to serialise `git worktree add`). */
  acquireLock(name: string, owner: string, ttlMs = 60_000): boolean {
    return this.tx(() => {
      const now = this.now();
      this.db.prepare("DELETE FROM locks WHERE expires_at < ?").run(now);
      const res = this.db.prepare("INSERT OR IGNORE INTO locks (name, owner, expires_at) VALUES (?,?,?)").run(name, owner, now + ttlMs);
      return res.changes === 1;
    });
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
  }

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ─────────────────────────────── outbox ───────────────────────────────

  enqueue(target: string, payload: Record<string, unknown>): number {
    const now = this.now();
    const res = this.db
      .prepare("INSERT INTO outbox (target, payload, next_try, created_at) VALUES (?,?,?,?)")
      .run(target, JSON.stringify(payload), now, now);
    return Number(res.lastInsertRowid);
  }

  dueOutbox(target?: string, limit = 50): Array<{ id: number; target: string; payload: Record<string, unknown>; attempts: number }> {
    const rows = (
      target
        ? this.db.prepare("SELECT * FROM outbox WHERE done_at IS NULL AND next_try <= ? AND target = ? ORDER BY id LIMIT ?").all(this.now(), target, limit)
        : this.db.prepare("SELECT * FROM outbox WHERE done_at IS NULL AND next_try <= ? ORDER BY id LIMIT ?").all(this.now(), limit)
    ) as Row[];
    return rows.map((r) => ({ id: Number(r.id), target: String(r.target), payload: json(r.payload, {}), attempts: Number(r.attempts) }));
  }

  outboxResult(id: number, ok: boolean, error?: string): void {
    if (ok) {
      this.db.prepare("UPDATE outbox SET done_at = ?, last_error = NULL WHERE id = ?").run(this.now(), id);
    } else {
      const row = this.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as { attempts: number } | undefined;
      const attempts = (row?.attempts ?? 0) + 1;
      // Exponential backoff capped at one hour; give up after 10 attempts.
      const delay = Math.min(60 * 60_000, 2 ** attempts * 5_000);
      this.db
        .prepare("UPDATE outbox SET attempts = ?, next_try = ?, last_error = ?, done_at = ? WHERE id = ?")
        .run(attempts, this.now() + delay, error ?? "failed", attempts >= 10 ? this.now() : null, id);
    }
  }

  outboxStats(): { pending: number; failed: number } {
    const p = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE done_at IS NULL").get() as { n: number };
    const f = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE done_at IS NOT NULL AND last_error IS NOT NULL").get() as { n: number };
    return { pending: p.n, failed: f.n };
  }

  // ─────────────────────────────── audit ───────────────────────────────

  /** Re-hash the whole chain. Returns the first broken seq, if any. */
  verifyAudit(): { ok: boolean; events: number; broken_at?: number; head: string } {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY seq").all() as Row[];
    let prev = GENESIS_HASH;
    for (const r of rows) {
      const e = eventFromRow(r);
      const expect = eventHash(prev, {
        seq: e.seq,
        ts: Number(r.ts),
        actor: e.actor,
        actor_kind: e.actor_kind,
        action: e.action,
        ticket_id: e.ticket_id,
        payload: e.payload,
      });
      if (e.prev_hash !== prev || e.hash !== expect) return { ok: false, events: rows.length, broken_at: e.seq, head: prev };
      prev = e.hash;
    }
    return { ok: true, events: rows.length, head: prev };
  }

  // ─────────────────────────────── stats ───────────────────────────────

  stats(): Record<string, unknown> {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status").all() as Array<{ status: Status; n: number }>) {
      counts[r.status] = r.n;
    }
    const week = this.now() - 7 * 86_400_000;
    const done = this.db
      .prepare("SELECT claimed_at, closed_at, rework_count FROM tickets WHERE status = 'done' AND closed_at >= ?")
      .all(week) as Array<{ claimed_at: number | null; closed_at: number; rework_count: number }>;
    const cycle = done.filter((d) => d.claimed_at).map((d) => d.closed_at - (d.claimed_at as number));
    const median = cycle.length ? cycle.sort((a, b) => a - b)[Math.floor(cycle.length / 2)] : null;
    return {
      counts,
      ready: this.ready({ limit: 1000 }).length,
      done_last_7d: done.length,
      median_cycle_minutes: median === null ? null : Math.round(median / 60_000),
      rework_rate: done.length ? done.filter((d) => d.rework_count > 0).length / done.length : 0,
      needs_human: this.list({ label: "needs-human" }).length,
      wip_limits: this.config.wip,
      outbox: this.outboxStats(),
      last_seq: this.lastSeq(),
    };
  }

  // ─────────────────────────── snapshot (JSONL) ───────────────────────────

  /** Deterministic JSONL: one ticket per line, sorted by id, canonical key order. */
  exportSnapshot(): string {
    const ids = (this.db.prepare("SELECT id FROM tickets ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    const lines = ids.map((id) => {
      const d = this.detail(id, { events: 0 });
      const deps = (this.db.prepare("SELECT depends_on, kind FROM deps WHERE ticket_id = ? ORDER BY depends_on, kind").all(id) as Array<{
        depends_on: string;
        kind: string;
      }>).map((r) => ({ id: r.depends_on, kind: r.kind }));
      const { events: _e, sessions: _s, depends_on: _d, dependents: _x, children: _c, blocked_by: _b, ac_total: _t, ac_verified: _v, parent: _p, ...rest } = d;
      return canonical({
        ...rest,
        deps,
        acceptance: d.acceptance.map(({ updated_at: _u, ...a }) => a),
        comments: d.comments.map(({ id: _i, ...c }) => c),
      });
    });
    return lines.length ? `${lines.join("\n")}\n` : "";
  }

  writeSnapshot(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, this.exportSnapshot());
    renameSync(tmp, file);
  }

  /**
   * Merge a snapshot into the DB (fresh clone, or teammate's export). New tickets are inserted; existing
   * tickets are overwritten only when the snapshot copy is newer (`updated_at`). Returns counts.
   */
  importSnapshot(text: string, actor: string): { inserted: number; updated: number; skipped: number } {
    const records = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    return this.tx(() => {
      const pendingDeps: Array<[string, string, string]> = [];
      for (const r of records) {
        const id = String(r.id);
        const updatedAt = Date.parse(String(r.updated_at));
        const current = this.db.prepare("SELECT updated_at FROM tickets WHERE id = ?").get(id) as { updated_at: number } | undefined;
        if (current && current.updated_at >= updatedAt) {
          skipped++;
          continue;
        }
        const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : null);
        const values: Record<string, SQLInputValue> = {
          id,
          type: String(r.type ?? "feature"),
          title: String(r.title),
          body: String(r.body ?? ""),
          status: String(r.status ?? "backlog"),
          priority: String(r.priority ?? "p2"),
          lane: String(r.lane ?? "feature"),
          labels: JSON.stringify(r.labels ?? []),
          scope_paths: JSON.stringify(r.scope_paths ?? []),
          owner: (r.owner as string | null) ?? null,
          lease_until: ms(r.lease_until),
          claimed_at: ms(r.claimed_at),
          attempts: Number(r.attempts ?? 0),
          rework_count: Number(r.rework_count ?? 0),
          blocked_reason: (r.blocked_reason as string | null) ?? null,
          unblock_condition: (r.unblock_condition as string | null) ?? null,
          spec_ref: (r.spec_ref as string | null) ?? null,
          branch: (r.branch as string | null) ?? null,
          github_issue: (r.github_issue as number | null) ?? null,
          pr_url: (r.pr_url as string | null) ?? null,
          external_key: (r.external_key as string | null) ?? null,
          created_by: String(r.created_by ?? actor),
          created_at: ms(r.created_at) ?? this.now(),
          updated_at: updatedAt || this.now(),
          closed_at: ms(r.closed_at),
          version: Number(r.version ?? 1),
        };
        const cols = Object.keys(values);
        this.db
          .prepare(`INSERT OR REPLACE INTO tickets (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
          .run(...cols.map((c) => values[c]));
        this.db.prepare("DELETE FROM acceptance_criteria WHERE ticket_id = ?").run(id);
        for (const a of (r.acceptance as Array<Record<string, unknown>>) ?? []) {
          this.db
            .prepare("INSERT INTO acceptance_criteria (ticket_id, ac_id, text, verdict, evidence, updated_at) VALUES (?,?,?,?,?,?)")
            .run(id, String(a.ac_id), String(a.text), String(a.verdict ?? "Unknown"), (a.evidence as string | null) ?? null, this.now());
        }
        this.db.prepare("DELETE FROM comments WHERE ticket_id = ?").run(id);
        for (const c of (r.comments as Array<Record<string, unknown>>) ?? []) {
          this.db
            .prepare("INSERT INTO comments (ticket_id, kind, actor, body, created_at) VALUES (?,?,?,?,?)")
            .run(id, String(c.kind), String(c.actor), String(c.body), Date.parse(String(c.created_at)) || this.now());
        }
        this.db.prepare("DELETE FROM deps WHERE ticket_id = ?").run(id);
        for (const d of (r.deps as Array<{ id: string; kind: string }>) ?? []) pendingDeps.push([id, d.id, d.kind]);
        if (current) updated++;
        else inserted++;
      }
      for (const [id, on, kind] of pendingDeps) {
        if (this.exists(on)) {
          this.db.prepare("INSERT OR IGNORE INTO deps (ticket_id, depends_on, kind, created_at) VALUES (?,?,?,?)").run(id, on, kind, this.now());
        }
      }
      if (inserted || updated) this.emit("snapshot.imported", actor, null, { inserted, updated, skipped });
      return { inserted, updated, skipped };
    });
  }

  /** Board grouped by status (cancelled omitted). */
  board(filter: ListFilter = {}): { columns: Array<{ status: Status; wip_limit: number | null; tickets: Ticket[] }> } {
    const tickets = this.list({ ...filter, includeClosed: false });
    const cols = STATUSES.filter((s) => s !== "cancelled");
    return {
      columns: cols.map((status) => ({
        status,
        wip_limit: this.config.wip.columns[status] ?? null,
        tickets: tickets.filter((t) => t.status === status),
      })),
    };
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

function eventHash(prev: string, body: Record<string, unknown>): string {
  return createHash("sha256").update(prev).update(canonical(body)).digest("hex");
}

function eventFromRow(r: Row): FlowEvent {
  return {
    seq: Number(r.seq),
    ts: iso(r.ts) ?? "",
    actor: String(r.actor),
    actor_kind: r.actor_kind as ActorKind,
    action: String(r.action),
    ticket_id: (r.ticket_id as string | null) ?? null,
    payload: json<Record<string, unknown>>(r.payload, {}),
    prev_hash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function checkEnum(name: string, value: string | undefined, allowed: readonly string[]): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new FlowError("INVALID_ARGUMENT", `${name} must be one of ${allowed.join(", ")} (got ${value})`);
  }
}

function pastTense(action: Action): string {
  const map: Record<string, string> = {
    promote: "promoted",
    demote: "demoted",
    start: "started",
    release: "released",
    block: "blocked",
    unblock: "unblocked",
    submit: "submitted",
    approve: "approved",
    reject: "rejected",
    close: "closed",
    reopen: "reopened",
    cancel: "cancelled",
  };
  return map[action] ?? action;
}

function safeCall(fn: EventListener, event: FlowEvent): void {
  try {
    fn(event);
  } catch {
    // listeners (SSE, notifiers) must never break a committed write
  }
}

export function snapshotExists(file: string): boolean {
  return existsSync(file);
}

export function readSnapshot(file: string): string {
  return readFileSync(file, "utf8");
}
