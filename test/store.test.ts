import { describe, expect, it } from "vitest";
import path from "node:path";
import { FlowError } from "../src/core/errors.js";
import { FlowStore } from "../src/core/store.js";
import { actionForMove } from "../src/core/states.js";
import { Clock, makeStore, tempDir } from "./helpers.js";

const A = "claude:agent-a";
const B = "codex:agent-b";
const H = "human:dmn";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as FlowError).code;
  }
  return undefined;
}

describe("ready queue", () => {
  it("orders by expedite lane, then priority, and hides blocked tickets", () => {
    const { store } = makeStore();
    const low = store.create({ title: "low", priority: "p3", status: "ready" }, H);
    const high = store.create({ title: "high", priority: "p1", status: "ready" }, H);
    const hot = store.create({ title: "hotfix", priority: "p2", lane: "expedite", status: "ready" }, H);
    const dep = store.create({ title: "depends", priority: "p0", status: "ready", depends_on: [low.id] }, H);
    store.create({ title: "backlogged", priority: "p0" }, H);
    expect(store.ready().map((t) => t.title)).toEqual(["hotfix", "high", "low"]);
    expect(store.get(dep.id).blocked_by).toEqual([low.id]);
    expect(hot.lane).toBe("expedite");
    void high;
  });

  it("unblocks dependents when the blocker is done", () => {
    const { store } = makeStore({ requireReview: false, requireHandoff: false });
    const a = store.create({ title: "a", status: "ready" }, H);
    const b = store.create({ title: "b", status: "ready", depends_on: [a.id] }, H);
    expect(store.ready().map((t) => t.id)).toEqual([a.id]);
    store.claim(a.id, A);
    store.transition(a.id, "close", A);
    expect(store.ready().map((t) => t.id)).toEqual([b.id]);
  });

  it("filters by label and skill routing", () => {
    const { store } = makeStore();
    store.create({ title: "ok", status: "ready", labels: ["agent-ok"] }, H);
    store.create({ title: "fe", status: "ready", labels: ["agent-ok", "skill:frontend"] }, H);
    store.create({ title: "no", status: "ready" }, H);
    expect(store.ready({ label: "agent-ok" }).map((t) => t.title)).toEqual(["ok", "fe"]);
    expect(store.ready({ label: "agent-ok", skills: ["backend"] }).map((t) => t.title)).toEqual(["ok"]);
  });
});

describe("claims and leases", () => {
  it("claims atomically; a second claimer gets CLAIM_CONFLICT", () => {
    const dir = tempDir();
    const file = path.join(dir, "flow.db");
    const { store: one, clock } = makeStore({}, file);
    // A genuinely separate connection to the same file, sharing the test clock.
    const other = FlowStore.open(file, { config: one.config, now: clock.now });
    const t = one.create({ title: "contended", status: "ready" }, H);
    expect(one.claim(t.id, A).owner).toBe(A);
    expect(code(() => other.claim(t.id, B))).toBe("CLAIM_CONFLICT");
    one.close();
    other.close();
  });

  it("claim --next skips tickets another connection already took", () => {
    const dir = tempDir();
    const file = path.join(dir, "flow.db");
    const { store: one, clock } = makeStore({}, file);
    const other = FlowStore.open(file, { config: one.config, now: clock.now });
    one.create({ title: "first", status: "ready", priority: "p0" }, H);
    one.create({ title: "second", status: "ready", priority: "p1" }, H);
    const a = one.claim(null, A);
    const b = other.claim(null, B);
    expect(a.title).toBe("first");
    expect(b.title).toBe("second");
    expect(code(() => other.claim(null, "claude:c"))).toBe("NOT_FOUND");
    one.close();
    other.close();
  });

  it("enforces per-agent WIP", () => {
    const { store } = makeStore();
    store.create({ title: "1", status: "ready" }, H);
    store.create({ title: "2", status: "ready" }, H);
    store.claim(null, A);
    expect(code(() => store.claim(null, A))).toBe("WIP_LIMIT");
  });

  it("reaps expired leases back to ready and counts the attempt", () => {
    const { store, clock } = makeStore({ leaseMinutes: 10 });
    const t = store.create({ title: "x", status: "ready" }, H);
    store.claim(t.id, A);
    clock.advance(5);
    store.heartbeat(t.id, A);
    clock.advance(9);
    expect(store.reap()).toEqual([]);
    clock.advance(2);
    expect(store.reap()).toEqual([t.id]);
    const after = store.get(t.id);
    expect(after.status).toBe("ready");
    expect(after.owner).toBeNull();
    expect(after.attempts).toBe(1);
    expect(store.claim(null, B).id).toBe(t.id);
  });

  it("refuses to claim blocked or epic tickets", () => {
    const { store } = makeStore();
    const a = store.create({ title: "a", status: "ready" }, H);
    const b = store.create({ title: "b", status: "ready", depends_on: [a.id] }, H);
    const epic = store.create({ title: "epic", type: "epic", status: "ready" }, H);
    expect(code(() => store.claim(b.id, A))).toBe("BLOCKED_BY_DEPENDENCY");
    expect(code(() => store.claim(epic.id, A))).toBe("INVALID_ARGUMENT");
  });
});

