import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";
// @ts-expect-error plain ESM module shipped with the plugin
import { resolveCli, spawnTarget, splitBin } from "../plugin/scripts/resolve.mjs";

const WIN = process.platform === "win32";
const SCRIPTS = path.join(__dirname, "..", "plugin", "scripts");
const HOOK = path.join(SCRIPTS, "hook.mjs");
const AF = path.join(SCRIPTS, "af.mjs");
const CLI = path.join(__dirname, "..", "bin", "agent-flow.js");

/** Stub CLI bodies, run by node so the same stub works on every platform. */
const recordingCli = (log: string) =>
  `const fs = require("fs");
   fs.writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n" + fs.readFileSync(0, "utf8"));
   process.stdout.write('{"ok":true}\\n');`;
const failingCli = `require("fs").readFileSync(0); console.error("DoD failing"); process.exitCode = 2;`;

/** Lay out a stub CLI the way npm installs one on this platform, and return its bin dir. */
function installCli(body: string): string {
  const bin = tempDir("af-bin-");
  const entry = path.join(bin, "node_modules", "synthet-agent-flow", "bin", "agent-flow.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, body);
  if (WIN) {
    writeFileSync(path.join(bin, "agent-flow.cmd"), `@"${process.execPath}" "${entry}" %*\r\n`);
  } else {
    const launcher = path.join(bin, "agent-flow");
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return bin;
}

/** cmd.exe needs these to start, and the shims run with a minimal environment here. */
const baseEnv = () => ({
  HOME: process.env.HOME ?? "",
  ...(WIN ? { SystemRoot: process.env.SystemRoot ?? "", ComSpec: process.env.ComSpec ?? "" } : {}),
});

const runScript = (script: string, args: string[], env: Record<string, string>, input: string) =>
  spawnSync(process.execPath, [script, ...args], { input, env: { ...baseEnv(), ...env }, encoding: "utf8" });

describe("plugin CLI resolver", () => {
  it("prefers AGENT_FLOW_BIN, including a JSON array for paths with spaces", () => {
    expect(resolveCli({ env: { AGENT_FLOW_BIN: "node /opt/af/bin/agent-flow.js", PATH: "/usr/bin" } }).argv).toEqual(["node", "/opt/af/bin/agent-flow.js"]);
    expect(splitBin('["C:\\\\Program Files\\\\nodejs\\\\node.exe","C:\\\\af x\\\\cli.js"]')).toEqual(["C:\\Program Files\\nodejs\\node.exe", "C:\\af x\\cli.js"]);
  });

  it("finds agent-flow on a POSIX PATH", () => {
    const r = resolveCli({ env: { PATH: "/a:/b" }, platform: "linux", exists: (p: string) => p === "/b/agent-flow" });
    expect(r).toEqual({ argv: ["/b/agent-flow"], shell: false, via: "PATH" });
  });

  it("on Windows, turns npm's .cmd shim into `node <entry.js>` (no cmd.exe)", () => {
    const files = new Set(["C:\\npm\\agent-flow.cmd", "C:\\npm\\node_modules\\synthet-agent-flow\\bin\\agent-flow.js"]);
    const r = resolveCli({ env: { Path: "C:\\Windows;C:\\npm" }, platform: "win32", exists: (p: string) => files.has(p), nodePath: "C:\\node\\node.exe" });
    expect(r).toEqual({ argv: ["C:\\node\\node.exe", "C:\\npm\\node_modules\\synthet-agent-flow\\bin\\agent-flow.js"], shell: false, via: "npm shim" });
  });

  it("on Windows, falls back to the .cmd shim through the shell when the entry is elsewhere", () => {
    const r = resolveCli({ env: { PATH: "D:\\tools" }, platform: "win32", exists: (p: string) => p === "D:\\tools\\agent-flow.cmd" });
    expect(r).toEqual({ argv: ["D:\\tools\\agent-flow.cmd"], shell: true, via: "cmd shim" });
  });

  it("returns null when nothing is installed", () => {
    expect(resolveCli({ env: { PATH: "/nope" }, platform: "linux", exists: () => false })).toBeNull();
  });

  it("quotes the command when a shell will parse it, because Node does not", () => {
    expect(spawnTarget({ argv: ["C:\\a b\\agent-flow.cmd"], shell: true }, ["hook", "a b"])).toEqual({ cmd: '"C:\\a b\\agent-flow.cmd" hook "a b"', args: [] });
    expect(spawnTarget({ argv: ["/a b/agent-flow", "x"], shell: false }, ["y z"])).toEqual({ cmd: "/a b/agent-flow", args: ["x", "y z"] });
  });

  it("passes no args array with a shell, which Node 24 deprecates (DEP0190)", () => {
    expect(spawnTarget({ argv: ["D:\\tools\\agent-flow.cmd"], shell: true }, ["mcp"]).args).toEqual([]);
  });

  it("leaves a bare .cmd name unquoted: cmd.exe resolves %~dp0 to the cwd for a quoted name found on PATH", () => {
    expect(spawnTarget({ argv: ["npx.cmd", "--yes"], shell: true }).cmd).toBe("npx.cmd --yes");
  });
});

describe("hook.mjs shim", () => {
  const run = (env: Record<string, string>, input: string) => runScript(HOOK, ["session-start"], env, input);

  it("fails open with {} when the CLI is missing", () => {
    const r = run({ PATH: tempDir() }, '{"session_id":"x"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("{}");
  });

  it("invokes the CLI with `hook <event>` and forwards stdin and stdout", () => {
    const log = path.join(tempDir(), "log.txt");
    const r = run({ PATH: installCli(recordingCli(log)) }, '{"session_id":"abc"}');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"ok":true}');
    expect(readFileSync(log, "utf8")).toBe('hook session-start\n{"session_id":"abc"}');
  });

  it("passes exit code 2 through (DoD gate)", () => {
    const r = run({ PATH: installCli(failingCli) }, "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DoD failing");
  });

  it("drives the real CLI through AGENT_FLOW_BIN", () => {
    const dir = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    initWorkspace(dir);
    const ws = openWorkspace(dir);
    ws.store.create({ title: "Reached the real CLI", status: "ready" }, "human:x");
    ws.close();
    // The JSON form, because node.exe usually sits under "Program Files". The ticket title proves the CLI ran:
    // a failed launch also prints {}, so asserting on {} alone cannot tell the two apart.
    const r = run({ PATH: process.env.PATH ?? "", AGENT_FLOW_BIN: JSON.stringify([process.execPath, CLI]) }, JSON.stringify({ cwd: dir, session_id: "abcd1234", source: "startup" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("Reached the real CLI");
  });
});

describe.runIf(WIN)("a .cmd CLI in a path with a space", () => {
  /** A bare .cmd with no npm layout next to it, so the shims have to go through cmd.exe. */
  function installCmd(body: string): string {
    const bin = tempDir("af bin ");
    const entry = path.join(tempDir("af-entry-"), "cli.cjs");
    writeFileSync(entry, body);
    writeFileSync(path.join(bin, "agent-flow.cmd"), `@"${process.execPath}" "${entry}" %*\r\n@exit /b %errorlevel%\r\n`);
    return bin;
  }

  it("hook.mjs runs it and forwards stdin and stdout", () => {
    const log = path.join(tempDir(), "log.txt");
    const r = runScript(HOOK, ["session-start"], { PATH: installCmd(recordingCli(log)) }, '{"session_id":"abc"}');
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"ok":true}');
    expect(readFileSync(log, "utf8")).toBe('hook session-start\n{"session_id":"abc"}');
  });

  it("hook.mjs passes exit code 2 through", () => {
    const r = runScript(HOOK, ["session-start"], { PATH: installCmd(failingCli) }, "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DoD failing");
  });

  it("af.mjs runs it", () => {
    const log = path.join(tempDir(), "log.txt");
    const r = runScript(AF, ["mcp"], { PATH: installCmd(recordingCli(log)) }, "");
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("mcp\n");
  });
});
