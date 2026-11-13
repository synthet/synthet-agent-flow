# Tasks: Software Factory, with agent-flow as the spine

Spec: [spec.md](spec.md). Imported as backlog, so promote a ticket when you want it worked.

| ID | Task | Owner role | Files / areas | Depends on | ACs | Verification |
|----|------|------------|---------------|------------|-----|--------------|
| T-1 | Spec Kit, OpenSpec and markdown importers keep the spec's own AC ids and text | backend | `src/importers/index.ts`, `test/importers.test.ts` | - | AC-1 | `npm test -- importers` |
| T-2 | Ticket telemetry: harness, cost_usd and tokens (migration, store setters, loop run and session-end) | backend | `src/core/db.ts`, `src/core/store.ts`, `src/integrations/loop.ts`, `src/hooks/index.ts` | - | AC-2 | `npm test -- store loop hooks` |
| T-3 | Per-epic budget (budget_usd, deadline) enforced on claim, in the Stop hook and in loop run | backend | `src/core/store.ts`, `src/hooks/index.ts`, `src/integrations/loop.ts` | T-2 | AC-3 | `npm test -- store loop hooks` |
| T-4 | `agent-flow conform <epic>`: spec AC to verified ticket AC to test, with `--file` and an MCP tool | backend | `src/core/conform.ts`, `src/cli/commands/core.ts`, `src/mcp/server.ts` | T-1 | AC-4 | `npm test -- conform` |
| T-5 | Swarm review events record per-AC votes and each voter's harness and model | backend | `src/integrations/swarm.ts`, `test/swarm.test.ts` | - | AC-5 | `npm test -- swarm` |
| T-6 | `agent-flow calibrate`: judge vs reviewer agreement export, read-only | backend | `src/core/calibrate.ts`, `src/cli/commands/core.ts` | T-5 | AC-6 | `npm test -- calibrate` |
| T-7 | Repo policy lock that forbids judge auto-approval, enforced in FlowStore | backend | `src/core/config.ts`, `src/core/store.ts`, `src/integrations/swarm.ts` | - | AC-7 | `npm test -- store swarm` |
| T-8 | Stats: first-pass approval, escalation rate and cost per done ticket | backend | `src/core/store.ts`, `src/cli/commands/core.ts`, `assets/dashboard/` | T-2 | AC-8 | `npm test -- stats cli` |
