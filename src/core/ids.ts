import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Hash-style id (`af-k3x9q`): safe to create on different branches/machines and merge. */
export function newTicketId(prefix: string, length = 5): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}-${out}`;
}

export const TICKET_ID_RE = /\b([a-z][a-z0-9]{0,7}-[0-9a-z]{4,8})\b/;

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "work"
  );
}

/** Extract a ticket id from a branch like `af/af-k3x9q-add-login` or `feat/af-k3x9q`. */
export function ticketIdFromBranch(branch: string, prefix: string): string | null {
  const re = new RegExp(`(?:^|[/_-])(${prefix}-[0-9a-z]{4,8})(?=$|[/_-])`);
  const m = re.exec(branch);
  return m ? m[1] : null;
}
