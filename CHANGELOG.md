# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `run.cmd`: starts the dashboard on Windows, or opens it if it is already running.
- CI runs on `windows-latest`.

### Changed
- The dashboard default port is now 8791, because 8790 clashes with AI Quotas. Projects with `server.port` set in their config keep it.

### Fixed
- Importers parse CRLF markdown. Spec Kit and OpenSpec files with CRLF line endings used to yield no tasks.
- Plugin hook and MCP shims launch a `.cmd` CLI from a path containing a space. Hooks used to exit 1 with no output instead of failing open.
- `agent-flow init` marks `tickets.jsonl` as `eol=lf`, so autocrlf checkouts stay clean. Existing projects keep their current rule.

## [0.1.0] - 2026-11-06

### Added
- **Core store**: built on SQLite via `node:sqlite` and shared across git worktrees. It provides:
  - a dependency-aware ready queue,
  - atomic, leased claims with WIP limits,
  - the lifecycle state machine with gates (handoff, DoD, evidence-backed acceptance criteria, no self-approval, escalation to needs-human),
  - epic rollup,
  - a hash-chained append-only audit log,
  - deterministic `tickets.jsonl` snapshots.
- **CLI** `agent-flow` / `af`, covering the full lifecycle plus prime/context, branch naming, DoD, tree, stats, export/import and audit.
- **SDD importers**: framework `/tasks` T-n tables, Spec Kit `tasks.md`, OpenSpec change folders, and Local Markdown backlogs.
- **MCP server**: `flow_*` tools; `flow://workflow/overview`, `flow://board` and `flow://ticket/{id}` resources; confirmation on destructive and bulk tools.
- **REST/SSE server and web dashboard**:
  - board with swimlanes, WIP limits and drag-to-transition,
  - ticket drawer, review queue, activity feed, agents view, epic dependency graphs, stats,
  - light and dark themes.
- **Claude Code plugin**: nine skills, reviewer/planner agents, hooks (context, safety/WIP, auto-start, heartbeats, loop controller, StopFailure, transcript pointers, DoD gate) and an MCP config. Also a statusline command.
- **Claude Code mod**: `/flow-board` pane, attention band, status entry, toasts.
- **Integrations**:
  - GitHub one-way mirror (issues, sub-issues, labels, PR creation, reconcile, signed webhook),
  - synthet-agent-mailbox notifications via a retrying outbox,
  - synthet-agent-swarm multi-harness review,
  - per-ticket worktrees,
  - an outer autonomous loop runner,
  - an installer with receipts and rollback for Claude Code, Cursor, Codex and synthet-code-framework projects.
