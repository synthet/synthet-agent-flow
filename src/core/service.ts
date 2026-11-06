import { runDod, type DodResult } from "./dod.js";
import { slugify } from "./ids.js";
import { worktreeTop } from "./paths.js";
import type { ReadyFilter, Ticket } from "./types.js";
import type { Workspace } from "./workspace.js";
import type { Action } from "./states.js";

/**
 * Lifecycle operations shared by CLI, MCP and REST. The store enforces the rules; this layer adds the
 * side-effecting bits (running DoD commands, naming branches).
 */

export function branchFor(pattern: string, t: Pick<Ticket, "id" | "title" | "type">): string {
  return pattern
    .replace("{id}", t.id)
    .replace("{slug}", slugify(t.title, 32))
    .replace("{type}", t.type);
}

export function claimTicket(
  ws: Workspace,
  id: string | null,
  actor: string,
  opts: { filter?: ReadyFilter; leaseMinutes?: number } = {},
): Ticket {
  const t = ws.store.claim(id, actor, opts);
  if (!t.branch) return ws.store.update(t.id, { branch: branchFor(ws.config.branchPattern, t) }, actor);
  return t;
}

export async function checkDod(ws: Workspace, cwd: string): Promise<DodResult> {
  const dir = worktreeTop(cwd) ?? cwd;
  return runDod(ws.config.dod, dir, ws.config.dodTimeoutMs);
}

export async function submitTicket(
  ws: Workspace,
  id: string,
  actor: string,
  opts: { skipDod?: boolean; force?: boolean; cwd?: string } = {},
): Promise<{ ticket: Ticket; dod: DodResult | null }> {
  let dod: DodResult | null = null;
  if (!opts.skipDod && ws.config.dod.length) dod = await checkDod(ws, opts.cwd ?? process.cwd());
  const ticket = ws.store.transition(id, "submit", actor, {
    force: opts.force,
    dod: dod ? { passed: dod.passed, summary: dod.summary } : undefined,
  });
  return { ticket, dod };
}

export async function applyAction(
  ws: Workspace,
  id: string,
  action: Action,
  actor: string,
  opts: { reason?: string; unblockCondition?: string; force?: boolean; skipDod?: boolean; cwd?: string } = {},
): Promise<Ticket> {
  if (action === "claim") return claimTicket(ws, id, actor);
  if (action === "submit") return (await submitTicket(ws, id, actor, opts)).ticket;
  return ws.store.transition(id, action, actor, opts);
}
