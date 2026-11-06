import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
  server = await startServer(ws, { port: 0, actor: "human:tester", pollMs: 50 });
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
