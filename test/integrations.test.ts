import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../src/core/proc.js";
import { initWorkspace, openWorkspace, type Workspace } from "../src/core/workspace.js";
import { claimTicket } from "../src/core/service.js";
import { attachNotifiers, flushOutbox } from "../src/integrations/notify.js";
import { applyPrState, pushIssues, reconcile, renderTemplate, prBody, githubWebhookHandler } from "../src/integrations/github.js";
import { swarmReview, parseSwarm } from "../src/integrations/swarm.js";
import { createWorktree, worktreePath } from "../src/integrations/worktree.js";
import { runLoop, startLoop, stopLoop } from "../src/integrations/loop.js";
import { applyEdits, planFramework, planInstall, rollback } from "../src/integrations/install.js";
import { startServer } from "../src/server/http.js";
import type { Runner } from "../src/integrations/exec.js";
import { tempDir } from "./helpers.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, ms: 1 });
const fail = (stderr = "boom", code = 1): RunResult => ({ code, stdout: "", stderr, timedOut: false, ms: 1 });

function repo(config: Record<string, unknown> = {}) {
  const dir = tempDir("af-int-");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  initWorkspace(dir, config as never);
  return { dir, git, ws: openWorkspace(dir) };
}

function recorder(respond: (argv: string[], input?: string) => RunResult): { run: Runner; calls: Array<{ argv: string[]; input?: string }> } {
  const calls: Array<{ argv: string[]; input?: string }> = [];
  return {
    calls,
    run: async (argv, opts) => {
      calls.push({ argv, input: opts?.input });
      return respond(argv, opts?.input);
    },
  };
}

describe("mailbox notifications", () => {
  it("queues events in the outbox and publishes through agent-mail (register once, review → peer send)", async () => {
    const { ws } = repo({ mailbox: { enabled: true, scope: "team-flow", reviewPeer: "Laptop" } } as never);
    attachNotifiers(ws);
    const t = ws.store.create({ title: "Notify me", status: "ready" }, "human:x");
    claimTicket(ws, t.id, "claude:a");
    ws.store.comment(t.id, "handoff", "done", "claude:a");
    ws.store.transition(t.id, "submit", "claude:a");
    expect(ws.store.outboxStats().pending).toBe(2); // claimed + review
    const { run, calls } = recorder(() => ok("{}"));
    const res = await flushOutbox(ws, { run });
    expect(res).toEqual({ sent: 2, failed: 0 });
    const verbs = calls.map((c) => c.argv.slice(0, 2).join(" "));
    expect(verbs).toEqual(["agent-mail register", "agent-mail publish", "agent-mail publish", "agent-mail send"]);
    const publish = calls[1].argv;
    expect(publish).toContain("--scope");
    expect(publish[publish.indexOf("--scope") + 1]).toBe("team-flow");
    expect(publish.join(" ")).toContain(`[flow] ${t.id} claimed`);
    expect(calls[3].argv[2]).toBe("Laptop");
    ws.close();
  });

  it("keeps failed deliveries queued with backoff and never breaks the write", async () => {
    const { ws } = repo({ mailbox: { enabled: true } } as never);
    attachNotifiers(ws);
    const t = ws.store.create({ title: "x", status: "ready" }, "human:x");
    claimTicket(ws, t.id, "claude:a");
    const { run } = recorder(() => fail("agent-mail: not found", -1));
    expect(await flushOutbox(ws, { run })).toEqual({ sent: 0, failed: 1 });
    expect(ws.store.outboxStats().pending).toBe(1);
    expect(ws.store.dueOutbox()).toHaveLength(0); // backed off
    ws.close();
  });
});

