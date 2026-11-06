import { register, str } from "../registry.js";

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
  summary: "Web Kanban dashboard + REST/SSE API on loopback (default http://127.0.0.1:8790)",
  usage: "serve [--port 8790] [--host 127.0.0.1] [--open]",
  options: { port: { type: "string", short: "p" }, host: { type: "string" }, open: { type: "boolean" } },
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
      const stop = () => void server.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
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
