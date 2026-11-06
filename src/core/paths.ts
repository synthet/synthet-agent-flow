import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const FLOW_DIRNAME = ".agent-flow";

export interface FlowPaths {
  /** Project root (main worktree root, so every worktree shares one tracker). */
  root: string;
  dir: string;
  db: string;
  config: string;
  snapshot: string;
  stopFile: string;
  loopFile: string;
  serveFile: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the tracker root:
 * 1. `AGENT_FLOW_HOME` (a project directory) wins.
 * 2. Inside git: the directory that owns the common `.git` dir, so linked worktrees share the DB.
 * 3. Otherwise walk up looking for `.agent-flow/`; fall back to cwd.
 */
export function resolveRoot(cwd: string = process.cwd()): string {
  const home = process.env.AGENT_FLOW_HOME;
  if (home) return path.resolve(home);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    if (path.basename(common) === ".git") return path.dirname(common);
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (top) return top;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, FLOW_DIRNAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export function flowPaths(root: string): FlowPaths {
  const dir = path.join(root, FLOW_DIRNAME);
  return {
    root,
    dir,
    db: process.env.AGENT_FLOW_DB ? path.resolve(process.env.AGENT_FLOW_DB) : path.join(dir, "flow.db"),
    config: path.join(dir, "config.json"),
    snapshot: path.join(dir, "tickets.jsonl"),
    stopFile: path.join(dir, "STOP"),
    loopFile: path.join(dir, "loop.json"),
    serveFile: path.join(dir, "serve.json"),
  };
}

/** Current branch of the worktree that contains `cwd` (not necessarily the root). */
export function currentBranch(cwd: string = process.cwd()): string | null {
  const b = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b && b !== "HEAD" ? b : null;
}

export function worktreeTop(cwd: string = process.cwd()): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}
