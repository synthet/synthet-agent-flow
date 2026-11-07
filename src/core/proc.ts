import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { batchCommandLine, comSpec, isBatchFile, resolveWindowsCommand } from "./windows.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Cap captured output per stream (default 1 MiB). */
  maxBytes?: number;
}

interface Launch {
  file: string;
  args: string[];
  verbatim?: boolean;
}

/** Windows runs a .cmd or .bat through cmd.exe, so its arguments must be escaped for that shell. */
function launchFor(argv: string[], env: NodeJS.ProcessEnv): Launch {
  if (process.platform === "win32") {
    const file = resolveWindowsCommand(argv[0], env);
    if (isBatchFile(file)) return { file: comSpec(env), args: ["/d", "/s", "/c", `"${batchCommandLine(file, argv.slice(1))}"`], verbatim: true };
  }
  return { file: argv[0], args: argv.slice(1) };
}

/** Run argv. Never throws for non-zero exits; `code` is -1 if the binary is missing. */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    return capture(launchFor(argv, opts.env ?? process.env), opts);
  } catch (err) {
    return Promise.resolve({ code: -1, stdout: "", stderr: String(err), timedOut: false, ms: 0 });
  }
}

function capture(launch: Launch, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = opts.maxBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.file, launch.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch (err) {
      stderr = String(err);
      done(-1);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < max) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < max) stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += String(err);
      done(-1);
    });
    child.on("close", (code) => done(timedOut ? 124 : (code ?? 1)));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run a shell command line (DoD commands are user-configured shell strings). */
export function runShell(command: string, opts: RunOptions = {}): Promise<RunResult> {
  if (process.platform !== "win32") return run(["sh", "-c", command], opts);
  // Verbatim, or Node rewrites each " as \", which cmd.exe does not understand.
  return capture({ file: comSpec(opts.env ?? process.env), args: ["/d", "/s", "/c", `"${command}"`], verbatim: true }, opts);
}

export function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
}
