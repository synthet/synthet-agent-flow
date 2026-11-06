import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlowError } from "../core/errors.js";
import { binArgv } from "./exec.js";

/**
 * Wire agent-flow into Claude Code / Cursor / Codex and into synthet-code-framework projects.
 * Pattern from synthet-code-framework `jev-engineering/install_config.py`: additive edits only, a timestamped
 * backup of every file touched, a sha256 receipt, and an uninstall that restores a file only if it is still
 * exactly what the install wrote.
 */

export type Harness = "claude" | "cursor" | "codex";
export type Scope = "project" | "user";

export interface PlannedEdit {
  file: string;
  kind: "json-merge" | "block-append" | "copy-if-missing" | "toml-append";
  description: string;
  next: string | null; // null → no change
}

export interface Receipt {
  created_at: string;
  root: string;
  entries: Array<{ file: string; before_sha: string | null; after_sha: string; backup: string | null; description: string }>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const BEGIN = "<!-- BEGIN AGENT-FLOW -->";

function assetRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", ".."), path.join(here, "..")]) if (existsSync(path.join(p, "templates"))) return p;
  throw new FlowError("NOT_FOUND", "agent-flow templates/ not found next to the CLI");
}

function cliCommand(): { command: string; args: string[] } {
  const bin = process.env.AGENT_FLOW_BIN;
  if (bin) {
    const [command, ...args] = binArgv(bin);
    return { command, args };
  }
  return { command: "agent-flow", args: [] };
}

function jsonMerge(file: string, mutate: (obj: Record<string, unknown>) => boolean, description: string): PlannedEdit {
  const before = read(file);
  let obj: Record<string, unknown> = {};
  if (before?.trim()) {
    try {
      obj = JSON.parse(before) as Record<string, unknown>;
    } catch {
      throw new FlowError("INVALID_ARGUMENT", `${file} is not valid JSON; fix it or add agent-flow by hand`);
    }
  }
  const changed = mutate(obj);
  return { file, kind: "json-merge", description, next: changed ? `${JSON.stringify(obj, null, 2)}\n` : null };
}

function mcpEntry(cursor = false): Record<string, unknown> {
  const { command, args } = cliCommand();
  return { ...(cursor ? { type: "stdio" } : {}), command, args: [...args, "mcp"] };
}

function addMcp(obj: Record<string, unknown>, cursor = false): boolean {
  const servers = (obj.mcpServers ??= {}) as Record<string, unknown>;
  if (servers["agent-flow"]) return false;
  servers["agent-flow"] = mcpEntry(cursor);
  return true;
}

const HOOKS: Array<[string, string, string | null, number]> = [
  ["SessionStart", "session-start", "startup|resume|clear|compact", 20],
  ["PreToolUse", "pre-tool", "Bash", 10],
  ["PostToolUse", "post-tool", "Bash|Edit|Write|MultiEdit", 15],
  ["Stop", "stop", null, 20],
  ["StopFailure", "stop-failure", null, 10],
  ["TaskCompleted", "task-completed", null, 900],
  ["PreCompact", "pre-compact", null, 10],
  ["SessionEnd", "session-end", null, 5],
];

