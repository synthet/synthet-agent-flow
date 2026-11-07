import { statSync } from "node:fs";
import path from "node:path";
import { FlowError } from "./errors.js";

/**
 * Launching .cmd and .bat files safely. The arguments are parsed by cmd.exe twice: once for the command line,
 * and again when the batch file expands %*, as npm's shims do. So every metacharacter needs escaping twice,
 * for every batch file. Escaping once leaves a quote followed by `&` free to start a second command.
 * cmd.exe cannot carry a newline at all, so those arguments are refused rather than silently cut short.
 * Trade-off: a batch file that reads %~1 directly, rather than forwarding %*, sees the argument with its quotes.
 * The escaping cannot serve both, and forwarding is what npm shims do. The failure there is a wrong value, not injection.
 */
const META = /([()\][%!^"`<>&|;, *?])/g;
const caret = (s: string): string => s.replace(META, "^$1");

/** A resolved path is quoted, so `=` and spaces stay in it. A bare name must not be: see spawnTarget in resolve.mjs. */
export function escapeBatchCommand(file: string): string {
  // Real quotes keep = in the path, where ^" would be a literal. But %VAR% still expands inside quotes, so a path
  // with % takes the caret form. One with both % and = then fails to launch, which is the safe way to fail.
  return /[\\/]/.test(file) && !file.includes("%") ? `"${file}"` : caret(file);
}

/** Quote for the C runtime: backslashes double only before a quote, including the closing one. */
function quoteForArgv(arg: string): string {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

export function escapeBatchArgument(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new FlowError("INVALID_ARGUMENT", "an argument with a newline cannot be passed through a .cmd or .bat file");
  return caret(caret(quoteForArgv(arg)));
}

export const isBatchFile = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

/** The line for `cmd.exe /d /s /c "<line>"`. Pass it with windowsVerbatimArguments. */
export function batchCommandLine(file: string, args: string[]): string {
  return [escapeBatchCommand(file), ...args.map(escapeBatchArgument)].join(" ");
}

export function comSpec(env: NodeJS.ProcessEnv): string {
  return env.ComSpec || env.COMSPEC || process.env.ComSpec || "cmd.exe";
}

/** Plain objects keep their key casing, unlike process.env, so match names case-insensitively. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Find a command the way the shell would, through PATH and PATHEXT. Returns the input if nothing matches. */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string {
  const exts = (envValue(env, "PATHEXT") ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // Only PATHEXT counts as an extension: npm also writes an extensionless sh script next to my.tool.cmd.
  const named = (base: string): string[] => (exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase())) ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return named(path.win32.resolve(cwd, command)).find(isFile) ?? command;
  const dirs = (envValue(env, "PATH") ?? "").split(";").map((d) => d.replace(/^"+|"+$/g, "")).filter(Boolean);
  for (const dir of dirs) {
    const found = named(path.win32.resolve(cwd, dir, command)).find(isFile);
    if (found) return found;
  }
  return command;
}