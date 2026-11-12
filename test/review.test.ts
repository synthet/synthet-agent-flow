import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main } from "../src/cli/main.js";
import { defaultConfig } from "../src/core/config.js";
import { flowPaths } from "../src/core/paths.js";
import { FlowStore } from "../src/core/store.js";
import { createFlowMcpServer } from "../src/mcp/server.js";
import { tempDir } from "./helpers.js";

const AUTHOR = "claude:author";

async function af(cwd: string, args: string[], actor = AUTHOR) {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "-C", cwd, "--actor", actor, "--json"], { stdout: (s) => (stdout += `${s}\n`), stderr: (s) => (stderr += `${s}\n`) });
  return { code, json: () => JSON.parse(stdout || stderr) };
}

function repo(): string {
  const dir = tempDir("af-review-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

describe("independent review brief (CLI)", () => {
  it("hands out a reviewer identity that can approve where the author cannot", async () => {
    const dir = repo();
    await af(dir, ["init"], "human:test");
    const id = (await af(dir, ["create", "Add pagination", "--ready", "--ac", "pages of 50", "--ac", "400 on bad page"], "human:test")).json().id as string;
    await af(dir, ["claim", id]);
    await af(dir, ["ac", "verify", id, "AC-1", "--evidence", "author: npm test ok"]);
    await af(dir, ["ac", "verify", id, "AC-2", "--evidence", "author: npm test ok"]);

    // Not in review yet: no brief.
    const early = await af(dir, ["review", id, "--brief"]);
    expect(early.code).not.toBe(0);
    expect(early.json().error.code).toBe("INVALID_TRANSITION");

    await af(dir, ["note", id, "--handoff", "paginated GET /orders; tests in test/orders.test.ts"]);
    expect((await af(dir, ["submit", id])).code).toBe(0);
    expect((await af(dir, ["approve", id])).json().error.code).toBe("GATE_FAILED");

    const brief = (await af(dir, ["review", id, "--brief"])).json();
    expect(brief.reviewer).toMatch(new RegExp(`^claude:review-${id}-[0-9a-f]{6}$`));
    expect(brief.requested_by).toBe(AUTHOR);
    expect(brief.prompt).toContain(brief.reviewer);
    expect(brief.prompt).toContain("pages of 50");
    expect(brief.prompt).toContain("paginated GET /orders");
    expect(brief.commands.approve).toBe(`agent-flow approve ${id} --actor ${brief.reviewer}`);

    // The reviewer has to record its own verdicts; the author's are not enough.
    expect((await af(dir, ["approve", id], brief.reviewer)).json().error.code).toBe("GATE_FAILED");
    for (const ac of ["AC-1", "AC-2"]) await af(dir, ["ac", "verify", id, ac, "--evidence", "reviewer: re-ran npm test"], brief.reviewer);
    expect((await af(dir, ["approve", id], brief.reviewer)).json().status).toBe("done");

    const events = (await af(dir, ["events", id, "--limit", "100"])).json() as Array<{ action: string; actor: string; payload: { reviewer?: string } }>;
    expect(events.find((e) => e.action === "review.requested")).toMatchObject({ actor: AUTHOR, payload: { reviewer: brief.reviewer } });
  });
});

describe("independent review brief (MCP)", () => {
  it("flow_review_brief gives a subagent an actor that approves through the same MCP server", async () => {
    const store = FlowStore.open(":memory:", { config: defaultConfig() });
    const ws = { paths: flowPaths(tempDir()), config: store.config, store, close: () => store.close() };
    const { server } = createFlowMcpServer({ workspace: ws, actor: AUTHOR });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
    };

    const t = store.create({ title: "MCP ticket", status: "ready", acceptance: ["works"] }, "human:x");
    store.claim(t.id, AUTHOR);
    store.comment(t.id, "handoff", "done", AUTHOR);
    store.transition(t.id, "submit", AUTHOR);

    const brief = (await call("flow_review_brief", { id: t.id, harness: "codex" })).data;
    expect(brief.reviewer).toMatch(new RegExp(`^codex:review-${t.id}-`));
    // A subagent shares this MCP server; it acts as the reviewer by passing `actor`.
    expect((await call("flow_transition", { id: t.id, action: "approve" })).isError).toBe(true);
    await call("flow_ac", { id: t.id, op: "verify", ac_id: "AC-1", verdict: "Verified", evidence: "reviewer ran the tests", actor: brief.reviewer });
    const approved = await call("flow_transition", { id: t.id, action: "approve", actor: brief.reviewer });
    expect(approved.isError).toBe(false);
    expect(store.get(t.id).status).toBe("done");
    store.close();
  });
});
