import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { configSchema, defaultConfig, loadConfig } from "../src/core/config.js";
import { toFlowError } from "../src/core/errors.js";
import { tempDir } from "./helpers.js";

const parse = (raw: unknown) => configSchema.parse(raw);

describe("config defaults", () => {
  it("fills every nested section from an empty config", () => {
    const c = defaultConfig();
    expect(c.wip).toEqual({ perAgent: 1, columns: { in_progress: 4, review: 6 } });
    expect(c.loop).toEqual({ maxTickets: 5, label: "agent-ok", maxTurns: 80, harness: "claude" });
    expect(c.github).toEqual({ enabled: false, repo: null, labelPrefix: "status:", issueLabel: "agent-flow", reconcileMinutes: 5, webhookSecretEnv: "AGENT_FLOW_GITHUB_SECRET" });
    expect(c.mailbox.notifyOn).toEqual(["claimed", "review", "rejected", "blocked", "needs_human", "done", "lease_expired"]);
    expect(c.swarm).toEqual({ enabled: false, path: null, harnesses: [], autoApproveOnMajority: false, timeoutMs: 300000 });
    expect(c.jev).toEqual({ path: null, model: null, onSubmit: false, timeoutMs: 120000 });
    expect(c.hooks).toEqual({ taskCompletedDod: false, handoffOnStop: true, heartbeatMinutes: 5 });
    expect(c.server).toEqual({ host: "127.0.0.1", port: 8791 });
  });

  it("keeps the other defaults when a section is set partly", () => {
    expect(parse({ wip: { perAgent: 3 } }).wip).toEqual({ perAgent: 3, columns: { in_progress: 4, review: 6 } });
    expect(parse({ mailbox: { enabled: true } }).mailbox).toMatchObject({ enabled: true, bin: "agent-mail", audience: "group" });
    expect(parse({ server: { port: 9000 } }).server).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(defaultConfig().wiki).toEqual({ enabled: false, root: null, outDir: "wiki/notes/agent-flow", ingest: true, bin: "llmwiki" });
    expect(parse({ wiki: { enabled: true, root: "D:/wiki" } }).wiki).toMatchObject({ enabled: true, root: "D:/wiki", ingest: true });
  });

  it("does not share default objects between configs", () => {
    const a = defaultConfig();
    a.wip.columns.review = 99;
    a.dod.push("x");
    const b = defaultConfig();
    expect(b.wip.columns.review).toBe(6);
    expect(b.dod).toEqual([]);
  });
});

describe("config validation", () => {
  it("accepts WIP limits for only some columns", () => {
    expect(parse({ wip: { columns: { review: 2 } } }).wip.columns).toEqual({ review: 2 });
  });

  it("rejects an unknown column", () => {
    expect(() => parse({ wip: { columns: { nope: 1 } } })).toThrow();
  });

  it("drops unknown keys", () => {
    expect(parse({ somethingElse: true, server: { other: 1 } })).not.toHaveProperty("somethingElse");
    expect(parse({ server: { other: 1 } }).server).not.toHaveProperty("other");
  });

  it("reports the field path for an invalid value", () => {
    let err: unknown;
    try {
      parse({ leaseMinutes: 0, server: { port: "x" } });
    } catch (e) {
      err = e;
    }
    const fe = toFlowError(err);
    expect(fe.code).toBe("INVALID_ARGUMENT");
    expect(fe.message).toContain("leaseMinutes");
    expect(fe.message).toContain("server.port");
  });
});

describe("config files", () => {
  it("round-trips a saved config unchanged", () => {
    const file = path.join(tempDir(), "config.json");
    const c = defaultConfig({ prefix: "xy", dod: ["npm test"] });
    writeFileSync(file, JSON.stringify(c));
    expect(loadConfig(file)).toEqual(c);
  });

  it("loads this repo's config", () => {
    const c = loadConfig(path.join(__dirname, "..", ".agent-flow", "config.json"));
    expect(c.prefix).toBe("af");
    expect(c.wip.columns).toEqual({ in_progress: 4, review: 6 });
  });
});
