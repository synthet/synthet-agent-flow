# Spec: Software Factory, with agent-flow as the spine

## Problem
The design note "Synthet Agentic Software Factory: A Unified Design for agent-flow, agent-swarm, agent-sdlc, jev-mcp and jev-engineering" (2026-11, not committed here) says agent-flow should be the single state machine:
- the framework provides the spec/SDD front;
- synthet-agent-swarm provides read-only votes;
- Jev is an advisory decision layer.

The note was written from GitHub pages, so some of it is stale. This spec keeps only the gaps that a check of the local repos confirmed, and turns them into tickets (`tasks.md`).

## Claim check (2026-11-13, against the local repos)

| Design claim | Evidence | Result |
|---|---|---|
| jev-mcp pins jev-1.13.0 | jev-mcp `client.py`: `DEFAULT_MODEL = "jev-1.14.0"`; its CHANGELOG records the migration | Stale. Dropped |
| The swarm README still lists Gemini | The README says Gemini CLI is retired and skipped. `registry.test.ts` keeps the `gemini→agy` fallback on purpose | Stale. Dropped |
| jev-engineering can't be inspected | `synthet-code-framework/jev-engineering/` and `infra/jev/` both exist | Wrong. L-008 records the decision |
| L-007 and L-008 are open | Rows in the framework's legacy `.agent/backlog/items.md`, not in its agent-flow DB. `import-backlog --dry-run` migrates 0 | Confirmed. Filed by hand |
| No spec AC id on tickets | The framework T-n importer keeps the spec's `AC-n` ids and text (`--spec`). The Spec Kit, OpenSpec and markdown importers mint local `AC-1..` | Partly true. Gap in the non-framework importers only |
| Standardize on Spec Kit task syntax | Only the framework table carries spec AC ids today | Disagree. The framework T-n table is the standard; Spec Kit stays importable |
| The framework spec template lacks EARS ACs | `/spec` already requires EARS sentences numbered `AC-1..` | Already done |
| No cost, harness or tokens per ticket | `tickets` has none of them. `harness` is already recorded per session (`sessions.harness`, written by the hooks, read by `store.sessions(ticketId)`) and in the `loop.run_started` event. Nothing records cost or tokens | Partly true. Cost and tokens are missing; reuse `sessions.harness` |
| No per-epic budget | The loop caps tickets, turns and continuations (`src/hooks/index.ts`). There is no dollar or wall-clock budget | Confirmed |
| No spec-conformance or judge-calibration loop | Neither command exists | Confirmed |
| Jev model recorded per decision | `jev.reviewed` records `model` | Already done |
| Swarm votes usable for calibration | `swarm.reviewed` records only `{verdict, parsed}` | Confirmed gap |
| A repo can't forbid swarm auto-approval | `swarm.autoApproveOnMajority` defaults to false, but nothing stops a repo from turning it on | Confirmed gap |
| Factory metrics | `stats` reports throughput, cycle time and rework | Partly done. First-pass approval, escalation rate and cost per done ticket are missing |

Already tracked elsewhere, so not repeated here:
- N1 triage with Jev: af-c333n.
- Cross-host or headless dispatch: the af-s9qsf epic.
- Routing the framework SDD commands to agent-flow: af-6ycpq.

## Goal
Every spec acceptance criterion can be traced to a verified ticket and a test. Every ticket carries its harness and cost. Epics have budgets. Judges (swarm, Jev) stay advisory until a calibration export shows how well they agree with reviewers.

## Acceptance criteria
- **AC-1**: When a Spec Kit, OpenSpec or markdown spec defines `AC-<n>` criteria, the importers shall carry those ids and their text onto the tickets that cover them, as the framework T-n importer already does.
- **AC-2**: When a ticket is worked by `loop run` or a session that reports usage, agent-flow shall store the ticket's `harness`, `cost_usd` and `tokens` through a new migration and FlowStore setters.
- **AC-3**: While an epic's `budget_usd` or `deadline` is exceeded, FlowStore shall refuse new claims on its children, and the Stop hook and `loop run` shall stop with a stated reason.
- **AC-4**: When `agent-flow conform <epic>` runs, the system shall report each spec AC that lacks a ticket AC marked `Verified` or a test whose name contains the AC id. With `--file`, it shall open `discovered-from` tickets for those gaps. The command is also available as an MCP tool.
- **AC-5**: When a swarm review finishes, the `swarm.reviewed` event shall record the per-AC votes and each voter's harness and model, as far as `swarm_run` returns them.
- **AC-6**: When `agent-flow calibrate` runs, the system shall export swarm and Jev verdicts next to reviewer or human verdicts, with agreement, precision and recall per judge. It shall not change any config.
- **AC-7**: While a repo's config forbids judge auto-approval, FlowStore shall refuse any approval that comes from a judge, whatever `swarm.autoApproveOnMajority` says.
- **AC-8**: When `agent-flow stats` runs, the system shall report first-pass approval rate, escalation rate (`needs-human` over claimed) and cost per done ticket.

## Out of scope
- Temporal, LangGraph or any other workflow runtime.
- Promoting a judge from advisory to gating. That needs calibration data from AC-6 and an owner decision.
- Code changes in other repos. The framework and jev-mcp items are tickets in their own trackers (below).

## Filed in other trackers
- **synthet-code-framework:**
  - L-007: stop seeding the Jev control plane.
  - L-008: keep `infra/jev/` as the single Jev home and delete `jev-engineering/`.
  - `/converge`: a command that runs `agent-flow conform` after merge (depends on AC-4).
- **jev-mcp:** decide, after L-008, whether jev-mcp absorbs `jev_decide` and `jev_assess_risk`.

## Proposed for other repos (not filed; verify each, then file)
- **synthet-agent-swarm:**
  - CI fails when the harness list drifts from the framework's `.agent/harnesses/registry.json`. First check what the registry audit already covers.
  - Per-vote harness and model metadata, plus a note on correlated voters. First check `docs/api.md` for what `swarm_run` already returns.
- **agent-sdlc:** archive with a README pointer to synthet-code-framework, under framework GitHub epic #66. Archiving the GitHub repo itself needs a human.
- **image-scoring:**
  - A production-path lint as a DoD gate: no Jev or swarm imports outside `scripts/research/**`, and an experimental-flag default may change only with an `owner-approved` label.
  - The AC-7 auto-approve lock.
  - These go in the repo that holds the Jev adapter; check whether that is backend or pipeline.
- **project-twelve:** DoD `python scripts/run_unity_tests.py`, and `needs-human` scope for scenes, prefabs and the assets submodule. First check its current config.
