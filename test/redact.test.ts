import { describe, expect, it } from "vitest";
import { scrubMachinePaths } from "../src/core/redact.js";
import { makeStore } from "./helpers.js";

const H = "human:dmn";
const MACHINE = /[A-Za-z]:[\\/]|\/(?:home|Users)\/|(?<![\w.~:-])\/[a-z]\/[\w.-]/;

describe("scrubMachinePaths", () => {
  it.each([
    ["in worktree D:\\Projects\\synthet-code-framework.worktrees\\scf-3ilvi. Left", "in worktree <path>. Left"],
    ["list -C D:/Projects/jev-mcp --all → jev-t4msd", "list -C <path> --all → jev-t4msd"],
    ["receipt C:\\Users\\alice\\.claude\\skills\\x\\SKILL.md ok", "receipt <path> ok"],
    ["escaped D:\\\\Projects\\\\synthet-agent-flow\\\\src in JSON", "escaped <path> in JSON"],
    ["git bash /d/Projects/synthet-agent-flow/bin then", "git bash <path> then"],
    ["home /home/alice/work and /Users/alice/src/x.ts", "home <path> and <path>"],
    ["(see `D:\\Projects\\x`)", "(see `<path>`)"],
  ])("replaces %j", (input, expected) => {
    expect(scrubMachinePaths(input)).toBe(expected);
  });

  it.each([
    "src/core/store.ts:120 and docs/specs/software-factory/tasks.md#T-1",
    "https://github.com/synthet/synthet-agent-flow/pull/26",
    "~/.claude/skills/next-steps and ~/.agents/skills",
    "AC-1: works; deps T-3>T-2; and/or; C: drive is full",
    "file:///not-a-drive and ./scripts/x.py",
  ])("leaves %j untouched", (input) => {
    expect(scrubMachinePaths(input)).toBe(input);
  });
});

describe("snapshot export", () => {
  it("scrubs machine paths from free text but keeps the database text", () => {
    const { store } = makeStore();
    const t = store.create(
      { title: "Fix D:\\Projects\\x", body: "Context: D:/Projects/workspace map, src/core/a.ts", acceptance: ["Runs from C:\\Users\\alice\\repo"] },
      H,
    );
    store.comment(t.id, "handoff", "Worktree D:\\Projects\\fw.worktrees\\scf-3ilvi; branch af/x", H);
    store.verifyAcceptance(t.id, "AC-1", "Verified", "list -C D:/Projects/jev-mcp --all; /home/alice/x", H);

    const snapshot = store.exportSnapshot();
    expect(snapshot).not.toMatch(MACHINE);
    const row = JSON.parse(snapshot.trim()) as { title: string; body: string; acceptance: Array<{ text: string; evidence: string }>; comments: Array<{ body: string }> };
    expect(row.title).toBe("Fix <path>");
    expect(row.body).toBe("Context: <path> map, src/core/a.ts");
    expect(row.acceptance[0]).toMatchObject({ text: "Runs from <path>", evidence: "list -C <path> --all; <path>" });
    expect(row.comments[0].body).toBe("Worktree <path>; branch af/x");

    const d = store.detail(t.id);
    expect(d.body).toContain("D:/Projects/workspace");
    expect(d.comments[0].body).toContain("D:\\Projects\\fw.worktrees");
    expect(d.acceptance[0].evidence).toContain("D:/Projects/jev-mcp");
  });

  it("re-importing the scrubbed snapshot does not overwrite the database text", () => {
    const { store } = makeStore();
    const t = store.create({ title: "T", body: "at D:\\Projects\\x" }, H);
    store.comment(t.id, "note", "see D:/Projects/y", H);
    expect(store.importSnapshot(store.exportSnapshot(), "system:test")).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect(store.detail(t.id).body).toBe("at D:\\Projects\\x");
    expect(store.detail(t.id).comments[0].body).toBe("see D:/Projects/y");
  });
});
