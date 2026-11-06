/**
 * Stable JSON: keys sorted recursively, undefined dropped.
 * Same contract as synthet-agent-mailbox `src/fabric/canonical.ts`, so hashes are comparable across tools.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}
