import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { initWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "agent-flow.js");

function project(): string {
  const dir = tempDir("af-tray-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  initWorkspace(dir, {} as never);
  return dir;
}

describe("serve --exit-on-stdin-close", () => {
  it("serves the dashboard, then exits 0 when its stdin closes", async () => {
    const child = spawn(process.execPath, [BIN, "serve", "--port", "0", "--exit-on-stdin-close", "--json", "-C", project(), "--actor", "human:test"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no url in: ${out}`)), 20_000);
      child.stdout.on("data", (b: Buffer) => {
        out += b.toString();
        const m = /"url":\s*"([^"]+)"/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    const res = await fetch(new URL("api/board", url), { headers: { connection: "close" } });
    expect(res.status).toBe(200);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 10_000))]);
    if (code === "still running") child.kill();
    expect(code).toBe(0);
  }, 40_000);
});

// The exe is a GUI app, so CI only checks that it builds and passes its own startup checks.
// The tray itself is checked by hand: it needs a desktop session.
describe.skipIf(process.platform !== "win32")("Windows tray app", () => {
  it("builds with the .NET Framework compiler, finds the checkout and icon, and is DPI aware", () => {
    const exe = path.join(tempDir("af-tray-exe-"), "AgentFlowTray.exe");
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "build-tray.ps1"), "-Out", exe], { stdio: "pipe" });
    expect(existsSync(exe)).toBe(true);
    // --check never touches a running tray: no mutex, no quit event, no UI.
    expect(spawnSync(exe, ["--check"], { env: { ...process.env, AGENT_FLOW_ROOT: ROOT }, timeout: 20_000 }).status).toBe(0);
    expect(spawnSync(exe, ["--check"], { env: { ...process.env, AGENT_FLOW_ROOT: tempDir("af-not-a-checkout-") }, timeout: 20_000 }).status).toBe(2);
  }, 120_000);
});
