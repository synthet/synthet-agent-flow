import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { primeContext } from "../core/context.js";
import { runDod } from "../core/dod.js";
import { ticketIdFromBranch } from "../core/ids.js";
import { currentBranch, resolveRoot, worktreeTop, flowPaths } from "../core/paths.js";
import type { Ticket } from "../core/types.js";
import { isInitialized, openWorkspace, type Workspace } from "../core/workspace.js";
import { execFileSync } from "node:child_process";
import { attachNotifiers, flushOutbox } from "../integrations/notify.js";
import { maybeReconcile } from "../integrations/github.js";

/**
 * Claude Code hook handlers (`agent-flow hook <event>`).
 *
 * Safety rules (synthet-code-framework `hook-loopback-safety`):
 * - stdin is untrusted: parsed with a permissive zod schema; anything unexpected → `{}`.
 * - internal errors fail OPEN for advisory hooks (emit `{}`, exit 0) — a broken tracker must never wedge the agent.
 * - hooks never return `permissionDecision: "allow"`; they only deny/ask or stay silent.
 */

export const HOOK_EVENTS = [
  "session-start",
  "pre-tool",
  "post-tool",
  "stop",
  "stop-failure",
  "task-completed",
  "pre-compact",
  "session-end",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookResult {
  stdout: string;
  stderr?: string;
  code: number;
}

const inputSchema = z
  .object({
    session_id: z.string().max(200).optional(),
    transcript_path: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
    hook_event_name: z.string().max(100).optional(),
    source: z.string().max(50).optional(),
    reason: z.string().max(200).optional(),
    trigger: z.string().max(50).optional(),
    tool_name: z.string().max(200).optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    stop_hook_active: z.boolean().optional(),
    error: z.unknown().optional(),
    error_type: z.string().max(200).optional(),
  })
  .passthrough();
export type HookInput = z.infer<typeof inputSchema>;

export interface LoopState {
  active: boolean;
  started_at: string;
  max_tickets: number;
  label: string | null;
  actor: string | null;
  halted?: string | null;
  blocks?: number;
  last_seq?: number;
  contract?: Record<string, unknown>;
}

const SILENT: HookResult = { stdout: "{}", code: 0 };
const json = (v: unknown): HookResult => ({ stdout: JSON.stringify(v), code: 0 });

export function hookActor(input: HookInput, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_FLOW_ACTOR) return env.AGENT_FLOW_ACTOR;
  const sid = (input.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return `claude:${sid || "session"}`;
}

export function readLoop(ws: Workspace): LoopState | null {
  if (!existsSync(ws.paths.loopFile)) return null;
  try {
    return JSON.parse(readFileSync(ws.paths.loopFile, "utf8")) as LoopState;
  } catch {
    return null;
  }
}

export function writeLoop(ws: Workspace, state: LoopState): void {
  writeFileSync(ws.paths.loopFile, `${JSON.stringify(state, null, 2)}\n`);
}

function boundTicket(ws: Workspace, cwd: string, actor: string): Ticket | null {
  const branch = currentBranch(cwd);
  const id = branch ? ticketIdFromBranch(branch, ws.config.prefix) : null;
  if (id && ws.store.exists(id)) return ws.store.get(id);
  const mine = ws.store.list({ owner: actor, status: ["claimed", "in_progress"] });
  return mine[0] ?? null;
}

function hasHandoffSinceClaim(ws: Workspace, t: Ticket): boolean {
  const since = t.claimed_at ? Date.parse(t.claimed_at) : 0;
  return !!ws.store.db
    .prepare("SELECT 1 FROM comments WHERE ticket_id = ? AND kind = 'handoff' AND created_at >= ? LIMIT 1")
    .get(t.id, since);
}

// ───────────────────────────── handlers ─────────────────────────────

function sessionStart(ws: Workspace, input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const cwd = input.cwd ?? process.cwd();
  const actor = hookActor(input, env);
  ws.store.reap();
  ws.store.seenAgent(actor, "claude");
  // Persist the actor for later Bash calls so CLI writes match hook/MCP identity.
  if (env.CLAUDE_ENV_FILE && !env.AGENT_FLOW_ACTOR) {
    try {
      appendFileSync(env.CLAUDE_ENV_FILE, `export AGENT_FLOW_ACTOR=${actor}\n`);
    } catch {
      /* not fatal */
    }
  }
  const branch = currentBranch(cwd);
  const bound = boundTicket(ws, cwd, actor);
  if (input.session_id) {
    ws.store.recordSession({
      session_id: input.session_id,
      ticket_id: bound?.id ?? null,
      harness: "claude",
      actor,
      transcript_path: input.transcript_path ?? null,
      branch,
      reason: input.source ?? "startup",
    });
  }
  const loop = readLoop(ws);
  const res = primeContext(ws.store, { branch, actor, ticketId: bound?.id, label: loop?.active ? loop.label : null, maxChars: 7000 });
  const lines = [res.text, "", `Your agent-flow actor id is \`${actor}\` (pass it as \`actor\` to flow_* MCP tools; the CLI picks it up from AGENT_FLOW_ACTOR).`];
  if (loop?.active) {
    lines.push(
      `Autonomous loop is ACTIVE (max ${loop.max_tickets} tickets${loop.label ? `, label ${loop.label}` : ""}). Follow the flow-loop skill; ` +
        "create .agent-flow/STOP to halt.",
    );
  }
  return json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
}

const DANGEROUS: Array<{ re: RegExp; why: string }> = [
  { re: /\bgit\s+push\b[^|;&]*\s(--force(?!-with-lease)|-f\b|\+\S+)/, why: "force-push rewrites shared history; use --force-with-lease on your own ticket branch if you must" },
  { re: /\bgit\s+branch\s+-D\s+(main|master|develop)\b/, why: "deleting a protected branch" },
  { re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\/\s|\/\*)/, why: "recursive delete of / or home" },
  { re: /\bgit\s+(reset\s+--hard\s+origin\/(main|master)|clean\s+-[a-z]*x)/, why: "discards work irreversibly" },
];

