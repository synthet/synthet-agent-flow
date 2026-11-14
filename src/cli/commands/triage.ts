import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FlowError } from "../../core/errors.js";
import { bool, int, list, register, str } from "../registry.js";

const readJson = <T>(file: string): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    throw new FlowError("INVALID_ARGUMENT", `cannot read ${path.basename(file)}: ${(e as Error).message.slice(0, 120)}`);
  }
};
const writeJson = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
const num = (v: unknown): number | undefined => (typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const need = (v: unknown, flag: string): string => {
  const s = str(v);
  if (!s) throw new FlowError("INVALID_ARGUMENT", `triage needs --${flag}`);
  return s;
};

register({
  name: "triage",
  group: "tickets",
  summary: "Stale-ticket housekeeping: scan | describe | jev | decide | apply | verify | restore (docs/housekeeping-protocol.md)",
  usage: [
    "triage scan (--root dir | --repo dir) --out plan.json [--source tickets|github [--owner login,...]] [--stale-days 30 (github: 60)] [--blocked-days 14] [--review-days 7]",
    "triage describe --plan plan.json --swarm <dist/index.js> [--harness claude] [--max-items 40] [--budget-usd n] [--dry-run]",
    "triage jev --plan plan.json",
    "triage decide --plan plan.json --answers answers.json [--min-confidence 0.5]",
    "triage apply --plan plan.json [--apply] [--approve T0001,T0002 --approval-note '...'] [--actor housekeeping:<run>]",
    "triage verify|restore --manifest manifest.json",
  ].join("\n       "),
  options: {
    root: { type: "string" },
    source: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    out: { type: "string" },
    plan: { type: "string" },
    answers: { type: "string" },
    manifest: { type: "string" },
    swarm: { type: "string" },
    harness: { type: "string" },
    approve: { type: "string" },
    "approval-note": { type: "string" },
    "min-confidence": { type: "string" },
    "max-items": { type: "string" },
    "budget-usd": { type: "string" },
    "timeout-ms": { type: "string" },
    "stale-days": { type: "string" },
    "blocked-days": { type: "string" },
    "review-days": { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
  },
  async run(ctx) {
    const t = await import("../../integrations/triage.js");
    const [step = ""] = ctx.positionals;
    const v = ctx.values;
    switch (step) {
      case "scan": {
        const out = need(v.out, "out");
        const source = str(v.source) ?? "tickets";
        if (source !== "tickets" && source !== "github") throw new FlowError("INVALID_ARGUMENT", "--source must be tickets or github");
        const plan = source === "github" ? await scanGithub(v) : await t.scanTriage({
          root: str(v.root) && path.resolve(str(v.root) as string),
          repo: str(v.repo),
          rules: { staleDays: int(v["stale-days"]), blockedDays: int(v["blocked-days"]), reviewDays: int(v["review-days"]) },
        });
        writeJson(out, plan);
        const counts: Record<string, number> = {};
        for (const it of plan.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
        const summary = { plan: out, repos: plan.repos.length, items: plan.items.length, by_status: counts, repo_errors: plan.repos.filter((r) => r.error) };
        return ctx.print(summary, () => `${plan.items.length} stale tickets across ${plan.repos.length} repos → ${out}`);
      }
      case "describe": {
        const file = need(v.plan, "plan");
        const swarm = str(v.swarm) ?? process.env.AGENT_FLOW_SWARM_ENTRY;
        if (!swarm && !bool(v["dry-run"])) {
          ctx.print({ ok: false, error: "no swarm: pass --swarm <synthet-agent-swarm>/agent-orchestrator/dist/index.js" });
          return 3;
        }
        const plan = readJson<Awaited<ReturnType<typeof t.scanTriage>>>(file);
        const res = await t.describeTriage(plan, {
          swarm,
          harness: str(v.harness),
          maxItems: int(v["max-items"]),
          budgetUsd: num(v["budget-usd"]),
          timeoutMs: int(v["timeout-ms"]),
          dryRun: bool(v["dry-run"]),
        });
        writeJson(file, plan);
        ctx.print(res, () => `described ${res.described}, undescribed ${res.undescribed.length}`);
        return res.undescribed.length && !bool(v["dry-run"]) ? 1 : 0;
      }
      case "jev": {
        const payload = t.jevPayload(readJson(need(v.plan, "plan")));
        return ctx.print(payload, () => JSON.stringify(payload, null, 1));
      }
      case "decide": {
        const file = need(v.plan, "plan");
        const plan = readJson<Awaited<ReturnType<typeof t.scanTriage>>>(file);
        const res = t.decideTriage(plan, readJson(need(v.answers, "answers")), num(v["min-confidence"]) ?? 0.5);
        writeJson(file, plan);
        return ctx.print(res, () => `held ${res.held.length}; needs approval: ${res.needs_owner_approval.join(", ") || "none"}`);
      }
      case "apply": {
        const file = need(v.plan, "plan");
        const plan = readJson<Awaited<ReturnType<typeof t.scanTriage>>>(file);
        const res = t.applyTriage(plan, {
          apply: bool(v.apply),
          actor: ctx.actor,
          approve: list(v.approve),
          approvalNote: str(v["approval-note"]) ?? null,
          planFile: file,
        });
        const g = await import("../../integrations/triage-github.js");
        const issues = await g.applyIssues(plan, { apply: bool(v.apply), approve: list(v.approve) });
        if (issues.done.length) res.manifest.issues = issues.done;
        res.manifest.skipped.push(...issues.skipped);
        res.log.push(...issues.log);
        let manifestFile: string | undefined;
        if (!res.dry_run && (res.manifest.tickets.length || res.manifest.issues?.length || res.manifest.skipped.length)) {
          manifestFile = path.join(path.dirname(file), `manifest-triage-${res.manifest.applied.replace(/[:.]/g, "")}.json`);
          writeJson(manifestFile, res.manifest);
        }
        const out = { dry_run: res.dry_run, applied: res.manifest.tickets.length + (res.manifest.issues?.length ?? 0), skipped: res.manifest.skipped, manifest: manifestFile, log: res.log };
        ctx.print(out, () => res.log.join("\n") || "nothing to do");
        return res.manifest.skipped.length && !res.dry_run ? 1 : 0;
      }
      case "verify": {
        const manifest = readJson<ReturnType<typeof t.applyTriage>["manifest"]>(need(v.manifest, "manifest"));
        const g = await import("../../integrations/triage-github.js");
        const base = t.verifyTriage(manifest);
        const problems = [...base.problems, ...(await g.verifyIssues(manifest.issues ?? []))];
        const res = { ok: problems.length === 0, problems };
        ctx.print(res, () => (res.ok ? "ok" : res.problems.join("\n")));
        return res.ok ? 0 : 1;
      }
      case "restore": {
        const manifest = readJson<ReturnType<typeof t.applyTriage>["manifest"]>(need(v.manifest, "manifest"));
        const g = await import("../../integrations/triage-github.js");
        const lines = [...t.restoreTriage(manifest), ...g.restoreIssues(manifest.issues ?? [])];
        return ctx.print({ commands: lines }, () => lines.join("\n"));
      }
      default:
        throw new FlowError("INVALID_ARGUMENT", "usage: triage scan|describe|jev|decide|apply|verify|restore");
    }
  },
});

async function scanGithub(v: Record<string, unknown>) {
  const { TOOL } = await import("../../integrations/triage.js");
  const g = await import("../../integrations/triage-github.js");
  const root = str(v.root);
  const found = await g.scanIssues({ root: root && path.resolve(root), repo: str(v.repo), staleDays: int(v["stale-days"]), owners: list(v.owner) });
  found.items.forEach((it, i) => (it.id = `T${String(i + 1).padStart(4, "0")}`));
  return { tool: TOOL, version: 1 as const, root: path.resolve(root ?? str(v.repo) ?? "."), scanned: new Date().toISOString(), ...found };
}