describe("lifecycle gates", () => {
  function claimed() {
    const ctx = makeStore();
    const t = ctx.store.create({ title: "feature", status: "ready", acceptance: ["returns 200", "rejects bad input"] }, H);
    ctx.store.claim(t.id, A);
    ctx.store.transition(t.id, "start", A);
    return { ...ctx, id: t.id };
  }

  it("rejects illegal transitions", () => {
    const { store } = makeStore();
    const t = store.create({ title: "x" }, H);
    expect(code(() => store.transition(t.id, "approve", H))).toBe("INVALID_TRANSITION");
    expect(code(() => store.transition(t.id, "start", A))).toBe("INVALID_TRANSITION");
  });

  it("submit requires a handoff note; approve requires verified AC and a different actor", () => {
    const { store, id } = claimed();
    expect(code(() => store.transition(id, "submit", A))).toBe("GATE_FAILED");
    store.comment(id, "handoff", "implemented endpoint; tests in test/orders.test.ts", A);
    expect(code(() => store.transition(id, "submit", B))).toBe("NOT_OWNER");
    expect(store.transition(id, "submit", A).status).toBe("review");
    expect(code(() => store.transition(id, "approve", A))).toBe("GATE_FAILED"); // self-approval
    expect(code(() => store.transition(id, "approve", B))).toBe("GATE_FAILED"); // AC unverified
    expect(code(() => store.verifyAcceptance(id, "AC-1", "Verified", "", B))).toBe("INVALID_ARGUMENT");
    store.verifyAcceptance(id, "AC-1", "Verified", "npm test: orders 200 ok", B);
    store.verifyAcceptance(id, "AC-2", "Verified", "npm test: 400 on bad page", B);
    const done = store.transition(id, "approve", B);
    expect(done.status).toBe("done");
    expect(done.closed_at).not.toBeNull();
  });

  it("failed DoD blocks submit", () => {
    const { store, id } = claimed();
    store.comment(id, "handoff", "done", A);
    expect(code(() => store.transition(id, "submit", A, { dod: { passed: false, summary: "npm test: 2 failing" } }))).toBe("GATE_FAILED");
  });

  it("escalates to needs-human after maxAttempts rejections", () => {
    const { store, id } = claimed();
    for (let i = 0; i < 3; i++) {
      store.comment(id, "handoff", `attempt ${i}`, A);
      store.transition(id, "submit", A);
      store.transition(id, "reject", B, { reason: `missing tests ${i}` });
    }
    const t = store.get(id);
    expect(t.status).toBe("blocked");
    expect(t.labels).toContain("needs-human");
    expect(t.rework_count).toBe(3);
    expect(store.events({ ticketId: id }).some((e) => e.action === "ticket.escalated")).toBe(true);
  });

  it("block/unblock keeps the owner", () => {
    const { store, id } = claimed();
    expect(code(() => store.transition(id, "block", A))).toBe("INVALID_ARGUMENT");
    store.transition(id, "block", A, { reason: "waiting for API key", unblockCondition: "key in vault" });
    expect(store.get(id).unblock_condition).toBe("key in vault");
    const t = store.transition(id, "unblock", H);
    expect(t.status).toBe("in_progress");
    expect(t.owner).toBe(A);
  });

  it("only human/system actors may force", () => {
    const { store, id } = claimed();
    expect(code(() => store.transition(id, "submit", A, { force: true }))).toBe("UNAUTHORIZED");
    expect(store.transition(id, "submit", H, { force: true }).status).toBe("review");
  });
});

