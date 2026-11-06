import { existsSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { FlowError } from "../core/errors.js";
import { readLoop, writeLoop, type LoopState } from "../hooks/index.js";
import type { Workspace } from "../core/workspace.js";
import { defaultRunner, type Runner } from "./exec.js";

/**
 * Autonomous loop, two tiers:
 * - `loop start` arms the in-session Stop-hook controller (`.agent-flow/loop.json`).
 * - `loop run` is the outer loop: one fresh headless session per ticket (no context rot), state in the tracker.
 * Both follow the synthet-code-framework autonomous-run-contract: explicit budget, label scope, stop conditions.
 */

export interface LoopOptions {
  max: number;
  label: string | null;
  actor?: string | null;
}

export function contract(ws: Workspace, opts: LoopOptions): Record<string, unknown> {
  return {
    scope: opts.label ? `ready tickets labelled ${opts.label}` : "any ready ticket",
    budget: { max_tickets: opts.max, max_turns_per_ticket: ws.config.loop.maxTurns },
    stop_conditions: ["ready queue empty", ".agent-flow/STOP exists", "StopFailure (rate limit, billing, …)", "no progress since last continuation", "ticket blocked / needs-human", "budget reached"],
    revert_rule: "never leave red work: release with a reason or block it",
    human_gates: ["PR merge", "destructive commands (denied by hooks)"],
  };
}

export function startLoop(ws: Workspace, opts: LoopOptions): LoopState {
  if (existsSync(ws.paths.stopFile)) rmSync(ws.paths.stopFile);
  const state: LoopState = {
    active: true,
    started_at: new Date().toISOString(),
    max_tickets: opts.max,
    label: opts.label,
    actor: opts.actor ?? null,
    contract: contract(ws, opts),
  };
  writeLoop(ws, state);
  ws.store.record("loop.started", opts.actor ?? "system:loop", null, { max: opts.max, label: opts.label });
  return state;
}

export function stopLoop(ws: Workspace, actor: string, why = "stopped by user"): LoopState | null {
  writeFileSync(ws.paths.stopFile, `${why}\n`);
  const loop = readLoop(ws);
  if (loop) writeLoop(ws, { ...loop, active: false, halted: why });
  ws.store.record("loop.stopped", actor, null, { why });
  return readLoop(ws);
}

export interface RunLoopOptions extends LoopOptions {
  harness: "claude" | "codex";
  maxTurns: number;
  permissionMode?: string;
  cwd: string;
  log?: (line: string) => void;
}

export function iterationPrompt(label: string | null, harness: "claude" | "codex"): string {
  const filter = label ? ` --label ${label}` : "";
  if (harness === "claude") {
    return `/agent-flow:flow-next${filter}\nThen follow the flow-work and flow-complete skills for that one ticket. Stop after it is submitted (or blocked with a reason). Do not claim a second ticket.`;
  }
  return [
    "You are working from the agent-flow tracker (CLI: agent-flow). Do exactly one ticket:",
    `1. agent-flow claim --next${filter} --json  (stop if the queue is empty)`,
    "2. git switch -c <branch from the claim>; agent-flow show <id>",
    "3. implement test-first; record evidence per criterion: agent-flow ac verify <id> AC-n --evidence '...'",
    "4. agent-flow note <id> --handoff 'changed | decisions | left | gotchas'; agent-flow submit <id>",
    "Never push to the default branch. Stop after submitting.",
  ].join("\n");
}

/** Outer loop with fresh contexts. Returns a per-iteration summary. */
export async function runLoop(ws: Workspace, opts: RunLoopOptions, run: Runner = defaultRunner): Promise<Array<{ iteration: number; ticket: string | null; status: string | null; code: number }>> {
  const out: Array<{ iteration: number; ticket: string | null; status: string | null; code: number }> = [];
  const log = opts.log ?? (() => undefined);
  if (existsSync(ws.paths.stopFile)) rmSync(ws.paths.stopFile);
  ws.store.record("loop.run_started", "system:loop", null, { ...contract(ws, opts), harness: opts.harness });
  for (let i = 1; i <= opts.max; i++) {
    if (existsSync(ws.paths.stopFile)) {
      log("STOP file present — halting");
      break;
    }
    ws.store.reap();
    const ready = ws.store.ready({ label: opts.label ?? undefined, limit: 1 });
    if (!ready.length) {
      log("ready queue empty — done");
      break;
    }
    const actor = `${opts.harness}:loop-${randomBytes(3).toString("hex")}`;
    const prompt = iterationPrompt(opts.label, opts.harness);
    const argv =
      opts.harness === "claude"
        ? ["claude", "-p", prompt, "--max-turns", String(opts.maxTurns), "--output-format", "json", "--permission-mode", opts.permissionMode ?? "acceptEdits"]
        : ["codex", "exec", "--full-auto", prompt];
    log(`iteration ${i}/${opts.max} as ${actor}: next is ${ready[0].id} ${ready[0].title}`);
    const before = ws.store.lastSeq();
    const res = await run(argv, { cwd: opts.cwd, timeoutMs: 60 * 60_000, env: { ...process.env, AGENT_FLOW_ACTOR: actor } });
    const touched = ws.store.events({ since: before, limit: 5000 }).find((e) => e.actor === actor && e.action === "ticket.claimed")?.ticket_id ?? null;
    const status = touched ? ws.store.get(touched).status : null;
    out.push({ iteration: i, ticket: touched, status, code: res.code });
    ws.store.record("loop.iteration", "system:loop", touched, { iteration: i, actor, exit: res.code, status });
    log(`  → exit ${res.code}; ${touched ?? "no ticket claimed"} ${status ?? ""}`);
    if (res.code !== 0) {
      log("non-zero exit — halting (see the session transcript)");
      break;
    }
    if (!touched) {
      log("the session claimed nothing — halting");
      break;
    }
    if (status === "blocked" || (touched && ws.store.get(touched).labels.includes("needs-human"))) {
      log(`${touched} needs attention (${status}) — halting`);
      break;
    }
    if (status === "claimed" || status === "in_progress") {
      ws.store.transition(touched, "release", "system:loop", { reason: "loop iteration ended without submitting", force: true });
      log(`${touched} was not submitted — released and halting`);
      break;
    }
  }
  ws.store.record("loop.run_finished", "system:loop", null, { iterations: out.length });
  return out;
}

export function requireMax(n: number | undefined, fallback: number): number {
  const v = n ?? fallback;
  if (v < 1 || v > 100) throw new FlowError("INVALID_ARGUMENT", "--max must be between 1 and 100");
  return v;
}