function addHooks(obj: Record<string, unknown>, statusline: boolean): boolean {
  const { command, args } = cliCommand();
  const base = [command, ...args].join(" ");
  const hooks = (obj.hooks ??= {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  let changed = false;
  for (const [event, sub, matcher, timeout] of HOOKS) {
    const groups = (hooks[event] ??= []);
    if (groups.some((g) => g.hooks?.some((h) => h.command?.includes(`hook ${sub}`) && h.command.includes("agent-flow")))) continue;
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${base} hook ${sub}`, timeout }] });
    changed = true;
  }
  if (statusline && !obj.statusLine) {
    obj.statusLine = { type: "command", command: `${base} statusline`, padding: 0, refreshInterval: 15 };
    changed = true;
  }
  return changed;
}

function blockAppend(file: string, block: string, description: string): PlannedEdit {
  const before = read(file) ?? "";
  if (before.includes(BEGIN)) return { file, kind: "block-append", description, next: null };
  const sep = before && !before.endsWith("\n") ? "\n\n" : before ? "\n" : "";
  return { file, kind: "block-append", description, next: `${before}${sep}${block.trim()}\n` };
}

function copyIfMissing(file: string, source: string, description: string): PlannedEdit {
  return { file, kind: "copy-if-missing", description, next: existsSync(file) ? null : readFileSync(source, "utf8") };
}

export function planInstall(opts: { harness: Harness; scope: Scope; root: string; hooks?: boolean; statusline?: boolean; home?: string }): PlannedEdit[] {
  const home = opts.home ?? os.homedir();
  const assets = assetRoot();
  const claudeBlock = readFileSync(path.join(assets, "templates", "CLAUDE.agent-flow.md"), "utf8");
  const edits: PlannedEdit[] = [];
  if (opts.harness === "claude") {
    if (opts.scope === "project") {
      edits.push(jsonMerge(path.join(opts.root, ".mcp.json"), (o) => addMcp(o), "register the agent-flow MCP server"));
      if (opts.hooks !== false) edits.push(jsonMerge(path.join(opts.root, ".claude", "settings.json"), (o) => addHooks(o, !!opts.statusline), "agent-flow hooks (context, safety, loop)"));
      edits.push(blockAppend(path.join(opts.root, "CLAUDE.md"), claudeBlock, "agent-flow working rules"));
    } else {
      edits.push(jsonMerge(path.join(home, ".claude.json"), (o) => addMcp(o), "register the agent-flow MCP server (user)"));
      if (opts.hooks !== false) edits.push(jsonMerge(path.join(home, ".claude", "settings.json"), (o) => addHooks(o, opts.statusline !== false), "agent-flow hooks (user)"));
    }
  } else if (opts.harness === "cursor") {
    const dir = opts.scope === "project" ? path.join(opts.root, ".cursor") : path.join(home, ".cursor");
    edits.push(jsonMerge(path.join(dir, "mcp.json"), (o) => addMcp(o, true), "register the agent-flow MCP server (Cursor)"));
    if (opts.scope === "project") edits.push(copyIfMissing(path.join(dir, "rules", "agent-flow.mdc"), path.join(assets, "templates", "cursor-rule.mdc"), "Cursor rule"));
  } else if (opts.harness === "codex") {
    const file = path.join(home, ".codex", "config.toml");
    const before = read(file) ?? "";
    const { command, args } = cliCommand();
    const block = `\n[mcp_servers.agent-flow]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify([...args, "mcp"])}\n`;
    edits.push({ file, kind: "toml-append", description: "register the agent-flow MCP server (Codex)", next: before.includes("[mcp_servers.agent-flow]") ? null : `${before}${block}` });
    edits.push(blockAppend(path.join(opts.root, "AGENTS.md"), claudeBlock, "agent-flow working rules"));
  }
  return edits;
}

/** Drop the synthet-code-framework backlog-provider kit into a framework-seeded project. */
export function planFramework(project: string): PlannedEdit[] {
  const kit = path.join(assetRoot(), "integrations", "synthet-code-framework");
  return [
    copyIfMissing(path.join(project, ".agent", "backlog", "providers", "agent-flow.md"), path.join(kit, ".agent", "backlog", "providers", "agent-flow.md"), "agent-flow backlog provider"),
    blockAppend(path.join(project, ".agent", "backlog", "README.md"), readFileSync(path.join(kit, "backlog-readme-block.md"), "utf8"), "list agent-flow in the provider order"),
    blockAppend(path.join(project, "CLAUDE.md"), readFileSync(path.join(assetRoot(), "templates", "CLAUDE.agent-flow.md"), "utf8"), "agent-flow working rules"),
  ];
}

export function applyEdits(edits: PlannedEdit[], receiptDir: string, root: string): Receipt {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(receiptDir, "backups", stamp);
  const receipt: Receipt = { created_at: new Date().toISOString(), root, entries: [] };
  for (const e of edits) {
    if (e.next === null) continue;
    const before = read(e.file);
    let backup: string | null = null;
    if (before !== null) {
      mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, e.file.replace(/[\\/:]+/g, "_"));
      copyFileSync(e.file, backup);
    }
    mkdirSync(path.dirname(e.file), { recursive: true });
    writeFileSync(e.file, e.next);
    // Re-read and verify, as the jev installer does.
    const after = readFileSync(e.file, "utf8");
    if (after !== e.next) throw new FlowError("INTERNAL", `verification failed writing ${e.file}`);
    if (e.kind === "json-merge") JSON.parse(after);
    receipt.entries.push({ file: e.file, before_sha: before === null ? null : sha(before), after_sha: sha(after), backup, description: e.description });
  }
  if (receipt.entries.length) {
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(path.join(receiptDir, `receipt-${stamp}.json`), JSON.stringify(receipt, null, 2));
    writeFileSync(path.join(receiptDir, "latest.json"), JSON.stringify(receipt, null, 2));
  }
  return receipt;
}

/** Restore files from the latest receipt — only those still byte-identical to what the install wrote. */
export function rollback(receiptDir: string): { restored: string[]; skipped: Array<{ file: string; why: string }> } {
  const latest = path.join(receiptDir, "latest.json");
  if (!existsSync(latest)) throw new FlowError("NOT_FOUND", "no install receipt found");
  const receipt = JSON.parse(readFileSync(latest, "utf8")) as Receipt;
  const restored: string[] = [];
  const skipped: Array<{ file: string; why: string }> = [];
  for (const e of [...receipt.entries].reverse()) {
    const now = read(e.file);
    if (now === null) {
      skipped.push({ file: e.file, why: "file no longer exists" });
      continue;
    }
    if (sha(now) !== e.after_sha) {
      skipped.push({ file: e.file, why: "changed since install; edit by hand" });
      continue;
    }
    if (e.backup) copyFileSync(e.backup, e.file);
    else rmSync(e.file);
    restored.push(e.file);
  }
  rmSync(latest);
  return { restored, skipped };
}
