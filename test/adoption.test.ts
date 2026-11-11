import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../src/core/proc.js";
import { adoptionReport, parseSince } from "../src/integrations/adoption.js";
import { main } from "../src/cli/main.js";
import { tempDir } from "./helpers.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function tracked(root: string, name: string, tickets: Array<Record<string, unknown>> = []): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, ".agent-flow"), { recursive: true });
  writeFileSync(path.join(dir, ".agent-flow", "config.json"), "{}\n");
  writeFileSync(path.join(dir, ".agent-flow", "tickets.jsonl"), tickets.map((t) => JSON.stringify(t)).join("\n") + (tickets.length ? "\n" : ""));
  return dir;
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, ms: 1 });

describe("adoption report", () => {
  it("parses windows like 30d, 2w, 12h and ISO dates", () => {
    expect(parseSince("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(parseSince("2w", NOW)).toBe(NOW - 14 * DAY);
    expect(parseSince("12h", NOW)).toBe(NOW - 12 * 3_600_000);
    expect(parseSince("2026-11-01", NOW)).toBe(Date.parse("2026-11-01"));
    expect(() => parseSince("soon", NOW)).toThrow();
  });

  it("counts tickets in the window from each snapshot, counts commits, and flags untracked activity", async () => {
    const root = tempDir("af-adopt-");
    tracked(root, "busy", [
      { id: "a-1", status: "done", created_at: iso(NOW - 2 * DAY), claimed_at: iso(NOW - 2 * DAY), closed_at: iso(NOW - DAY) },
      { id: "a-2", status: "ready", created_at: iso(NOW - 40 * DAY), claimed_at: null, closed_at: null },
    ]);
    tracked(root, "silent");
    mkdirSync(path.join(root, "untracked-repo"));
    const counts: string[][] = [];
    const run = async (argv: string[]) => {
      if (argv.includes("config")) return ok("dev@example.test\n");
      counts.push(argv);
      return ok(argv.some((a) => a.endsWith("busy")) ? "3\n" : "5\n");
    };
    const rows = await adoptionReport({ root, sinceMs: NOW - 30 * DAY, run });
    expect(rows.map((r) => r.repo)).toEqual(["silent", "busy"]); // untracked activity first
    const busy = rows.find((r) => r.repo === "busy")!;
    expect(busy).toMatchObject({ created: 1, claimed: 1, done: 1, commits: 3, untracked: false });
    const silent = rows.find((r) => r.repo === "silent")!;
    expect(silent).toMatchObject({ created: 0, claimed: 0, done: 0, commits: 5, untracked: true });
    expect(counts.every((c) => c[0] === "git" && c.includes("rev-list") && c.includes("--count"))).toBe(true);
    expect(counts.every((c) => c.includes("--author=dev@example.test"))).toBe(true); // only the repo user's commits
    expect(counts).toHaveLength(2); // the repo without .agent-flow is skipped
  });

  it("counts a linked checkout once, under its real name", async () => {
    const root = tempDir("af-adopt-");
    const real = tracked(root, "pipeline");
    symlinkSync(real, path.join(root, "a-backend-link"), "junction");
    const rows = await adoptionReport({ root, sinceMs: NOW - DAY, run: async () => ok("0\n") });
    expect(rows.map((r) => r.repo)).toEqual(["pipeline"]);
  });

  it("records a git failure as an error instead of failing the report", async () => {
    const root = tempDir("af-adopt-");
    tracked(root, "broken");
    const rows = await adoptionReport({ root, sinceMs: NOW - DAY, run: async () => ({ ...ok(""), code: 128, stderr: "not a git repository" }) });
    expect(rows[0]).toMatchObject({ repo: "broken", commits: 0, untracked: false });
    expect(rows[0].error).toContain("not a git repository");
  });

  it("agent-flow adoption --json reports real repos under --root", async () => {
    const root = tempDir("af-adopt-cli-");
    const dir = tracked(root, "real");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "work"], { cwd: dir });
    // Someone else's commit (an upstream author in a fork) is not counted.
    execFileSync("git", ["-c", "user.email=upstream@x", "commit", "-q", "--allow-empty", "-m", "upstream"], { cwd: dir });
    let stdout = "";
    const code = await main(["adoption", "--root", root, "--since", "7d", "--json", "--actor", "human:test"], { stdout: (s) => (stdout += s), stderr: () => {} });
    expect(code).toBe(0);
    const rows = JSON.parse(stdout) as Array<{ repo: string; commits: number; untracked: boolean }>;
    expect(rows).toEqual([expect.objectContaining({ repo: "real", commits: 1, untracked: true })]);
  });
});
