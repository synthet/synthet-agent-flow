import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowError } from "../core/errors.js";
import { clip, redactHome, redactSecrets } from "../core/redaction.js";
import { defaultRunner, type Runner } from "./exec.js";
import type { TriageItem, TriagePlan } from "./triage.js";

/**
 * GitHub-issue source for `agent-flow triage` (housekeeping protocol, synthet-code-framework
 * docs/housekeeping-protocol.md). Works on any git repo whose origin is on github.com; no `.agent-flow/` store is
 * needed. Every write (close, comment) leaves the machine, so `apply` acts only on ids the owner approved.
 */

export const ISSUE_DEFAULT_STALE_DAYS = 60;
const DAY = 86_400_000;
const SKIP_LABELS = new Set(["pinned", "keep", "stale-candidate", "security"]);

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  updatedAt: string;
  labels?: Array<{ name: string }>;
  url?: string;
}

interface GhPr {
  number: number;
  title?: string;
  body?: string;
}

export function ghRepoFromUrl(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const tokens = (title: string) => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const mentions = (text: string, n: number) => new RegExp(`(^|[^\\w/])#${n}(?![0-9])`).test(text);

/** Repo-relative paths the issue names in backticks, e.g. `src/core/store.ts`. */
function mentionedPaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/`([\w.@-]+(?:\/[\w.@-]+)+)`/g)) if (!m[1].includes("..")) out.add(m[1]);
  return [...out].slice(0, 10);
}

