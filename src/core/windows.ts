import { existsSync } from "node:fs";
import path from "node:path";
import { FlowError } from "./errors.js";

/**
 * Launching .cmd and .bat files safely. The arguments are parsed by cmd.exe twice: once for the command line,
 * and again when the batch file expands %*, as npm's shims do. So every metacharacter needs escaping twice,
 * for every batch file. Escaping once leaves a quote followed by `&` free to start a second command.
 * cmd.exe cannot carry a newline at all, so those arguments are refused rather than silently cut short.
 */
const META = /([()\][%!^"`<>&|;, *?])/g;
const caret = (s: string): string => s.replace(META, "^$1");

export function escapeBatchCommand(file: string): string {
  return caret(file);
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
  return env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? "cmd.exe";
}

/** Find a command the way the shell would, through PATH and PATHEXT. Returns the input if nothing matches. */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string {
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const named = (base: string): string[] => (path.win32.extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return named(command).find(exists) ?? command;
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const found = named(path.win32.join(dir, command)).find(exists);
    if (found) return found;
  }
  return command;
}
