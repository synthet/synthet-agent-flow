import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Runner } from "../src/integrations/exec.js";
import {
  TRIAGE_LABEL,
  applyTriage,
  decideTriage,
  describeTriage,
  jevPayload,
  needsApproval,
  restoreTriage,
  scanTriage,
  verifyTriage,
  type TriagePlan,
} from "../src/integrations/triage.js";
import { initWorkspace, openWorkspaceAt } from "../src/core/workspace.js";
import { main } from "../src/cli/main.js";
import { tempDir } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = `ghp_${"Zq9".repeat(13)}`;
const okRun: Runner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ms: 0 });

function setup() {
  const dir = tempDir("af-triage-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  initWorkspace(dir);
  const ws = openWorkspaceAt(dir);
  const s = ws.store;
  const backlog = s.create({ title: "Old idea", body: `notes with ${TOKEN}` }, "human:t");
  const ready = s.create({ title: "Old ready work", status: "ready" }, "human:t");
  const review = s.create({ title: "Waiting review", status: "ready" }, "human:t");
  s.setStatusAdmin(review.id, "review", "human:t", "test");
  const live = s.create({ title: "Being worked", status: "ready" }, "human:t");
  s.claim(live.id, "claude:x");
  const escalated = s.create({ title: "Escalated", labels: ["needs-human"] }, "human:t");
  const gone = s.create({ title: "Dropped dependency" }, "human:t");
  const waiting = s.create({ title: "Waits on dropped", depends_on: [gone.id] }, "human:t");
  s.transition(gone.id, "cancel", "human:t");
  s.writeSnapshot(ws.paths.snapshot);
  ws.close();
  return { dir, ids: { backlog: backlog.id, ready: ready.id, review: review.id, live: live.id, escalated: escalated.id, waiting: waiting.id } };
}

const later = () => Date.now() + 40 * DAY;
const byTicket = (plan: TriagePlan) => new Map(plan.items.map((i) => [i.ticket, i]));

describe("triage", () => {
  it("scan flags stale tickets from the snapshot and skips live, escalated and fresh work", async () => {
    const { dir, ids } = setup();
    const now = await scanTriage({ repo: dir, run: okRun });
    expect([...byTicket(now).keys()]).toEqual([ids.waiting]);
    expect(byTicket(now).get(ids.waiting)?.why).toContain("blocked only by cancelled tickets");

    const plan = await scanTriage({ repo: dir, run: okRun, now: later() });
    const items = byTicket(plan);
    expect(items.has(ids.backlog) && items.has(ids.ready) && items.has(ids.review)).toBe(true);
    expect(items.has(ids.live)).toBe(false);
    expect(items.has(ids.escalated)).toBe(false);
    expect(items.get(ids.review)?.options).toEqual(["flag", "keep"]);
    expect(JSON.stringify(plan)).not.toContain(TOKEN);
  });

  it("describe redacts ticket text going out and the reply coming back", async () => {
    const { dir, ids } = setup();
    const plan = await scanTriage({ repo: dir, run: okRun, now: later() });
    let request = "";
    const swarmRun: Runner = async (argv) => {
      request = readFileSync(argv[argv.indexOf("--request") + 1], "utf8");
      const reply = `Looked at it.\n${JSON.stringify({ [ids.backlog]: `superseded; key ${TOKEN}`, [ids.ready]: "still wanted" })}`;
      return { code: 0, stdout: JSON.stringify({ ok: true, reply }), stderr: "", timedOut: false, ms: 1 };
    };
    const res = await describeTriage(plan, { swarm: "swarm.js", run: swarmRun });
    expect(request).not.toContain(TOKEN);
    expect(request).toContain(ids.backlog);
    expect(res.described).toBe(2);
    const items = byTicket(plan);
    expect(items.get(ids.backlog)?.description).toContain("superseded");
    expect(items.get(ids.backlog)?.description).not.toContain(TOKEN);
    expect(jevPayload(plan).state.items).toHaveProperty(items.get(ids.backlog)!.id);
  });

  it("decide → apply (gated) → verify → restore", async () => {
    const { dir, ids } = setup();
    const plan = await scanTriage({ repo: dir, run: okRun, now: later() });
    const items = byTicket(plan);
    const id = (t: string) => items.get(t)!.id;
    const answers = {
      answers: {
        [id(ids.backlog)]: { choice: "flag", confidence: 0.9 },
        [id(ids.ready)]: { choice: "cancel", confidence: 0.8 },
        [id(ids.review)]: { choice: "cancel", confidence: 0.9 },
        [id(ids.waiting)]: { choice: "keep", confidence: 0.9 },
      },
    };
    const decided = decideTriage(plan, answers);
    expect(decided.needs_owner_approval).toEqual([id(ids.ready)]);
    expect(decided.held.sort()).toEqual([id(ids.review), id(ids.waiting)].sort());

    const dry = applyTriage(plan, { apply: false, actor: "housekeeping:t", now: later() });
    expect(dry.dry_run).toBe(true);
    expect(() => applyTriage(plan, { apply: true, actor: "human:me", now: later() })).toThrow(/agent identity/);

    const first = applyTriage(plan, { apply: true, actor: "housekeeping:t", now: later() });
    expect(first.manifest.tickets.map((t) => t.ticket)).toEqual([ids.backlog]);
    expect(first.manifest.skipped.map((s) => s.why)).toEqual([`cancel needs --approve ${id(ids.ready)}`]);
    let ws = openWorkspaceAt(dir);
    expect(ws.store.get(ids.backlog).labels).toContain(TRIAGE_LABEL);
    expect(ws.store.get(ids.ready).status).toBe("ready");
    ws.close();

    const second = applyTriage(plan, { apply: true, actor: "housekeeping:t", approve: [id(ids.ready)], approvalNote: "yes", now: later() });
    expect(second.manifest.tickets.map((t) => t.mode)).toContain("cancel");
    ws = openWorkspaceAt(dir);
    expect(ws.store.get(ids.ready).status).toBe("cancelled");
    ws.close();
    expect(verifyTriage(second.manifest).ok).toBe(true);
    expect(restoreTriage(first.manifest)[0]).toContain(`--remove-label ${TRIAGE_LABEL}`);
  });

  it("apply skips a ticket that changed after the scan", async () => {
    const { dir, ids } = setup();
    const plan = await scanTriage({ repo: dir, run: okRun, now: later() });
    const it0 = byTicket(plan).get(ids.backlog)!;
    decideTriage(plan, { answers: { [it0.id]: { choice: "flag", confidence: 0.9 } } });
    const ws = openWorkspaceAt(dir);
    ws.store.comment(ids.backlog, "note", "someone is back on it", "human:t");
    ws.close();
    const res = applyTriage(plan, { apply: true, actor: "housekeeping:t", now: later() });
    expect(res.manifest.skipped[0]?.why).toBe("ticket changed since scan");
  });

  it("a flag in a repo that mirrors to mailbox or GitHub needs approval", () => {
    const item = { notify_remote: true } as TriagePlan["items"][number];
    expect(needsApproval(item, "flag")).toBe(true);
    expect(needsApproval({ ...item, notify_remote: false }, "flag")).toBe(false);
    expect(needsApproval({ ...item, notify_remote: false }, "cancel")).toBe(true);
  });

  it("cli: scan writes a plan, describe without a swarm exits 3", async () => {
    const { dir } = setup();
    const out = path.join(dir, "plan.json");
    let stdout = "";
    const io = { stdout: (s: string) => (stdout += `${s}\n`), stderr: () => undefined };
    expect(await main(["triage", "scan", "--repo", dir, "--out", out, "--json", "-C", dir, "--actor", "claude:t"], io)).toBe(0);
    expect(JSON.parse(stdout).items).toBe(1);
    const saved = process.env.AGENT_FLOW_SWARM_ENTRY;
    delete process.env.AGENT_FLOW_SWARM_ENTRY;
    try {
      expect(await main(["triage", "describe", "--plan", out, "--json", "-C", dir, "--actor", "claude:t"], io)).toBe(3);
    } finally {
      if (saved !== undefined) process.env.AGENT_FLOW_SWARM_ENTRY = saved;
    }
  });
});