function gitRepos(opts: { root?: string; repo?: string }): string[] {
  if (opts.repo) return [path.resolve(opts.repo)];
  if (!opts.root) throw new FlowError("INVALID_ARGUMENT", "triage scan needs --root <projects root> or --repo <dir>");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of readdirSync(opts.root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(opts.root, entry.name);
    if (!entry.isDirectory() || !existsSync(path.join(dir, ".git"))) continue;
    let real = dir;
    try {
      real = realpathSync.native(dir);
    } catch {
      /* keep dir */
    }
    if (!seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

async function ghJson<T>(run: Runner, argv: string[]): Promise<T | null> {
  const r = await run(argv, { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

export async function scanIssues(opts: {
  root?: string;
  repo?: string;
  staleDays?: number;
  /** Only repos owned by these accounts (default: the authenticated gh user). Clones of upstream projects are skipped. */
  owners?: string[];
  now?: number;
  run?: Runner;
}): Promise<Pick<TriagePlan, "repos" | "items">> {
  const run = opts.run ?? defaultRunner;
  let owners = (opts.owners ?? []).map((o) => o.toLowerCase());
  if (!owners.length) {
    const me = await run(["gh", "api", "user", "-q", ".login"], { timeoutMs: 30_000 });
    if (me.code !== 0 || !me.stdout.trim()) {
      throw new FlowError("NOT_FOUND", "cannot tell whose repos to triage: run `gh auth login` or pass --owner <login>");
    }
    owners = [me.stdout.trim().toLowerCase()];
  }
  const now = opts.now ?? Date.now();
  const staleDays = opts.staleDays ?? ISSUE_DEFAULT_STALE_DAYS;
  const repos: TriagePlan["repos"] = [];
  const items: TriageItem[] = [];
  const seenGh = new Set<string>();
  for (const repo of gitRepos(opts)) {
    const origin = await run(["git", "-C", repo, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
    const gh = origin.code === 0 ? ghRepoFromUrl(origin.stdout) : null;
    if (!gh || seenGh.has(gh)) continue;
    seenGh.add(gh);
    if (!owners.includes(gh.split("/")[0].toLowerCase())) {
      repos.push({ repo: path.basename(repo), path: repo, error: `skipped: ${gh} is not owned by ${owners.join(", ")}` });
      continue;
    }
    const issues = await ghJson<GhIssue[]>(run, ["gh", "issue", "list", "-R", gh, "--state", "open", "--limit", "200", "--json", "number,title,body,updatedAt,labels,url"]);
    if (!issues) {
      repos.push({ repo: path.basename(repo), path: repo, error: "gh issue list failed (issues disabled, no access, or offline)" });
      continue;
    }
    repos.push({ repo: path.basename(repo), path: repo });
    const stale = issues.filter((i) => Math.floor((now - Date.parse(i.updatedAt)) / DAY) >= staleDays && !(i.labels ?? []).some((l) => SKIP_LABELS.has(l.name)));
    if (!stale.length) continue;
    const prs = (await ghJson<GhPr[]>(run, ["gh", "pr", "list", "-R", gh, "--state", "merged", "--limit", "200", "--json", "number,title,body"])) ?? [];
    for (const issue of stale) {
      const age = Math.floor((now - Date.parse(issue.updatedAt)) / DAY);
      const log = await run(["git", "-C", repo, "log", "--all", "-E", `--grep=#${issue.number}([^0-9]|$)`, "--format=%cs"], { timeoutMs: 30_000 });
      const commits = log.code === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : [];
      const paths = mentionedPaths(issue.body ?? "");
      const dup = issues
        .filter((o) => o.number !== issue.number)
        .map((o) => ({ n: o.number, s: similarity(issue.title, o.title) }))
        .sort((a, b) => b.s - a.s)[0];
      const evidence: Record<string, unknown> = {
        status: "open",
        age_days: age,
        labels: (issue.labels ?? []).map((l) => l.name),
        merged_prs_mentioning: prs.filter((p) => mentions(`${p.title ?? ""}\n${p.body ?? ""}`, issue.number)).map((p) => p.number),
        commits_referencing: commits.length,
        ...(commits.length ? { last_reference: commits[0] } : {}),
        ...(paths.length ? { paths_named: paths.length, paths_missing: paths.filter((p) => !existsSync(path.join(repo, p))).length } : {}),
        ...(dup && dup.s >= 0.6 ? { duplicate_of: dup.n, title_similarity: Number(dup.s.toFixed(2)) } : {}),
      };
      items.push({
        id: "",
        kind: "issue",
        repo: path.basename(repo),
        repo_path: repo,
        ticket: `#${issue.number}`,
        gh_repo: gh,
        number: issue.number,
        updated_at: issue.updatedAt,
        title: clip(redactHome(redactSecrets(issue.title), os.homedir()), 200),
        status: "open",
        version: 0,
        action: "decide",
        options: ["close_completed", "close_not_planned", ...(evidence.duplicate_of ? ["duplicate"] : []), "needs_info", "keep"],
        why: `open issue untouched ${age}d`,
        evidence,
        notify_remote: true,
      });
    }
  }
  return { repos, items };
}

/** The describe text for one issue: title, body and the last two comments, redacted. */
export async function issueBlock(run: Runner, it: TriageItem): Promise<string> {
  const data = await ghJson<{ title?: string; body?: string; comments?: Array<{ body?: string }> }>(run, [
    "gh", "issue", "view", String(it.number), "-R", it.gh_repo ?? "", "--json", "title,body,comments",
  ]);
  const comments = (data?.comments ?? []).slice(-2).map((c, i) => `Comment ${i + 1}: ${clip(c.body ?? "", 300)}`);
  const text = [
    `### #${it.number} (${it.why})`,
    `Title: ${data?.title ?? it.title}`,
    `Evidence: ${JSON.stringify(it.evidence)}`,
    `Body: ${clip((data?.body ?? "").trim() || "(none)", 700)}`,
    ...comments,
  ].join("\n");
  return redactHome(redactSecrets(text), os.homedir());
}

export interface IssueRecord {
  id: string;
  gh_repo: string;
  number: number;
  mode: string;
}

const CLOSE: Record<string, "completed" | "not planned"> = { close_completed: "completed", close_not_planned: "not planned", duplicate: "not planned" };

export async function applyIssues(
  plan: TriagePlan,
  opts: { apply: boolean; approve?: Iterable<string>; run?: Runner },
): Promise<{ done: IssueRecord[]; skipped: Array<{ id: string; why: string }>; log: string[] }> {
  const run = opts.run ?? defaultRunner;
  const approved = new Set(opts.approve ?? []);
  const done: IssueRecord[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  const log: string[] = [];
  const skip = (it: TriageItem, why: string) => {
    skipped.push({ id: it.id, why });
    log.push(`SKIP ${it.id} ${it.gh_repo}${it.ticket}: ${why}`);
  };
  for (const it of plan.items.filter((i) => i.kind === "issue" && (i.action in CLOSE || i.action === "needs_info"))) {
    if (!it.gh_repo || !it.number) {
      skip(it, "missing repo or issue number");
      continue;
    }
    if (!approved.has(it.id)) {
      skip(it, `${it.action} writes to GitHub; needs --approve ${it.id}`);
      continue;
    }
    if (!opts.apply) {
      log.push(`DRY ${it.action.toUpperCase()} ${it.gh_repo}${it.ticket} (${it.why})`);
      continue;
    }
    const live = await ghJson<{ state?: string; updatedAt?: string }>(run, ["gh", "issue", "view", String(it.number), "-R", it.gh_repo, "--json", "state,updatedAt"]);
    if (!live || live.state !== "OPEN" || live.updatedAt !== it.updated_at) {
      skip(it, "issue changed since scan (or is no longer open)");
      continue;
    }
    const note = [
      `Housekeeping triage (${it.action}): ${it.why}.`,
      it.action === "duplicate" ? `Duplicate of #${String(it.evidence.duplicate_of)}.` : "",
      it.jev ? `Jev chose ${it.jev.choice} at ${it.jev.confidence.toFixed(2)}.` : "",
      it.description ? `Agent read: ${it.description}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const reason = CLOSE[it.action];
    const argv = reason
      ? ["gh", "issue", "close", String(it.number), "-R", it.gh_repo, "--reason", reason, "--comment", note]
      : ["gh", "issue", "comment", String(it.number), "-R", it.gh_repo, "--body", note];
    const r = await run(argv, { timeoutMs: 60_000 });
    if (r.code !== 0) {
      skip(it, `gh failed: ${clip((r.stderr || r.stdout).trim(), 200)}`);
      continue;
    }
    done.push({ id: it.id, gh_repo: it.gh_repo, number: it.number, mode: it.action });
    log.push(`${it.action.toUpperCase()} ${it.gh_repo}${it.ticket}`);
  }
  return { done, skipped, log };
}

export async function verifyIssues(records: IssueRecord[], run: Runner = defaultRunner): Promise<string[]> {
  const problems: string[] = [];
  for (const r of records.filter((x) => x.mode in CLOSE)) {
    const live = await ghJson<{ state?: string }>(run, ["gh", "issue", "view", String(r.number), "-R", r.gh_repo, "--json", "state"]);
    if (live?.state !== "CLOSED") problems.push(`${r.gh_repo}#${r.number}: not closed (${live?.state ?? "unknown"})`);
  }
  return problems;
}

export function restoreIssues(records: IssueRecord[]): string[] {
  return records.map((r) =>
    r.mode in CLOSE ? `gh issue reopen ${r.number} -R ${r.gh_repo}` : `# ${r.gh_repo}#${r.number}: a comment was added; delete it on GitHub if unwanted`,
  );
}
