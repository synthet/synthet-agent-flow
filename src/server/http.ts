import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { defaultConfig, LANES, PRIORITIES, STATUSES, TICKET_TYPES, type Status } from "../core/config.js";
import { FlowError, toFlowError } from "../core/errors.js";
import { canonicalRoot, hubTokenFile, readRegistry, registerWorkspace, registryPath, rootKey, slug, unregisterWorkspace, workspaceAvailable, type RegistryEntry } from "../core/registry.js";
import { applyAction } from "../core/service.js";
import { actionForMove, actionsFrom, ACTIONS, type Action } from "../core/states.js";
import { actorKind } from "../core/store.js";
import type { Verdict } from "../core/types.js";
import { openWorkspaceAt, type Workspace } from "../core/workspace.js";
import { APP_CSS, APP_JS, DASHBOARD_HTML, FAVICON_SVG } from "./dashboard.js";
import { attachNotifiers, flushOutbox } from "../integrations/notify.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Default actor for dashboard writes (must be human:…). */
  actor?: string;
  token?: string;
  pollMs?: number;
  reapMs?: number;
  /**
   * The workspace registry the hub mounts projects from. Omitted: the user-level registry (`AGENT_FLOW_REGISTRY` or
   * `~/.agent-flow/workspaces.json`). `null`: no registry, so only the default workspace is served.
   */
  registry?: string | null;
  /** Optional handler for POST /hooks/github (wired by the GitHub integration). */
  githubWebhook?: (event: string, payload: unknown, ws: Workspace) => Promise<unknown>;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** One project served by the hub. Each keeps its own database; the hub only holds a connection to it. */
interface Mount {
  id: string;
  name: string;
  root: string;
  isDefault: boolean;
  ws: Workspace | null;
  /** The hub opened this workspace, so it closes it. The default workspace belongs to the caller. */
  owned: boolean;
  state: "ok" | "missing" | "error";
  error: string | null;
  lastSeq: number;
  /** A project-level token (`.agent-flow/serve.json`) that also authorizes writes to this workspace. */
  projectToken: string | null;
  detach: () => void;
  retryAt: number;
}

interface StreamClient {
  res: ServerResponse;
  /** Only this workspace's events, or every workspace's. */
  only: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY = 1024 * 1024;
const RETRY_MS = 30_000;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  const fe = toFlowError(err);
  const status: Record<string, number> = {
    NOT_FOUND: 404,
    NOT_INITIALIZED: 404,
    INVALID_ARGUMENT: 400,
    INVALID_TRANSITION: 409,
    CLAIM_CONFLICT: 409,
    VERSION_CONFLICT: 409,
    WIP_LIMIT: 409,
    BLOCKED_BY_DEPENDENCY: 409,
    GATE_FAILED: 422,
    CYCLE: 422,
    NOT_OWNER: 403,
    UNAUTHORIZED: 401,
    CONFIRMATION_REQUIRED: 428,
  };
  send(res, status[fe.code] ?? 500, { error: fe.toJSON() });
}

const notFound = (message = "no such endpoint") => ({ error: { code: "NOT_FOUND", message, retryable: false, next_steps: [] } });

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new FlowError("INVALID_ARGUMENT", "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new FlowError("INVALID_ARGUMENT", "body must be a JSON object");
  }
}

const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Load or create the bearer token (`.agent-flow/serve.json`, like the mailbox daemon.json). */
export function serverToken(file: string): string {
  const existing = readToken(file);
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ token }, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return token;
}

function readToken(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token || null;
  } catch {
    return null;
  }
}

const frame = (id: string, e: { seq: number }) => `id: ${e.seq}\nevent: flow\ndata: ${JSON.stringify({ ...e, workspace: id })}\n\n`;

/**
 * Start the dashboard hub. One process serves every registered project from one port: `/api/workspaces` lists them,
 * `/api/w/<id>/...` is one project's API, and `/api/stream` carries all their events. `ws` is the default workspace,
 * which the legacy `/api/<endpoint>` routes still address; it may be null when serve starts outside a project.
 */
