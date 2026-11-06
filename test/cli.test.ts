import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { main } from "../src/cli/main.js";
import { tempDir } from "./helpers.js";

const BIN = path.join(__dirname, "..", "bin", "agent-flow.js");

function repo(): string {
  const dir = tempDir("af-cli-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

async function af(cwd: string, args: string[], actor = "human:test") {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "-C", cwd, "--actor", actor], { stdout: (s) => (stdout += `${s}\n`), stderr: (s) => (stderr += `${s}\n`) });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("cli", () => {
  it("init → create → claim → handoff → submit → approve with JSON output and exit codes", async () => {
    const dir = repo();
    expect((await af(dir, ["init", "--dod", "true"])).code).toBe(0);
    const created = (await af(dir, ["create", "Ship it", "--ready", "--ac", "it ships", "--json"])).json();
    const id = created.id as string;
    const claim = (await af(dir, ["claim", "--next", "--json"], "claude:a")).json();
    expect(claim.id).toBe(id);
    expect(claim.branch).toMatch(new RegExp(`^af/${id}-ship-it$`));
    const gate = await af(dir, ["submit", id, "--json"], "claude:a");
    expect(gate.code).toBe(2);
    expect(gate.json().error.code).toBe("GATE_FAILED");
    await af(dir, ["note", id, "--handoff", "shipped"], "claude:a");
    const sub = (await af(dir, ["submit", id, "--json"], "claude:a")).json();
    expect(sub.ticket.status).toBe("review");
    expect(sub.dod.passed).toBe(true);
    await af(dir, ["ac", "verify", id, "AC-1", "--evidence", "ci green"], "codex:reviewer");
    expect((await af(dir, ["approve", id, "--json"], "codex:reviewer")).json().status).toBe("done");
    expect((await af(dir, ["audit", "verify", "--json"])).json().ok).toBe(true);
  });

  it("binds the ticket from the branch name", async () => {
    const dir = repo();
    await af(dir, ["init"]);
    const t = (await af(dir, ["create", "Branch bound", "--ready", "--json"])).json();
    const c = (await af(dir, ["claim", t.id, "--json"], "claude:a")).json();
    execFileSync("git", ["switch", "-q", "-c", c.branch], { cwd: dir });
    const prime = (await af(dir, ["prime", "--json"], "claude:other")).json();
    expect(prime.ticket).toBe(t.id);
    expect(prime.text).toContain("Current ticket");
    expect((await af(dir, ["show", "--json"], "claude:other")).json().id).toBe(t.id);
  });

  it("reports structured errors for unknown tickets and bad flags", async () => {
    const dir = repo();
    await af(dir, ["init"]);
    const r = await af(dir, ["show", "af-zzzzz", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("NOT_FOUND");
    const bad = await af(dir, ["list", "--nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("usage:");
  });

  it("parallel processes racing claim --next never double-claim", async () => {
    const dir = repo();
    await af(dir, ["init"]);
    // per-agent WIP is 1 and column WIP 4 by default → raise column limit for the race.
    const cfgPath = path.join(dir, ".agent-flow", "config.json");
    const fs = await import("node:fs");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.wip.columns = {};
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    for (let i = 0; i < 5; i++) await af(dir, ["create", `task ${i}`, "--ready"]);
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new Promise<{ code: number; out: string }>((resolve) => {
          const p = spawn(process.execPath, [BIN, "claim", "--next", "--json", "-C", dir, "--actor", `claude:racer${i}`]);
          let out = "";
          p.stdout.on("data", (b) => (out += b));
          p.on("close", (code) => resolve({ code: code ?? 1, out }));
        }),
      ),
    );
    const won = runs.filter((r) => r.code === 0).map((r) => JSON.parse(r.out).id as string);
    expect(won).toHaveLength(5);
    expect(new Set(won).size).toBe(5);
    const lost = runs.filter((r) => r.code !== 0).map((r) => JSON.parse(r.out).error.code);
    expect(lost.every((c) => c === "NOT_FOUND")).toBe(true);
  }, 60000);

  it("imports framework tasks via the CLI", async () => {
    const dir = repo();
    await af(dir, ["init"]);
    const fx = path.join(__dirname, "fixtures", "framework");
    const r = (await af(dir, ["import-tasks", path.join(fx, "tasks.md"), "--spec", path.join(fx, "spec.md"), "--json"])).json();
    expect(r.created).toHaveLength(4);
    expect(r.epic.title).toBe("Orders pagination");
  });
});
