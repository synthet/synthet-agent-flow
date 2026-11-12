import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const STATUSES = [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];

export const LANES = ["expedite", "feature", "bug", "maintenance"] as const;
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const TICKET_TYPES = ["feature", "bug", "chore", "spike", "docs", "epic"] as const;

// `.prefault` parses its value, so a missing section still gets its nested defaults. `.default` would return `{}` as is.
export const configSchema = z.object({
  version: z.literal(1).default(1),
  /** Ticket id prefix, e.g. `af` → `af-k3x9q`. */
  prefix: z.string().regex(/^[a-z][a-z0-9]{0,7}$/).default("af"),
  leaseMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  wip: z
    .object({
      perAgent: z.number().int().min(1).max(50).default(1),
      columns: z.partialRecord(z.enum(STATUSES), z.number().int().min(1)).prefault({ in_progress: 4, review: 6 }),
    })
    .prefault({}),
  requireReview: z.boolean().default(true),
  requireHandoff: z.boolean().default(true),
  allowSelfApprove: z.boolean().default(false),
  /**
   * An agent or system approver must have recorded its own Verified verdict on every acceptance criterion, and must
   * never have claimed, started or submitted the ticket. Humans approve on the owner's evidence. `agent-flow review
   * <id> --brief` (MCP `flow_review_brief`) hands out such a reviewer identity.
   */
  independentReview: z.boolean().default(true),
  /** Definition-of-Done commands run before `submit` (and by the DoD hooks). */
  dod: z.array(z.string()).default([]),
  dodTimeoutMs: z.number().int().min(1000).default(10 * 60 * 1000),
  autoExport: z.boolean().default(true),
  defaultBranch: z.string().default("main"),
  branchPattern: z.string().default("af/{id}-{slug}"),
  worktreeDir: z.string().default("../{repo}.worktrees"),
  loop: z
    .object({
      maxTickets: z.number().int().min(1).max(100).default(5),
      label: z.string().nullable().default("agent-ok"),
      maxTurns: z.number().int().min(1).default(80),
      harness: z.enum(["claude", "codex"]).default("claude"),
    })
    .prefault({}),
  github: z
    .object({
      enabled: z.boolean().default(false),
      repo: z.string().nullable().default(null),
      labelPrefix: z.string().default("status:"),
      issueLabel: z.string().default("agent-flow"),
      reconcileMinutes: z.number().int().min(0).default(5),
      webhookSecretEnv: z.string().default("AGENT_FLOW_GITHUB_SECRET"),
    })
    .prefault({}),
  mailbox: z
    .object({
      enabled: z.boolean().default(false),
      bin: z.string().default("agent-mail"),
      session: z.string().default("agent-flow"),
      scope: z.string().nullable().default(null),
      audience: z.enum(["group", "broadcast", "topic"]).default("group"),
      notifyOn: z
        .array(z.string())
        .default(["claimed", "review", "rejected", "blocked", "needs_human", "done", "lease_expired"]),
      reviewPeer: z.string().nullable().default(null),
    })
    .prefault({}),
  swarm: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().nullable().default(null),
      harnesses: z.array(z.string()).default([]),
      autoApproveOnMajority: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).default(300000),
    })
    .prefault({}),
  /**
   * Advisory Jev (TypeSafe System One) review through a jev-mcp checkout. Jev only comments: it never
   * approves, rejects or verifies. `onSubmit` spends one paid call per submit, so it is off by default.
   */
  jev: z
    .object({
      path: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      onSubmit: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).default(120000),
    })
    .prefault({}),
  /**
   * LLM Wiki export (synthet-llm-wiki). On approve/close the ticket is written as a markdown source
   * under `<root>/<outDir>/<repo>/<id>.md` and, with `ingest`, passed to `llmwiki ingest`. Off by default.
   */
  wiki: z
    .object({
      enabled: z.boolean().default(false),
      root: z.string().nullable().default(null),
      outDir: z.string().default("wiki/notes/agent-flow"),
      ingest: z.boolean().default(true),
      bin: z.string().default("llmwiki"),
    })
    .prefault({}),
  hooks: z
    .object({
      /** Run DoD on Claude Code TaskCompleted (exit 2 blocks completion). Off by default: can be slow. */
      taskCompletedDod: z.boolean().default(false),
      /** Nudge once on Stop when leaving an owned ticket without a handoff note. */
      handoffOnStop: z.boolean().default(true),
      /** Remind once per session when committing or opening a PR while holding no ticket. Advisory only. */
      untrackedNudge: z.boolean().default(true),
      heartbeatMinutes: z.number().int().min(1).default(5),
    })
    .prefault({}),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(8791),
    })
    .prefault({}),
});

export type FlowConfig = z.infer<typeof configSchema>;

export function defaultConfig(overrides: Partial<FlowConfig> = {}): FlowConfig {
  return configSchema.parse(overrides);
}

export function loadConfig(file: string): FlowConfig {
  if (!existsSync(file)) return defaultConfig();
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return configSchema.parse(raw);
}

export function saveConfig(file: string, config: FlowConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
