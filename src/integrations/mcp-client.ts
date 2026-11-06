import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FlowError } from "../core/errors.js";

/**
 * Minimal stdio MCP client for sibling tools (synthet-agent-mailbox journal, synthet-agent-swarm).
 * Using their MCP servers means agent-flow depends only on their published tool contracts.
 */

export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface McpSession {
  call: McpCall;
  close(): Promise<void>;
}

export type McpOpener = (spec: McpSpec) => Promise<McpSession>;

export interface McpSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
  name: string;
}

function parseResult(tool: string, res: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): unknown {
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (res.isError) throw new FlowError("EXTERNAL_FAILURE", `${tool}: ${text.slice(0, 500) || "tool error"}`, { retryable: true });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const openStdioMcp: McpOpener = async (spec) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, spec.env ?? {});
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env, cwd: spec.cwd, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (b: Buffer) => {
    if (stderr.length < 4000) stderr += b.toString("utf8");
  });
  const client = new Client({ name: "agent-flow", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new FlowError("EXTERNAL_FAILURE", `could not start ${spec.name} MCP server (${spec.command} ${spec.args.join(" ")}): ${String(err)}${stderr ? `\n${stderr.trim().slice(0, 800)}` : ""}`, {
      retryable: true,
    });
  }
  return {
    call: async (tool, args) => {
      try {
        const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: spec.timeoutMs ?? 30_000 });
        return parseResult(tool, res as never);
      } catch (err) {
        if (err instanceof FlowError) throw err;
        throw new FlowError("EXTERNAL_FAILURE", `${spec.name} ${tool} failed: ${String(err)}${stderr ? `\n${stderr.trim().slice(0, 800)}` : ""}`, { retryable: true });
      }
    },
    close: () => client.close(),
  };
};
