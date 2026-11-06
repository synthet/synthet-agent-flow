/**
 * Structured, actionable errors (same envelope shape as synthet-agent-swarm's `swarmError`).
 * Every surface (CLI, MCP, REST) serialises FlowError the same way so agents can branch on `code`.
 */
export type FlowErrorCode =
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "INVALID_TRANSITION"
  | "CLAIM_CONFLICT"
  | "NOT_OWNER"
  | "WIP_LIMIT"
  | "BLOCKED_BY_DEPENDENCY"
  | "GATE_FAILED"
  | "CYCLE"
  | "VERSION_CONFLICT"
  | "NOT_INITIALIZED"
  | "CONFIRMATION_REQUIRED"
  | "EXTERNAL_FAILURE"
  | "UNAUTHORIZED"
  | "INTERNAL";

export interface FlowErrorShape {
  code: FlowErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  next_steps: string[];
}

export class FlowError extends Error {
  readonly code: FlowErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly nextSteps: string[];

  constructor(
    code: FlowErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryable?: boolean; nextSteps?: string[] } = {},
  ) {
    super(message);
    this.name = "FlowError";
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    this.nextSteps = opts.nextSteps ?? [];
  }

  toJSON(): FlowErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
      next_steps: this.nextSteps,
    };
  }
}

export function toFlowError(err: unknown): FlowError {
  if (err instanceof FlowError) return err;
  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown[] }).issues)) {
    const issues = (err as { issues: Array<{ path: unknown[]; message: string }> }).issues;
    return new FlowError("INVALID_ARGUMENT", issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FlowError("INTERNAL", message);
}

/** Exit codes shared by CLI and hooks: 0 ok, 1 error, 2 conflict / blocked. */
export function exitCodeFor(err: FlowError): number {
  switch (err.code) {
    case "CLAIM_CONFLICT":
    case "WIP_LIMIT":
    case "BLOCKED_BY_DEPENDENCY":
    case "GATE_FAILED":
    case "VERSION_CONFLICT":
      return 2;
    default:
      return 1;
  }
}