describe("github mirror", () => {
  function fakeGh() {
    let issue = 100;
    const prs: unknown[] = [];
    const r = recorder((argv) => {
      const a = argv.slice(1).join(" ");
      if (a.startsWith("repo view")) return ok("synthet/demo\n");
      if (a.startsWith("label create")) return ok();
      if (a.startsWith("issue create")) return ok(`https://github.com/synthet/demo/issues/${++issue}\n`);
      if (/^api repos\/synthet\/demo\/issues\/\d+ --jq/.test(a)) return ok(`9${issue}\n`);
      if (a.startsWith("api -X POST")) return ok("{}");
      if (a.startsWith("issue edit") || a.startsWith("issue close")) return ok();
      if (a.startsWith("pr list")) return ok(JSON.stringify(prs));
      return fail(`unexpected: ${a}`);
    });
    return { ...r, prs };
  }

  it("pushes epics first, attaches children as sub-issues, and projects status labels", async () => {
    const { ws } = repo({ github: { enabled: true } } as never);
    const epic = ws.store.create({ title: "Epic", type: "epic" }, "human:x");
    const child = ws.store.create({ title: "Child", status: "ready", parent: epic.id, acceptance: ["works"] }, "human:x");
    const gh = fakeGh();
    const res = await pushIssues(ws, null, gh.run);
    expect(res.created.map((c) => c.id)).toEqual([epic.id, child.id]);
    expect(ws.store.get(child.id).github_issue).toBe(102);
    const sub = gh.calls.find((c) => c.argv.includes("POST"));
    expect(sub?.argv).toContain("repos/synthet/demo/issues/101/sub_issues");
    const body = gh.calls.find((c) => c.argv.includes("create") && c.argv.includes("issue") && c.input?.includes(child.id))?.input ?? "";
    expect(body).toContain("Part of #101");
    expect(body).toContain("- [ ] **AC-1** works");
    // status change → outbox → label edit
    attachNotifiers(ws);
    claimTicket(ws, child.id, "claude:a");
    await flushOutbox(ws, { run: gh.run });
    const edit = gh.calls.filter((c) => c.argv[1] === "issue" && c.argv[2] === "edit").at(-1)!;
    expect(edit.argv).toContain("status:claimed");
    ws.close();
  });

  it("reconciles PR state: changes requested → reject, merged → approved; idempotent", async () => {
    const { ws } = repo({ github: { enabled: true } } as never);
    const t = ws.store.create({ title: "PR me", status: "ready", acceptance: ["a"] }, "human:x");
    const c = claimTicket(ws, t.id, "claude:a");
    ws.store.comment(t.id, "handoff", "done", "claude:a");
    ws.store.transition(t.id, "submit", "claude:a");
    const gh = fakeGh();
    gh.prs.push({ number: 7, headRefName: c.branch, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", body: `Refs ${t.id}`, url: "https://github.com/synthet/demo/pull/7" });
    expect(await reconcile(ws, gh.run)).toEqual([{ ticket: t.id, action: "rejected", pr: 7 }]);
    expect(ws.store.get(t.id).status).toBe("in_progress");
    expect(ws.store.get(t.id).pr_url).toBe("https://github.com/synthet/demo/pull/7");
    expect(await reconcile(ws, gh.run)).toEqual([]); // same state: no-op
    ws.store.comment(t.id, "handoff", "fixed", "claude:a");
    ws.store.transition(t.id, "submit", "claude:a");
    expect(applyPrState(ws, { number: 7, headRefName: c.branch!, state: "MERGED", body: "" })).toEqual({ ticket: t.id, action: "approved" });
    expect(ws.store.get(t.id).status).toBe("done");
    ws.close();
  });

  it("verifies webhook signatures and applies pull_request events", async () => {
    const { ws } = repo({ github: { enabled: true } } as never);
    const t = ws.store.create({ title: "hooked", status: "ready" }, "human:x");
    const c = claimTicket(ws, t.id, "claude:a");
    process.env.AGENT_FLOW_GITHUB_SECRET = "s3cret";
    const server = await startServer(ws, { port: 0, githubWebhook: githubWebhookHandler });
    const payload = JSON.stringify({ action: "closed", pull_request: { number: 9, head: { ref: c.branch }, state: "closed", merged: true, body: "", html_url: "https://x/pull/9" } });
    const sig = `sha256=${createHmac("sha256", "s3cret").update(payload).digest("hex")}`;
    const post = (signature: string) =>
      fetch(`${server.url}hooks/github`, { method: "POST", headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature, "content-type": "application/json" }, body: payload });
    expect((await post("sha256=bad")).status).toBe(401);
    const good = await post(sig);
    expect(good.status).toBe(200);
    expect(ws.store.get(t.id).status).toBe("done");
    await server.close();
    delete process.env.AGENT_FLOW_GITHUB_SECRET;
    ws.close();
  });

  it("renders the PR body template", () => {
    expect(renderTemplate("Refs {{id}}{{#issue}} Closes #{{issue}}{{/issue}}\n{{#acceptance}}- [{{check}}] {{ac_id}}\n{{/acceptance}}", { id: "af-1", issue: 5, acceptance: [{ check: "x", ac_id: "AC-1" }] })).toBe(
      "Refs af-1 Closes #5\n- [x] AC-1\n",
    );
    const { ws } = repo();
    const t = ws.store.create({ title: "Body", acceptance: ["one"] }, "human:x");
    const body = prBody(ws, t.id);
    expect(body.startsWith(`Refs ${t.id}`)).toBe(true);
    expect(body).toContain("**AC-1** one");
    ws.close();
  });
});

describe("swarm review", () => {
  const SWARM_OUT = {
    ok: true,
    judges: [
      { agent: "codex", ok: true, summary: "looks good" },
      { agent: "claude", ok: true, summary: "approve" },
      { agent: "antigravity", ok: true, summary: "approve" },
    ],
    agreement: {
      parsedAgents: ["codex", "claude", "antigravity"],
      unparsedAgents: [],
      items: {
        _reply: {
          votes: {},
          fields: {
            verdict: { value: "approve", counts: { approve: 3 }, disputed: false, answered: 3 },
            "AC-1": { value: "pass", counts: { pass: 3 }, disputed: false, answered: 3 },
          },
        },
      },
    },
  };

  function swarmCheckout(): string {
    const dir = tempDir("af-swarm-");
    mkdirSync(path.join(dir, "agent-orchestrator", "dist"), { recursive: true });
    writeFileSync(path.join(dir, "agent-orchestrator", "dist", "index.js"), "");
    return dir;
  }

  it("parses strict-majority votes", () => {
    const r = parseSwarm(SWARM_OUT, ["AC-1", "AC-2"]);
    expect(r.verdict).toBe("approve");
    expect(r.ac["AC-1"].value).toBe("pass");
    expect(r.ac["AC-2"].value).toBeNull();
    expect(r.harnesses.map((h) => h.harness)).toEqual(["codex", "claude", "antigravity"]);
  });

  it("records the verdict as a review comment; auto-approves only when configured and all AC pass", async () => {
    for (const auto of [false, true]) {
      const { ws, dir } = repo({ swarm: { enabled: true, path: swarmCheckout(), autoApproveOnMajority: auto } } as never);
      const t = ws.store.create({ title: "Swarm me", status: "ready", acceptance: ["works"] }, "human:x");
      claimTicket(ws, t.id, "claude:a");
      ws.store.comment(t.id, "handoff", "done", "claude:a");
      ws.store.transition(t.id, "submit", "claude:a");
      const { run, calls } = recorder(() => ok(JSON.stringify(SWARM_OUT)));
      const res = await swarmReview(ws, t.id, { cwd: dir }, run);
      const argv = calls[0].argv;
      expect(argv[2]).toBe("swarm");
      expect(argv[argv.indexOf("--task") + 1]).toContain('"AC-1": "pass" | "fail" | "unknown"');
      expect(res.approved).toBe(auto);
      expect(ws.store.get(t.id).status).toBe(auto ? "done" : "review");
      expect(ws.store.detail(t.id).comments.at(-1)?.body).toContain("Swarm review: **approve**");
      ws.close();
    }
  });
});

describe("worktrees", () => {
  it("creates one worktree per ticket; concurrent creation is serialised", async () => {
    const { ws, dir } = repo();
    const ids = ["a", "b", "c"].map((n) => claimTicket(ws, ws.store.create({ title: `wt ${n}`, status: "ready" }, "human:x").id, `human:${n}`).id);
    const results = await Promise.all(ids.map((id) => createWorktree(ws, id, "human:x")));
    for (const r of results) {
      expect(r.created).toBe(true);
      expect(existsSync(path.join(r.path, ".git"))).toBe(true);
    }
    const list = execFileSync("git", ["worktree", "list"], { cwd: dir }).toString();
    for (const id of ids) expect(list).toContain(worktreePath(ws, id));
    expect((await createWorktree(ws, ids[0], "human:x")).created).toBe(false);
    ws.close();
  });
});

describe("loop", () => {
  it("runs fresh sessions per ticket until the labelled queue is empty", async () => {
    const { ws, dir } = repo({ requireHandoff: true } as never);
    for (const n of [1, 2]) ws.store.create({ title: `auto ${n}`, status: "ready", labels: ["agent-ok"] }, "human:x");
    ws.store.create({ title: "manual only", status: "ready" }, "human:x");
    // Fake headless session: claims the head of the labelled queue as $AGENT_FLOW_ACTOR, hands off, submits.
    const run: Runner = async (_argv, opts) => {
      const actor = opts!.env!.AGENT_FLOW_ACTOR!;
      const w2 = openWorkspace(dir);
      const t = claimTicket(w2, null, actor, { filter: { label: "agent-ok" } });
      w2.store.comment(t.id, "handoff", "did it", actor);
      w2.store.transition(t.id, "submit", actor);
      w2.close();
      return ok("{}");
    };
    const res = await runLoop(ws, { max: 5, label: "agent-ok", harness: "claude", maxTurns: 10, cwd: dir }, run);
    expect(res.map((r) => r.status)).toEqual(["review", "review"]);
    expect(ws.store.list({ status: "ready" }).map((t) => t.title)).toEqual(["manual only"]);
  });

  it("halts on a non-submitted ticket and releases it; start/stop manage loop.json + STOP", async () => {
    const { ws, dir } = repo();
    ws.store.create({ title: "stuck", status: "ready", labels: ["agent-ok"] }, "human:x");
    const run: Runner = async (_argv, opts) => {
      const w2 = openWorkspace(dir);
      claimTicket(w2, null, opts!.env!.AGENT_FLOW_ACTOR!, {});
      w2.close();
      return ok();
    };
    const res = await runLoop(ws, { max: 3, label: "agent-ok", harness: "claude", maxTurns: 10, cwd: dir }, run);
    expect(res).toHaveLength(1);
    expect(ws.store.list({ status: "ready" })[0].attempts).toBe(1);
    const st = startLoop(ws, { max: 2, label: "agent-ok" });
    expect(st.active).toBe(true);
    stopLoop(ws, "human:x");
    expect(existsSync(ws.paths.stopFile)).toBe(true);
    ws.close();
  });
});

describe("install", () => {
  it("merges MCP + hooks additively, is idempotent, and rolls back only unchanged files", () => {
    const { dir } = repo();
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const receipts = path.join(dir, ".agent-flow", "install");
    const edits = planInstall({ harness: "claude", scope: "project", root: dir, statusline: true });
    const receipt = applyEdits(edits.filter((e) => e.next !== null), receipts, dir);
    expect(receipt.entries).toHaveLength(3);
    const mcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["other", "agent-flow"]);
    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("agent-flow hook session-start");
    expect(settings.statusLine.command).toBe("agent-flow statusline");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain("BEGIN AGENT-FLOW");
    expect(planInstall({ harness: "claude", scope: "project", root: dir }).every((e) => e.next === null)).toBe(true);
    writeFileSync(path.join(dir, "CLAUDE.md"), "edited by a human\n");
    const rb = rollback(receipts);
    expect(rb.restored.sort()).toEqual([path.join(dir, ".claude", "settings.json"), path.join(dir, ".mcp.json")].sort());
    expect(rb.skipped.map((s) => s.file)).toEqual([path.join(dir, "CLAUDE.md")]);
    expect(JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("codex + cursor + framework targets", () => {
    const { dir } = repo();
    const home = tempDir("af-home-");
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const codex = planInstall({ harness: "codex", scope: "user", root: dir, home });
    expect(codex[0].next).toContain('[mcp_servers.agent-flow]\ncommand = "agent-flow"\nargs = ["mcp"]');
    expect(codex[0].next!.startsWith('model = "gpt-5"\n')).toBe(true);
    const cursor = planInstall({ harness: "cursor", scope: "project", root: dir });
    expect(JSON.parse(cursor[0].next!).mcpServers["agent-flow"].type).toBe("stdio");
    const project = tempDir("af-fw-");
    mkdirSync(path.join(project, ".agent", "backlog"), { recursive: true });
    writeFileSync(path.join(project, ".agent", "backlog", "README.md"), "# Backlog providers\n");
    const fw = planFramework(project);
    applyEdits(fw.filter((e) => e.next !== null), path.join(project, ".receipts"), project);
    expect(readFileSync(path.join(project, ".agent", "backlog", "providers", "agent-flow.md"), "utf8")).toContain("Five-step contract");
    expect(readFileSync(path.join(project, ".agent", "backlog", "README.md"), "utf8")).toContain("agent-flow provider");
  });
});
