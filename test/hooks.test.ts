import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runHook, statusLine, writeLoop, readLoop } from "../src/hooks/index.js";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { claimTicket } from "../src/core/service.js";
import { tempDir } from "./helpers.js";

const SID = "abcd1234-ffff-0000";
const ACTOR = "claude:abcd1234";
const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra }) as NodeJS.ProcessEnv;

function repo() {
  const dir = tempDir("af-hook-");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  initWorkspace(dir);
  return { dir, git };
}

const hook = (event: string, payload: Record<string, unknown>, e = env()) => runHook(event, JSON.stringify(payload), e);

describe("hooks", () => {
  it("fails open on garbage stdin and outside initialised repos", async () => {
    expect(await runHook("session-start", "not json")).toEqual({ stdout: "{}", code: 0 });
    const bare = tempDir();
    expect((await hook("pre-tool", { cwd: bare, tool_name: "Bash", tool_input: { command: "git push --force" } })).stdout).toBe("{}");
  });

  it("session-start injects the ready queue, actor id, and persists AGENT_FLOW_ACTOR", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    ws.store.create({ title: "Ready one", status: "ready" }, "human:x");
    ws.close();
    const envFile = path.join(tempDir(), "env.sh");
    writeFileSync(envFile, "");
    const res = await hook("session-start", { cwd: dir, session_id: SID, source: "startup", transcript_path: "/tmp/t.jsonl" }, env({ CLAUDE_ENV_FILE: envFile }));
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("Ready one");
    expect(out.hookSpecificOutput.additionalContext).toContain(ACTOR);
    expect(readFileSync(envFile, "utf8")).toBe(`export AGENT_FLOW_ACTOR=${ACTOR}\n`);
  });

  it("session-start binds the ticket from the branch and shows spec + AC + handoff", async () => {
    const { dir, git } = repo();
    const ws = openWorkspace(dir);
    const t = ws.store.create({ title: "Bound", status: "ready", body: "Do the thing", acceptance: ["thing done"] }, "human:x");
    const c = claimTicket(ws, t.id, ACTOR);
    ws.store.comment(t.id, "handoff", "halfway there", ACTOR);
    ws.close();
    git("switch", "-q", "-c", c.branch!);
    const out = JSON.parse((await hook("session-start", { cwd: dir, session_id: SID, source: "compact" })).stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(`Current ticket: ${t.id}`);
    expect(ctx).toContain("Do the thing");
    expect(ctx).toContain("AC-1: thing done");
    expect(ctx).toContain("halfway there");
  });

  it("pre-tool denies force-push, pushes to main, rm -rf outside the worktree; never allows", async () => {
    const { dir } = repo();
    const run = async (command: string) => JSON.parse((await hook("pre-tool", { cwd: dir, session_id: SID, tool_name: "Bash", tool_input: { command } })).stdout);
    expect((await run("git push --force origin af/x")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await run("git push origin main")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await run("git push")).hookSpecificOutput.permissionDecision).toBe("deny"); // on main
    expect((await run("rm -rf /")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await run("rm -rf ../other")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await run("rm -rf node_modules")).toEqual({});
    expect(await run("git push -u origin af/af-12345-x")).toEqual({});
    expect(await run("git push --force-with-lease origin af/af-12345-x")).toEqual({});
    const other = await hook("pre-tool", { cwd: dir, tool_name: "Edit", tool_input: { file_path: "x" } });
    expect(other.stdout).toBe("{}");
  });

  it("pre-tool resolves symlinks before the rm -r worktree check (macOS /var → /private/var)", async () => {
    const { dir } = repo();
    const link = path.join(tempDir("af-link-"), "repo-link");
    symlinkSync(dir, link, "junction"); // Windows only: junctions need no privilege. Other platforms ignore the type.
    const run = async (command: string) => JSON.parse((await hook("pre-tool", { cwd: link, session_id: SID, tool_name: "Bash", tool_input: { command } })).stdout);
    expect(await run("rm -rf node_modules")).toEqual({});
    expect(await run("rm -rf build/out")).toEqual({});
    expect((await run("rm -rf ../other")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it.runIf(process.platform === "win32")("pre-tool expands 8.3 short paths before the rm -r worktree check", async () => {
    const { dir } = repo();
    const short = execFileSync("cmd", ["/d", "/s", "/c", `"for %I in ("${dir}") do @echo %~sI"`], { encoding: "utf8", windowsVerbatimArguments: true }).trim();
    expect(short).not.toBe(dir); // this volume must generate 8.3 names, or the test proves nothing
    const run = async (command: string) => JSON.parse((await hook("pre-tool", { cwd: short, session_id: SID, tool_name: "Bash", tool_input: { command } })).stdout);
    expect(await run("rm -rf node_modules")).toEqual({});
    expect((await run("rm -rf ../other")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("init keeps tickets.jsonl LF when git checks it out with autocrlf", () => {
    const { dir, git } = repo();
    const ws = openWorkspace(dir);
    ws.store.create({ title: "Snapshot line", status: "ready" }, "human:x");
    ws.close();
    git("config", "core.autocrlf", "true");
    git("add", "-A");
    git("commit", "-q", "-m", "flow");
    const snapshot = path.join(dir, ".agent-flow", "tickets.jsonl");
    rmSync(snapshot);
    git("checkout", "--", ".agent-flow/tickets.jsonl");
    const text = readFileSync(snapshot, "utf8");
    expect(text).toContain("Snapshot line");
    expect(text).not.toContain("\r");
  });

  it("pre-tool enforces WIP before a second claim", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    ws.store.create({ title: "a", status: "ready" }, "human:x");
    ws.store.create({ title: "b", status: "ready" }, "human:x");
    claimTicket(ws, null, ACTOR);
    ws.close();
    const out = JSON.parse((await hook("pre-tool", { cwd: dir, session_id: SID, tool_name: "Bash", tool_input: { command: "agent-flow claim --next" } })).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("WIP");
  });

  it("post-tool moves claimed → in_progress on the first real commit", async () => {
    const { dir, git } = repo();
    const ws = openWorkspace(dir);
    const t = ws.store.create({ title: "Commit me", status: "ready" }, "human:x");
    const c = claimTicket(ws, t.id, ACTOR);
    ws.close();
    git("switch", "-q", "-c", c.branch!);
    writeFileSync(path.join(dir, "a.txt"), "x");
    git("add", "a.txt");
    git("commit", "-q", "-m", "feat: a");
    const res = JSON.parse((await hook("post-tool", { cwd: dir, session_id: SID, tool_name: "Bash", tool_input: { command: "git commit -m 'feat: a'" }, tool_response: { stdout: "", stderr: "", interrupted: false } })).stdout);
    expect(res.hookSpecificOutput.additionalContext).toContain("in_progress");
    const ws2 = openWorkspace(dir);
    expect(ws2.store.get(t.id).status).toBe("in_progress");
    expect(ws2.store.sessions(t.id)[0].commit_range).toMatch(/^[0-9a-f]{7,}$/);
    ws2.close();
    // A second post-tool without a new commit is a no-op.
    expect((await hook("post-tool", { cwd: dir, session_id: SID, tool_name: "Bash", tool_input: { command: "git commit -m again" } })).stdout).toBe("{}");
  });

  it("post-tool reminds once per session when committing or opening a PR without a ticket", async () => {
    const { dir, git } = repo();
    const bash = (event: string, command: string, sid = SID) =>
      hook(event, { cwd: dir, session_id: sid, tool_name: "Bash", tool_input: { command }, tool_response: { interrupted: false } });
    const commit = async (file: string, sid = SID) => {
      await bash("pre-tool", `git commit -m ${file}`, sid);
      writeFileSync(path.join(dir, file), "x");
      git("add", file);
      git("commit", "-q", "-m", file);
      return JSON.parse((await bash("post-tool", `git commit -m ${file}`, sid)).stdout);
    };
    const first = await commit("a.txt");
    expect(first.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(first.hookSpecificOutput.additionalContext).toContain("you hold no ticket");
    expect(first.hookSpecificOutput.additionalContext).toContain("Refs <id>");
    expect(first.hookSpecificOutput.permissionDecision).toBeUndefined();
    // Once per session: a second untracked commit stays silent.
    expect(await commit("b.txt")).toEqual({});
    // A commit that didn't happen (HEAD unchanged) never nudges.
    await bash("pre-tool", "git commit -m nothing", "other-session-1");
    expect((await bash("post-tool", "git commit -m nothing", "other-session-1")).stdout).toBe("{}");
    // Opening a PR nudges in a new session; unrelated commands don't.
    expect((await bash("post-tool", "ls -la", "other-session-2")).stdout).toBe("{}");
    const pr = JSON.parse((await bash("post-tool", "gh pr create --fill", "other-session-2")).stdout);
    expect(pr.hookSpecificOutput.additionalContext).toContain("you hold no ticket");
  });

  it("post-tool stays silent about untracked work when the actor holds a ticket or the nudge is off", async () => {
    const held = repo();
    const ws = openWorkspace(held.dir);
    const t = ws.store.create({ title: "Held", status: "ready" }, "human:x");
    const c = claimTicket(ws, t.id, ACTOR);
    ws.close();
    held.git("switch", "-q", "-c", c.branch!);
    const pr = (await hook("post-tool", { cwd: held.dir, session_id: SID, tool_name: "Bash", tool_input: { command: "gh pr create --fill" } })).stdout;
    expect(pr).not.toContain("you hold no ticket");

    const dir = tempDir("af-hook-off-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    initWorkspace(dir, { hooks: { untrackedNudge: false } } as never);
    expect((await hook("post-tool", { cwd: dir, session_id: SID, tool_name: "Bash", tool_input: { command: "gh pr create --fill" } })).stdout).toBe("{}");
  });

  it("stop nudges once for a missing handoff and honours stop_hook_active", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    const t = ws.store.create({ title: "Held", status: "ready" }, "human:x");
    claimTicket(ws, t.id, ACTOR);
    ws.close();
    const first = JSON.parse((await hook("stop", { cwd: dir, session_id: SID, stop_hook_active: false })).stdout);
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("handoff");
    expect((await hook("stop", { cwd: dir, session_id: SID, stop_hook_active: true })).stdout).toBe("{}");
  });

  it("loop mode: blocks while ready work remains, stops on STOP file, cap, or StopFailure", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    ws.store.create({ title: "loop 1", status: "ready", labels: ["agent-ok"] }, "human:x");
    ws.store.create({ title: "not for agents", status: "ready" }, "human:x");
    writeLoop(ws, { active: true, started_at: new Date(Date.now() - 1000).toISOString(), max_tickets: 2, label: "agent-ok", actor: ACTOR });
    ws.close();
    const go = JSON.parse((await hook("stop", { cwd: dir, session_id: SID, stop_hook_active: false })).stdout);
    expect(go.decision).toBe("block");
    expect(go.reason).toContain("loop 1");
    // No progress since the last continuation → let it stop and deactivate.
    expect((await hook("stop", { cwd: dir, session_id: SID, stop_hook_active: true })).stdout).toBe("{}");
    const ws2 = openWorkspace(dir);
    expect(readLoop(ws2)?.active).toBe(false);
    // Re-arm, then the STOP file halts it.
    writeLoop(ws2, { active: true, started_at: new Date().toISOString(), max_tickets: 2, label: "agent-ok", actor: ACTOR });
    writeFileSync(ws2.paths.stopFile, "");
    ws2.close();
    expect((await hook("stop", { cwd: dir, session_id: SID })).stdout).toBe("{}");
    const ws3 = openWorkspace(dir);
    expect(readLoop(ws3)?.halted).toBe("STOP file present");
    writeLoop(ws3, { active: true, started_at: new Date().toISOString(), max_tickets: 2, label: "agent-ok", actor: ACTOR });
    ws3.close();
    await hook("stop-failure", { cwd: dir, session_id: SID, error: "rate_limit" });
    const ws4 = openWorkspace(dir);
    expect(readLoop(ws4)?.halted).toBe("StopFailure: rate_limit");
    ws4.close();
  });

  it("session-end records the transcript pointer and flags a missing handoff", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    const t = ws.store.create({ title: "Ends", status: "ready" }, "human:x");
    claimTicket(ws, t.id, ACTOR);
    ws.close();
    await hook("session-end", { cwd: dir, session_id: SID, transcript_path: "/x/y.jsonl", reason: "prompt_input_exit" });
    const ws2 = openWorkspace(dir);
    const d = ws2.store.detail(t.id);
    expect(d.sessions[0]).toMatchObject({ transcript_path: "/x/y.jsonl", reason: "prompt_input_exit" });
    expect(d.sessions[0].ended_at).not.toBeNull();
    expect(d.comments.at(-1)?.body).toContain("without a handoff");
    ws2.close();
  });

  it("task-completed DoD gate exits 2 with the failure when enabled", async () => {
    const { dir } = repo();
    const cfgFile = path.join(dir, ".agent-flow", "config.json");
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    cfg.dod = ["echo boom && exit 3"];
    cfg.hooks = { taskCompletedDod: true };
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const res = await hook("task-completed", { cwd: dir, session_id: SID, task_id: "1", task_subject: "x" });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("boom");
  });

  it("statusline shows the bound ticket", async () => {
    const { dir } = repo();
    const ws = openWorkspace(dir);
    const t = ws.store.create({ title: "Shown", status: "ready", acceptance: ["a"] }, "human:x");
    claimTicket(ws, t.id, ACTOR);
    ws.store.create({ title: "Other", status: "ready" }, "human:x");
    ws.close();
    const line = statusLine(JSON.stringify({ session_id: SID, workspace: { current_dir: dir } }), env());
    expect(line).toContain(`${t.id} · claimed`);
    expect(line).toContain("AC 0/1");
    expect(line).toContain("ready 1");
  });
});
