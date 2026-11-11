import { bool, int, list, register, str } from "../registry.js";
import { FlowError } from "../../core/errors.js";
import { loadConfig, saveConfig, configSchema } from "../../core/config.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { flowPaths, resolveRoot } from "../../core/paths.js";

register({
  name: "mcp",
  group: "servers",
  summary: "Run the MCP server on stdio (tools flow_*, resources flow://...)",
  usage: "mcp [--actor id] [-C dir]",
  async run(ctx) {
    const { runStdioServer } = await import("../../mcp/server.js");
    await runStdioServer({ cwd: ctx.cwd, actor: str(ctx.values.actor) });
    // Keep the process alive; the transport closes on stdin EOF.
    await new Promise<void>((resolve) => process.stdin.on("close", () => resolve()));
  },
});

register({
  name: "serve",
  aliases: ["dashboard", "ui"],
  group: "servers",
  summary: "Web Kanban dashboard + REST/SSE API on loopback (default http://127.0.0.1:8791)",
  usage: "serve [--port 8791] [--host 127.0.0.1] [--open] [--exit-on-stdin-close]",
  options: { port: { type: "string", short: "p" }, host: { type: "string" }, open: { type: "boolean" }, "exit-on-stdin-close": { type: "boolean" } },
  async run(ctx) {
    const { startServer } = await import("../../server/http.js");
    const { githubWebhookHandler } = await import("../../integrations/github.js");
    const ws = ctx.ws();
    const port = str(ctx.values.port);
    const server = await startServer(ws, {
      host: str(ctx.values.host),
      port: port !== undefined ? Number(port) : undefined,
      actor: ctx.actor,
      githubWebhook: ws.config.github.enabled ? githubWebhookHandler : undefined,
      log: (l) => ctx.stderr(l),
    });
    ctx.print({ url: server.url, token_file: ws.paths.serveFile }, `agent-flow dashboard: ${server.url}\nREST writes need: Authorization: Bearer $(jq -r .token ${ws.paths.serveFile})\nCtrl-C to stop.`);
    if (ctx.values.open) {
      const { run } = await import("../../core/proc.js");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      void run([opener, server.url]);
    }
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void server.close().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (bool(ctx.values["exit-on-stdin-close"])) {
        // For a supervisor such as the Windows tray, which has no signal to send a windowless child:
        // closing stdin, or the parent dying, stops the server cleanly.
        process.stdin.once("end", stop);
        process.stdin.once("close", stop);
        process.stdin.resume();
      }
    });
  },
});

register({
  name: "hook",
  group: "agents",
  summary: "Claude Code hook entry point: hook <session-start|pre-tool|post-tool|stop|stop-failure|task-completed|pre-compact|session-end>",
  usage: "hook <event>   (reads the hook JSON on stdin)",
  async run(ctx) {
    const { runHook } = await import("../../hooks/index.js");
    const event = ctx.positionals[0] ?? "";
    const res = await runHook(event, await ctx.readStdin());
    if (res.stdout) ctx.stdout(res.stdout);
    if (res.stderr) ctx.stderr(res.stderr);
    return res.code;
  },
});

register({
  name: "statusline",
  group: "agents",
  summary: "One-line status for Claude Code's statusLine (reads its JSON on stdin)",
  usage: "statusline",
  async run(ctx) {
    const { statusLine } = await import("../../hooks/index.js");
    try {
      ctx.stdout(statusLine(await ctx.readStdin()));
    } catch {
      ctx.stdout("");
    }
  },
});

register({
  name: "snapshot",
  group: "agents",
  summary: "Compact JSON for UIs: bound ticket (branch/session), ready head, counts, loop state",
  usage: "snapshot [--session <claude session id>]",
  options: { session: { type: "string" } },
  async run(ctx) {
    const { snapshot } = await import("../../hooks/index.js");
    ctx.stdout(JSON.stringify(snapshot(ctx.cwd, str(ctx.values.session))));
  },
});

// ───────────────────────────── integrations ─────────────────────────────

