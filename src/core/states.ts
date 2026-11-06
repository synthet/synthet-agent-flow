import type { Status } from "./config.js";

export const ACTIONS = [
  "promote",
  "demote",
  "claim",
  "start",
  "release",
  "block",
  "unblock",
  "submit",
  "approve",
  "reject",
  "close",
  "reopen",
  "cancel",
] as const;
export type Action = (typeof ACTIONS)[number];

interface Rule {
  from: readonly Status[];
  /** Target status; `unblock` is resolved at runtime (owner → in_progress, else ready). */
  to: Status | "dynamic";
  /** Only the current owner (or a human / system actor) may perform it. */
  ownerOnly?: boolean;
  /** A reason string is mandatory. */
  needsReason?: boolean;
}

const OPEN: readonly Status[] = ["backlog", "ready", "claimed", "in_progress", "blocked", "review"];

export const RULES: Record<Action, Rule> = {
  promote: { from: ["backlog"], to: "ready" },
  demote: { from: ["ready"], to: "backlog" },
  claim: { from: ["ready"], to: "claimed" },
  start: { from: ["claimed"], to: "in_progress", ownerOnly: true },
  release: { from: ["claimed", "in_progress"], to: "ready", ownerOnly: true },
  block: { from: ["ready", "claimed", "in_progress"], to: "blocked", needsReason: true },
  unblock: { from: ["blocked"], to: "dynamic" },
  submit: { from: ["claimed", "in_progress"], to: "review", ownerOnly: true },
  approve: { from: ["review"], to: "done" },
  reject: { from: ["review"], to: "in_progress", needsReason: true },
  close: { from: ["claimed", "in_progress", "review"], to: "done", ownerOnly: true },
  reopen: { from: ["done"], to: "ready", needsReason: true },
  cancel: { from: OPEN, to: "cancelled" },
};

export function canTransition(action: Action, from: Status): boolean {
  return RULES[action].from.includes(from);
}

/** Actions available from a status (used by the dashboard to colour drop targets). */
export function actionsFrom(from: Status): Action[] {
  return ACTIONS.filter((a) => RULES[a].from.includes(from));
}

/**
 * Map a board drag (column → column) to a lifecycle action, or null if no single action applies.
 */
export function actionForMove(from: Status, to: Status): Action | null {
  if (from === to) return null;
  const candidates = ACTIONS.filter((a) => {
    const r = RULES[a];
    if (!r.from.includes(from)) return false;
    if (r.to === "dynamic") return to === "ready" || to === "in_progress";
    return r.to === to;
  });
  // Prefer the "forward" action when several match (e.g. review→in_progress is reject).
  return candidates[0] ?? null;
}
