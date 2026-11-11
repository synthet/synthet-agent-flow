import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, saveConfig, type FlowConfig } from "./config.js";
import { FlowError } from "./errors.js";
import { flowPaths, resolveRoot, type FlowPaths } from "./paths.js";
import { FlowStore } from "./store.js";

export interface Workspace {
  paths: FlowPaths;
  config: FlowConfig;
  store: FlowStore;
  close(): void;
}

export function isInitialized(root: string): boolean {
  return existsSync(flowPaths(root).config);
}

/**
 * Open the tracker for `cwd`. If the DB is missing but a committed `tickets.jsonl` exists
 * (fresh clone), the DB is rebuilt from the snapshot.
 */
export function openWorkspace(cwd: string = process.cwd(), opts: { requireInit?: boolean } = {}): Workspace {
  const root = resolveRoot(cwd);
  const paths = flowPaths(root);
  if (opts.requireInit !== false && !existsSync(paths.config)) {
    throw new FlowError("NOT_INITIALIZED", `no .agent-flow/ in ${root}`, { nextSteps: ["agent-flow init"] });
  }
  const config = loadConfig(paths.config);
  const fresh = !existsSync(paths.db);
  const store = FlowStore.open(paths.db, { config, snapshotPath: paths.snapshot });
  if (fresh && existsSync(paths.snapshot)) {
    store.importSnapshot(readFileSync(paths.snapshot, "utf8"), "system:bootstrap");
  }
  return { paths, config, store, close: () => store.close() };
}

export function initWorkspace(cwd: string, overrides: Partial<FlowConfig> = {}): { paths: FlowPaths; created: boolean } {
  const root = resolveRoot(cwd);
  const paths = flowPaths(root);
  const created = !existsSync(paths.config);
  mkdirSync(paths.dir, { recursive: true });
  if (created) saveConfig(paths.config, defaultConfig(overrides));
  const gi = path.join(paths.dir, ".gitignore");
  if (!existsSync(gi)) {
    writeFileSync(
      gi,
      [
        "# agent-flow local state (the committed record is tickets.jsonl + config.json)",
        "flow.db",
        "flow.db-*",
        "serve.json",
        "loop.json",
        "STOP",
        "*.tmp",
        "# Keep the committed record visible even when a root .gitignore ignores config.json or *.jsonl.",
        "!config.json",
        "!tickets.jsonl",
        "",
      ].join("\n"),
    );
  }
  // Union merges keep the line-per-ticket snapshot readable, and eol=lf matches what the snapshot writer emits, so autocrlf checkouts stay clean.
  const ga = path.join(root, ".gitattributes");
  const rule = ".agent-flow/tickets.jsonl text eol=lf merge=union\n";
  if (!existsSync(ga) || !readFileSync(ga, "utf8").includes(".agent-flow/tickets.jsonl")) appendFileSync(ga, rule);
  const ws = openWorkspace(root);
  ws.store.writeSnapshot(paths.snapshot);
  ws.close();
  return { paths, created };
}

/** Resolve the actor id: explicit → env → harness:session → `human:$USER`. */
export function resolveActor(explicit?: string | null): string {
  if (explicit) return explicit;
  const env = process.env.AGENT_FLOW_ACTOR;
  if (env) return env;
  const session = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  if (session) return `claude:${session.slice(0, 12)}`;
  if (process.env.CODEX_SESSION_ID) return `codex:${process.env.CODEX_SESSION_ID.slice(0, 12)}`;
  return `human:${process.env.USER || process.env.USERNAME || "local"}`;
}
