import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, runShell } from "../src/core/proc.js";
import { tempDir } from "./helpers.js";

const WIN = process.platform === "win32";
const ECHO_ARGS = `process.stdout.write(JSON.stringify(process.argv.slice(2)));`;

describe("run", () => {
  it("passes arguments through unchanged", async () => {
    const args = ["a b", "c&d", 'say "hi"', "100%"];
    const entry = path.join(tempDir(), "cli.cjs");
    writeFileSync(entry, ECHO_ARGS);
    const r = await run([process.execPath, entry, ...args]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  it("reports a missing binary as -1 instead of throwing", async () => {
    expect((await run(["af-no-such-binary-xyz"])).code).toBe(-1);
  });

  it("forwards stdin and the exit code", async () => {
    const r = await run([process.execPath, "-e", `process.stdout.write(require("fs").readFileSync(0,"utf8")); process.exitCode = 3`], { input: "hello" });
    expect(r).toMatchObject({ code: 3, stdout: "hello" });
  });
});

describe("runShell", () => {
  it("runs a command line through the platform shell", async () => {
    const r = await runShell("echo agent-flow-shell");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("agent-flow-shell");
  });
});

describe.runIf(WIN)("run with a .cmd CLI", () => {
  /** A .cmd that forwards its arguments the way npm's shims do, in a folder with a space. */
  function installCmd(name: string): { bin: string; cmd: string } {
    const bin = tempDir("af bin ");
    const entry = path.join(tempDir("af-entry-"), "cli.cjs");
    writeFileSync(entry, ECHO_ARGS);
    const cmd = path.join(bin, `${name}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "${entry}" %*\r\n@exit /b %errorlevel%\r\n`);
    return { bin, cmd };
  }

  it("runs one from a path with a space", async () => {
    const r = await run([installCmd("af-tool").cmd, "ok"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["ok"]);
  });

  it("finds a bare name on PATH, as npm installs CLIs", async () => {
    const { bin } = installCmd("af-bare-tool");
    const r = await run(["af-bare-tool", "ok"], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["ok"]);
  });

  it.each([["a space", "a b"], ["an ampersand", "a&b"], ["a pipe", "a|b"], ["percent signs", "%PATH%"], ["a caret", "a^b"], ["a redirect", "a>b"]])("keeps %s in an argument intact", async (_name, arg) => {
    const r = await run([installCmd("af-tool").cmd, arg]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([arg]);
  });

  it("does not let an argument run a second command", async () => {
    const marker = path.join(tempDir(), "injected.txt");
    await run([installCmd("af-tool").cmd, `x" & echo pwned> "${marker}" & "`]);
    expect(existsSync(marker)).toBe(false);
  });
});
