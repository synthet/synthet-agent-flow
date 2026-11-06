import type { Workspace } from "../core/workspace.js";

/** Placeholder; the full GitHub mirror lands with the integrations milestone. */
export async function githubWebhookHandler(_event: string, _payload: unknown, _ws: Workspace): Promise<unknown> {
  return { ignored: true };
}
