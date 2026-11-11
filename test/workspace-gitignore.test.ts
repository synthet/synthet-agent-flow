import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { initWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";

/** `git check-ignore -q` exits 0 when the path is ignored and 1 when it isn't. */
function ignored(dir: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("init keeps the committed tracker files visible to git", () => {
  it("re-includes config.json and tickets.jsonl when a root .gitignore ignores them", () => {
    const dir = tempDir("af-gi-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    // A common pattern in app repos: secrets/config files ignored everywhere.
    writeFileSync(path.join(dir, ".gitignore"), "config.json\n*.jsonl\n");
    initWorkspace(dir);
    expect(ignored(dir, ".agent-flow/config.json")).toBe(false);
    expect(ignored(dir, ".agent-flow/tickets.jsonl")).toBe(false);
    // Local state stays ignored.
    expect(ignored(dir, ".agent-flow/flow.db")).toBe(true);
    // An app's own config.json elsewhere is still ignored by the root rule.
    expect(ignored(dir, "config.json")).toBe(true);
  });
});