function preTool(ws: Workspace, input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  if (input.tool_name !== "Bash") return SILENT;
  const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? "");
  if (!command) return SILENT;
  const deny = (reason: string) =>
    json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `agent-flow: ${reason}` } });
  for (const d of DANGEROUS) if (d.re.test(command)) return deny(d.why);
  const def = ws.config.defaultBranch;
  const cwd = input.cwd ?? process.cwd();
  if (/\bgit\s+push\b/.test(command)) {
    const explicit = new RegExp(`\\bgit\\s+push\\b[^|;&]*\\s(\\S+:)?(refs/heads/)?${def}(\\s|$)`).test(command);
    const onDefault = currentBranch(cwd) === def && !/\s[\w/.-]+:[\w/.-]+/.test(command) && !/--set-upstream|-u\s/.test(command);
    if (explicit || (onDefault && /\bgit\s+push\s*($|origin\s*$)/.test(command.trim()))) {
      return deny(`direct pushes to ${def} are not allowed; push your ticket branch and open a PR (Refs <ticket-id>)`);
    }
  }
  if (/\b(agent-flow|af)\s+claim\b/.test(command)) {
    const actor = hookActor(input, env);
    const mine = ws.store.list({ owner: actor, status: ["claimed", "in_progress"] });
    if (mine.length >= ws.config.wip.perAgent) {
      return deny(`WIP limit: you already hold ${mine.map((t) => t.id).join(", ")}. Submit or release it before claiming more.`);
    }
  }
  const rm = /\brm\s+-[a-z]*r[a-z]*\s+([^\s;&|]+)/.exec(command);
  if (rm) {
    // Compare canonical paths: git reports the worktree top as a realpath (macOS /var → /private/var,
    // or any symlinked checkout), so the target must be resolved the same way before the prefix check.
    const top = canonicalPath(worktreeTop(cwd) ?? cwd);
    const target = canonicalPath(path.resolve(cwd, rm[1].replace(/^~(?=\/|$)/, env.HOME ?? "~")));
    if (!target.startsWith(top + path.sep) && target !== top) return deny(`rm -r outside the worktree (${target})`);
  }
  return SILENT;
}

