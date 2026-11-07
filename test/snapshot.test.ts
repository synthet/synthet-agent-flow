import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/core/config.js";
import { FlowStore } from "../src/core/store.js";
import { tempDir } from "./helpers.js";

/** A directory at the snapshot path makes every rename onto it fail, on every platform. */
function storeWithBlockedSnapshot() {
  const dir = tempDir();
  const snapshot = path.join(dir, "tickets.jsonl");
  mkdirSync(snapshot);
  return { dir, snapshot, store: FlowStore.open(":memory:", { config: defaultConfig(), snapshotPath: snapshot }) };
}

describe("snapshot writes after commit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not fail a committed operation when the snapshot cannot be written", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { store } = storeWithBlockedSnapshot();
    const t = store.create({ title: "kept", status: "ready" }, "human:x");
    expect(store.get(t.id).title).toBe("kept");
    expect(store.claim(t.id, "claude:a", {}).owner).toBe("claude:a");
    expect(warn.mock.calls.join(" ")).toContain("tickets.jsonl");
  });

  it("leaves no temporary file behind after a failed write", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { store, dir } = storeWithBlockedSnapshot();
    store.create({ title: "x", status: "ready" }, "human:x");
    expect(readdirSync(dir)).toEqual(["tickets.jsonl"]);
  });

  it("retries a failed export on the next transaction, even one that changes nothing", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { store, snapshot } = storeWithBlockedSnapshot();
    store.create({ title: "pending export", status: "ready" }, "human:x");
    rmdirSync(snapshot);
    store.tx(() => undefined);
    expect(readFileSync(snapshot, "utf8")).toContain("pending export");
  });
  it("keeps the pending export through a transaction that rolls back", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { store, snapshot } = storeWithBlockedSnapshot();
    store.create({ title: "pending export", status: "ready" }, "human:x");
    rmdirSync(snapshot);
    expect(() => store.tx(() => { throw new Error("rolled back"); })).toThrow("rolled back");
    store.tx(() => undefined);
    expect(readFileSync(snapshot, "utf8")).toContain("pending export");
  });
  it("still reports a failure from an explicit export", () => {
    const { store, snapshot } = storeWithBlockedSnapshot();
    expect(() => store.writeSnapshot(snapshot)).toThrow();
  });

  it("writes the snapshot as usual when nothing is in the way", () => {
    const snapshot = path.join(tempDir(), "tickets.jsonl");
    const store = FlowStore.open(":memory:", { config: defaultConfig(), snapshotPath: snapshot });
    store.create({ title: "written", status: "ready" }, "human:x");
    expect(readFileSync(snapshot, "utf8")).toContain("written");
  });
});
