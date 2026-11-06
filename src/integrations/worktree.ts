import { existsSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { branchFor } from "../core/service.js";
import type { Workspace } from "../core/workspace.js";
import { defaultRunner, type Runner } from "./exec.js";

/**
 * One git worktree per ticket. Creation is serialised through a DB lock: concurrent `git worktree add`
 * collides on .git locks (see anthropics/claude-code#55724 and #104026), so agents queue here instead.
 */

export function worktreePath(ws: Workspace, id: string): string {
  const repo = path.basename(ws.paths.root);
  const dir = ws.config.worktreeDir.replace("{repo}", repo);
  return path.resolve(ws.paths.root, dir, id);
}

async function git(run: Runner, cwd: string, args: string[]): Promise<string> {
  const r = await run(["git", ...args], { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new FlowError("EXTERNAL_FAILURE", `git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

export async function createWorktree(
  ws: Workspace,
  id: string,
  actor: string,
  opts: { base?: string; waitMs?: number } = {},
  run: Runner = defaultRunner,
): Promise<{ path: string; branch: string; created: boolean }> {
  const t = ws.store.get(id);
  const branch = t.branch ?? branchFor(ws.config.branchPattern, t);
  if (!t.branch) ws.store.update(id, { branch }, actor);
  const dest = worktreePath(ws, id);
  if (existsSync(dest)) return { path: dest, branch, created: false };
  const lock = "git-worktree";
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  while (!ws.store.acquireLock(lock, actor, 120_000)) {
    if (Date.now() > deadline) throw new FlowError("CLAIM_CONFLICT", "another agent is creating a worktree; retry shortly", { retryable: true });
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    const exists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: ws.paths.root })).code === 0;
    const args = exists ? ["worktree", "add", dest, branch] : ["worktree", "add", "-b", branch, dest, opts.base ?? ws.config.defaultBranch];
    await git(run, ws.paths.root, args);
  } finally {
    ws.store.releaseLock(lock, actor);
  }
  ws.store.record("worktree.created", actor, id, { path: dest, branch });
  return { path: dest, branch, created: true };
}

export async function removeWorktree(ws: Workspace, id: string, actor: string, opts: { force?: boolean } = {}, run: Runner = defaultRunner): Promise<string> {
  const dest = worktreePath(ws, id);
  await git(run, ws.paths.root, ["worktree", "remove", ...(opts.force ? ["--force"] : []), dest]);
  ws.store.record("worktree.removed", actor, id, { path: dest });
  return dest;
}
