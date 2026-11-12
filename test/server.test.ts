import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRegistry, registerWorkspace } from "../src/core/registry.js";
import { initWorkspace, openWorkspace, type Workspace } from "../src/core/workspace.js";
import { startServer, type RunningServer } from "../src/server/http.js";
import { tempDir } from "./helpers.js";

let server: RunningServer | null = null;
let ws: Workspace | null = null;

afterEach(async () => {
  await server?.close();
  ws?.close();
  server = null;
  ws = null;
});

async function boot() {
  const dir = tempDir("af-srv-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  initWorkspace(dir);
  ws = openWorkspace(dir);
  server = await startServer(ws, { port: 0, actor: "human:tester", pollMs: 50, registry: path.join(tempDir("af-srv-reg-"), "workspaces.json") });
  const base = server.url.replace(/\/$/, "");
  const token = server.token;
  const call = async (method: string, path: string, body?: unknown, auth = true, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  return { base, call, store: ws.store };
}

describe("http server", () => {
  it("serves the dashboard with a strict CSP and the token embedded", async () => {
    const { call } = await boot();
    const page = await call("GET", "/", undefined, false);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(String(page.json)).toContain(server!.token);
    expect(String(page.json)).not.toContain("__FLOW_TOKEN__");
    expect((await call("GET", "/app.js", undefined, false)).status).toBe(200);
  });

  it("requires the bearer token for writes and refuses cross-origin writes", async () => {
    const { call } = await boot();
    expect((await call("POST", "/api/tickets", { title: "nope" }, false)).status).toBe(401);
    const cross = await call("POST", "/api/tickets", { title: "nope" }, true, { origin: "https://evil.example" });
    expect(cross.status).toBe(401);
    const ok = await call("POST", "/api/tickets", { title: "From the dashboard", ready: true, acceptance: ["works"] });
    expect(ok.status).toBe(201);
    expect(ok.json.created_by).toBe("human:tester");
  });

  it("rejects non-loopback Host headers (DNS rebinding guard)", async () => {
    const { base } = await boot();
    const http = await import("node:http");
    const url = new URL(base);
    const status = await new Promise<number>((resolve) => {
      http.get({ host: url.hostname, port: url.port, path: "/api/board", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(421);
  });

  it("moves cards via drag targets and maps errors to HTTP codes", async () => {
    const { call } = await boot();
    const t = (await call("POST", "/api/tickets", { title: "Drag me", ready: true })).json;
    const claimed = await call("POST", `/api/tickets/${t.id}/move`, { to: "claimed" });
    expect(claimed.status).toBe(200);
    expect(claimed.json.action).toBe("claim");
    expect(claimed.json.ticket.owner).toBe("human:tester");
    const bad = await call("POST", `/api/tickets/${t.id}/move`, { to: "backlog" });
    expect(bad.status).toBe(409);
    expect(bad.json.error.code).toBe("INVALID_TRANSITION");
    const gated = await call("POST", `/api/tickets/${t.id}/move`, { to: "done" });
    expect(gated.status).toBe(422); // close is refused by the review gate
    expect(gated.json.error.code).toBe("GATE_FAILED");
    const board = (await call("GET", "/api/board", undefined, false)).json;
    expect(board.columns.find((c: any) => c.status === "claimed").tickets[0].id).toBe(t.id);
  });

  it("streams events over SSE, including writes made by other processes", async () => {
    const { base, store } = await boot();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const decoder = new TextDecoder();
    // A write through a separate store connection (like the CLI) must reach the stream.
    const other = openWorkspace(ws!.paths.root);
    other.store.create({ title: "made elsewhere" }, "claude:cli");
    other.close();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.some((s) => s.includes("ticket.created"))) {
      const { value } = await reader.read();
      seen.push(decoder.decode(value));
    }
    ctrl.abort();
    expect(seen.join("")).toContain("ticket.created");
    void store;
  });

  it("exposes meta, stats, agents and epics", async () => {
    const { call, store } = await boot();
    const epic = store.create({ title: "Epic", type: "epic" }, "human:x");
    const a = store.create({ title: "A", status: "ready", parent: epic.id }, "human:x");
    store.create({ title: "B", status: "ready", parent: epic.id, depends_on: [a.id] }, "human:x");
    const meta = (await call("GET", "/api/meta", undefined, false)).json;
    expect(meta.transitions.ready).toContain("claim");
    const epics = (await call("GET", "/api/epics", undefined, false)).json;
    expect(epics[0].edges).toEqual([{ from: a.id, to: expect.any(String) }]);
    expect((await call("GET", "/api/stats", undefined, false)).json.ready).toBe(1);
  });
});

describe("dashboard hub", () => {
  let extra: RunningServer | null = null;
  afterEach(async () => {
    await extra?.close();
    extra = null;
  });

  function project(parent: string, name: string): string {
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    initWorkspace(dir);
    return dir;
  }

  async function hub(withDefault: boolean) {
    const parent = tempDir("af-hub-");
    const registry = path.join(parent, "home", "workspaces.json");
    const alpha = project(parent, "alpha");
    const beta = project(parent, "beta");
    registerWorkspace(beta, registry);
    // Beta's tickets live in beta's own database, written by beta's own processes (CLI, MCP).
    const betaWs = openWorkspace(beta);
    betaWs.store.create({ title: "Beta needs review", status: "ready" }, "human:x");
    betaWs.close();
    ws = withDefault ? openWorkspace(alpha) : null;
    extra = await startServer(ws, { port: 0, actor: "human:tester", pollMs: 50, registry });
    const base = extra.url.replace(/\/$/, "");
    const call = async (method: string, p: string, body?: unknown, token: string | null = extra!.token) => {
      const res = await fetch(base + p, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    return { base, call, registry, alpha, beta };
  }

  it("serves every registered workspace from one port, each from its own database", async () => {
    const { call, registry, alpha, beta } = await hub(true);
    // Starting the hub in alpha registered alpha too.
    expect(readRegistry(registry).map((e) => e.id).sort()).toEqual(["alpha", "beta"]);
    const list = (await call("GET", "/api/workspaces", undefined, null)).json;
    expect(list.default).toBe("alpha");
    const byId = Object.fromEntries(list.workspaces.map((w: any) => [w.id, w]));
    expect(byId.alpha).toMatchObject({ status: "ok", default: true, ready: 0 });
    expect(byId.beta).toMatchObject({ status: "ok", default: false, ready: 1, root: expect.stringContaining("beta") });

    const made = await call("POST", "/api/w/beta/tickets", { title: "From the hub", ready: true });
    expect(made.status).toBe(201);
    expect((await call("GET", "/api/w/beta/board", undefined, null)).json.columns.find((c: any) => c.status === "ready").tickets).toHaveLength(2);
    expect((await call("GET", "/api/w/beta/meta", undefined, null)).json).toMatchObject({ workspace: { id: "beta", default: false } });
    // Legacy routes still address the default workspace.
    expect((await call("GET", "/api/board", undefined, null)).json.columns.flatMap((c: any) => c.tickets)).toEqual([]);
    expect((await call("GET", "/api/w/nope/board", undefined, null)).status).toBe(404);

    // Alpha's project token (.agent-flow/serve.json) writes to alpha, not to beta.
    const alphaToken = JSON.parse(readFileSync(path.join(alpha, ".agent-flow", "serve.json"), "utf8")).token as string;
    expect((await call("POST", "/api/w/alpha/tickets", { title: "a" }, alphaToken)).status).toBe(201);
    expect((await call("POST", "/api/w/beta/tickets", { title: "b" }, alphaToken)).status).toBe(401);
    void beta;
  });

  it("streams events from every workspace tagged with the workspace id", async () => {
    const { base, beta } = await hub(true);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const other = openWorkspace(beta);
    other.store.create({ title: "made in beta" }, "claude:cli");
    other.close();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes("made in beta")) text += decoder.decode((await reader.read()).value);
    ctrl.abort();
    const frame = text.split(/\n\n/).find((f) => f.includes("ticket.created"))!;
    expect(JSON.parse(frame.split("data: ")[1])).toMatchObject({ workspace: "beta", action: "ticket.created" });
  });

  it("starts without a default workspace, picks up new registrations, and forgets unavailable ones", async () => {
    const { call, registry } = await hub(false);
    expect((await call("GET", "/api/workspaces", undefined, null)).json.default).toBeNull();
    expect((await call("GET", "/api/board", undefined, null)).status).toBe(404);
    expect((await call("GET", "/", undefined, null)).status).toBe(200);

    const late = project(path.dirname(path.dirname(registry)), "gamma");
    registerWorkspace(late, registry);
    // A registered project whose folder has since lost its .agent-flow/ (deleted, moved, or on an unplugged drive).
    const stale = { id: "gone", name: "gone", root: tempDir("af-hub-gone-"), added_at: new Date().toISOString() };
    writeFileSync(registry, JSON.stringify({ version: 1, workspaces: [...readRegistry(registry), stale] }));
    const ids = async () => (await call("GET", "/api/workspaces", undefined, null)).json.workspaces.map((w: any) => [w.id, w.status]);
    expect(Object.fromEntries(await ids())).toEqual({ beta: "ok", gamma: "ok", gone: "missing" });
    expect((await call("GET", "/api/w/gone/board", undefined, null)).status).toBe(404);
    expect((await call("POST", "/api/workspaces/gone/forget", {})).status).toBe(200);

    expect((await call("POST", "/api/workspaces/beta/forget", {}, null)).status).toBe(401);
    expect((await call("POST", "/api/workspaces/beta/forget", {})).status).toBe(200);
    expect(readRegistry(registry).map((e) => e.id)).not.toContain("beta");
    expect((await call("GET", "/api/w/beta/board", undefined, null)).status).toBe(404);
  });
});
