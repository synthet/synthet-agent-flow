// Resolve how to launch the agent-flow CLI, on POSIX and Windows, without a shell.
// Order: $AGENT_FLOW_BIN → `agent-flow` on PATH (Windows: npm's .cmd shim → its JS entry) → null.
import { existsSync } from "node:fs";
import path from "node:path";

const PKG_ENTRY = ["node_modules", "synthet-agent-flow", "bin", "agent-flow.js"];

/** Split $AGENT_FLOW_BIN: a JSON array (`["node","C:\\x y\\cli.js"]`) or a whitespace-separated command. */
export function splitBin(value) {
  const v = value.trim();
  if (v.startsWith("[")) {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string")) return arr;
    throw new Error("AGENT_FLOW_BIN JSON must be a non-empty string array");
  }
  return v.split(/\s+/).filter(Boolean);
}

/**
 * Build spawn()'s command and args for a resolved CLI. With `shell: true` Node joins them unquoted, so anything
 * with a space (`C:\Users\First Last\...`) would be cut by cmd.exe, and Node 24 deprecates that form (DEP0190).
 * So the shell form is one command string. Quote only when needed: for a quoted bare name found on PATH (npx.cmd),
 * cmd.exe expands %~dp0 to the cwd.
 * @param {{ argv: string[], shell: boolean }} cli
 * @param {string[]} [extra] arguments to add after the resolved argv
 * @returns {{ cmd: string, args: string[] }}
 */
export function spawnTarget(cli, extra = []) {
  const [cmd, ...args] = [...cli.argv, ...extra];
  if (!cli.shell) return { cmd, args };
  const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return { cmd: [cmd, ...args].map(quote).join(" "), args: [] };
}

/**
 * @param {{ env?: Record<string,string|undefined>, platform?: string, exists?: (p: string) => boolean, nodePath?: string }} [opts]
 * @returns {{ argv: string[], shell: boolean, via: string } | null}
 */
export function resolveCli(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const node = opts.nodePath ?? process.execPath;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (env.AGENT_FLOW_BIN) return { argv: splitBin(env.AGENT_FLOW_BIN), shell: false, via: "AGENT_FLOW_BIN" };
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    if (platform === "win32") {
      // npm installs `agent-flow.cmd` next to node_modules\synthet-agent-flow: run the JS entry with node directly
      // (no cmd.exe, so arguments are never re-parsed by a shell).
      if (exists(p.join(dir, "agent-flow.cmd")) || exists(p.join(dir, "agent-flow.ps1"))) {
        const entry = p.join(dir, ...PKG_ENTRY);
        if (exists(entry)) return { argv: [node, entry], shell: false, via: "npm shim" };
        if (exists(p.join(dir, "agent-flow.cmd"))) return { argv: [p.join(dir, "agent-flow.cmd")], shell: true, via: "cmd shim" };
      }
      if (exists(p.join(dir, "agent-flow.exe"))) return { argv: [p.join(dir, "agent-flow.exe")], shell: false, via: "PATH" };
    } else if (exists(p.join(dir, "agent-flow"))) {
      return { argv: [p.join(dir, "agent-flow")], shell: false, via: "PATH" };
    }
  }
  return null;
}
