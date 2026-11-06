import { run, type RunOptions, type RunResult } from "../core/proc.js";

/** Injectable command runner so integrations can be tested without gh / agent-mail / swarm installed. */
export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export const defaultRunner: Runner = (argv, opts) => run(argv, opts);

/**
 * Split a configured binary into argv: a JSON string array (`["node","C:\\x y\\cli.js"]`, for paths with
 * spaces) or a whitespace-separated command like `node /path/cli.js`.
 */
export function binArgv(bin: string): string[] {
  const v = bin.trim();
  if (v.startsWith("[")) {
    const arr = JSON.parse(v) as unknown;
    if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string")) return arr as string[];
    throw new Error("binary JSON must be a non-empty string array");
  }
  return v.split(/\s+/).filter(Boolean);
}