/** realpath of the nearest existing ancestor, with the not-yet-existing remainder re-appended. */
function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) return abs;
    rest.unshift(path.basename(head));
    head = parent;
  }
  try {
    return path.join(realpathSync.native(head), ...rest); // .native: the JS version keeps Windows 8.3 names (RUNNER~1), and git reports long ones
  } catch {
    return abs;
  }
}

function postTool(ws: Workspace, input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const cwd = input.cwd ?? process.cwd();
  const actor = hookActor(input, env);
  const t = boundTicket(ws, cwd, actor);
  if (!t || t.owner !== actor) return SILENT;
  const notes: string[] = [];
  const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? "");
  if (input.tool_name === "Bash" && /\bgit\s+commit\b/.test(command)) {
    // Bash tool_response has no exit code, so detect a real commit by HEAD moving.
    let head: string | null = null;
    try {
      head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      head = null;
    }
    const headKey = `head:${t.id}`;
    const before = ws.store.getKv(headKey);
    if (head && head !== before && !isInterrupted(input.tool_response)) {
      ws.store.setKv(headKey, head);
      // Framework backlog contract step 3: move to In Progress on the first commit.
      if (t.status === "claimed") {
        ws.store.transition(t.id, "start", actor);
        notes.push(`agent-flow: ${t.id} moved to in_progress (first commit ${head}).`);
      }
      if (input.session_id) ws.store.recordSession({ session_id: input.session_id, ticket_id: t.id, commit_range: head });
    }
  }
  // Heartbeat at most every `hooks.heartbeatMinutes` while the owner is active.
  const key = `hb:${t.id}`;
  const last = Number(ws.store.getKv(key) ?? 0);
  if (["claimed", "in_progress"].includes(ws.store.get(t.id).status) && Date.now() - last > ws.config.hooks.heartbeatMinutes * 60_000) {
    ws.store.heartbeat(t.id, actor);
    ws.store.setKv(key, String(Date.now()));
  }
  if (!notes.length) return SILENT;
  return json({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join("\n") } });
}

function isInterrupted(resp: unknown): boolean {
  return !!resp && typeof resp === "object" && (resp as Record<string, unknown>).interrupted === true;
}

/** Stop: loop controller + "land the plane" nudge. Always honours stop_hook_active to avoid infinite loops. */
function stop(ws: Workspace, input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const cwd = input.cwd ?? process.cwd();
  const actor = hookActor(input, env);
  const loop = readLoop(ws);
  const block = (reason: string) => json({ decision: "block", reason });
  const mine = ws.store.list({ owner: actor, status: ["claimed", "in_progress"] });
  const current = boundTicket(ws, cwd, actor) ?? mine[0] ?? null;

  if (!loop?.active) {
    // Outside the loop: one nudge if the agent is leaving an owned ticket without a handoff.
    if (input.stop_hook_active || !ws.config.hooks.handoffOnStop) return SILENT;
    if (current && current.owner === actor && ["claimed", "in_progress"].includes(current.status) && !hasHandoffSinceClaim(ws, current)) {
      return block(
        `You still hold ${current.id} (${current.status}) with no handoff note. Before stopping: write one with ` +
          `\`agent-flow note ${current.id} --handoff "<what changed, decisions, what's left, gotchas>"\`, then either submit it or ` +
          `\`agent-flow release ${current.id}\`. If you are mid-task and the user is steering, just say so.`,
      );
    }
    return SILENT;
  }

  const finish = (why: string) => {
    writeLoop(ws, { ...loop, active: false, halted: why });
    return SILENT;
  };
  if (existsSync(ws.paths.stopFile)) return finish("STOP file present");
  if (loop.halted) return finish(loop.halted);
  const started = Date.parse(loop.started_at);
  const submitted = ws.store
    .events({ limit: 10_000 })
    .filter((e) => e.actor === actor && Date.parse(e.ts) >= started && ["ticket.submitted", "ticket.closed"].includes(e.action)).length;
  if (submitted >= loop.max_tickets) return finish(`completed ${submitted}/${loop.max_tickets} tickets`);
  // Stuck detection: blocked last time and nothing this actor did since → let it stop.
  const lastSeq = ws.store.lastSeq();
  const progressed = ws.store.events({ since: loop.last_seq ?? 0, limit: 10_000 }).some((e) => e.actor === actor);
  if (input.stop_hook_active && loop.last_seq !== undefined && !progressed) return finish("no progress since last continuation");
  const blocks = (loop.blocks ?? 0) + 1;
  if (blocks > loop.max_tickets * 6) return finish("continuation budget exhausted");
  writeLoop(ws, { ...loop, blocks, last_seq: lastSeq });

  if (current && ["claimed", "in_progress"].includes(current.status)) {
    return block(
      `Loop: ${current.id} is still ${current.status}. Finish it with the flow-complete skill (verify every AC with evidence, ` +
        `run DoD, handoff note, submit), or block it with a reason if you cannot proceed. Tickets done this loop: ${submitted}/${loop.max_tickets}.`,
    );
  }
  const ready = ws.store.ready({ label: loop.label ?? undefined, limit: 5 });
  if (ready.length === 0) return finish("ready queue empty");
  return block(
    `Loop: ${submitted}/${loop.max_tickets} tickets done. Next: run the flow-next skill (claim ${ready[0].id} "${ready[0].title}" or the queue head` +
      `${loop.label ? ` with --label ${loop.label}` : ""}), then flow-work and flow-complete. Create .agent-flow/STOP to halt.`,
  );
}

