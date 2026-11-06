import { describe, expect, it } from "vitest";
import path from "node:path";
import { applyPlan, buildPlan, detectFormat, parseLocalMarkdown } from "../src/importers/index.js";
import { readFileSync } from "node:fs";
import { makeStore } from "./helpers.js";

const fx = (p: string) => path.join(__dirname, "fixtures", p);
const H = "human:dmn";

describe("framework /tasks importer", () => {
  it("parses the T-n table, deps, scope and AC text from the spec", () => {
    const plan = buildPlan(fx("framework/tasks.md"), "auto", { specFile: fx("framework/spec.md") });
    expect(plan.format).toBe("framework");
    expect(plan.tasks.map((t) => t.key)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    const t3 = plan.tasks[2];
    expect(t3.deps).toEqual(["T-1", "T-2"]);
    expect(t3.scope_paths).toEqual(["src/server/routes/orders.ts", "src/server/services/orders.ts"]);
    expect(t3.acceptance?.map((a) => a.ac_id)).toEqual(["AC-1", "AC-2"]);
    expect(t3.acceptance?.[1].text).toContain("returns 400");
    expect(t3.labels).toEqual(["role:backend"]);
    expect(plan.epic?.title).toBe("Orders pagination");
    expect(plan.warnings).toEqual([]);
  });

  it("applies idempotently as an epic + ready tickets with blocking deps", () => {
    const { store } = makeStore();
    const plan = buildPlan(fx("framework/tasks.md"), "framework", { specFile: fx("framework/spec.md") });
    const first = applyPlan(store, plan, H, { root: fx("") });
    expect(first.created).toHaveLength(4);
    expect(first.epic?.type).toBe("epic");
    expect(store.ready().map((t) => t.title)).toEqual(["Add orders service skeleton"]);
    const again = applyPlan(store, plan, H, { root: fx("") });
    expect(again.created).toHaveLength(0);
    expect(again.existing).toHaveLength(4);
    expect(store.list({ epic: first.epic!.id })).toHaveLength(4);
    expect(store.get(first.created[0].id).spec_ref).toBe("framework/tasks.md#T-1");
  });
});

describe("Spec Kit importer", () => {
  it("models [P] groups and phases as dependencies; checked tasks import as done", () => {
    const plan = buildPlan(fx("speckit/tasks.md"));
    expect(plan.format).toBe("speckit");
    const by = Object.fromEntries(plan.tasks.map((t) => [t.key, t]));
    expect(by.T001.status).toBe("done");
    expect(by.T002.deps).toEqual(["T001"]);
    expect(by.T003.deps).toEqual(["T001"]);
    // New phase starts a new [P] group that waits for the previous group
    expect(by.T004.deps).toEqual(["T002", "T003"]);
    expect(by.T005.deps).toEqual(["T002", "T003"]);
    expect(by.T006.deps).toEqual(["T004", "T005"]);
    expect(by.T007.deps).toEqual(["T006"]);
    expect(by.T004.labels).toContain("story:US1");
    expect(by.T006.scope_paths).toEqual(["src/models/album.py"]);
    const { store } = makeStore();
    applyPlan(store, plan, H, { root: fx("") });
    expect(store.ready().map((t) => t.title).sort()).toEqual(["Configure formatting in .prettierrc", "Configure linting in .eslintrc.json"]);
  });
});

describe("OpenSpec importer", () => {
  it("reads a change folder: sections are sequential, scenarios become epic AC", () => {
    const plan = buildPlan(fx("openspec/changes/add-2fa"));
    expect(plan.format).toBe("openspec");
    expect(plan.epic?.title).toBe("Add two-factor authentication");
    expect(plan.epic?.acceptance?.map((a) => a.text)).toEqual([
      "Valid code — the login succeeds",
      "Invalid code — the login is rejected with 401",
    ]);
    const by = Object.fromEntries(plan.tasks.map((t) => [t.key, t]));
    expect(by["1.2"].deps).toEqual(["1.1"]);
    expect(by["2.1"].deps).toEqual(["1.2"]);
    expect(by["3.1"].deps).toEqual(["2.2"]);
    expect(by["2.1"].scope_paths).toEqual(["src/auth/otp.ts"]);
  });
});

describe("local-markdown backlog migration", () => {
  it("maps provider statuses; claims are not migrated", () => {
    const text = readFileSync(fx("items.md"), "utf8");
    expect(detectFormat(fx("items.md"), text)).toBe("local-markdown");
    const plan = parseLocalMarkdown(text, fx("items.md"));
    expect(plan.tasks.map((t) => t.status)).toEqual(["ready", "done", "ready"]);
    expect(plan.tasks[2].acceptance?.[0].text).toBe("smoke test runs in CI");
    expect(plan.warnings[0]).toContain("L-001");
    const { store } = makeStore();
    const res = applyPlan(store, plan, "system:import", { noEpic: true, root: fx("") });
    expect(res.created.map((t) => t.status)).toEqual(["ready", "done", "ready"]);
  });
});
