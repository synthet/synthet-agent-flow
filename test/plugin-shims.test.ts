import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";
// @ts-expect-error plain ESM module shipped with the plugin
import { resolveCli, splitBin } from "../plugin/scripts/resolve.mjs";

const HOOK = path.join(__dirname, "..", "plugin", "scripts", "hook.mjs");

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
});

describe("hook.mjs shim", () => {
  const run = (env: Record<string, string>, input: string) =>
    spawnSync(process.execPath, [HOOK, "session-start"], { input, env: { HOME: process.env.HOME ?? "", ...env }, encoding: "utf8" });

  it("fails open with {} when the CLI is missing", () => {
    const r = run({ PATH: tempDir() }, '{"session_id":"x"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("{}");
  });

  it("invokes the CLI with `hook <event>` and forwards stdin and stdout", () => {
    const bin = tempDir("af-bin-");
    const log = path.join(bin, "log.txt");
    const stub = path.join(bin, "agent-flow");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${log}"\ncat >> "${log}"\necho '{"ok":true}'\n`);
    chmodSync(stub, 0o755);
    const r = run({ PATH: `${bin}:/usr/bin:/bin` }, '{"session_id":"abc"}');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"ok":true}');
    expect(readFileSync(log, "utf8")).toBe('hook session-start\n{"session_id":"abc"}');
  });

  it("passes exit code 2 through (DoD gate)", () => {
    const bin = tempDir("af-bin-");
    const stub = path.join(bin, "agent-flow");
    writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho "DoD failing" >&2\nexit 2\n');
    chmodSync(stub, 0o755);
    const r = run({ PATH: `${bin}:/usr/bin:/bin` }, "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DoD failing");
  });

  it("drives the real CLI through AGENT_FLOW_BIN", () => {
    const r = run({ PATH: process.env.PATH ?? "", AGENT_FLOW_BIN: `${process.execPath} ${path.join(__dirname, "..", "bin", "agent-flow.js")}` }, JSON.stringify({ cwd: tempDir() }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}"); // not an agent-flow repo → silent
  });
});
