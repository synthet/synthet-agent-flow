# AGENTS.md: working on synthet-agent-flow

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (vitest; `test/**/*.test.ts`). Some tests import `dist/` through `bin/agent-flow.js`, so build first.
- Typecheck: `npm run typecheck`
- Plugin checks: `claude plugin validate plugin`, `claude plugin validate mod`, `claude plugin test mod`
- Run locally: `node bin/agent-flow.js <command>` (or `npm link`, then `agent-flow`)

## Layout
| Path | What |
|---|---|
| `src/core/` | store (all rules), states table, db/migrations, config schema, context builder, service layer, DoD runner, workspace registry (`registry.ts`) |
| `src/cli/` | `main.ts` dispatcher, `registry.ts`, `commands/core.ts` (tickets/lifecycle), `commands/extra.ts` (servers/hooks/integrations) |
| `src/mcp/` | stdio MCP server (`flow_*` tools, resources) |
| `src/server/` + `assets/dashboard/` | REST/SSE hub for every registered workspace and the vanilla dashboard (strict CSP, textContent only) |
| `src/hooks/` | Claude Code hook handlers, statusline, snapshot |
| `src/integrations/` | github, mailbox, swarm, worktree, loop, notify/outbox, install |
| `src/importers/` | framework `/tasks`, Spec Kit, OpenSpec and local-markdown importers |
| `plugin/` | Claude Code plugin (skills, agents, hooks.json, .mcp.json) |
| `mod/` | Claude Code mod (pane, band, status line) |
| `integrations/synthet-code-framework/` | backlog-provider kit for framework projects |
| `templates/` | PR body, CLAUDE.md block, Cursor rule, statusline snippet |
| `tray/` + `scripts/*-tray.ps1` | Windows tray app (C# 5, built by the .NET Framework `csc.exe`) that runs `serve --exit-on-stdin-close` |

## Rules
- **Every lifecycle rule lives in `FlowStore`.** Surfaces (CLI, MCP, REST, hooks) stay thin, and side effects (DoD, branch names) go in `service.ts`. Never re-implement a gate in a surface.
- **Mutations go through `store.tx()`.** It provides `BEGIN IMMEDIATE`, an event inside the transaction, and listeners and the snapshot export after commit.
- **New events** use `store.record()` (integrations) or `emit()` inside the store. Action names are `noun.verb_past`.
- **Schema changes** are a new entry appended to `MIGRATIONS` in `db.ts`. Never edit an existing one.
- **Hooks fail open** (`{}`, exit 0) and never emit `allow`.
- **Dashboard rendering** uses `el()` and `textContent` only. No inline script or style, because of the CSP.
- **Tests:** add vitest coverage for every behaviour change. Integration code takes a `Runner`, so tests stub `gh`, `agent-mail` and the swarm.
- **Commits:** Conventional Commits (`feat(core): …`, `fix(hooks): …`).

## Work tracking
This repo dogfoods agent-flow. Run `node bin/agent-flow.js ready` to see open follow-ups. Claim before you work, and reference `Refs <id>` in PRs.