register({
  name: "github",
  aliases: ["gh"],
  group: "integrations",
  summary: "One-way GitHub mirror via gh: push (issues + sub-issues) | reconcile (PR state → tickets) | pr <id> (open PR)",
  usage: "github push [<id>...] | github reconcile | github pr <id> [--base main] [--draft] | github body <id>",
  options: { base: { type: "string" }, draft: { type: "boolean" } },
  async run(ctx) {
    const gh = await import("../../integrations/github.js");
    const ws = ctx.ws();
    const [sub, ...ids] = ctx.positionals;
    if (sub === "push") {
      const res = await gh.pushIssues(ws, ids.length ? ids : null);
      return ctx.print(res, () => [`created ${res.created.length}, updated ${res.updated.length}`, ...res.created.map((c) => `  ${c.id} → #${c.issue}`)].join("\n"));
    }
    if (sub === "reconcile" || sub === "sync") {
      const res = await gh.reconcile(ws);
      return ctx.print(res, () => res.map((r) => `PR #${r.pr} → ${r.ticket}: ${r.action}`).join("\n") || "nothing to reconcile");
    }
    if (sub === "pr") {
      const url = await gh.createPr(ws, ids[0] ?? "", { base: str(ctx.values.base), draft: bool(ctx.values.draft) });
      return ctx.print({ url }, url);
    }
    if (sub === "body") return ctx.stdout(gh.prBody(ws, ids[0] ?? ""));
    throw new FlowError("INVALID_ARGUMENT", "usage: github push|reconcile|pr|body");
  },
});

register({
  name: "mailbox",
  group: "integrations",
  summary: "synthet-agent-mailbox notifications: test | flush | status",
  usage: "mailbox test [--text t] | mailbox flush | mailbox status",
  options: { text: { type: "string" } },
  async run(ctx) {
    const ws = ctx.ws();
    const sub = ctx.positionals[0] ?? "status";
    if (sub === "status") return ctx.print({ config: ws.config.mailbox, outbox: ws.store.outboxStats() }, () => JSON.stringify({ ...ws.config.mailbox, outbox: ws.store.outboxStats() }, null, 2));
    if (sub === "test") {
      const { deliver } = await import("../../integrations/mailbox.js");
      await deliver(ws, { kind: "test", ticket_id: null, subject: "[flow] test", text: str(ctx.values.text) ?? `agent-flow test message from ${ws.paths.root}` });
      return ctx.print({ ok: true }, "sent");
    }
    if (sub === "flush") {
      const { flushOutbox } = await import("../../integrations/notify.js");
      const res = await flushOutbox(ws, { budgetMs: 60_000 });
      return ctx.print(res, `sent ${res.sent}, failed ${res.failed}`);
    }
    throw new FlowError("INVALID_ARGUMENT", "usage: mailbox test|flush|status");
  },
});

register({
  name: "adoption",
  group: "tickets",
  summary: "Cross-repo report: tickets created/claimed/done vs commits per tracked repo; flags commits with no tickets",
  usage: "adoption [--root dir] [--since 30d|2w|12h|date]",
  options: { root: { type: "string" }, since: { type: "string" } },
  async run(ctx) {
    const { adoptionReport, parseSince, renderAdoption } = await import("../../integrations/adoption.js");
    const since = str(ctx.values.since) ?? "30d";
    const root = path.resolve(str(ctx.values.root) ?? path.dirname(resolveRoot(ctx.cwd)));
    const rows = await adoptionReport({ root, sinceMs: parseSince(since) });
    return ctx.print(rows, () => renderAdoption(rows, since));
  },
});

