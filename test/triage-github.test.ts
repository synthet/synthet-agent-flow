import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Runner } from "../src/integrations/exec.js";
import { decideTriage, jevPayload, needsApproval, type TriagePlan } from "../src/integrations/triage.js";
import { applyIssues, ghRepoFromUrl, restoreIssues, scanIssues, verifyIssues } from "../src/integrations/triage-github.js";
import { tempDir } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
const TOKEN = `ghp_${"Zq9".repeat(13)}`;

function fakeGh(state: { issueState?: Record<number, { state: string; updatedAt: string }> } = {}) {
  const calls: string[][] = [];
  const issues = [
    { number: 1, title: "Crash when importing XMP sidecars", body: "Fails in `src/import/xmp.ts`", updatedAt: ago(120), labels: [] },
    { number: 2, title: "Add dark mode toggle", body: "", updatedAt: ago(90), labels: [{ name: "pinned" }] },
    { number: 3, title: "Recent bug", body: "", updatedAt: ago(5), labels: [] },
    { number: 4, title: "Crash when importing XMP sidecars again", body: `token ${TOKEN}`, updatedAt: ago(70), labels: [] },
  ];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false, ms: 1 });
    const cmd = argv.join(" ");
    if (cmd.includes("remote get-url origin")) return ok("https://github.com/acme/app.git\n");
    if (cmd === "gh api user -q .login") return ok("acme\n");
    if (cmd.startsWith("gh issue list")) return ok(JSON.stringify(issues));
    if (cmd.startsWith("gh pr list")) return ok(JSON.stringify([{ number: 9, title: "Fix XMP import", body: "Closes #1" }]));
    if (cmd.startsWith("git -C") && cmd.includes(" log ")) return ok(cmd.includes("#1(") ? "2026-06-01\n" : "");
    if (cmd.startsWith("gh issue view")) {
      const n = Number(argv[3]);
      if (cmd.includes("state,updatedAt")) return ok(JSON.stringify(state.issueState?.[n] ?? { state: "OPEN", updatedAt: issues.find((i) => i.number === n)?.updatedAt }));
      if (cmd.endsWith("--json state")) return ok(JSON.stringify({ state: "CLOSED" }));
      return ok(JSON.stringify({ title: "x", body: `secret ${TOKEN}`, comments: [] }));
    }
    if (cmd.startsWith("gh issue close") || cmd.startsWith("gh issue comment")) return ok("");
    return { code: 1, stdout: "", stderr: `unexpected ${cmd}`, timedOut: false, ms: 1 };
  };
  return { run, calls };
}

function repoDir() {
  const dir = tempDir("af-gh-");
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, "src", "import"), { recursive: true });
  writeFileSync(path.join(dir, "src", "import", "xmp.ts"), "export {}\n");
  return dir;
}

async function plan(run: Runner): Promise<TriagePlan> {
  const found = await scanIssues({ repo: repoDir(), now: NOW, run });
  found.items.forEach((it, i) => (it.id = `T${String(i + 1).padStart(4, "0")}`));
  return { tool: "agent-flow-triage", version: 1, root: ".", scanned: "", ...found };
}

describe("triage github source", () => {
  it("parses github origins", () => {
    expect(ghRepoFromUrl("git@github.com:acme/app.git")).toBe("acme/app");
    expect(ghRepoFromUrl("https://github.com/acme/app")).toBe("acme/app");
    expect(ghRepoFromUrl("https://gitlab.com/acme/app.git")).toBeNull();
  });

  it("scan lists stale unpinned issues with evidence and no secrets", async () => {
    const { run } = fakeGh();
    const p = await plan(run);
    const byNumber = new Map(p.items.map((i) => [i.number, i]));
    expect([...byNumber.keys()].sort()).toEqual([1, 4]);
    const one = byNumber.get(1)!;
    expect(one.evidence).toMatchObject({ merged_prs_mentioning: [9], commits_referencing: 1, paths_named: 1, paths_missing: 0 });
    expect(one.evidence.duplicate_of).toBe(4);
    expect(one.options).toContain("duplicate");
    expect(JSON.stringify(p)).not.toContain(TOKEN);
    expect(needsApproval(one, "needs_info")).toBe(true);
    expect(needsApproval(one, "keep")).toBe(false);
    expect(Object.keys(jevPayload(p).questions)).toHaveLength(2);
  });

  it("scan skips repos owned by someone else (clones of upstream projects)", async () => {
    const { run } = fakeGh();
    const found = await scanIssues({ repo: repoDir(), now: NOW, run, owners: ["someone-else"] });
    expect(found.items).toEqual([]);
    expect(found.repos[0].error).toMatch(/not owned by someone-else/);
  });

  it("apply writes to GitHub only for approved ids, re-checks the issue, then verify and restore", async () => {
    const { run, calls } = fakeGh({ issueState: { 4: { state: "OPEN", updatedAt: ago(1) } } });
    const p = await plan(run);
    const id = (n: number) => p.items.find((i) => i.number === n)!.id;
    decideTriage(p, { answers: { [id(1)]: { choice: "close_completed", confidence: 0.9 }, [id(4)]: { choice: "needs_info", confidence: 0.8 } } });

    const unapproved = await applyIssues(p, { apply: true, run });
    expect(unapproved.done).toEqual([]);
    expect(unapproved.skipped.map((s) => s.id).sort()).toEqual([id(1), id(4)].sort());
    expect(calls.some((c) => c[1] === "issue" && (c[2] === "close" || c[2] === "comment"))).toBe(false);

    const dry = await applyIssues(p, { apply: false, approve: [id(1)], run });
    expect(dry.log[0]).toMatch(/^DRY CLOSE_COMPLETED/);

    const res = await applyIssues(p, { apply: true, approve: [id(1), id(4)], run });
    expect(res.done).toEqual([{ id: id(1), gh_repo: "acme/app", number: 1, mode: "close_completed" }]);
    expect(res.skipped).toEqual([{ id: id(4), why: "issue changed since scan (or is no longer open)" }]);
    const close = calls.find((c) => c[2] === "close")!;
    expect(close).toEqual(expect.arrayContaining(["--reason", "completed"]));
    expect(await verifyIssues(res.done, run)).toEqual([]);
    expect(restoreIssues(res.done)).toEqual(["gh issue reopen 1 -R acme/app"]);
  });
});
