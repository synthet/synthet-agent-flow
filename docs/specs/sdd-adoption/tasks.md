# Tasks: SDD/SLC adoption

Spec: [spec.md](spec.md). Existing tickets `af-rtoxu` (init detects the default branch) and `af-0syon` (init re-includes ignored config) join this epic.

| ID | Task | Owner role | Files / areas | Depends on | ACs | Verification |
|----|------|------------|---------------|------------|-----|--------------|
| T-1 | Empty-queue wording: file the user's request as a ticket, then claim it | backend | `src/core/context.ts`, `src/mcp/overview.ts`, `plugin/skills/flow-next/SKILL.md`, `integrations/synthet-code-framework/.agent/backlog/providers/agent-flow.md` | - | AC-1 | `npm test -- hooks mcp` |
| T-2 | Post-tool nudge for untracked commits and PRs, once per session, switch `hooks.untrackedNudge` | backend | `src/hooks/index.ts`, `src/core/config.ts`, `test/hooks.test.ts` | - | AC-2, AC-3 | `npm test -- hooks` |
| T-3 | `agent-flow adoption` cross-repo report | backend | `src/cli/commands/core.ts`, `src/core/`, `test/cli.test.ts` | - | AC-4 | `npm test -- cli` |
| T-4 | Route the framework SDD commands to agent-flow (framework PR, then sync user-level copies) | docs | `synthet-code-framework/.claude/commands/{spec,plan,tasks,implement,test-and-fix,pr-ready}.md` | T-1 | AC-5 | framework CI green; `cmp` user-level copies |
| T-5 | Retire the 4 legacy empty `.agent/backlog/items.md` files | chore | burstpick-re, jev-mcp, synthet-code-framework, zed | - | AC-6 | `agent-flow import-backlog --dry-run` shows 0 items; file gone on default branch |
| T-6 | Remove duplicate `~/.claude/skills/flow-*`; refresh `~/.agents` and `~/.gemini` copies from `plugin/skills` | chore | user-level skill dirs | T-1 | AC-6 | one `flow-*` per harness; `cmp` with `plugin/skills` |
