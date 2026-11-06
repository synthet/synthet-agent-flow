/**
 * Secret redaction for anything that leaves the tracker (mailbox notifications, swarm prompts,
 * GitHub mirrors). Ported from synthet-agent-swarm `services/redaction.ts`.
 */
const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { pattern: /ghp_[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /gho_[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_OAUTH]" },
  { pattern: /github_pat_[a-zA-Z0-9_]{20,}/g, replacement: "[REDACTED_GITHUB_PAT]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
  { pattern: /(?:Bearer|bearer)\s+[a-zA-Z0-9._-]+/g, replacement: "Bearer [REDACTED]" },
  {
    pattern: /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
    replacement: "[REDACTED_CREDENTIAL]",
  },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactObject(v);
    return out as T;
  }
  return value;
}

/** Truncate to `max` chars with a visible marker. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 20))}\n…[truncated ${text.length - max + 20} chars]`;
}
