import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { clip, redactHome, redactSecrets } from "../core/redaction.js";
import type { TicketDetail } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import { openStdioMcp, type McpOpener } from "./mcp-client.js";

/**
 * Advisory review by Jev (TypeSafe System One) through a jev-mcp checkout's stdio server.
 *
 * Jev judges text, not code: whether each criterion's recorded evidence shows it is met, whether the notes
 * say required work is unfinished, and an overall read. The answer is recorded as a review comment and an
 * event. It never approves, rejects or verifies anything, so the review gate and its human or peer
 * reviewer stay in charge. The checkout's own launcher loads its API key from its `.env`, so agent-flow
 * never reads, passes or stores the key.
 */

const ACTOR = "system:jev";
const TOOL = "jev_system_one";
const LAUNCHER = path.join("scripts", "run_jev_mcp.py");

export type JevVerdict = "looks_ready" | "needs_changes" | "unclear";

const AC_CRITERIA = {
  supported: "The evidence names a concrete check (a command, test result, measurement or observed behaviour) that directly shows this criterion is met",
  partial: "The evidence covers only part of the criterion, or shows something related but not this criterion",
  unsupported: "There is no evidence, or it only restates the claim without showing any check",
} as const;

const OVERALL_CRITERIA: Record<JevVerdict, string> = {
  looks_ready: "Every criterion has supporting evidence and nothing says required work is unfinished, so a reviewer can approve after a normal check",
  needs_changes: "At least one criterion lacks evidence, evidence contradicts a criterion, or the notes say required work is unfinished or failing",
  unclear: "The evidence is too thin or ambiguous to tell, so a reviewer should look closely",
};

export interface JevReview {
  verdict: JevVerdict;
  confidence: number | null;
  ac: Record<string, { choice: keyof typeof AC_CRITERIA; confidence: number | null }>;
  /** Probability that the notes say required work is unfinished. */
  open_work: number | null;
  model: string | null;
  usage: unknown;
}

export interface JevDryRun {
  tool: typeof TOOL;
  arguments: { state: Record<string, unknown>; questions: Record<string, Question>; model?: string };
  launch: { command: string; args: string[]; cwd: string };
}

interface Question {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string>;
}

interface Envelope {
  ok?: boolean;
  result?: { model?: string | null; usage?: unknown; answers?: Record<string, { type?: string; choice?: string; confidence?: number | null; noul?: number }> };
  error?: { code?: string; message?: string; next_steps?: string[] };
}

/** The jev-mcp checkout to launch, from AGENT_FLOW_JEV_PATH or `jev.path`. */
export function jevLaunch(ws: Workspace): { command: string; args: string[]; cwd: string } {
  const base = process.env.AGENT_FLOW_JEV_PATH || ws.config.jev.path;
  if (!base) {
    throw new FlowError("INVALID_ARGUMENT", "set jev.path in .agent-flow/config.json (or AGENT_FLOW_JEV_PATH) to your jev-mcp checkout", {
      nextSteps: ['agent-flow config set jev.path "/path/to/jev-mcp"'],
    });
  }
  const launcher = path.join(base, LAUNCHER);
  if (!existsSync(launcher)) {
    throw new FlowError("NOT_FOUND", `jev-mcp launcher not found: ${LAUNCHER} under ${base}`, { nextSteps: ["point jev.path at a jev-mcp checkout"] });
  }
  return { command: "uv", args: ["run", "--project", base, "python", launcher], cwd: base };
}

const questionId = (acId: string) => acId.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Deep-map every string through secret and home-directory redaction. */
function scrub<T>(value: T, home: string): T {
  if (typeof value === "string") return redactHome(redactSecrets(value), home) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, home)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, home)])) as T;
  return value;
}

export function buildJevRequest(t: TicketDetail, model: string | null, home = os.homedir()): JevDryRun["arguments"] {
  const handoff = [...t.comments].reverse().find((c) => c.kind === "handoff");
  // Earlier Jev comments are left out so Jev never grades its own opinion.
  const reviews = t.comments.filter((c) => c.kind === "review" && c.actor !== ACTOR).slice(-5);
  const submitted = [...t.events].reverse().find((e) => e.action === "ticket.submitted");
  const state = scrub(
    {
      ticket: { id: t.id, type: t.type, title: t.title, spec: clip(t.body.trim() || "(none)", 3000) },
      acceptance: t.acceptance.map((a) => ({ id: a.ac_id, criterion: clip(a.text, 600), recorded_verdict: a.verdict, evidence: a.evidence ? clip(a.evidence, 1500) : null })),
      handoff: handoff ? clip(handoff.body, 2000) : null,
      definition_of_done: submitted?.payload.dod ?? null,
      other_reviews: reviews.map((c) => ({ by: c.actor, text: clip(c.body, 600) })),
    },
    home,
  );
  const questions: Record<string, Question> = {};
  for (const a of t.acceptance) {
    questions[questionId(a.ac_id)] = {
      type: "choice",
      instructions: scrub(
        `Acceptance criterion ${a.ac_id} reads: "${clip(a.text, 600)}". Using only the text in the state, does the evidence recorded for ${a.ac_id}, together with the handoff ` +
          "and reviews, show that this criterion is met? You cannot see the code. A bare claim such as 'done' is not evidence.",
        home,
      ),
      criteria: { ...AC_CRITERIA },
    };
  }
  questions.open_work = {
    type: "noul",
    instructions: "Does the handoff, any evidence, or any review say that work required by the acceptance criteria is still unfinished, untested or failing?",
  };
  questions.overall = {
    type: "choice",
    instructions: "Overall, how ready does this ticket look for a reviewer to approve, judging only the recorded evidence, handoff and reviews in the state?",
    criteria: { ...OVERALL_CRITERIA },
  };
  return { state, questions, ...(model ? { model } : {}) };
}

