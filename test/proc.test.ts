import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
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

describe.runIf(WIN)("runShell on Windows", () => {
  it("runs a quoted executable path", async () => {
    const r = await runShell(`"${process.execPath}" -e "process.stdout.write('quoted-ok')"`);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("quoted-ok");
  });

  it("keeps quotes and operators working", async () => {
    const r = await runShell('echo "a"&& echo "b"');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"a"');
    expect(r.stdout).toContain('"b"');
    expect(r.stdout).not.toContain("\\");
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

  it.each([
    ['foo" & echo INJECTED> marker.txt'],
    ['a"&echo INJECTED>marker.txt&"'],
    ['x" | echo INJECTED> marker.txt'],
    ['say "hi" & echo INJECTED> marker.txt'],
    ["ends with a backslash\\"],
    ["!PATH!"],
    [""],
  ])("delivers %j unchanged and runs nothing else", async (arg) => {
    const cwd = tempDir();
    const r = await run([installCmd("af-tool").cmd, arg], { cwd });
    expect(existsSync(path.join(cwd, "marker.txt"))).toBe(false);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([arg]);
  });

  it.each([['two\\"quote'], ['a\\\\"b"c'], ['"&echo INJECTED>marker.txt&""a"'], ["trailing\\\\"], ['\\\\"&echo INJECTED>marker.txt&"  ']])("keeps backslashes before a quote: %j", async (arg) => {
    const cwd = tempDir();
    const r = await run([installCmd("af-tool").cmd, arg, "next"], { cwd });
    expect(existsSync(path.join(cwd, "marker.txt"))).toBe(false);
    expect(JSON.parse(r.stdout)).toEqual([arg, "next"]);
  });

  it.each([["line one\nline two"], ["a\r\nb"], ["\n&echo INJECTED>marker.txt\n"]])("refuses %j rather than cut it short, because cmd.exe cannot carry a newline", async (arg) => {
    const cwd = tempDir();
    const r = await run([installCmd("af-tool").cmd, arg], { cwd });
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("newline");
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(cwd, "marker.txt"))).toBe(false);
  });

  it("survives seeded random arguments built from cmd.exe metacharacters", async () => {
    const atoms = ['"', "\\", "\\\\", "&", "|", "<", ">", "^", "%", "!", "(", ")", ";", ",", " ", "  ", "`", "*", "?", "%PATH%", "%~dp0", "%*", "a", "é", '" & echo PWN>pwn.txt & "', '"&echo PWN>pwn.txt&"', "^&", '\\"'];
    let seed = 20261107;
    const next = (n: number) => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
    const { cmd } = installCmd("af-tool");
    const cwd = tempDir();
    for (let i = 0; i < 60; i++) {
      const args = Array.from({ length: 1 + next(3) }, () => Array.from({ length: 1 + next(7) }, () => atoms[next(atoms.length)]).join(""));
      const r = await run([cmd, ...args], { cwd });
      expect(JSON.parse(r.stdout), JSON.stringify(args)).toEqual(args);
      expect(readdirSync(cwd), JSON.stringify(args)).toEqual([]);
    }
  }, 60000);
  it("treats a .bat the same way", async () => {
    const { bin, cmd } = installCmd("af-tool");
    const bat = path.join(bin, "af-tool.bat");
    copyFileSync(cmd, bat);
    const cwd = tempDir();
    const arg = 'foo" & echo INJECTED> marker.txt';
    const r = await run([bat, arg], { cwd });
    expect(existsSync(path.join(cwd, "marker.txt"))).toBe(false);
    expect(JSON.parse(r.stdout)).toEqual([arg]);
  });
  it("does not let an argument run a second command", async () => {
    const marker = path.join(tempDir(), "injected.txt");
    await run([installCmd("af-tool").cmd, `x" & echo pwned> "${marker}" & "`]);
    expect(existsSync(marker)).toBe(false);
  });
});
