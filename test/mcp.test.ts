import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createFlowMcpServer, TOOL_NAMES } from "../src/mcp/server.js";
import { defaultConfig } from "../src/core/config.js";
import { FlowStore } from "../src/core/store.js";
import { flowPaths } from "../src/core/paths.js";
import { initWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";

async function connect(actor: string | null = "claude:mcp-test") {
  const store = FlowStore.open(":memory:", { config: defaultConfig() });
  const ws = { paths: flowPaths(tempDir()), config: store.config, store, close: () => store.close() };
  const { server } = createFlowMcpServer({ workspace: ws, actor: actor ?? undefined });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
  };
  return { client, call, store };
}

describe("mcp actor identity", () => {
  const noSession = () => {
    for (const name of ["AGENT_FLOW_ACTOR", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"]) vi.stubEnv(name, "");
  };
  afterEach(() => vi.unstubAllEnvs());

  it("never defaults to a human: an MCP client is an agent", async () => {
    noSession();
    const { call } = await connect(null);
    expect((await call("flow_create", { title: "default actor" })).data.created_by).toBe("agent:mcp");
  });

  it("still uses a harness session id when one is set", async () => {
    noSession();
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "abcdef123456789");
    const { call } = await connect(null);
    expect((await call("flow_create", { title: "session actor" })).data.created_by).toBe("claude:abcdef123456");
  });

  it("lets an explicit --actor or AGENT_FLOW_ACTOR decide, including a human", async () => {
    noSession();
    expect((await (await connect("gemini:mcp")).call("flow_create", { title: "flag" })).data.created_by).toBe("gemini:mcp");
    vi.stubEnv("AGENT_FLOW_ACTOR", "human:me");
    expect((await (await connect(null)).call("flow_create", { title: "env" })).data.created_by).toBe("human:me");
  });

  it.each(["human:me", "system:import"])("rejects %s as a tool argument from an agent session", async (actor) => {
    const { call, store } = await connect("gemini:mcp");
    const res = await call("flow_create", { title: "escalate", actor });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("UNAUTHORIZED");
    expect(store.list({})).toHaveLength(0);
  });

  it("allows naming another agent, and lets a human session name anyone", async () => {
    expect((await (await connect("gemini:mcp")).call("flow_create", { title: "peer", actor: "claude:other" })).data.created_by).toBe("claude:other");
    expect((await (await connect("human:me")).call("flow_create", { title: "human", actor: "system:import" })).data.created_by).toBe("system:import");
  });
});

describe("mcp server", () => {
  it("lists every tool with annotations and the overview resource", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const ready = tools.tools.find((t) => t.name === "flow_ready")!;
    expect(ready.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((t) => t.name === "flow_cancel")!.annotations?.destructiveHint).toBe(true);
    const res = await client.readResource({ uri: "flow://workflow/overview" });
    expect((res.contents[0] as { text: string }).text).toContain("Five-step loop");
  });

  it("drives the lifecycle end to end", async () => {
    const { call } = await connect();
    const t = (await call("flow_create", { title: "Add pagination", ready: true, acceptance: ["20 per page"] })).data;
    expect((await call("flow_ready")).data.map((x: { id: string }) => x.id)).toEqual([t.id]);
    const claimed = (await call("flow_claim", { next: true })).data;
    expect(claimed.owner).toBe("claude:mcp-test");
    const second = await call("flow_claim", { id: t.id, actor: "claude:other" });
    expect(second.isError).toBe(true);
    expect(second.data.error.code).toBe("CLAIM_CONFLICT");
    expect((await call("flow_transition", { id: t.id, action: "start" })).data.status).toBe("in_progress");
    const gate = await call("flow_transition", { id: t.id, action: "submit" });
    expect(gate.data.error.code).toBe("GATE_FAILED");
    await call("flow_comment", { id: t.id, kind: "handoff", body: "done; see tests" });
    expect((await call("flow_transition", { id: t.id, action: "submit" })).data.status).toBe("review");
    await call("flow_ac", { id: t.id, op: "verify", ac_id: "AC-1", verdict: "Verified", evidence: "vitest ok", actor: "claude:reviewer" });
    expect((await call("flow_transition", { id: t.id, action: "approve", actor: "claude:reviewer" })).data.status).toBe("done");
    const events = (await call("flow_events", { ticket_id: t.id })).data;
    expect(events.length).toBeGreaterThan(5);
  });

  it("requires confirmation for destructive tools", async () => {
    const { call } = await connect();
    const t = (await call("flow_create", { title: "Throwaway" })).data;
    const denied = await call("flow_cancel", { id: t.id });
    expect(denied.data.error.code).toBe("CONFIRMATION_REQUIRED");
    expect((await call("flow_cancel", { id: t.id, confirmed: true })).data.status).toBe("cancelled");
  });

  it("validates input with zod", async () => {
    const { client } = await connect();
    const res = (await client.callTool({ name: "flow_create", arguments: { title: "x" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("serves over stdio through the real binary", async () => {
    const dir = tempDir("af-mcp-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    initWorkspace(dir);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "bin", "agent-flow.js"), "mcp", "-C", dir, "--actor", "claude:stdio"],
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    const created = (await client.callTool({ name: "flow_create", arguments: { title: "Over stdio", ready: true } })) as { content: Array<{ text: string }> };
    const id = JSON.parse(created.content[0].text).id;
    const claim = (await client.callTool({ name: "flow_claim", arguments: { next: true } })) as { content: Array<{ text: string }> };
    expect(JSON.parse(claim.content[0].text)).toMatchObject({ id, owner: "claude:stdio", status: "claimed" });
    await client.close();
  }, 30000);
});
