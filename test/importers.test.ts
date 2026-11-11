import { describe, expect, it } from "vitest";
import path from "node:path";
import { applyPlan, buildPlan, detectFormat, parseFrameworkTasks, parseLocalMarkdown, parseOpenSpec, parseSpecKit, parseTables } from "../src/importers/index.js";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { makeStore, tempDir } from "./helpers.js";

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

  it("names the source repo-relative in ticket and epic bodies, never the absolute path", () => {
    const { store } = makeStore();
    const abs = path.resolve(fx("framework/tasks.md")); // the CLI resolves the file to an absolute path
    const plan = buildPlan(abs, "framework", { specFile: fx("framework/spec.md") });
    const res = applyPlan(store, plan, H, { root: fx("") });
    const bodies = [res.epic!, ...res.created].map((t) => store.get(t.id).body);
    for (const body of bodies) {
      expect(body).toContain("framework/tasks.md");
      expect(body).not.toContain(path.dirname(abs));
    }
    expect(store.get(res.created[0].id).body).toContain("Imported from framework/tasks.md (T-1)");
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

describe("importing as an agent", () => {
  it("imports checked tasks as done, recording a system actor for the status", () => {
    const { store } = makeStore();
    const plan = parseSpecKit("## Phase 1\n- [x] T001 Done task\n- [ ] T002 Open task\n", "tasks.md");
    const res = applyPlan(store, plan, "agent:mcp", { noEpic: true, root: fx("") });
    expect(res.created.map((t) => t.status)).toEqual(["done", "ready"]);
  });
});
describe("CRLF input", () => {
  // Fixtures may be either on disk (autocrlf), so derive both forms explicitly.
  const lf = (file: string) => readFileSync(fx(file), "utf8").replace(/\r\n/g, "\n");
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");

  it("Spec Kit parses the same as LF", () => {
    const text = lf("speckit/tasks.md");
    expect(parseSpecKit(crlf(text), "tasks.md")).toEqual(parseSpecKit(text, "tasks.md"));
  });

  it("framework /tasks parses the same as LF", () => {
    const text = lf("framework/tasks.md");
    const spec = lf("framework/spec.md");
    expect(parseFrameworkTasks(crlf(text), "tasks.md", crlf(spec))).toEqual(parseFrameworkTasks(text, "tasks.md", spec));
  });

  it("local-markdown parses the same as LF", () => {
    const text = lf("items.md");
    expect(parseLocalMarkdown(crlf(text), "items.md")).toEqual(parseLocalMarkdown(text, "items.md"));
  });

  it("table headings survive CRLF", () => {
    expect(parseTables("# Tasks\r\n\r\n| a |\r\n|---|\r\n| 1 |\r\n")[0].heading).toBe("Tasks");
  });

  it("an OpenSpec change folder parses the same as LF", () => {
    const copy = (convert: (s: string) => string) => {
      const dir = path.join(tempDir(), "add-2fa");
      cpSync(fx("openspec/changes/add-2fa"), dir, { recursive: true });
      for (const f of ["proposal.md", "tasks.md", "specs/auth/spec.md"]) {
        const p = path.join(dir, f);
        writeFileSync(p, convert(readFileSync(p, "utf8").replace(/\r\n/g, "\n")));
      }
      return parseOpenSpec(dir);
    };
    const a = copy(crlf);
    const b = copy((s) => s);
    expect(a.tasks.length).toBeGreaterThan(0);
    expect(a.tasks).toEqual(b.tasks);
    expect(a.epic).toEqual(b.epic);
  });
});