function stopFailure(ws: Workspace, input: HookInput): HookResult {
  const loop = readLoop(ws);
  if (loop?.active) {
    const why = typeof input.error === "string" ? input.error : (input.error_type ?? "api failure");
    writeLoop(ws, { ...loop, active: false, halted: `StopFailure: ${why}` });
  }
  return SILENT;
}

async function taskCompleted(ws: Workspace, input: HookInput): Promise<HookResult> {
  if (!ws.config.hooks.taskCompletedDod || ws.config.dod.length === 0) return SILENT;
  const cwd = input.cwd ?? process.cwd();
  const res = await runDod(ws.config.dod, worktreeTop(cwd) ?? cwd, ws.config.dodTimeoutMs);
  if (res.passed) return SILENT;
  return { stdout: "", stderr: `agent-flow Definition of Done is failing; fix before marking this task complete:\n${res.summary}`, code: 2 };
}

function preCompactOrEnd(ws: Workspace, input: HookInput, env: NodeJS.ProcessEnv, end: boolean): HookResult {
  if (!input.session_id) return SILENT;
  const cwd = input.cwd ?? process.cwd();
  const actor = hookActor(input, env);
  const t = boundTicket(ws, cwd, actor);
  ws.store.recordSession({
    session_id: input.session_id,
    ticket_id: t?.id ?? null,
    harness: "claude",
    actor,
    transcript_path: input.transcript_path ?? null,
    branch: currentBranch(cwd),
    reason: end ? (input.reason ?? "end") : `compact:${input.trigger ?? "auto"}`,
    end,
  });
  if (end && t && t.owner === actor && ["claimed", "in_progress"].includes(t.status) && !hasHandoffSinceClaim(ws, t)) {
    ws.store.comment(
      t.id,
      "system",
      `Session ${input.session_id} ended (${input.reason ?? "end"}) without a handoff note. Transcript: ${input.transcript_path ?? "n/a"}`,
      "system:hook",
    );
  }
  return SILENT;
}

// ───────────────────────────── dispatcher ─────────────────────────────

