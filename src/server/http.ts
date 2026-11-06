import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LANES, PRIORITIES, STATUSES, TICKET_TYPES, type Status } from "../core/config.js";
import { FlowError, toFlowError } from "../core/errors.js";
import { applyAction } from "../core/service.js";
import { actionForMove, actionsFrom, ACTIONS, type Action } from "../core/states.js";
import { actorKind } from "../core/store.js";
import type { Verdict } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { APP_CSS, APP_JS, DASHBOARD_HTML, FAVICON_SVG } from "./dashboard.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Default actor for dashboard writes (must be human:…). */
  actor?: string;
  token?: string;
  pollMs?: number;
  reapMs?: number;
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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY = 1024 * 1024;

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
  if (existsSync(file)) {
    try {
      const t = (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token;
      if (t) return t;
    } catch {
      /* regenerate */
    }
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, JSON.stringify({ token }, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return token;
}

export function startServer(ws: Workspace, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? ws.config.server.host;
  const port = opts.port ?? ws.config.server.port;
  const token = opts.token ?? serverToken(ws.paths.serveFile);
  const defaultActor = opts.actor && actorKind(opts.actor) === "human" ? opts.actor : `human:${process.env.USER || process.env.USERNAME || "dashboard"}`;
  const log = opts.log ?? (() => {});
  const store = ws.store;
  const clients = new Set<ServerResponse>();
  let lastSeq = store.lastSeq();

  const html = DASHBOARD_HTML.replace("__FLOW_TOKEN__", token).replace("__FLOW_ACTOR__", defaultActor.replace(/[<>"&]/g, ""));

  const broadcastTick = () => {
    try {
      const events = store.events({ since: lastSeq, limit: 500 });
      if (events.length) lastSeq = events[events.length - 1].seq;
      for (const e of events) {
        const frame = `id: ${e.seq}\nevent: flow\ndata: ${JSON.stringify(e)}\n\n`;
        for (const c of clients) c.write(frame);
      }
    } catch (err) {
      log(`sse poll failed: ${String(err)}`);
    }
  };
  const poll = setInterval(broadcastTick, opts.pollMs ?? 1000);
  const keepAlive = setInterval(() => {
    for (const c of clients) c.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  const reaper = setInterval(() => {
    try {
      store.reap();
    } catch (err) {
      log(`reap failed: ${String(err)}`);
    }
  }, opts.reapMs ?? 30_000);

  const authorizeWrite = (req: IncomingMessage) => {
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !safeEqual(given, token)) {
      throw new FlowError("UNAUTHORIZED", "writes need Authorization: Bearer <token from .agent-flow/serve.json>");
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(hostHeader)) {
      // DNS-rebinding guard: only loopback Host headers are served.
      return send(res, 421, { error: { code: "UNAUTHORIZED", message: "loopback only", retryable: false, next_steps: [] } });
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    const q = (k: string) => url.searchParams.get(k) ?? undefined;

    // ───── static ─────
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return send(res, 200, html, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "referrer-policy": "no-referrer" });
    }
    if (method === "GET" && url.pathname === "/app.js") return send(res, 200, APP_JS, { "content-type": "text/javascript; charset=utf-8" });
    if (method === "GET" && url.pathname === "/app.css") return send(res, 200, APP_CSS, { "content-type": "text/css; charset=utf-8" });
    if (method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
      return send(res, 200, FAVICON_SVG, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
    }
    if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, last_seq: store.lastSeq() });

    if (parts[0] === "hooks" && parts[1] === "github" && method === "POST") {
      if (!opts.githubWebhook) throw new FlowError("NOT_FOUND", "GitHub webhook not enabled");
      const raw = await readBody(req);
      const secret = process.env[ws.config.github.webhookSecretEnv];
      if (!secret) throw new FlowError("UNAUTHORIZED", `set ${ws.config.github.webhookSecretEnv} to accept webhooks`);
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expect = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (!safeEqual(sig, expect)) throw new FlowError("UNAUTHORIZED", "bad webhook signature");
      const result = await opts.githubWebhook(String(req.headers["x-github-event"] ?? ""), JSON.parse(raw), ws);
      return send(res, 200, { ok: true, result });
    }

    if (parts[0] !== "api") return send(res, 404, { error: { code: "NOT_FOUND", message: "not found", retryable: false, next_steps: [] } });

    // ───── SSE ─────
    if (method === "GET" && parts[1] === "stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const since = Number(req.headers["last-event-id"] ?? q("since") ?? NaN);
      if (Number.isFinite(since)) {
        for (const e of store.events({ since, limit: 500 })) res.write(`id: ${e.seq}\nevent: flow\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.write(`event: hello\ndata: ${JSON.stringify({ last_seq: store.lastSeq() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // ───── reads ─────
    if (method === "GET") {
      switch (parts[1]) {
        case "meta":
          return send(res, 200, {
            version: "0.1.0",
            root: ws.paths.root,
            actor: defaultActor,
            statuses: STATUSES,
            lanes: LANES,
            priorities: PRIORITIES,
            types: TICKET_TYPES,
            actions: ACTIONS,
            transitions: Object.fromEntries(STATUSES.map((st) => [st, actionsFrom(st)])),
            config: {
              prefix: ws.config.prefix,
              wip: ws.config.wip,
              requireReview: ws.config.requireReview,
              requireHandoff: ws.config.requireHandoff,
              allowSelfApprove: ws.config.allowSelfApprove,
              leaseMinutes: ws.config.leaseMinutes,
              dod: ws.config.dod,
              github: ws.config.github.enabled ? ws.config.github.repo : null,
              mailbox: ws.config.mailbox.enabled,
              swarm: ws.config.swarm.enabled,
            },
          });
        case "board":
          return send(res, 200, store.board({ epic: q("epic"), label: q("label"), lane: q("lane"), query: q("q") }));
        case "ready":
          return send(res, 200, store.ready({ label: q("label"), epic: q("epic") }));
        case "tickets":
          if (parts[2]) return send(res, 200, store.detail(parts[2], { events: Number(q("events") ?? 100) }));
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
      return send(res, 404, { error: { code: "NOT_FOUND", message: "no such endpoint", retryable: false, next_steps: [] } });
    }

    // ───── writes ─────
    if (method !== "POST" && method !== "PATCH") return send(res, 405, { error: { code: "INVALID_ARGUMENT", message: "method not allowed", retryable: false, next_steps: [] } });
    authorizeWrite(req);
    const body = await readJson(req);
    const actor = actorFor(req, body);

    if (parts[1] === "tickets" && !parts[2] && method === "POST") {
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
    const id = parts[2];
    if (parts[1] !== "tickets" || !id) return send(res, 404, { error: { code: "NOT_FOUND", message: "no such endpoint", retryable: false, next_steps: [] } });
    if (method === "PATCH" && !parts[3]) {
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
    switch (parts[3]) {
      case "transition":
      case "move": {
        let action: Action | null;
        if (parts[3] === "move") {
          const to = s(body.to) as Status;
          action = actionForMove(store.get(id).status, to);
          if (!action) throw new FlowError("INVALID_TRANSITION", `no single action moves ${id} to ${to}`);
        } else {
          action = s(body.action) as Action;
          if (!ACTIONS.includes(action)) throw new FlowError("INVALID_ARGUMENT", `unknown action ${String(body.action)}`);
        }
        const t = await applyAction(ws, id, action, actor, {
          reason: s(body.reason),
          unblockCondition: s(body.unblock_condition),
          force: body.force === true,
          skipDod: body.skip_dod === true,
          cwd: ws.paths.root,
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
    return send(res, 404, { error: { code: "NOT_FOUND", message: "no such endpoint", retryable: false, next_steps: [] } });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
      const url = `http://${shownHost}:${addr.port}/`;
      log(`agent-flow dashboard ${url}`);
      resolve({
        url,
        port: addr.port,
        token,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(poll);
            clearInterval(keepAlive);
            clearInterval(reaper);
            for (const c of clients) c.end();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
