import { runShell, tail } from "./proc.js";

export interface DodResult {
  passed: boolean;
  summary: string;
  results: Array<{ command: string; code: number; ms: number; output: string }>;
}

/** Run Definition-of-Done commands in order; stop at the first failure. Empty list passes. */
export async function runDod(commands: string[], cwd: string, timeoutMs: number): Promise<DodResult> {
  const results: DodResult["results"] = [];
  for (const command of commands) {
    const r = await runShell(command, { cwd, timeoutMs });
    const output = tail(`${r.stdout}\n${r.stderr}`.trim(), 2000);
    results.push({ command, code: r.code, ms: r.ms, output });
    if (r.code !== 0) break;
  }
  const passed = results.every((r) => r.code === 0) && results.length === commands.length;
  const summary = commands.length
    ? results
        .map((r) =>
          r.code === 0
            ? `✔ ${r.command} (${(r.ms / 1000).toFixed(1)}s)`
            : `✘ ${r.command} → exit ${r.code}${r.code === 124 ? " (timeout)" : ""}\n${r.output}`,
        )
        .join("\n")
    : "no DoD commands configured";
  return { passed, summary, results };
}
