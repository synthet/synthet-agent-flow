import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli/main.js";
import { createFlowMcpServer } from "../src/mcp/server.js";
import {
  hubTokenFile,
  readRegistry,
  registerWorkspace,
  registryPath,
  scanForWorkspaces,
  unregisterWorkspace,
} from "../src/core/registry.js";
import { initWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";

function project(parent = tempDir("af-reg-"), name = "proj"): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  initWorkspace(dir);
  return dir;
}

async function af(cwd: string, args: string[]) {
  let stdout = "";
  const code = await main([...args, "-C", cwd, "--actor", "human:test", "--json"], { stdout: (s) => (stdout += `${s}\n`), stderr: () => {} });
  return { code, json: () => JSON.parse(stdout) };
}

const saved = process.env.AGENT_FLOW_REGISTRY;
afterEach(() => {
  process.env.AGENT_FLOW_REGISTRY = saved;
});

/** A fresh registry for one test, set through the env so CLI and MCP code paths use it too. */
function freshRegistry(): string {
  const file = path.join(tempDir("af-regfile-"), "workspaces.json");
  process.env.AGENT_FLOW_REGISTRY = file;
  return file;
}

describe("workspace registry", () => {
  it("is never the real ~/.agent-flow file under test", () => {
    expect(registryPath()).toBe(path.resolve(saved as string));
    expect(hubTokenFile("/x/y/workspaces.json")).toBe(path.join("/x/y", "serve.json"));
  });

  it("registers idempotently and disambiguates projects that share a folder name", () => {
    const file = freshRegistry();
    const a = project(tempDir("af-reg-a-"), "app");
    const b = project(tempDir("af-reg-b-"), "app");
    const first = registerWorkspace(a, file)!;
    expect(first).toMatchObject({ added: true, entry: { id: "app", name: "app" } });
    expect(registerWorkspace(path.join(a, "."), file)!.added).toBe(false);
    const second = registerWorkspace(b, file)!;
    expect(second.entry.id).toMatch(/^app-[0-9a-f]{6}$/);
    expect(readRegistry(file).map((e) => e.id)).toEqual(["app", second.entry.id]);
    expect(unregisterWorkspace("app", file)?.root).toBe(first.entry.root);
    expect(unregisterWorkspace(b, file)?.id).toBe(second.entry.id);
    expect(readRegistry(file)).toEqual([]);
  });

  it("refuses a directory without .agent-flow/ and reads a broken file as empty", () => {
    const file = freshRegistry();
    expect(() => registerWorkspace(tempDir("af-reg-none-"), file)).toThrow(/no \.agent-flow/);
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "{not json")`]);
    expect(readRegistry(file)).toEqual([]);
  });

  it("AGENT_FLOW_REGISTRY=off disables registration", () => {
    process.env.AGENT_FLOW_REGISTRY = "off";
    expect(registryPath()).toBeNull();
    expect(registerWorkspace(project())).toBeNull();
    expect(readRegistry()).toEqual([]);
  });

  it("scan finds direct children with .agent-flow/", () => {
    const parent = tempDir("af-reg-scan-");
    project(parent, "one");
    project(parent, "two");
    mkdirSync(path.join(parent, "plain"));
    expect(scanForWorkspaces(parent).map((p) => path.basename(p))).toEqual(["one", "two"]);
  });

  it("init and the MCP server register the project", async () => {
    const file = freshRegistry();
    const dir = tempDir("af-reg-init-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const init = await af(dir, ["init"]);
    expect(init.code).toBe(0);
    expect(init.json().workspace).toBe(path.basename(dir).toLowerCase());
    expect(readRegistry(file)).toHaveLength(1);

    const other = project(tempDir("af-reg-mcp-"), "via-mcp");
    const mcp = createFlowMcpServer({ cwd: other, actor: "claude:t" });
    mcp.workspace();
    mcp.close();
    expect(readRegistry(file).map((e) => e.id)).toEqual([path.basename(dir).toLowerCase(), "via-mcp"]);
  });

  it("workspaces add | list | scan | remove", async () => {
    const file = freshRegistry();
    const parent = tempDir("af-reg-cli-");
    const one = project(parent, "one");
    project(parent, "two");
    expect((await af(one, ["workspaces", "add"])).json()[0]).toMatchObject({ id: "one", added: true });
    const dry = (await af(one, ["workspaces", "scan", parent, "--dry-run"])).json();
    expect(dry.workspaces.map((w: { added: boolean }) => w.added)).toEqual([false, true]);
    expect(readRegistry(file)).toHaveLength(1);
    const scan = (await af(one, ["workspaces", "scan", parent])).json();
    expect(scan.workspaces.map((w: { id: string; added: boolean }) => [w.id, w.added])).toEqual([["one", false], ["two", true]]);
    const list = (await af(one, ["workspaces"])).json();
    expect(list.workspaces.map((w: { id: string; available: boolean }) => [w.id, w.available])).toEqual([["one", true], ["two", true]]);
    expect((await af(one, ["workspaces", "remove", "two"])).code).toBe(0);
    expect((await af(one, ["workspaces", "remove", "two"])).code).not.toBe(0);
    expect(readRegistry(file).map((e) => e.id)).toEqual(["one"]);
    expect(existsSync(path.join(parent, "two", ".agent-flow", "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });
});
