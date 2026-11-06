import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, type FlowConfig } from "../src/core/config.js";
import { FlowStore } from "../src/core/store.js";

export function tempDir(prefix = "af-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export class Clock {
  t = Date.parse("2026-11-06T12:00:00Z");
  now = () => this.t;
  advance(minutes: number) {
    this.t += minutes * 60_000;
  }
}

export function makeStore(over: Partial<FlowConfig> = {}, file?: string, clock = new Clock()) {
  const config = defaultConfig({ requireHandoff: true, ...over });
  const store = FlowStore.open(file ?? ":memory:", { config, now: clock.now });
  return { store, clock, config };
}
