import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { actorKind, type FlowStore } from "../core/store.js";
import { FlowError } from "../core/errors.js";
import type { Ticket } from "../core/types.js";
import type { Status } from "../core/config.js";

export interface PlannedTask {
  key: string;
  title: string;
  body?: string;
  type?: string;
  priority?: string;
  labels?: string[];
  scope_paths?: string[];
  acceptance?: Array<{ ac_id: string; text: string }>;
  deps?: string[];
  status?: Status;
  owner_role?: string;
}

export interface ImportPlan {
  format: string;
  source: string;
  epic?: { title: string; body?: string; acceptance?: Array<{ ac_id: string; text: string }> };
  tasks: PlannedTask[];
  warnings: string[];
}

export type ImportFormat = "auto" | "framework" | "speckit" | "openspec" | "local-markdown" | "checklist";

const PATH_RE = /(?:^|[\s`(])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8}|(?:[\w@.-]+\/){1,}[\w@-]+\/)(?=$|[\s`),;:])/g;
const AC_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?(AC-\d+)(?:\*\*)?\s*[:.—–-]\s*(.+?)\s*$/;

/** Markdown may arrive with CRLF (Windows editors, autocrlf). `.` does not match `\r`, so `(.+)$` patterns would silently miss every line. */
const toLf = (text: string): string => text.replace(/\r\n?/g, "\n");
const readText = (file: string): string => toLf(readFileSync(file, "utf8"));

export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, "");
    if (!/^https?:/.test(p) && !p.includes("://")) out.add(p);
  }
  return [...out];
}

/** `AC-n: text` lines anywhere in a document. */
export function extractAcceptance(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of toLf(text).split("\n")) {
    const m = AC_LINE_RE.exec(line);
    if (m && !map.has(m[1])) map.set(m[1], m[2].replace(/\*\*/g, "").trim());
  }
  // Also table rows like | AC-1 | text | …
  for (const row of parseTables(text).flatMap((t) => t.rows)) {
    const first = row[0]?.trim();
    // Skip traceability rows (`| AC-1 | T-2, T-3 |`) — those map ACs to tasks, not to text.
    if (first && /^AC-\d+$/.test(first) && row[1] && !/^(T-?\d+[,\s]*)+$/i.test(row[1].trim()) && !map.has(first)) {
      map.set(first, row[1].trim());
    }
  }
  return map;
}

// ────────────────────────────── markdown tables ──────────────────────────────

export interface MdTable {
  header: string[];
  rows: string[][];
  heading: string | null;
}

