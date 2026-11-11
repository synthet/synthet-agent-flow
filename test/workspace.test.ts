import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/core/config.js";
import { flowPaths } from "../src/core/paths.js";
import { initWorkspace } from "../src/core/workspace.js";
import { tempDir } from "./helpers.js";

function repo(branch: string) {
  const dir = tempDir("af-ws-");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, git };
}

const defaultBranchOf = (dir: string) => loadConfig(flowPaths(dir).config).defaultBranch;

describe("init detects the default branch", () => {
  it("uses origin/HEAD when it exists, even from a feature branch", () => {
    const { dir, git } = repo("master");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    git("switch", "-q", "-c", "feature/x");
    initWorkspace(dir);
    expect(defaultBranchOf(dir)).toBe("master");
  });

  it("falls back to an existing local master when there is no origin/HEAD", () => {
    const { dir } = repo("master");
    initWorkspace(dir);
    expect(defaultBranchOf(dir)).toBe("master");
  });

  it("prefers a local main, and falls back to main when neither exists", () => {
    const both = repo("master");
    both.git("branch", "main");
    initWorkspace(both.dir);
    expect(defaultBranchOf(both.dir)).toBe("main");

    const neither = repo("trunk");
    initWorkspace(neither.dir);
    expect(defaultBranchOf(neither.dir)).toBe("main");
  });

  it("keeps an explicit defaultBranch override", () => {
    const { dir } = repo("master");
    initWorkspace(dir, { defaultBranch: "develop" });
    expect(defaultBranchOf(dir)).toBe("develop");
  });
});