register({
  name: "wiki",
  group: "integrations",
  summary: "Export finished tickets to synthet-llm-wiki as sources: export <id>… | export --done | status",
  usage: "wiki export <id>... [--root dir] [--no-ingest] | wiki export --done [--root dir] [--no-ingest] | wiki status",
  options: { root: { type: "string" }, done: { type: "boolean" }, "no-ingest": { type: "boolean" } },
  async run(ctx) {
    const ws = ctx.ws();
    const [sub = "status", ...ids] = ctx.positionals;
    if (sub === "status") {
      const out = { config: ws.config.wiki, outbox: ws.store.outboxStats() };
      return ctx.print(out, () => JSON.stringify({ ...ws.config.wiki, outbox: out.outbox }, null, 2));
    }
    if (sub === "export") {
      const { doneTicketIds, exportTicket } = await import("../../integrations/wiki.js");
      const targets = bool(ctx.values.done) ? doneTicketIds(ws) : ids;
      if (!targets.length) throw new FlowError("INVALID_ARGUMENT", "usage: wiki export <id>... | wiki export --done");
      const ingest = bool(ctx.values["no-ingest"]) ? false : undefined;
      const results: Awaited<ReturnType<typeof exportTicket>>[] = [];
      for (const id of targets) results.push(await exportTicket(ws, id, { root: str(ctx.values.root), ingest }));
      return ctx.print(results, () => results.map((r) => `${r.id} → ${r.file}${r.ingested ? " (ingested)" : ""}`).join("\n"));
    }
    throw new FlowError("INVALID_ARGUMENT", "usage: wiki export|status");
  },
});

register({
  name: "review",
  group: "integrations",
  summary: "Review a ticket in review: multi-harness via synthet-agent-swarm (--swarm), or advisory Jev evidence check (--jev); recorded as a review comment",
  usage: "review <id> --swarm [--agents codex,claude] [--dry-run] | review <id> --jev [--dry-run]",
  options: { swarm: { type: "boolean" }, jev: { type: "boolean" }, agents: { type: "string" }, "dry-run": { type: "boolean" } },
  async run(ctx) {
    if (bool(ctx.values.swarm) && bool(ctx.values.jev)) throw new FlowError("INVALID_ARGUMENT", "pass --swarm or --jev, not both");
    if (bool(ctx.values.jev)) {
      const { jevReview, jevComment } = await import("../../integrations/jev.js");
      const res = await jevReview(ctx.ws(), ctx.positionals[0] ?? "", { cwd: ctx.cwd, dryRun: bool(ctx.values["dry-run"]) });
      if ("dry_run" in res) return ctx.print(res.dry_run, () => JSON.stringify(res.dry_run, null, 2));
      return ctx.print(res, () => jevComment(res));
    }
    if (!bool(ctx.values.swarm)) throw new FlowError("INVALID_ARGUMENT", "use the flow-review skill for manual review, or pass --swarm or --jev");
    const { swarmReview } = await import("../../integrations/swarm.js");
    const ws = ctx.ws();
    const res = await swarmReview(ws, ctx.positionals[0] ?? "", { cwd: ctx.cwd, harnesses: list(ctx.values.agents), dryRun: bool(ctx.values["dry-run"]) });
    if (res.dry_run) {
      const rows = (res.dry_run.harnesses ?? []) as Array<{ id?: string; ok?: boolean; commandPreview?: string; summary?: string }>;
      return ctx.print(res.dry_run, () => rows.map((r) => `${r.id}: ${r.ok ? "ready" : "unavailable"} — ${(r.commandPreview ?? r.summary ?? "").split("\n")[0]}`).join("\n") || "no harnesses available");
    }
    ctx.print(res, () =>
      [`swarm verdict: ${res.verdict}${res.approved ? " (auto-approved)" : ""}`, ...Object.entries(res.ac).map(([k, v]) => `  ${k}: ${v.value ?? "disputed"} ${JSON.stringify(v.counts)}`), ...res.harnesses.map((h) => `  ${h.harness}: ${h.ok ? "ok" : "failed"} ${h.summary}`)].join("\n"),
    );
  },
});