function parseAnswers(out: unknown, questions: Record<string, Question>, acIds: string[]): JevReview {
  if (!out || typeof out !== "object") throw new FlowError("EXTERNAL_FAILURE", `${TOOL} returned no JSON`, { retryable: true });
  const env = out as Envelope;
  if (env.ok === false || !env.result) {
    const e = env.error ?? {};
    throw new FlowError("EXTERNAL_FAILURE", `jev: ${e.code ?? "error"}: ${e.message ?? "no result"}`, { nextSteps: e.next_steps ?? [] });
  }
  const answers = env.result.answers ?? {};
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers[qid];
    const valid = q.type === "noul" ? typeof a?.noul === "number" : typeof a?.choice === "string" && a.choice in (q.criteria ?? {});
    if (!valid) throw new FlowError("EXTERNAL_FAILURE", `jev returned no valid answer for ${qid}`, { retryable: true });
  }
  const overall = answers.overall;
  return {
    verdict: overall.choice as JevVerdict,
    confidence: overall.confidence ?? null,
    ac: Object.fromEntries(
      acIds.map((id) => {
        const a = answers[questionId(id)];
        return [id, { choice: a.choice as keyof typeof AC_CRITERIA, confidence: a.confidence ?? null }];
      }),
    ),
    open_work: answers.open_work.noul ?? null,
    model: env.result.model ?? null,
    usage: env.result.usage ?? null,
  };
}

const pct = (p: number | null) => (p === null ? "n/a" : p.toFixed(2));

export function jevComment(r: JevReview): string {
  return [
    `Jev review (advisory${r.model ? `, ${r.model}` : ""}): **${r.verdict}** (${pct(r.confidence)})`,
    ...Object.entries(r.ac).map(([id, a]) => `- ${id}: ${a.choice} (${pct(a.confidence)})`),
    `- Notes say required work is unfinished: ${pct(r.open_work)}`,
    "Jev judged the recorded evidence, handoff and reviews, not the code. Confidence is not proof: a reviewer still approves or rejects.",
  ].join("\n");
}

export async function jevReview(ws: Workspace, id: string, opts: { cwd?: string; dryRun: true }, open?: McpOpener): Promise<{ dry_run: JevDryRun }>;
export async function jevReview(ws: Workspace, id: string, opts?: { cwd?: string; dryRun?: false }, open?: McpOpener): Promise<JevReview>;
export async function jevReview(ws: Workspace, id: string, opts?: { cwd?: string; dryRun?: boolean }, open?: McpOpener): Promise<JevReview | { dry_run: JevDryRun }>;
export async function jevReview(
  ws: Workspace,
  id: string,
  opts: { cwd?: string; dryRun?: boolean } = {},
  open: McpOpener = openStdioMcp,
): Promise<JevReview | { dry_run: JevDryRun }> {
  const launch = jevLaunch(ws);
  const t = ws.store.detail(id, { events: 50 });
  const request = buildJevRequest(t, ws.config.jev.model);
  if (opts.dryRun) return { dry_run: { tool: TOOL, arguments: request, launch } };
  if (t.status !== "review") throw new FlowError("INVALID_TRANSITION", `${id} is ${t.status}; Jev reviews tickets in review`);

  const session = await open({ name: "jev-mcp", ...launch, timeoutMs: ws.config.jev.timeoutMs });
  let out: unknown;
  try {
    out = await session.call(TOOL, request);
  } finally {
    await session.close();
  }
  const review = parseAnswers(out, request.questions, t.acceptance.map((a) => a.ac_id));
  ws.store.comment(id, "review", jevComment(review), ACTOR);
  ws.store.record("jev.reviewed", ACTOR, id, {
    verdict: review.verdict,
    confidence: review.confidence,
    ac: Object.fromEntries(Object.entries(review.ac).map(([k, v]) => [k, v.choice])),
    open_work: review.open_work,
    model: review.model,
  });
  return review;
}

/** Run after a successful submit when `jev.onSubmit` is on. Never throws: a failure is an event, not a failed submit. */
export async function jevAfterSubmit(ws: Workspace, id: string, open?: McpOpener): Promise<JevReview | { error: string }> {
  try {
    return await jevReview(ws, id, {}, open);
  } catch (err) {
    const error = clip(redactHome(redactSecrets(err instanceof Error ? err.message : String(err)), os.homedir()), 500);
    ws.store.record("jev.failed", ACTOR, id, { error });
    return { error };
  }
}
