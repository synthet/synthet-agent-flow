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