register({
  name: "worktree",
  aliases: ["wt"],
  group: "agents",
  summary: "One worktree per ticket (creation serialised by a DB lock): create | rm | path",
  usage: "worktree create <id> [--base main] | worktree rm <id> [--force] | worktree path <id>",
  options: { base: { type: "string" }, force: { type: "boolean" } },
  async run(ctx) {
    const wt = await import("../../integrations/worktree.js");
    const ws = ctx.ws();
    const [sub, id] = ctx.positionals;
    if (!id) throw new FlowError("INVALID_ARGUMENT", "give a ticket id");
    if (sub === "create" || sub === "add") {
      const res = await wt.createWorktree(ws, id, ctx.actor, { base: str(ctx.values.base) });
      return ctx.print(res, () => `${res.created ? "created" : "exists"} ${res.path}\nbranch ${res.branch}\ncd ${res.path}`);
    }
    if (sub === "rm" || sub === "remove") {
      const p = await wt.removeWorktree(ws, id, ctx.actor, { force: bool(ctx.values.force) });
      return ctx.print({ removed: p }, `removed ${p}`);
    }
    if (sub === "path") return ctx.print({ path: wt.worktreePath(ws, id) }, wt.worktreePath(ws, id));
    throw new FlowError("INVALID_ARGUMENT", "usage: worktree create|rm|path <id>");
  },
});

register({
  name: "loop",
  group: "automation",
  summary: "Capped autonomous loop: start (Stop-hook controller) | run (fresh headless session per ticket) | stop | status",
  usage: "loop start [--max 3] [--label agent-ok] | loop run [--max 3] [--label agent-ok] [--harness claude|codex] [--max-turns 80] [--permission-mode acceptEdits] | loop stop | loop status",
  options: {
    max: { type: "string" },
    label: { type: "string" },
    "any-label": { type: "boolean" },
    harness: { type: "string" },
    "max-turns": { type: "string" },
    "permission-mode": { type: "string" },
  },
  async run(ctx) {
    const loop = await import("../../integrations/loop.js");
    const { readLoop } = await import("../../hooks/index.js");
    const ws = ctx.ws();
    const sub = ctx.positionals[0] ?? "status";
    const label = bool(ctx.values["any-label"]) ? null : (str(ctx.values.label) ?? ws.config.loop.label);
    const max = loop.requireMax(int(ctx.values.max), ws.config.loop.maxTickets);
    if (sub === "start") {
      const st = loop.startLoop(ws, { max, label, actor: ctx.actor.startsWith("human:") ? null : ctx.actor });
      return ctx.print(st, () => `loop armed: up to ${max} ticket(s)${label ? ` labelled ${label}` : ""}. Stop: touch .agent-flow/STOP or agent-flow loop stop.\nContract:\n${JSON.stringify(st.contract, null, 2)}`);
    }
    if (sub === "stop") return ctx.print(loop.stopLoop(ws, ctx.actor), "loop stopped (STOP file written)");
    if (sub === "status") return ctx.print(readLoop(ws) ?? { active: false }, () => JSON.stringify(readLoop(ws) ?? { active: false }, null, 2));
    if (sub === "run") {
      const harness = (str(ctx.values.harness) ?? ws.config.loop.harness) as "claude" | "codex";
      const res = await loop.runLoop(ws, {
        max,
        label,
        harness,
        maxTurns: int(ctx.values["max-turns"]) ?? ws.config.loop.maxTurns,
        permissionMode: str(ctx.values["permission-mode"]),
        cwd: ctx.cwd,
        log: (l) => ctx.stderr(l),
      });
      return ctx.print(res, () => res.map((r) => `#${r.iteration} ${r.ticket ?? "-"} ${r.status ?? ""} (exit ${r.code})`).join("\n") || "no iterations ran");
    }
    throw new FlowError("INVALID_ARGUMENT", "usage: loop start|run|stop|status");
  },
});

