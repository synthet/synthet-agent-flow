import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// init, mcp and serve register projects in a user-level registry. Point every test process (and the CLI children it
// spawns, which inherit the env) at a throwaway one, so a test run never edits ~/.agent-flow/workspaces.json.
process.env.AGENT_FLOW_REGISTRY = path.join(mkdtempSync(path.join(tmpdir(), "af-registry-")), "workspaces.json");
