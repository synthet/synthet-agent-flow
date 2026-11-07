#!/usr/bin/env node
// Launch the agent-flow CLI (used by the plugin's .mcp.json for `agent-flow mcp`). Cross-platform.
// Falls back to npx when the CLI is not installed.
import { spawn } from "node:child_process";
import { resolveCli, spawnTarget } from "./resolve.mjs";

const cli = resolveCli() ?? {
  argv: [process.platform === "win32" ? "npx.cmd" : "npx", "--yes", "--package=github:synthet/synthet-agent-flow", "agent-flow"],
  shell: process.platform === "win32",
  via: "npx",
};
const { cmd, args } = spawnTarget(cli, process.argv.slice(2));
const child = spawn(cmd, args, { stdio: "inherit", shell: cli.shell, windowsHide: true });
child.on("error", (err) => {
  process.stderr.write(`agent-flow: cannot start the CLI (${cli.via}): ${err.message}\nInstall it: npm i -g github:synthet/synthet-agent-flow, or set AGENT_FLOW_BIN.\n`);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 0));
