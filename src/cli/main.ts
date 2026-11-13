import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlowError, exitCodeFor, toFlowError } from "../core/errors.js";
import { openWorkspace, resolveActor, type Workspace } from "../core/workspace.js";
import { allCommands, lookup, type CommandCtx, type Options } from "./registry.js";
import { attachNotifiers, flushOutbox } from "../integrations/notify.js";
import "./commands/core.js";
import "./commands/extra.js";
import "./commands/workspaces.js";
import "./commands/triage.js";

const GLOBAL: Options = {
  json: { type: "boolean" },
  actor: { type: "string" },
  cwd: { type: "string", short: "C" },
  help: { type: "boolean", short: "h" },
};

export function version(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

function helpText(): string {
  const groups = new Map<string, string[]>();
  for (const c of allCommands()) {
    const lines = groups.get(c.group) ?? [];
    lines.push(`  ${c.name.padEnd(15)} ${c.summary}`);
    groups.set(c.group, lines);
  }
  const order = ["setup", "tickets", "lifecycle", "agents", "sdd", "integrations", "automation", "servers", "data"];
  const sections = [...groups.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  return [
    `agent-flow ${version()} — agent-oriented project management`,
    "",
    "usage: agent-flow <command> [args] [--json] [--actor id] [-C dir]",
    "",
    ...sections.flatMap(([g, lines]) => [`${g}:`, ...lines.sort(), ""]),
    "Run `agent-flow help <command>` for options. Exit codes: 0 ok · 1 error · 2 conflict/blocked/gate failed.",
  ].join("\n");
}

export interface MainIO {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  stdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[], io: MainIO = {}): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`));
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = rest[0] && lookup(rest[0]);
    if (target) {
      const opts = Object.entries(target.options ?? {}).map(([k, v]) => `  --${k}${v.short ? ` (-${v.short})` : ""}${v.type === "string" ? " <value>" : ""}${v.multiple ? " (repeatable)" : ""}`);
      out([`agent-flow ${target.usage}`, "", target.summary, "", ...(opts.length ? ["options:", ...opts] : []), "  --json  --actor <id>  -C <dir>"].join("\n"));
    } else out(helpText());
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    out(version());
    return 0;
  }
  const def = lookup(name);
  if (!def) {
    err(`unknown command: ${name}\n\n${helpText()}`);
    return 1;
  }
  let json = rest.includes("--json");
  let ws: Workspace | null = null;
  try {
    const parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...(def.options ?? {}) }, allowPositionals: true, strict: true });
    const values = parsed.values as CommandCtx["values"];
    if (values.help) {
      return main(["help", def.name], io);
    }
    json = values.json === true;
    const cwd = typeof values.cwd === "string" ? path.resolve(values.cwd) : process.cwd();
    const ctx: CommandCtx = {
      name: def.name,
      positionals: parsed.positionals,
      values,
      json,
      actor: resolveActor(typeof values.actor === "string" ? values.actor : null),
      cwd,
      ws() {
        if (!ws) {
          ws = openWorkspace(cwd);
          attachNotifiers(ws);
        }
        return ws;
      },
      print(data, human) {
        if (json) out(JSON.stringify(data, null, 2));
        else if (typeof human === "function") out(human());
        else if (typeof human === "string") out(human);
        else out(typeof data === "string" ? data : JSON.stringify(data, null, 2));
      },
      stdout: out,
      stderr: err,
      readStdin: io.stdin ?? readAllStdin,
    };
    const code = await def.run(ctx);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    const fe = e instanceof FlowError ? e : toFlowError(e);
    if ((e as { code?: string }).code?.startsWith?.("ERR_PARSE_ARGS")) {
      const msg = (e as Error).message;
      if (json) out(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: msg, retryable: false, next_steps: [`agent-flow help ${def.name}`] } }, null, 2));
      else err(`error: ${msg}\nusage: agent-flow ${def.usage}`);
      return 1;
    }
    if (json) out(JSON.stringify({ error: fe.toJSON() }, null, 2));
    else err(`error [${fe.code}]: ${fe.message}${fe.nextSteps.length ? `\nnext: ${fe.nextSteps.join("\n      ")}` : ""}`);
    return exitCodeFor(fe);
  } finally {
    const w = ws as Workspace | null;
    if (w) {
      // Deliver notifications produced by this command (bounded; failures stay queued with backoff).
      if (w.store.outboxStats().pending > 0) await flushOutbox(w, { budgetMs: 8000 }).catch(() => undefined);
      w.close();
    }
  }
}