register({
  name: "install",
  group: "setup",
  summary: "Wire agent-flow into Claude Code / Cursor / Codex (MCP, hooks, rules) or a synthet-code-framework project; backups + receipt",
  usage: "install --harness claude|cursor|codex [--scope project|user] [--no-hooks] [--statusline] [--dry-run] | install --framework <project-dir> [--dry-run]",
  options: {
    harness: { type: "string" },
    scope: { type: "string" },
    "no-hooks": { type: "boolean" },
    statusline: { type: "boolean" },
    framework: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  async run(ctx) {
    const inst = await import("../../integrations/install.js");
    const root = resolveRoot(ctx.cwd);
    const receiptDir = path.join(flowPaths(root).dir, "install");
    let edits;
    if (str(ctx.values.framework)) {
      edits = inst.planFramework(path.resolve(ctx.cwd, str(ctx.values.framework)!));
    } else {
      const harness = (str(ctx.values.harness) ?? "claude") as "claude" | "cursor" | "codex";
      if (!["claude", "cursor", "codex"].includes(harness)) throw new FlowError("INVALID_ARGUMENT", "--harness must be claude, cursor or codex");
      const scope = (str(ctx.values.scope) ?? (harness === "codex" ? "user" : "project")) as "project" | "user";
      edits = inst.planInstall({ harness, scope, root, hooks: !bool(ctx.values["no-hooks"]), statusline: bool(ctx.values.statusline) });
    }
    const pending = edits.filter((e) => e.next !== null);
    if (bool(ctx.values["dry-run"])) {
      return ctx.print({ edits: edits.map((e) => ({ file: e.file, kind: e.kind, description: e.description, change: e.next !== null })) }, () =>
        edits.map((e) => `${e.next !== null ? "would write" : "unchanged  "} ${e.file} — ${e.description}`).join("\n"),
      );
    }
    const receipt = inst.applyEdits(pending, receiptDir, root);
    ctx.print(receipt, () =>
      [
        ...edits.map((e) => `${e.next !== null ? "wrote    " : "unchanged"} ${e.file} — ${e.description}`),
        receipt.entries.length ? `receipt: ${path.join(receiptDir, "latest.json")} (undo: agent-flow uninstall)` : "nothing to change",
      ].join("\n"),
    );
  },
});

register({
  name: "uninstall",
  group: "setup",
  summary: "Undo the last install: restores each file only if unchanged since install",
  usage: "uninstall",
  async run(ctx) {
    const inst = await import("../../integrations/install.js");
    const res = inst.rollback(path.join(flowPaths(resolveRoot(ctx.cwd)).dir, "install"));
    ctx.print(res, () => [...res.restored.map((f) => `restored ${f}`), ...res.skipped.map((s) => `skipped  ${s.file}: ${s.why}`)].join("\n") || "nothing to undo");
  },
});

register({
  name: "config",
  group: "setup",
  summary: "Read or change .agent-flow/config.json (validated)",
  usage: "config get [dotted.key] | config set <dotted.key> <json-or-string>",
  run(ctx) {
    const file = flowPaths(resolveRoot(ctx.cwd)).config;
    const cfg = loadConfig(file) as unknown as Record<string, unknown>;
    const [sub, key, ...rest] = ctx.positionals;
    const dig = (obj: Record<string, unknown>, k: string) => k.split(".").reduce<unknown>((o, p) => (o && typeof o === "object" ? (o as Record<string, unknown>)[p] : undefined), obj);
    if (!sub || sub === "get") {
      const v = key ? dig(cfg, key) : cfg;
      return ctx.print(v, () => (typeof v === "string" ? v : JSON.stringify(v, null, 2)));
    }
    if (sub === "set") {
      if (!key || !rest.length) throw new FlowError("INVALID_ARGUMENT", "usage: config set <key> <value>");
      const raw = rest.join(" ");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      const parts = key.split(".");
      let o = cfg;
      for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
      o[parts.at(-1)!] = value;
      const next = configSchema.parse(cfg);
      saveConfig(file, next);
      return ctx.print({ [key]: dig(next as unknown as Record<string, unknown>, key) }, `${key} = ${JSON.stringify(dig(next as unknown as Record<string, unknown>, key))}`);
    }
    void readFileSync;
    throw new FlowError("INVALID_ARGUMENT", "usage: config get|set");
  },
});
