import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";

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

/**
 * Run argv. Never throws for non-zero exits; `code` is -1 if the binary is missing.
 * cross-spawn finds bare names through PATHEXT and escapes arguments for cmd.exe when the target is a Windows
 * .cmd, such as an npm-installed CLI, so an argument can never be parsed as a second command.
 */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
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
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams; // all three streams are pipes
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
  return process.platform === "win32" ? run(["cmd.exe", "/d", "/s", "/c", command], opts) : run(["sh", "-c", command], opts);
}

export function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
}
