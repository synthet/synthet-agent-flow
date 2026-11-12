import path from "node:path";
import { FlowError } from "../../core/errors.js";
import { resolveRoot } from "../../core/paths.js";
import {
  canonicalRoot,
  readRegistry,
  registerWorkspace,
  registryPath,
  rootKey,
  scanForWorkspaces,
  unregisterWorkspace,
  workspaceAvailable,
  type RegistryEntry,
} from "../../core/registry.js";
import { bool, register } from "../registry.js";

register({
  name: "workspaces",
  aliases: ["projects"],
  group: "servers",
  summary: "Projects the one dashboard shows: list | add [dir]... | remove <id|dir>... | scan [root] [--dry-run]",
  usage: "workspaces [list] | workspaces add [dir...] | workspaces remove <id|dir>... | workspaces scan [projects-root] [--dry-run]",
  options: { "dry-run": { type: "boolean" } },
  run(ctx) {
    const file = registryPath();
    if (!file) throw new FlowError("INVALID_ARGUMENT", "the workspace registry is disabled (AGENT_FLOW_REGISTRY=off)");
    const [sub = "list", ...args] = ctx.positionals;
    const added = (root: string): RegistryEntry & { added: boolean } => {
      const r = registerWorkspace(root, file);
      if (!r) throw new FlowError("INVALID_ARGUMENT", "the workspace registry is disabled");
      return { ...r.entry, added: r.added };
    };

    if (sub === "list" || sub === "ls") {
      const rows = readRegistry(file).map((e) => ({ ...e, available: workspaceAvailable(e.root) }));
      return ctx.print({ registry: file, workspaces: rows }, () =>
        rows.length
          ? rows.map((r) => `${r.id.padEnd(28)} ${r.available ? "ok     " : "missing"} ${r.root}`).join("\n")
          : `No registered workspaces in ${file}.\nRun agent-flow init in a project, or agent-flow workspaces scan <projects-root>.`,
      );
    }

    if (sub === "add") {
      const out = (args.length ? args : ["."]).map((d) => added(resolveRoot(path.resolve(ctx.cwd, d))));
      return ctx.print(out, () => out.map((e) => `${e.added ? "added  " : "already"} ${e.id}  ${e.root}`).join("\n"));
    }

    if (sub === "remove" || sub === "rm" || sub === "forget") {
      if (!args.length) throw new FlowError("INVALID_ARGUMENT", "usage: workspaces remove <id|dir>...");
      const out = args.map((a) => {
        const hit = unregisterWorkspace(a, file) ?? unregisterWorkspace(path.resolve(ctx.cwd, a), file);
        if (!hit) throw new FlowError("NOT_FOUND", `no registered workspace ${a}`, { nextSteps: ["agent-flow workspaces list"] });
        return hit;
      });
      return ctx.print(out, () => out.map((e) => `removed ${e.id}  ${e.root}  (its .agent-flow/ is untouched)`).join("\n"));
    }

    if (sub === "scan") {
      const root = canonicalRoot(path.resolve(ctx.cwd, args[0] ?? path.dirname(resolveRoot(ctx.cwd))));
      const dry = bool(ctx.values["dry-run"]);
      const known = new Set(readRegistry(file).map((e) => rootKey(e.root)));
      const out = scanForWorkspaces(root).map((dir) => (dry ? { id: null as string | null, root: dir, added: !known.has(rootKey(dir)) } : added(dir)));
      const n = out.filter((o) => o.added).length;
      return ctx.print({ root, dry_run: dry, workspaces: out }, () =>
        out.length
          ? [
              `${dry ? "Would add" : "Added"} ${n} of ${out.length} projects with .agent-flow/ under ${root}.`,
              ...out.map((o) => [o.added ? (dry ? "new    " : "added  ") : "already", o.id, o.root].filter(Boolean).join(" ")),
            ].join("\n")
          : `No projects with .agent-flow/ under ${root}.`,
      );
    }

    throw new FlowError("INVALID_ARGUMENT", "usage: workspaces list|add|remove|scan");
  },
});