export function parseTables(text: string): MdTable[] {
  const lines = toLf(text).split("\n");
  const tables: MdTable[] = [];
  let heading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) heading = h[1].trim();
    if (!line.trim().startsWith("|")) continue;
    const sep = lines[i + 1];
    if (!sep || !/^\s*\|?\s*:?-{2,}/.test(sep)) continue;
    const header = splitRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(splitRow(lines[j]));
    tables.push({ header, rows, heading });
    i = j - 1;
  }
  return tables;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on unescaped pipes
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function findCol(header: string[], re: RegExp, exclude: number[] = []): number {
  return header.findIndex((h, i) => !exclude.includes(i) && re.test(h.toLowerCase().replace(/[*_`]/g, "").trim()));
}

const listCell = (cell: string | undefined): string[] =>
  (cell ?? "")
    .replace(/[`*]/g, "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "-" && s !== "—" && s.toLowerCase() !== "none" && s.toLowerCase() !== "n/a");

// ────────────────────────────── framework /tasks ──────────────────────────────

/**
 * synthet-code-framework `/tasks` output: a `T-n` task table (owner role, files/areas, dependency IDs,
 * ACs covered, verification) plus spec `AC-n` lines. Columns are matched by header keywords.
 */
export function parseFrameworkTasks(text: string, source: string, specText?: string): ImportPlan {
  const warnings: string[] = [];
  const acText = extractAcceptance(`${specText ?? ""}\n${text}`);
  const table = parseTables(text).find((t) => {
    const id = findCol(t.header, /^(id|task ?id|#|task)$/);
    return id >= 0 && t.rows.some((r) => /^T-?\d+/i.test((r[id] ?? "").replace(/[*`]/g, "")));
  });
  if (!table) throw new FlowError("INVALID_ARGUMENT", `no T-n task table found in ${source}`);
  const h = table.header;
  const idCol = findCol(h, /^(id|task ?id|#)$/) >= 0 ? findCol(h, /^(id|task ?id|#)$/) : findCol(h, /^task$/);
  const titleCol = findCol(h, /(task|title|description|summary|work|what)/, [idCol]);
  const ownerCol = findCol(h, /(owner|role|agent)/, [idCol]);
  const filesCol = findCol(h, /(file|area|path|scope|touch)/, [idCol]);
  const depsCol = findCol(h, /(depend|blocked|after|requires|prereq)/, [idCol]);
  const acCol = findCol(h, /(^acs?$|\bac\b|acceptance|criteria|covers)/, [idCol]);
  const verifyCol = findCol(h, /(verif|evidence|test|command|check)/, [idCol, titleCol]);
  const tasks: PlannedTask[] = [];
  for (const row of table.rows) {
    const key = (row[idCol] ?? "").replace(/[*`]/g, "").trim().replace(/^T(\d)/i, "T-$1");
    if (!/^T-\d+/.test(key)) continue;
    const title = (row[titleCol] ?? key).replace(/\*\*/g, "").trim();
    const files = filesCol >= 0 ? listCell(row[filesCol]).filter((f) => f.includes("/") || f.includes(".")) : [];
    const deps = depsCol >= 0 ? listCell(row[depsCol]).map((d) => d.replace(/^T(\d)/i, "T-$1")).filter((d) => /^T-\d+/.test(d)) : [];
    const acIds = acCol >= 0 ? listCell(row[acCol]).filter((a) => /^AC-\d+$/.test(a)) : [];
    const verify = verifyCol >= 0 ? (row[verifyCol] ?? "").trim() : "";
    const acceptance = acIds.map((ac) => ({ ac_id: ac, text: acText.get(ac) ?? `${ac} (see spec)` }));
    if (acIds.some((a) => !acText.has(a))) warnings.push(`${key}: AC text not found for ${acIds.filter((a) => !acText.has(a)).join(", ")}`);
    if (acceptance.length === 0 && verify) acceptance.push({ ac_id: "AC-1", text: `Verification passes: ${verify}` });
    const role = ownerCol >= 0 ? (row[ownerCol] ?? "").trim() : "";
    const body = [
      `Imported from ${source} (${key}).`,
      files.length ? `Files / areas: ${files.join(", ")}` : "",
      role ? `Owner role: ${role}` : "",
      verify ? `Verify: ${verify}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    tasks.push({
      key,
      title,
      body,
      scope_paths: files,
      acceptance,
      deps,
      labels: role ? [`role:${slugLabel(role)}`] : [],
      owner_role: role || undefined,
      type: /\btest|validat/i.test(title) ? "chore" : "feature",
    });
  }
  const keys = new Set(tasks.map((t) => t.key));
  for (const t of tasks) {
    const missing = (t.deps ?? []).filter((d) => !keys.has(d));
    if (missing.length) warnings.push(`${t.key}: unknown dependencies ${missing.join(", ")} (ignored)`);
    t.deps = (t.deps ?? []).filter((d) => keys.has(d));
  }
  const title = firstHeading(specText ?? text) ?? path.basename(source, path.extname(source));
  return {
    format: "framework",
    source,
    epic: { title, body: `Tasks imported from ${source}.`, acceptance: [...acText].map(([ac_id, t]) => ({ ac_id, text: t })) },
    tasks,
    warnings,
  };
}

// ────────────────────────────── Spec Kit tasks.md ──────────────────────────────

const CHECK_RE = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/;

/**
 * GitHub Spec Kit `tasks.md`: `- [ ] T001 [P] [US1] Description in src/x.py`, grouped by `## Phase` headings.
 * Sequential tasks depend on the previous group; consecutive `[P]` tasks form a parallel group.
 */
export function parseSpecKit(text: string, source: string): ImportPlan {
  const tasks: PlannedTask[] = [];
  let phase: string | null = null;
  let frontier: string[] = [];
  let group: string[] | null = null;
  let groupDeps: string[] = [];
  for (const line of toLf(text).split("\n")) {
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) {
      phase = h[1].trim();
      group = null;
      continue;
    }
    const m = CHECK_RE.exec(line);
    if (!m) continue;
    const done = m[1].toLowerCase() === "x";
    let rest = m[2].trim();
    const idm = /^(T\d+)\b\s*/.exec(rest);
    if (!idm) continue;
    const key = idm[1];
    rest = rest.slice(idm[0].length);
    let parallel = false;
    const labels: string[] = [];
    for (;;) {
      const tag = /^\[([^\]]+)\]\s*/.exec(rest);
      if (!tag) break;
      if (tag[1] === "P") parallel = true;
      else labels.push(`story:${tag[1]}`);
      rest = rest.slice(tag[0].length);
    }
    let deps: string[];
    if (parallel) {
      if (group) {
        deps = [...groupDeps];
        group.push(key);
      } else {
        groupDeps = [...frontier];
        deps = [...groupDeps];
        group = [key];
      }
      frontier = [...group];
    } else {
      deps = [...frontier];
      group = null;
      frontier = [key];
    }
    if (phase) labels.push(`phase:${slugLabel(phase.replace(/^phase\s*\d+\s*[:.-]?\s*/i, "")) || "phase"}`);
    const title = rest.replace(/\s+/g, " ").trim();
    tasks.push({
      key,
      title: title.length > 120 ? `${title.slice(0, 117)}…` : title,
      body: `Imported from ${source} (${key}${phase ? `, ${phase}` : ""}).\n\n${title}`,
      scope_paths: extractPaths(rest),
      labels,
      deps,
      status: done ? "done" : undefined,
      type: /\btests?\b/i.test(title) ? "chore" : "feature",
      acceptance: [{ ac_id: "AC-1", text: title }],
    });
  }
  if (tasks.length === 0) throw new FlowError("INVALID_ARGUMENT", `no "- [ ] T001 ..." tasks found in ${source}`);
  return { format: "speckit", source, epic: { title: firstHeading(text) ?? path.basename(path.dirname(path.resolve(source))) }, tasks, warnings: [] };
}

// ────────────────────────────── OpenSpec change ──────────────────────────────

/**
 * OpenSpec change folder (`openspec/changes/<name>/`): `tasks.md` numbered checklists under `## n. Section`
 * headings, `proposal.md` for the epic body, and delta specs' `#### Scenario:` blocks as epic acceptance.
 * Sections are sequential barriers; tasks within a section are sequential.
 */
export function parseOpenSpec(changeDirOrTasks: string): ImportPlan {
  const isDir = existsSync(changeDirOrTasks) && statSync(changeDirOrTasks).isDirectory();
  const dir = isDir ? changeDirOrTasks : path.dirname(changeDirOrTasks);
  const tasksFile = isDir ? path.join(dir, "tasks.md") : changeDirOrTasks;
  if (!existsSync(tasksFile)) throw new FlowError("INVALID_ARGUMENT", `no tasks.md in ${dir}`);
  const text = readText(tasksFile);
  const name = path.basename(dir);
  const tasks: PlannedTask[] = [];
  let section: string | null = null;
  let prevSectionLast: string | null = null;
  let lastInSection: string | null = null;
  let auto = 0;
  for (const line of text.split("\n")) {
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) {
      if (lastInSection) prevSectionLast = lastInSection;
      lastInSection = null;
      section = h[1].trim();
      continue;
    }
    const m = CHECK_RE.exec(line);
    if (!m) continue;
    let rest = m[2].trim();
    const num = /^(\d+(?:\.\d+)*)\.?\s+/.exec(rest);
    const key = num ? num[1] : `t${++auto}`;
    if (num) rest = rest.slice(num[0].length);
    const deps = lastInSection ? [lastInSection] : prevSectionLast ? [prevSectionLast] : [];
    tasks.push({
      key,
      title: rest,
      body: `Imported from OpenSpec change \`${name}\`${section ? ` — ${section}` : ""}.\n\n${rest}`,
      scope_paths: extractPaths(rest),
      labels: [`openspec:${slugLabel(name)}`],
      deps,
      status: m[1].toLowerCase() === "x" ? "done" : undefined,
      acceptance: [{ ac_id: "AC-1", text: rest }],
    });
    lastInSection = key;
  }
  const proposal = path.join(dir, "proposal.md");
  const proposalText = existsSync(proposal) ? readText(proposal) : "";
  const scenarios = collectScenarios(path.join(dir, "specs"));
  return {
    format: "openspec",
    source: tasksFile,
    epic: {
      title: firstHeading(proposalText)?.replace(/^(change|proposal)\s*:\s*/i, "") ?? name,
      body: proposalText.trim() || `OpenSpec change ${name}`,
      acceptance: scenarios.map((s, i) => ({ ac_id: `AC-${i + 1}`, text: s })),
    },
    tasks,
    warnings: tasks.length ? [] : [`no checklist tasks in ${tasksFile}`],
  };
}

function collectScenarios(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".md")) {
        const lines = readText(p).split("\n");
        for (let i = 0; i < lines.length; i++) {
          const s = /^#{3,5}\s+Scenario:\s*(.+)$/.exec(lines[i]);
          if (!s) continue;
          const then = lines.slice(i + 1, i + 8).find((l) => /\bTHEN\b/.test(l));
          out.push(then ? `${s[1].trim()} — ${then.replace(/^[-*\s]+/, "").replace(/\*\*/g, "").trim().replace(/^THEN\s+/i, "")}` : s[1].trim());
        }
      }
    }
  };
  walk(dir);
  return out;
}

// ────────────────────────────── local-markdown backlog ──────────────────────────────

const LOCAL_STATUS: Record<string, Status> = {
  backlog: "backlog",
  ready: "ready",
  claimed: "ready",
  "in progress": "ready",
  blocked: "blocked",
  review: "review",
  done: "done",
};

/** synthet-code-framework Local Markdown provider: `| ID | Status | Priority | Owner | Title | Notes |`. */
export function parseLocalMarkdown(text: string, source: string): ImportPlan {
  const table = parseTables(text).find((t) => findCol(t.header, /^id$/) >= 0 && findCol(t.header, /^status$/) >= 0);
  if (!table) throw new FlowError("INVALID_ARGUMENT", `no | ID | Status | … | table in ${source}`);
  const h = table.header;
  const c = {
    id: findCol(h, /^id$/),
    status: findCol(h, /^status$/),
    priority: findCol(h, /^priority$/),
    owner: findCol(h, /^owner$/),
    title: findCol(h, /^title$/),
    notes: findCol(h, /^notes?$/),
  };
  const warnings: string[] = [];
  const tasks: PlannedTask[] = table.rows
    .filter((r) => (r[c.id] ?? "").trim())
    .map((r) => {
      const key = r[c.id].trim();
      const raw = (r[c.status] ?? "").trim().toLowerCase();
      const status = LOCAL_STATUS[raw] ?? "backlog";
      const owner = c.owner >= 0 ? (r[c.owner] ?? "").trim() : "";
      const notes = c.notes >= 0 ? (r[c.notes] ?? "").trim() : "";
      if ((raw === "claimed" || raw === "in progress") && owner && owner !== "-") {
        warnings.push(`${key}: was "${r[c.status].trim()}" by ${owner}; imported as ready (claims are not migrated)`);
      }
      const prio = (c.priority >= 0 ? r[c.priority] : "p2")?.trim().toLowerCase();
      const acm = /acceptance\s*:\s*(.+)$/i.exec(notes);
      return {
        key,
        title: (c.title >= 0 ? r[c.title] : key).trim(),
        body: [`Migrated from ${source} (${key}).`, notes].filter(Boolean).join("\n\n"),
        priority: /^p[0-3]$/.test(prio ?? "") ? prio : "p2",
        status,
        labels: [`legacy:${key}`],
        acceptance: acm ? [{ ac_id: "AC-1", text: acm[1].trim() }] : [],
      };
    });
  return { format: "local-markdown", source, tasks, warnings };
}

// ────────────────────────────── detection & apply ──────────────────────────────

export function detectFormat(file: string, text: string): Exclude<ImportFormat, "auto"> {
  if (existsSync(file) && statSync(file).isDirectory()) return "openspec";
  if (/openspec\/changes\//.test(path.resolve(file).replace(/\\/g, "/"))) return "openspec";
  if (/^\s*[-*]\s*\[[ xX]\]\s*T\d{2,}\b/m.test(text)) return "speckit";
  const tables = parseTables(text);
  if (tables.some((t) => findCol(t.header, /^id$/) >= 0 && findCol(t.header, /^status$/) >= 0 && findCol(t.header, /^owner$/) >= 0)) return "local-markdown";
  if (tables.some((t) => t.rows.some((r) => r.some((cell) => /^\**T-?\d+\**$/.test(cell.trim()))))) return "framework";
  if (/^\s*[-*]\s*\[[ xX]\]/m.test(text)) return "checklist";
  throw new FlowError("INVALID_ARGUMENT", `cannot detect task format of ${file}; pass --format`);
}

export function buildPlan(file: string, format: ImportFormat = "auto", opts: { specFile?: string } = {}): ImportPlan {
  const isDir = existsSync(file) && statSync(file).isDirectory();
  const text = isDir ? "" : readFileSync(file, "utf8");
  const fmt = format === "auto" ? detectFormat(file, text) : format;
  switch (fmt) {
    case "framework":
      return parseFrameworkTasks(text, file, opts.specFile ? readFileSync(opts.specFile, "utf8") : undefined);
    case "speckit":
      return parseSpecKit(text, file);
    case "openspec":
      return parseOpenSpec(file);
    case "local-markdown":
      return parseLocalMarkdown(text, file);
    case "checklist":
      return parseOpenSpec(file); // generic checklist: same sequential-section semantics
  }
}

export interface ApplyOptions {
  /** Status for new non-done tickets (default `ready`). */
  status?: "ready" | "backlog";
  epicTitle?: string;
  /** Attach to an existing epic instead of creating one. */
  epicId?: string;
  noEpic?: boolean;
  labels?: string[];
  /** Base dir for external keys (keys are `relpath#key`). */
  root?: string;
  dryRun?: boolean;
}

export interface ApplyResult {
  epic: Ticket | null;
  created: Ticket[];
  existing: Ticket[];
  warnings: string[];
  plan: ImportPlan;
}

/** Create the epic and tickets idempotently (external_key = `<relpath>#<key>`). */
export function applyPlan(store: FlowStore, plan: ImportPlan, actor: string, opts: ApplyOptions = {}): ApplyResult {
  const relative = path.relative(opts.root ?? process.cwd(), path.resolve(plan.source)).replace(/\\/g, "/");
  // Inside the repo: a portable relative path. Outside: the absolute path (no ../../.. chains).
  const rel = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.resolve(plan.source).replace(/\\/g, "/");
  if (opts.dryRun) return { epic: null, created: [], existing: [], warnings: plan.warnings, plan };
  return store.tx(() => {
    let epic: Ticket | null = null;
    if (opts.epicId) epic = store.get(opts.epicId);
    else if (!opts.noEpic && plan.epic && plan.tasks.length > 1) {
      epic = store.create(
        {
          title: opts.epicTitle ?? plan.epic.title,
          type: "epic",
          body: plan.epic.body ?? "",
          spec_ref: rel,
          acceptance: plan.epic.acceptance,
          external_key: `${rel}#epic`,
          labels: opts.labels,
        },
        actor,
      );
    }
    const ids = new Map<string, string>();
    const created: Ticket[] = [];
    const existing: Ticket[] = [];
    for (const t of plan.tasks) {
      const key = `${rel}#${t.key}`;
      const before = store.db.prepare("SELECT id FROM tickets WHERE external_key = ?").get(key) as { id: string } | undefined;
      const ticket = store.create(
        {
          title: t.title,
          body: t.body,
          type: t.type,
          priority: t.priority,
          labels: [...(t.labels ?? []), ...(opts.labels ?? [])],
          scope_paths: t.scope_paths,
          acceptance: t.acceptance,
          spec_ref: `${rel}#${t.key}`,
          parent: epic?.id ?? null,
          status: t.status === "backlog" ? "backlog" : (opts.status ?? "ready"),
          external_key: key,
        },
        actor,
      );
      ids.set(t.key, ticket.id);
      (before ? existing : created).push(ticket);
    }
    for (const t of plan.tasks) {
      for (const d of t.deps ?? []) {
        const on = ids.get(d);
        if (on) store.addDep(ids.get(t.key)!, on, "blocks", actor);
      }
    }
    // Statuses beyond ready (done / blocked / review from legacy or checked boxes) are set administratively.
    for (const t of plan.tasks) {
      const id = ids.get(t.key)!;
      if (t.status && !["ready", "backlog"].includes(t.status) && created.some((c) => c.id === id)) {
        store.setStatusAdmin(id, t.status, actorKind(actor) === "agent" ? "system:import" : actor, `imported as ${t.status}`);
      }
    }
    return {
      epic: epic ? store.get(epic.id) : null,
      created: created.map((c) => store.get(c.id)),
      existing,
      warnings: plan.warnings,
      plan,
    };
  });
}

function firstHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].replace(/[*`]/g, "").trim() : null;
}

function slugLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}