export async function runHook(event: string, stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<HookResult> {
  let input: HookInput;
  try {
    input = inputSchema.parse(stdin.trim() ? JSON.parse(stdin) : {});
  } catch {
    return SILENT;
  }
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd();
  input.cwd = cwd;
  const root = resolveRoot(cwd);
  if (!isInitialized(root)) return SILENT;
  let ws: Workspace | null = null;
  try {
    ws = openWorkspace(cwd);
    attachNotifiers(ws);
    switch (event as HookEvent) {
      case "session-start":
        await maybeReconcile(ws);
        return sessionStart(ws, input, env);
      case "pre-tool":
        return preTool(ws, input, env);
      case "post-tool":
        return postTool(ws, input, env);
      case "stop":
        return stop(ws, input, env);
      case "stop-failure":
        return stopFailure(ws, input);
      case "task-completed":
        return await taskCompleted(ws, input);
      case "pre-compact":
        return preCompactOrEnd(ws, input, env, false);
      case "session-end":
        return preCompactOrEnd(ws, input, env, true);
      default:
        return SILENT;
    }
  } catch (err) {
    // Fail open, but leave a trace for debugging.
    return { stdout: "{}", stderr: `agent-flow hook ${event}: ${err instanceof Error ? err.message : String(err)}`, code: 0 };
  } finally {
    if (ws) {
      if (ws.store.outboxStats().pending > 0) await flushOutbox(ws, { budgetMs: 3000 }).catch(() => undefined);
      ws.close();
    }
  }
}

/** One-line status for Claude Code's statusLine: `af-k3x9q · in_progress · lease 12m · ready 4`. */
export function statusLine(stdin: string, env: NodeJS.ProcessEnv = process.env): string {
  let cwd = process.cwd();
  let sessionId: string | undefined;
  try {
    const j = JSON.parse(stdin || "{}") as { cwd?: string; session_id?: string; workspace?: { current_dir?: string } };
    cwd = j.workspace?.current_dir ?? j.cwd ?? cwd;
    sessionId = j.session_id;
  } catch {
    /* ignore */
  }
  const root = resolveRoot(cwd);
  if (!existsSync(flowPaths(root).config)) return "";
  const ws = openWorkspace(cwd);
  try {
    const actor = hookActor({ session_id: sessionId }, env);
    const t = boundTicket(ws, cwd, actor);
    const ready = ws.store.ready({ limit: 100 }).length;
    const review = ws.store.list({ status: "review" }).length;
    const loop = readLoop(ws);
    const parts: string[] = [];
    if (t) {
      const lease = t.lease_until ? Math.round((Date.parse(t.lease_until) - Date.now()) / 60000) : null;
      parts.push(`${t.id} · ${t.status}${lease !== null ? ` · lease ${lease}m` : ""}${t.ac_total ? ` · AC ${t.ac_verified}/${t.ac_total}` : ""}`);
    } else parts.push("no ticket");
    parts.push(`ready ${ready}`);
    if (review) parts.push(`review ${review}`);
    if (loop?.active) parts.push(`loop ${loop.max_tickets}`);
    return `⚑ ${parts.join(" · ")}`;
  } finally {
    ws.close();
  }
}


/** Compact JSON snapshot for UIs (the Claude Code mod, status bars). */
export function snapshot(cwd: string, sessionId?: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const root = resolveRoot(cwd);
  if (!existsSync(flowPaths(root).config)) return { initialized: false };
  const ws = openWorkspace(cwd);
  try {
    ws.store.reap();
    const actor = hookActor({ session_id: sessionId }, env);
    const t = boundTicket(ws, cwd, actor);
    const d = t ? ws.store.detail(t.id, { events: 0 }) : null;
    const handoff = d ? [...d.comments].reverse().find((c) => c.kind === "handoff") : undefined;
    return {
      initialized: true,
      root,
      actor,
      ticket: d
        ? {
            id: d.id,
            title: d.title,
            status: d.status,
            owner: d.owner,
            priority: d.priority,
            lease_until: d.lease_until,
            branch: d.branch,
            blocked_reason: d.blocked_reason,
            rework_count: d.rework_count,
            acceptance: d.acceptance.map((a) => ({ ac_id: a.ac_id, text: a.text, verdict: a.verdict })),
            last_handoff: handoff ? handoff.body.slice(0, 400) : null,
          }
        : null,
      ready: ws.store.ready({ limit: 5 }).map((r) => ({ id: r.id, title: r.title, priority: r.priority, lane: r.lane })),
      counts: {
        ready: ws.store.ready({ limit: 1000 }).length,
        review: ws.store.list({ status: "review" }).length,
        blocked: ws.store.list({ status: "blocked" }).length,
        needs_human: ws.store.list({ label: "needs-human" }).length,
      },
      loop: readLoop(ws),
    };
  } finally {
    ws.close();
  }
}
