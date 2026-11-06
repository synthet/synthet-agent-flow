import { run, type RunOptions, type RunResult } from "../core/proc.js";

/** Injectable command runner so integrations can be tested without gh / agent-mail / swarm installed. */
export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export const defaultRunner: Runner = (argv, opts) => run(argv, opts);

/** Split a configured binary like `node /path/cli.js` into argv. */
export function binArgv(bin: string): string[] {
  return bin.split(/\s+/).filter(Boolean);
}
