import type { ParseArgsConfig } from "node:util";
import type { Workspace } from "../core/workspace.js";

export type Options = NonNullable<ParseArgsConfig["options"]>;

export interface CommandCtx {
  name: string;
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
  json: boolean;
  actor: string;
  cwd: string;
  /** Lazily opened workspace (closed by the dispatcher). */
  ws(): Workspace;
  /** Print `data` as JSON (with --json) or the human rendering. */
  print(data: unknown, human?: string | (() => string)): void;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  group: string;
  options?: Options;
  run(ctx: CommandCtx): Promise<number | void> | number | void;
}

const REGISTRY = new Map<string, CommandDef>();

export function register(...defs: CommandDef[]): void {
  for (const def of defs) {
    REGISTRY.set(def.name, def);
    for (const a of def.aliases ?? []) REGISTRY.set(a, def);
  }
}

export function lookup(name: string): CommandDef | undefined {
  return REGISTRY.get(name);
}

export function allCommands(): CommandDef[] {
  return [...new Set(REGISTRY.values())];
}

// ── small value helpers ──
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const bool = (v: unknown): boolean => v === true;
export const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
};
export const multi = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
export const int = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
