#!/usr/bin/env node
// Claude Code hook shim: `node hook.mjs <event>`. Cross-platform (no sh/cmd).
// No CLI installed → print {} and exit 0 (fail open). The CLI's own exit code (e.g. 2 from a failing
// DoD gate) is passed through unchanged.
import { spawn } from "node:child_process";
import { resolveCli } from "./resolve.mjs";

const event = process.argv[2] ?? "";
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  let cli = null;
  try {
    cli = resolveCli();
  } catch {
    cli = null;
  }
  if (!cli) {
    process.stdout.write("{}");
    process.exit(0);
  }
  const [cmd, ...args] = cli.argv;
  const child = spawn(cmd, [...args, "hook", event], { stdio: ["pipe", "inherit", "inherit"], shell: cli.shell, windowsHide: true });
  child.on("error", () => {
    process.stdout.write("{}");
    process.exit(0);
  });
  child.on("close", (code) => process.exit(code ?? 0));
  child.stdin.end(input);
});