describe("dependencies and epics", () => {
  it("rejects cycles", () => {
    const { store } = makeStore();
    const a = store.create({ title: "a" }, H);
    const b = store.create({ title: "b", depends_on: [a.id] }, H);
    const c = store.create({ title: "c", depends_on: [b.id] }, H);
    expect(code(() => store.addDep(a.id, c.id, "blocks", H))).toBe("CYCLE");
    expect(code(() => store.addDep(a.id, a.id, "blocks", H))).toBe("CYCLE");
  });

  it("rolls epics up from their children", () => {
    const { store } = makeStore({ requireReview: false, requireHandoff: false });
    const epic = store.create({ title: "Orders v2", type: "epic" }, H);
    const k1 = store.create({ title: "k1", status: "ready", parent: epic.id }, H);
    const k2 = store.create({ title: "k2", status: "ready", parent: epic.id }, H);
    store.claim(k1.id, A);
    expect(store.get(epic.id).status).toBe("in_progress");
    store.transition(k1.id, "close", A);
    store.claim(k2.id, A);
    store.transition(k2.id, "close", A);
    expect(store.get(epic.id).status).toBe("done");
    expect(store.list({ epic: epic.id }).length).toBe(2);
  });

  it("discovered work links back and leaves a note", () => {
    const { store } = makeStore();
    const a = store.create({ title: "a" }, H);
    const found = store.create({ title: "flaky test", discovered_from: a.id }, A);
    const d = store.detail(a.id);
    expect(d.dependents.find((x) => x.id === found.id)?.kind).toBe("discovered-from");
    expect(d.comments.at(-1)?.body).toContain(found.id);
  });
});

describe("audit log and snapshot", () => {
  it("hash chain verifies and tampering is detected", () => {
    const { store } = makeStore();
    const t = store.create({ title: "x", status: "ready" }, H);
    store.claim(t.id, A);
    expect(store.verifyAudit().ok).toBe(true);
    expect(() => store.db.exec("UPDATE events SET actor = 'evil' WHERE seq = 1")).toThrow(/append-only/);
    // Bypass the trigger to simulate offline tampering.
    store.db.exec("DROP TRIGGER events_no_update");
    store.db.exec("UPDATE events SET actor = 'evil' WHERE seq = 1");
    expect(store.verifyAudit()).toMatchObject({ ok: false, broken_at: 1 });
  });

  it("exports deterministic JSONL and round-trips through import", () => {
    const clock = new Clock();
    const { store } = makeStore({}, undefined, clock);
    const epic = store.create({ title: "E", type: "epic" }, H);
    const a = store.create({ title: "A", status: "ready", parent: epic.id, acceptance: ["works"], labels: ["b", "a"] }, H);
    store.create({ title: "B", depends_on: [a.id] }, H);
    store.comment(a.id, "note", "context", H);
    const first = store.exportSnapshot();
    expect(store.exportSnapshot()).toBe(first);
    expect(first.trim().split("\n")).toHaveLength(3);
    const { store: fresh } = makeStore({}, undefined, clock);
    expect(fresh.importSnapshot(first, "system:test")).toEqual({ inserted: 3, updated: 0, skipped: 0 });
    expect(fresh.exportSnapshot()).toBe(first);
    expect(fresh.importSnapshot(first, "system:test")).toEqual({ inserted: 0, updated: 0, skipped: 3 });
    expect(fresh.get(a.id).parent).toBe(epic.id);
  });

  it("external_key makes create idempotent", () => {
    const { store } = makeStore();
    const a = store.create({ title: "T-1", external_key: "spec.md#T-1" }, H);
    const b = store.create({ title: "T-1 again", external_key: "spec.md#T-1" }, H);
    expect(b.id).toBe(a.id);
  });
});

describe("board moves", () => {
  it("maps column drags to actions", () => {
    expect(actionForMove("ready", "claimed")).toBe("claim");
    expect(actionForMove("review", "done")).toBe("approve");
    expect(actionForMove("review", "in_progress")).toBe("reject");
    expect(actionForMove("blocked", "ready")).toBe("unblock");
    expect(actionForMove("backlog", "done")).toBeNull();
  });
});