export function startServer(ws: Workspace | null, opts: ServeOptions = {}): Promise<RunningServer> {
  const registryFile = opts.registry === undefined ? registryPath() : opts.registry;
  const fallback = defaultConfig().server;
  const host = opts.host ?? ws?.config.server.host ?? fallback.host;
  const port = opts.port ?? ws?.config.server.port ?? fallback.port;
  if (!ws && !registryFile) {
    return Promise.reject(new FlowError("NOT_INITIALIZED", "nothing to serve: no workspace here and no registry", { nextSteps: ["agent-flow init"] }));
  }
  // The project token keeps working for scripts that read .agent-flow/serve.json; the page itself uses the hub token.
  const projectToken = ws ? serverToken(ws.paths.serveFile) : null;
  const token = opts.token ?? (registryFile ? serverToken(hubTokenFile(registryFile)) : (projectToken as string));
  const defaultActor = opts.actor && actorKind(opts.actor) === "human" ? opts.actor : `human:${process.env.USER || process.env.USERNAME || "dashboard"}`;
  const log = opts.log ?? (() => {});
  const mounts = new Map<string, Mount>();
  const clients = new Set<StreamClient>();
  let defaultMount: Mount | null = null;

  if (ws) {
    let entry: RegistryEntry | null = null;
    try {
      entry = registryFile ? (registerWorkspace(ws.paths.root, registryFile)?.entry ?? null) : null;
    } catch (err) {
      log(`registry: ${String(err)}`);
    }
    defaultMount = {
      id: entry?.id ?? slug(path.basename(ws.paths.root)),
      name: entry?.name ?? path.basename(ws.paths.root),
      root: entry?.root ?? canonicalRoot(ws.paths.root),
      isDefault: true,
      ws,
      owned: false,
      state: "ok",
      error: null,
      lastSeq: ws.store.lastSeq(),
      projectToken,
      detach: attachNotifiers(ws),
      retryAt: 0,
    };
    mounts.set(defaultMount.id, defaultMount);
  }

  const open = (m: Mount) => {
    m.retryAt = Date.now() + RETRY_MS;
    if (!workspaceAvailable(m.root)) {
      m.state = "missing";
      m.error = `no .agent-flow/ at ${m.root}`;
      return;
    }
    try {
      const opened = openWorkspaceAt(m.root);
      m.ws = opened;
      m.state = "ok";
      m.error = null;
      m.lastSeq = opened.store.lastSeq();
      m.projectToken = readToken(opened.paths.serveFile);
      m.detach = attachNotifiers(opened);
    } catch (err) {
      m.state = "error";
      m.error = toFlowError(err).message;
      log(`workspace ${m.id}: ${m.error}`);
    }
  };

  const unmount = (m: Mount) => {
    m.detach();
    if (m.owned) m.ws?.close();
    m.ws = null;
    mounts.delete(m.id);
  };

  let registryStamp = "";
  /** Mount what the registry added and unmount what it dropped; a cheap stat skips the read when nothing changed. */
  const syncRegistry = (force = false) => {
    if (!registryFile) return;
    let stamp = "absent";
    try {
      const st = statSync(registryFile);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* no registry file yet */
    }
    if (!force && stamp === registryStamp) return;
    registryStamp = stamp;
    const entries = readRegistry(registryFile);
    const defaultKey = defaultMount ? rootKey(defaultMount.root) : null;
    const wanted = new Set<string>();
    for (const e of entries) {
      if (defaultKey && rootKey(e.root) === defaultKey) continue;
      wanted.add(e.id);
      if (mounts.has(e.id)) continue;
      const m: Mount = {
        id: e.id,
        name: e.name,
        root: e.root,
        isDefault: false,
        ws: null,
        owned: true,
        state: "missing",
        error: null,
        lastSeq: 0,
        projectToken: null,
        detach: () => {},
        retryAt: 0,
      };
      mounts.set(e.id, m);
      open(m);
    }
    for (const m of [...mounts.values()]) if (!m.isDefault && !wanted.has(m.id)) unmount(m);
  };
  syncRegistry(true);

  const broadcast = (id: string, text: string) => {
    for (const c of clients) if (c.only === null || c.only === id) c.res.write(text);
  };
  const broadcastTick = () => {
    syncRegistry();
    for (const m of mounts.values()) {
      if (!m.ws) {
        if (Date.now() >= m.retryAt) open(m);
        continue;
      }
      try {
        const events = m.ws.store.events({ since: m.lastSeq, limit: 500 });
        if (events.length) m.lastSeq = events[events.length - 1].seq;
        for (const e of events) broadcast(m.id, frame(m.id, e));
      } catch (err) {
        log(`sse poll failed for ${m.id}: ${String(err)}`);
      }
    }
  };
  const poll = setInterval(broadcastTick, opts.pollMs ?? 1000);
  const keepAlive = setInterval(() => {
    for (const c of clients) c.res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  const reaper = setInterval(() => {
    for (const m of mounts.values()) {
      const mws = m.ws;
      if (!mws) continue;
      try {
        mws.store.reap();
      } catch (err) {
        log(`reap failed for ${m.id}: ${String(err)}`);
      }
      if (mws.store.outboxStats().pending > 0) void flushOutbox(mws, { budgetMs: 10_000 }).catch((err) => log(`outbox ${m.id}: ${String(err)}`));
    }
  }, opts.reapMs ?? 30_000);

  const authorizeWrite = (req: IncomingMessage, m: Mount | null) => {
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const accepted = [token, m?.projectToken].filter((t): t is string => !!t);
    if (!given || !accepted.some((t) => safeEqual(given, t))) {
      throw new FlowError("UNAUTHORIZED", "writes need Authorization: Bearer <token from serve.json>");
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = LOOPBACK_HOSTS.has(new URL(origin).hostname);
      } catch {
        ok = false;
      }
      if (!ok) throw new FlowError("UNAUTHORIZED", "cross-origin writes are refused");
    }
  };

  const actorFor = (req: IncomingMessage, body: Record<string, unknown>): string => {
    const a = s(body.actor) ?? s(req.headers["x-flow-actor"]);
    if (!a) return defaultActor;
    if (!/^[a-z][a-z0-9_-]*:[\w.@:-]{1,80}$/i.test(a)) throw new FlowError("INVALID_ARGUMENT", `bad actor ${a}`);
    return a;
  };

  const usable = (m: Mount): Workspace => {
    if (!m.ws) throw new FlowError("NOT_INITIALIZED", `workspace ${m.id} is unavailable: ${m.error ?? "not open"}`, { nextSteps: [`agent-flow workspaces remove ${m.id}`] });
    return m.ws;
  };

  const summary = (m: Mount) => {
    const base = { id: m.id, name: m.name, root: m.root, default: m.isDefault };
    if (!m.ws) return { ...base, status: m.state, error: m.error };
    try {
      const store = m.ws.store;
      const st = store.stats() as { counts: Record<Status, number>; ready: number; needs_human: number; done_last_7d: number };
      const active = store.list({ status: ["claimed", "in_progress"] });
      const pick = (t: { id: string; title: string; priority: string; owner: string | null; status: string; updated_at: string }) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        owner: t.owner,
        status: t.status,
        updated_at: t.updated_at,
      });
      const last = store.events({ limit: 1, order: "desc" })[0];
      return {
        ...base,
        status: "ok" as const,
        prefix: m.ws.config.prefix,
        counts: st.counts,
        ready: st.ready,
        needs_human: st.needs_human,
        done_last_7d: st.done_last_7d,
        review: store.list({ status: ["review"] }).map(pick),
        in_flight: active.map(pick),
        agents: [...new Set(active.map((t) => t.owner).filter((o): o is string => !!o))],
        last_event: last ? { ts: last.ts, action: last.action, actor: last.actor, ticket_id: last.ticket_id } : null,
        last_seq: store.lastSeq(),
      };
    } catch (err) {
      return { ...base, status: "error" as const, error: toFlowError(err).message };
    }
  };

  const openStream = (req: IncomingMessage, res: ServerResponse, only: Mount | null, since: number) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Replay (Last-Event-ID / ?since=) is per workspace, since each project numbers its own events.
    const replay = only ?? defaultMount;
    if (Number.isFinite(since) && replay?.ws) {
      for (const e of replay.ws.store.events({ since, limit: 500 })) res.write(frame(replay.id, e));
    }
    const seqs = Object.fromEntries([...mounts.values()].map((m) => [m.id, m.lastSeq]));
    res.write(`event: hello\ndata: ${JSON.stringify({ last_seq: replay?.lastSeq ?? 0, workspaces: seqs })}\n\n`);
    const client: StreamClient = { res, only: only?.id ?? null };
    clients.add(client);
    req.on("close", () => clients.delete(client));
  };

  /** One project's API. `rest` is the path after `/api/` or `/api/w/<id>/`. */
  const handleWorkspace = async (m: Mount, rest: string[], req: IncomingMessage, res: ServerResponse, url: URL, method: string) => {
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    if (method === "GET" && rest[0] === "stream") {
      return openStream(req, res, m, Number(req.headers["last-event-id"] ?? q("since") ?? NaN));
    }
    const mws = usable(m);
    const store = mws.store;

    // ───── reads ─────
    if (method === "GET") {
      switch (rest[0]) {
        case "meta":
          return send(res, 200, {
            version: "0.1.0",
            root: mws.paths.root,
            workspace: { id: m.id, name: m.name, default: m.isDefault },
            actor: defaultActor,
            statuses: STATUSES,
            lanes: LANES,
            priorities: PRIORITIES,
            types: TICKET_TYPES,
            actions: ACTIONS,
            transitions: Object.fromEntries(STATUSES.map((st) => [st, actionsFrom(st)])),
            config: {
              prefix: mws.config.prefix,
              wip: mws.config.wip,
              requireReview: mws.config.requireReview,
              requireHandoff: mws.config.requireHandoff,
              allowSelfApprove: mws.config.allowSelfApprove,
              leaseMinutes: mws.config.leaseMinutes,
              dod: mws.config.dod,
              github: mws.config.github.enabled ? mws.config.github.repo : null,
              mailbox: mws.config.mailbox.enabled,
              swarm: mws.config.swarm.enabled,
            },
          });
        case "board":
          return send(res, 200, store.board({ epic: q("epic"), label: q("label"), lane: q("lane"), query: q("q") }));
        case "ready":
          return send(res, 200, store.ready({ label: q("label"), epic: q("epic") }));
        case "tickets":
          if (rest[1]) return send(res, 200, store.detail(rest[1], { events: Number(q("events") ?? 100) }));
          return send(
            res,
            200,
            store.list({
              status: q("status")?.split(",") as Status[] | undefined,
              owner: q("owner"),
              label: q("label"),
              epic: q("epic"),
              type: q("type"),
              query: q("q"),
              includeClosed: q("all") === "1",
            }),
          );
        case "events":
          return send(
            res,
            200,
            q("since") !== undefined
              ? store.events({ since: Number(q("since")), ticketId: q("ticket"), limit: Number(q("limit") ?? 200) })
              : store.events({ ticketId: q("ticket"), limit: Number(q("limit") ?? 200), order: "desc" }),
          );
        case "agents":
          return send(res, 200, store.agents());
        case "stats":
          return send(res, 200, store.stats());
        case "epics": {
          const epics = store.list({ type: "epic", includeClosed: true });
          return send(
            res,
            200,
            epics.map((e) => {
              const children = store.list({ epic: e.id, includeClosed: true });
              const edges = children.flatMap((c) =>
                (store.db.prepare("SELECT depends_on FROM deps WHERE ticket_id = ? AND kind = 'blocks'").all(c.id) as Array<{ depends_on: string }>).map((d) => ({
                  from: d.depends_on,
                  to: c.id,
                })),
              );
              return { epic: e, children, edges };
            }),
          );
        }
        case "sessions":
          return send(res, 200, store.sessions());
      }
      return send(res, 404, notFound());
    }

    // ───── writes ─────
    if (method !== "POST" && method !== "PATCH") return send(res, 405, { error: { code: "INVALID_ARGUMENT", message: "method not allowed", retryable: false, next_steps: [] } });
    authorizeWrite(req, m);
    const body = await readJson(req);
    const actor = actorFor(req, body);

    if (rest[0] === "tickets" && !rest[1] && method === "POST") {
      const t = store.create(
        {
          title: String(body.title ?? ""),
          body: s(body.body),
          type: s(body.type),
          priority: s(body.priority),
          lane: s(body.lane),
          labels: arr(body.labels),
          scope_paths: arr(body.scope_paths),
          acceptance: arr(body.acceptance),
          parent: s(body.parent),
          depends_on: arr(body.depends_on),
          status: body.ready === true ? "ready" : "backlog",
        },
        actor,
      );
      return send(res, 201, t);
    }
    const id = rest[1];
    if (rest[0] !== "tickets" || !id) return send(res, 404, notFound());
    if (method === "PATCH" && !rest[2]) {
      const t = store.update(
        id,
        {
          title: s(body.title),
          body: s(body.body),
          type: s(body.type),
          priority: s(body.priority),
          lane: s(body.lane),
          labels: arr(body.labels),
          add_labels: arr(body.add_labels),
          remove_labels: arr(body.remove_labels),
          scope_paths: arr(body.scope_paths),
        },
        actor,
        typeof body.expected_version === "number" ? body.expected_version : undefined,
      );
      return send(res, 200, t);
    }
    switch (rest[2]) {
      case "transition":
      case "move": {
        let action: Action | null;
        if (rest[2] === "move") {
          const to = s(body.to) as Status;
          action = actionForMove(store.get(id).status, to);
          if (!action) throw new FlowError("INVALID_TRANSITION", `no single action moves ${id} to ${to}`);
        } else {
          action = s(body.action) as Action;
          if (!ACTIONS.includes(action)) throw new FlowError("INVALID_ARGUMENT", `unknown action ${String(body.action)}`);
        }
        const t = await applyAction(mws, id, action, actor, {
          reason: s(body.reason),
          unblockCondition: s(body.unblock_condition),
          force: body.force === true,
          skipDod: body.skip_dod === true,
          cwd: mws.paths.root,
        });
        return send(res, 200, { action, ticket: t });
      }
      case "comments":
        return send(res, 201, store.comment(id, (s(body.kind) ?? "note") as never, String(body.body ?? ""), actor));
      case "ac":
        if (body.op === "add") return send(res, 201, store.addAcceptance(id, String(body.text ?? ""), actor, s(body.ac_id)));
        return send(res, 200, store.verifyAcceptance(id, String(body.ac_id ?? ""), (s(body.verdict) ?? "Verified") as Verdict, s(body.evidence) ?? null, actor));
      case "deps":
        if (body.remove === true) store.removeDep(id, String(body.depends_on), (s(body.kind) ?? "blocks") as never, actor);
        else store.addDep(id, String(body.depends_on), (s(body.kind) ?? "blocks") as never, actor);
        return send(res, 200, store.get(id));
    }
    return send(res, 404, notFound());
  };

  const html = DASHBOARD_HTML.replace("__FLOW_TOKEN__", token).replace("__FLOW_ACTOR__", defaultActor.replace(/[<>"&]/g, ""));

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(hostHeader)) {
      // DNS-rebinding guard: only loopback Host headers are served.
      return send(res, 421, { error: { code: "UNAUTHORIZED", message: "loopback only", retryable: false, next_steps: [] } });
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const method = req.method ?? "GET";

    // ───── static ─────
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return send(res, 200, html, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "referrer-policy": "no-referrer" });
    }
    if (method === "GET" && url.pathname === "/app.js") return send(res, 200, APP_JS, { "content-type": "text/javascript; charset=utf-8" });
    if (method === "GET" && url.pathname === "/app.css") return send(res, 200, APP_CSS, { "content-type": "text/css; charset=utf-8" });
    if (method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
      return send(res, 200, FAVICON_SVG, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
    }
    if (method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, last_seq: defaultMount?.ws?.store.lastSeq() ?? 0, workspaces: mounts.size });
    }

    if (parts[0] === "hooks" && parts[1] === "github" && method === "POST") {
      const target = parts[2] ? mounts.get(parts[2]) : defaultMount;
      const tws = target?.ws;
      if (!opts.githubWebhook || !tws || !tws.config.github.enabled) throw new FlowError("NOT_FOUND", "GitHub webhook not enabled");
      const raw = await readBody(req);
      const secret = process.env[tws.config.github.webhookSecretEnv];
      if (!secret) throw new FlowError("UNAUTHORIZED", `set ${tws.config.github.webhookSecretEnv} to accept webhooks`);
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expect = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (!safeEqual(sig, expect)) throw new FlowError("UNAUTHORIZED", "bad webhook signature");
      const result = await opts.githubWebhook(String(req.headers["x-github-event"] ?? ""), JSON.parse(raw), tws);
      return send(res, 200, { ok: true, result });
    }

    if (parts[0] !== "api") return send(res, 404, notFound("not found"));

    // ───── hub ─────
    if (method === "GET" && parts[1] === "stream") return openStream(req, res, null, Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? NaN));
    if (parts[1] === "workspaces") {
      if (method === "GET" && !parts[2]) {
        syncRegistry();
        return send(res, 200, { default: defaultMount?.id ?? null, actor: defaultActor, registry: registryFile, workspaces: [...mounts.values()].map(summary) });
      }
      if (method === "POST" && parts[2] && parts[3] === "forget") {
        authorizeWrite(req, null);
        const m = mounts.get(parts[2]);
        if (!m) throw new FlowError("NOT_FOUND", `no workspace ${parts[2]}`);
        if (m.isDefault) throw new FlowError("INVALID_ARGUMENT", "this hub was started in that workspace; stop serve to forget it");
        if (registryFile) unregisterWorkspace(m.root, registryFile);
        unmount(m);
        return send(res, 200, { ok: true, forgotten: m.id });
      }
      return send(res, 404, notFound());
    }
    if (parts[1] === "w") {
      const m = parts[2] ? mounts.get(parts[2]) : undefined;
      if (!m) throw new FlowError("NOT_FOUND", `no workspace ${parts[2] ?? ""}`, { nextSteps: ["GET /api/workspaces", "agent-flow workspaces add <dir>"] });
      return handleWorkspace(m, parts.slice(3), req, res, url, method);
    }
    // Legacy single-project routes address the default workspace.
    if (!defaultMount) {
      throw new FlowError("NOT_FOUND", "this hub has no default workspace: use /api/w/<id>/...", { nextSteps: ["GET /api/workspaces"] });
    }
    return handleWorkspace(defaultMount, parts.slice(1), req, res, url, method);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });

  const stopTimers = () => {
    clearInterval(poll);
    clearInterval(keepAlive);
    clearInterval(reaper);
  };

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      stopTimers();
      for (const m of [...mounts.values()]) unmount(m);
      reject(err);
    });
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
      const url = `http://${shownHost}:${addr.port}/`;
      log(`agent-flow dashboard ${url} (${mounts.size} workspace${mounts.size === 1 ? "" : "s"})`);
      resolve({
        url,
        port: addr.port,
        token,
        close: () =>
          new Promise<void>((done) => {
            stopTimers();
            for (const m of [...mounts.values()]) unmount(m);
            for (const c of clients) c.res.end();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
