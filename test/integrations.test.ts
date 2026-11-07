import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../src/core/proc.js";
import { initWorkspace, openWorkspace, type Workspace } from "../src/core/workspace.js";
import { claimTicket, submitTicket } from "../src/core/service.js";
import { jevReview } from "../src/integrations/jev.js";
import os from "node:os";
import { attachNotifiers, flushOutbox } from "../src/integrations/notify.js";
import { applyPrState, pushIssues, reconcile, renderTemplate, prBody, githubWebhookHandler } from "../src/integrations/github.js";
import { swarmReview } from "../src/integrations/swarm.js";
import { createWorktree, worktreePath } from "../src/integrations/worktree.js";
import { runLoop, startLoop, stopLoop } from "../src/integrations/loop.js";
import { applyEdits, planFramework, planInstall, rollback } from "../src/integrations/install.js";
import { startServer } from "../src/server/http.js";
import type { Runner } from "../src/integrations/exec.js";
import type { McpOpener, McpSpec } from "../src/integrations/mcp-client.js";
import { lastJsonObject } from "../src/integrations/swarm.js";
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

/** Fake stdio MCP server: records spawns and tool calls; `respond` returns the tool's JSON (throw to fail). */
function fakeMcp(respond: (tool: string, args: Record<string, unknown>) => unknown) {
  const spawns: McpSpec[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let closed = 0;
  const open: McpOpener = async (spec) => {
    spawns.push(spec);
    return {
      call: async (tool, args) => {
        calls.push({ tool, args });
        return respond(tool, args);
      },
      close: async () => {
        closed++;
      },
    };
  };
  return { open, spawns, calls, closed: () => closed };
}

describe("mailbox notifications", () => {
  it("delivers through the mailbox journal over MCP: one session per flush, register + subscribe, keyed publishes, review → peer send", async () => {
    const { ws } = repo({ mailbox: { enabled: true, scope: "team-flow", reviewPeer: "reviewer-pc" } } as never);
    attachNotifiers(ws);
    const t = ws.store.create({ title: "Notify me", status: "ready" }, "human:x");
    claimTicket(ws, t.id, "claude:a");
    ws.store.comment(t.id, "handoff", "done", "claude:a");
    ws.store.transition(t.id, "submit", "claude:a");
    expect(ws.store.outboxStats().pending).toBe(2); // claimed + review
    // Response shapes recorded from a real synthet-agent-mailbox 0.3.0 build.
    const mcp = fakeMcp((tool) =>
      tool === "mailbox_register_session"
        ? { agent_id: "4990c66e-526e-498b-9414-8810ee68a588", session_id: "agent-flow" }
        : tool === "mailbox_subscribe"
          ? { scope_id: "team-flow", agent_id: "4990c66e-526e-498b-9414-8810ee68a588" }
          : { duplicate: false, message_id: "882d7fcb-26d3-4203-8082-64c904a9486b", thread_id: "882d7fcb-26d3-4203-8082-64c904a9486b" },
    );
    const { run, calls } = recorder(() => ok("{}"));
    expect(await flushOutbox(ws, { run, openMcp: mcp.open })).toEqual({ sent: 2, failed: 0 });
    expect(mcp.spawns).toHaveLength(1);
    expect(mcp.spawns[0].args.slice(-6)).toEqual(["mcp", "--no-listen", "--harness", "agent-flow", "--agent-name", "agent-flow"]);
    expect(mcp.calls.map((c) => c.tool)).toEqual(["mailbox_register_session", "mailbox_subscribe", "mailbox_publish", "mailbox_publish"]);
    const pub = mcp.calls[2].args;
    expect(pub).toMatchObject({ session_id: "agent-flow", audience: "group", scope_id: "team-flow", subject: `[flow] ${t.id} claimed` });
    expect(String(pub.idempotency_key)).toMatch(/^agent-flow:[0-9a-f]{40}$/);
    expect(mcp.calls[3].args.idempotency_key).not.toBe(pub.idempotency_key);
    expect(mcp.closed()).toBe(1);
    // Only the review event goes to the peer, via the CLI.
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(0, 3)).toEqual(["agent-mail", "send", "reviewer-pc"]);
    ws.close();
  });

  it("explains a missing mailbox identity and keeps the job queued with backoff", async () => {
    const { ws } = repo({ mailbox: { enabled: true, scope: "team-flow" } } as never);
    attachNotifiers(ws);
    const t = ws.store.create({ title: "x", status: "ready" }, "human:x");
    claimTicket(ws, t.id, "claude:a");
    const mcp = fakeMcp(() => {
      throw new Error("ENOENT: no such file or directory, open '/home/u/.agent-mail/identity.json'");
    });
    expect(await flushOutbox(ws, { openMcp: mcp.open })).toEqual({ sent: 0, failed: 1 });
    const row = ws.store.db.prepare("SELECT last_error FROM outbox").get() as { last_error: string };
    expect(row.last_error).toContain("no identity");
    expect(ws.store.outboxStats().pending).toBe(1);
    expect(ws.store.dueOutbox()).toHaveLength(0); // backed off
    ws.close();
  });

  it("requires a scope for group audiences", async () => {
    const { ws } = repo({ mailbox: { enabled: true } } as never);
    attachNotifiers(ws);
    claimTicket(ws, ws.store.create({ title: "x", status: "ready" }, "human:x").id, "claude:a");
    const mcp = fakeMcp(() => ({}));
    expect((await flushOutbox(ws, { openMcp: mcp.open })).failed).toBe(1);
    expect((ws.store.db.prepare("SELECT last_error FROM outbox").get() as { last_error: string }).last_error).toContain("mailbox.scope");
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
  // swarm_run response shapes recorded from a real synthet-agent-swarm build.
  const MULTI = {
    ok: true,
    dryRun: false,
    harnesses: [
      { id: "codex", transport: "cli", ok: true, summary: "looks good" },
      { id: "claude", transport: "cli", ok: true, summary: "approve" },
      { id: "agy", transport: "cli", ok: true, summary: "approve" },
    ],
    agreement: {
      parsedAgents: ["codex", "claude", "agy"],
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

  async function inReview(config: Record<string, unknown>) {
    const ctx = repo({ swarm: { enabled: true, path: swarmCheckout(), ...config } } as never);
    const t = ctx.ws.store.create({ title: "Swarm me", status: "ready", acceptance: ["works"] }, "human:x");
    claimTicket(ctx.ws, t.id, "claude:a");
    ctx.ws.store.comment(t.id, "handoff", "done", "claude:a");
    ctx.ws.store.transition(t.id, "submit", "claude:a");
    return { ...ctx, id: t.id };
  }

  it("finds the last JSON object in a reply", () => {
    expect(lastJsonObject('notes {"x": 1}\nmore\n```json\n{"verdict": "approve", "AC-1": "pass"}\n```')).toEqual({ verdict: "approve", "AC-1": "pass" });
    expect(lastJsonObject("no json here")).toBeNull();
  });

  it("calls swarm_run (mode review) over MCP and records majority votes; auto-approves only with ≥2 judges when configured", async () => {
    for (const auto of [false, true]) {
      const { ws, dir, id } = await inReview({ autoApproveOnMajority: auto });
      const mcp = fakeMcp(() => MULTI);
      const res = await swarmReview(ws, id, { cwd: dir }, mcp.open);
      expect(mcp.spawns[0].env).toEqual({ WORKSPACE_ROOT: dir });
      expect(mcp.calls[0].tool).toBe("swarm_run");
      expect(mcp.calls[0].args).toMatchObject({ mode: "review", dryRun: false });
      expect(String(mcp.calls[0].args.task)).toContain('"AC-1": "pass" | "fail" | "unknown"');
      expect(res.parsed).toEqual(["codex", "claude", "agy"]);
      expect(res.approved).toBe(auto);
      expect(ws.store.get(id).status).toBe(auto ? "done" : "review");
      expect(ws.store.detail(id).comments.at(-1)?.body).toContain("Swarm review: **approve**");
      ws.close();
    }
  });

  it("single harness: reads that judge's reply file, never auto-approves", async () => {
    const { ws, dir, id } = await inReview({ autoApproveOnMajority: true });
    mkdirSync(path.join(dir, ".agent-runs", "r1"), { recursive: true });
    writeFileSync(path.join(dir, ".agent-runs", "r1", "stdout.md"), '# Subagent Result: claude\nLooks right.\n{"verdict": "approve", "AC-1": "pass", "reason": "tested"}\n');
    const mcp = fakeMcp(() => ({ ok: true, dryRun: false, harnesses: [{ id: "claude", transport: "cli", ok: true, summary: "# Subagent Result: claude", outputFile: ".agent-runs/r1/stdout.md" }] }));
    const res = await swarmReview(ws, id, { cwd: dir }, mcp.open);
    expect(res.verdict).toBe("approve");
    expect(res.ac["AC-1"]).toEqual({ value: "pass", counts: { pass: 1 } });
    expect(res.approved).toBe(false);
    expect(ws.store.detail(id).comments.at(-1)?.body).toContain("Single harness");
    ws.close();
  });

  it("surfaces swarm preflight errors", async () => {
    const { ws, dir, id } = await inReview({});
    const mcp = fakeMcp(() => ({ ok: false, error: { code: "unknown_harness", message: "nope", next_steps: ["swarm_search"] }, harnesses: [] }));
    await expect(swarmReview(ws, id, { cwd: dir, harnesses: ["nope"] }, mcp.open)).rejects.toThrow(/unknown_harness/);
    ws.close();
  });
});

describe("jev review (advisory)", () => {
  const home = os.homedir();

  function jevCheckout(): string {
    const dir = tempDir("af-jev-");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "run_jev_mcp.py"), "");
    return dir;
  }

  /** A ticket in review with one verified and one open criterion, a handoff, and prior review comments. */
  async function inReview(jev: Record<string, unknown> = {}) {
    const ctx = repo({ jev: { path: jevCheckout(), ...jev } } as never);
    const t = ctx.ws.store.create({ title: "Judge me", body: "Make the widget work.", status: "ready", acceptance: ["widget works", "docs updated"] }, "human:x");
    claimTicket(ctx.ws, t.id, "claude:a");
    ctx.ws.store.verifyAcceptance(t.id, "AC-1", "Verified", `ran npm test in ${home}${path.sep}work: 12 passed; token=abcd1234efgh5678`, "claude:a");
    ctx.ws.store.comment(t.id, "handoff", "Changed the widget. Left: docs still to write.", "claude:a");
    ctx.ws.store.transition(t.id, "submit", "claude:a");
    ctx.ws.store.comment(t.id, "review", "Earlier Jev comment that must not be resent", "system:jev");
    ctx.ws.store.comment(t.id, "review", "Peer says the widget test is thin", "codex:peer");
    return { ...ctx, id: t.id };
  }

  /** Answers every question the way `pick` says, in the jev-mcp envelope. */
  function jevAnswers(pick: (qid: string, criteria: string[]) => string, noul = 0.2) {
    return (_tool: string, args: Record<string, unknown>) => {
      const questions = args.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([qid, q]) => {
          if (q.type === "noul") return [qid, { type: "noul", noul }];
          const keys = Object.keys(q.criteria ?? {});
          const choice = pick(qid, keys);
          return [qid, { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.1])) }];
        }),
      );
      return { ok: true, result: { model: "jev-test", usage: { input_tokens: 10, output_tokens: 2 }, answers } };
    };
  }

  it("asks one jev_system_one call per ticket and records an advisory system:jev review comment", async () => {
    const { ws, dir, id } = await inReview();
    const cfg = ws.config.jev.path!;
    const mcp = fakeMcp(jevAnswers((qid, keys) => (qid === "overall" ? "looks_ready" : keys[0])));
    const res = await jevReview(ws, id, { cwd: dir }, mcp.open);
    expect(mcp.spawns).toHaveLength(1);
    expect(mcp.spawns[0]).toMatchObject({ command: "uv", args: ["run", "--project", cfg, "python", path.join(cfg, "scripts", "run_jev_mcp.py")], cwd: cfg });
    expect(mcp.spawns[0].env ?? {}).not.toHaveProperty("JEV_TOKEN");
    expect(mcp.closed()).toBe(1);
    expect(mcp.calls.map((c) => c.tool)).toEqual(["jev_system_one"]);
    const questions = mcp.calls[0].args.questions as Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
    expect(Object.keys(questions).sort()).toEqual(["ac_1", "ac_2", "open_work", "overall"]);
    expect(Object.keys(questions.ac_1.criteria!)).toEqual(["supported", "partial", "unsupported"]);
    expect(questions.ac_2.instructions).toContain("AC-2");
    expect(questions.open_work.type).toBe("noul");
    expect(res.verdict).toBe("looks_ready");
    expect(res.ac["AC-1"]).toEqual({ choice: "supported", confidence: 0.8 });
    expect(res.model).toBe("jev-test");
    const comment = ws.store.detail(id).comments.at(-1)!;
    expect(comment).toMatchObject({ kind: "review", actor: "system:jev" });
    expect(comment.body).toContain("Jev review (advisory");
    expect(comment.body).toContain("AC-1: supported (0.80)");
    expect(comment.body).toContain("not the code");
    expect(ws.store.detail(id, { events: 50 }).events.some((e) => e.action === "jev.reviewed")).toBe(true);
    ws.close();
  });

  it("never changes ticket status or acceptance verdicts, whatever Jev answers", async () => {
    for (const verdict of ["looks_ready", "needs_changes", "unclear"]) {
      const { ws, dir, id } = await inReview();
      const before = ws.store.detail(id).acceptance.map((a) => a.verdict);
      const mcp = fakeMcp(jevAnswers((qid, keys) => (qid === "overall" ? verdict : keys.at(-1)!), 0.9));
      await jevReview(ws, id, { cwd: dir }, mcp.open);
      expect(ws.store.get(id).status).toBe("review");
      expect(ws.store.detail(id).acceptance.map((a) => a.verdict)).toEqual(before);
      ws.close();
    }
  });

  it("sends no home path or secret, and leaves out earlier Jev comments", async () => {
    const { ws, dir, id } = await inReview();
    const mcp = fakeMcp(jevAnswers((_q, keys) => keys[0]));
    await jevReview(ws, id, { cwd: dir }, mcp.open);
    const sent = JSON.stringify(mcp.calls[0].args).toLowerCase();
    for (const form of [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]) expect(sent).not.toContain(form.toLowerCase());
    expect(sent).not.toContain("abcd1234efgh5678");
    expect(sent).toContain("~");
    expect(sent).not.toContain("earlier jev comment");
    expect(sent).toContain("peer says the widget test is thin");
    expect(sent).toContain("docs still to write");
    ws.close();
  });

  it("dry run returns the exact request without starting the server, even outside review", async () => {
    const ctx = repo({ jev: { path: jevCheckout() } } as never);
    const t = ctx.ws.store.create({ title: "Draft", status: "ready", acceptance: ["x"] }, "human:x");
    const mcp = fakeMcp(() => {
      throw new Error("must not be called");
    });
    const res = await jevReview(ctx.ws, t.id, { cwd: ctx.dir, dryRun: true }, mcp.open);
    expect(mcp.spawns).toHaveLength(0);
    expect(res.dry_run?.tool).toBe("jev_system_one");
    expect(Object.keys(res.dry_run!.arguments.questions)).toContain("ac_1");
    expect(ctx.ws.store.detail(t.id).comments).toHaveLength(0);
    ctx.ws.close();
  });

  it("gives clear errors and records nothing when Jev fails", async () => {
    const unset = repo();
    const draft = unset.ws.store.create({ title: "x", status: "ready" }, "human:x");
    await expect(jevReview(unset.ws, draft.id, { cwd: unset.dir, dryRun: true })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const empty = repo({ jev: { path: tempDir("af-nojev-") } } as never);
    const d2 = empty.ws.store.create({ title: "x", status: "ready" }, "human:x");
    await expect(jevReview(empty.ws, d2.id, { cwd: empty.dir, dryRun: true })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { ws, dir, id } = await inReview();
    const comments = ws.store.detail(id).comments.length;
    const envelope = fakeMcp(() => ({ ok: false, error: { code: "auth_failed", message: "bad token", retryable: false, next_steps: ["set JEV_TOKEN"] } }));
    await expect(jevReview(ws, id, { cwd: dir }, envelope.open)).rejects.toMatchObject({ code: "EXTERNAL_FAILURE", message: expect.stringContaining("auth_failed") });
    const partial = fakeMcp(() => ({ ok: true, result: { model: "jev-test", usage: null, answers: { overall: { type: "choice", choice: "looks_ready", confidence: 0.9, probabilities: {} } } } }));
    await expect(jevReview(ws, id, { cwd: dir }, partial.open)).rejects.toMatchObject({ code: "EXTERNAL_FAILURE" });
    expect(envelope.closed() + partial.closed()).toBe(2);
    expect(ws.store.detail(id).comments).toHaveLength(comments);

    const notReview = ws.store.create({ title: "y", status: "ready" }, "human:x");
    await expect(jevReview(ws, notReview.id, { cwd: dir }, envelope.open)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    ws.close();
  });

  it("onSubmit runs the review after submit, fails open, and starts nothing when off", async () => {
    for (const onSubmit of [true, false]) {
      const ctx = repo({ jev: { path: jevCheckout(), onSubmit } } as never);
      const t = ctx.ws.store.create({ title: "Auto", status: "ready", acceptance: ["x"] }, "human:x");
      claimTicket(ctx.ws, t.id, "claude:a");
      ctx.ws.store.comment(t.id, "handoff", "done", "claude:a");
      const mcp = fakeMcp(jevAnswers((_q, keys) => keys[0]));
      const res = await submitTicket(ctx.ws, t.id, "claude:a", { skipDod: true, cwd: ctx.dir, jevOpen: mcp.open });
      expect(res.ticket.status).toBe("review");
      expect(mcp.spawns).toHaveLength(onSubmit ? 1 : 0);
      expect(res.jev?.verdict).toBe(onSubmit ? "looks_ready" : undefined);
      expect(ctx.ws.store.detail(t.id).comments.some((c) => c.actor === "system:jev")).toBe(onSubmit);
      ctx.ws.close();
    }

    const ctx = repo({ jev: { path: jevCheckout(), onSubmit: true } } as never);
    const t = ctx.ws.store.create({ title: "Auto fail", status: "ready" }, "human:x");
    claimTicket(ctx.ws, t.id, "claude:a");
    ctx.ws.store.comment(t.id, "handoff", "done", "claude:a");
    const broken: McpOpener = async () => {
      throw new Error("uv not found");
    };
    const res = await submitTicket(ctx.ws, t.id, "claude:a", { skipDod: true, cwd: ctx.dir, jevOpen: broken });
    expect(res.ticket.status).toBe("review");
    expect(res.jev).toMatchObject({ error: expect.stringContaining("uv not found") });
    const failed = ctx.ws.store.detail(t.id, { events: 50 }).events.find((e) => e.action === "jev.failed");
    expect(failed?.payload.error).toContain("uv not found");
    ctx.ws.close();
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
    // git prints forward slashes on Windows too.
    for (const id of ids) expect(list).toContain(worktreePath(ws, id).replaceAll("\\", "/"));
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
