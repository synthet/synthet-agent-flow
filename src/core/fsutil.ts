import { renameSync } from "node:fs";

/** What Windows raises while another process is replacing or holding the same file. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface RenameRetryOptions {
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
  attempts?: number;
}

/** Rename a file, retrying transient failures with a growing wait. About 300 ms in total by default. */
export function renameWithRetry(from: string, to: string, opts: RenameRetryOptions = {}): void {
  const rename = opts.rename ?? renameSync;
  const sleep = opts.sleep ?? sleepSync;
  const attempts = opts.attempts ?? 6;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt >= attempts) throw err;
      sleep(10 * 2 ** (attempt - 1));
    }
  }
}
