import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { defaultRunner, type Runner } from "./exec.js";

/**
 * Cross-repo adoption report: for each tracked repo under a root, how many tickets were created, claimed and finished
 * in a window, against how many commits the repo's git user made. Read-only: tickets come from the committed
 * `tickets.jsonl` snapshot (no database is opened or created), commits from `git rev-list --author=<user.email>`.
 */
export interface AdoptionRow {
  repo: string;
  path: string;
  created: number;
  claimed: number;
  done: number;
  commits: number;
  /** Commits landed in the window but no ticket was created or claimed. */
  untracked: boolean;
  error?: string;
}

interface SnapshotTicket {
  status?: string;
  created_at?: string | null;
  claimed_at?: string | null;
  closed_at?: string | null;
}

const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** `30d`, `2w`, `12h`, or a date (`2026-11-01`) → epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
  const m = /^(\d+)([hdw])$/i.exec(value.trim());
  if (m) return now - Number(m[1]) * UNITS[m[2].toLowerCase()];
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new FlowError("INVALID_ARGUMENT", `--since must look like 30d, 2w, 12h or a date, got "${value}"`);
  return t;
}

function readSnapshot(file: string): SnapshotTicket[] {
  if (!existsSync(file)) return [];
  const out: SnapshotTicket[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SnapshotTicket);
    } catch {
      /* a torn line in a snapshot is skipped, not fatal */
    }
  }
  return out;
}

const inWindow = (ts: string | null | undefined, sinceMs: number) => !!ts && Date.parse(ts) >= sinceMs;

export async function adoptionReport(opts: { root: string; sinceMs: number; run?: Runner }): Promise<AdoptionRow[]> {
  const run = opts.run ?? defaultRunner;
  const seen = new Set<string>();
  const rows: AdoptionRow[] = [];
  const entries = readdirSync(opts.root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const dir = path.join(opts.root, entry.name);
    if (!existsSync(path.join(dir, ".agent-flow", "config.json"))) continue;
    // Junctions and symlinks to the same checkout count once.
    let real = dir;
    try {
      real = realpathSync.native(dir);
    } catch {
      /* keep dir */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const tickets = readSnapshot(path.join(dir, ".agent-flow", "tickets.jsonl"));
    const row: AdoptionRow = {
      repo: path.basename(real),
      path: real,
      created: tickets.filter((t) => inWindow(t.created_at, opts.sinceMs)).length,
      claimed: tickets.filter((t) => inWindow(t.claimed_at, opts.sinceMs)).length,
      done: tickets.filter((t) => t.status === "done" && inWindow(t.closed_at, opts.sinceMs)).length,
      commits: 0,
      untracked: false,
    };
    // Count the repo user's own commits (what agents commit as), so upstream history in forks doesn't drown the signal.
    const who = await run(["git", "-C", real, "config", "user.email"], { timeoutMs: 10_000 });
    const email = who.code === 0 ? who.stdout.trim() : "";
    const res = await run(
      ["git", "-C", real, "rev-list", "--count", "--branches", `--since=${new Date(opts.sinceMs).toISOString()}`, ...(email ? [`--author=${email}`] : [])],
      { timeoutMs: 30_000 },
    );
    if (res.code === 0) row.commits = Number.parseInt(res.stdout.trim(), 10) || 0;
    else row.error = (res.stderr || res.stdout).trim().slice(0, 200) || `git exited ${res.code}`;
    row.untracked = row.commits > 0 && row.created === 0 && row.claimed === 0;
    rows.push(row);
  }
  // Untracked activity first, then the busiest repos.
  return rows.sort((a, b) => Number(b.untracked) - Number(a.untracked) || b.commits - a.commits || a.repo.localeCompare(b.repo));
}

export function renderAdoption(rows: AdoptionRow[], since: string): string {
  if (!rows.length) return "No repos with .agent-flow/ under this root.";
  const head = ["repo", "commits", "created", "claimed", "done", "flag"];
  const body = rows.map((r) => [r.repo, String(r.commits), String(r.created), String(r.claimed), String(r.done), r.error ? `error: ${r.error}` : r.untracked ? "untracked activity" : ""]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const flagged = rows.filter((r) => r.untracked).length;
  return [`Since ${since}: ${rows.length} tracked repos, ${flagged} with commits but no tickets.`, "", line(head), ...body.map(line)].join("\n");
}
