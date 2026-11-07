import { describe, expect, it, vi } from "vitest";
import { renameWithRetry } from "../src/core/fsutil.js";

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe("renameWithRetry", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s until the rename works", (code) => {
    const sleep = vi.fn();
    const rename = vi.fn().mockImplementationOnce(() => { throw fsError(code); }).mockImplementationOnce(() => { throw fsError(code); }).mockImplementation(() => undefined);
    renameWithRetry("a", "b", { rename, sleep });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", () => {
    const rename = vi.fn(() => { throw fsError("ENOENT"); });
    expect(() => renameWithRetry("a", "b", { rename, sleep: () => undefined })).toThrow("ENOENT");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt and reports the error", () => {
    const rename = vi.fn(() => { throw fsError("EPERM"); });
    expect(() => renameWithRetry("a", "b", { rename, sleep: () => undefined, attempts: 4 })).toThrow("EPERM");
    expect(rename).toHaveBeenCalledTimes(4);
  });

  it("waits longer before each retry", () => {
    const waits: number[] = [];
    const rename = vi.fn(() => { throw fsError("EBUSY"); });
    expect(() => renameWithRetry("a", "b", { rename, sleep: (ms) => waits.push(ms), attempts: 4 })).toThrow();
    expect(waits).toEqual([...waits].sort((x, y) => x - y));
    expect(new Set(waits).size).toBe(waits.length);
  });
});
