---
name: flow-plan
description: Turn a feature request or spec into agent-ready agent-flow tickets — scale the ceremony to the size (bug/chore → one ticket; feature → spec + tasks; cross-cutting → full SDD), then import tasks as an epic with dependencies. Use for "plan this feature", "break this down", "create tickets for", or after /spec /plan /tasks. Only in projects with an `.agent-flow/` folder.
argument-hint: "<feature description | spec file | tasks.md | openspec change dir>"
capability: "spec to tickets"
side_effect_level: local_write
approval_required: true
requires_tools: "agent-flow CLI"
output_schema: "Epic id, ticket ids with dependencies, import warnings."
risk_class: medium
---

# flow-plan — from intent to tickets

Input: `$ARGUMENTS`.

## 1. Pick the ceremony by size (avoid SDD bloat)
- **Bug / chore / one-file change.** One ticket and no spec:
  ```
  agent-flow create "<title>" --type bug --ready --scope <path> --ac "<observable result>" --body "Task: … / Scope: … / Pattern: follow <file> / Done when: …"
  ```
- **Feature.** A one-page spec with numbered `AC-n` criteria (EARS style: `WHEN … THEN …`), then a `T-n` task table, then import.
- **Cross-cutting or architectural work.** The full framework path: `/spec` → `/clarify` → `/plan` → `/tasks` → `/analyze`, then import.

## 2. Write tickets as prompts
Each task or ticket needs:
- a **Task** line (one PR of work, one context window),
- **Scope**: the files to touch,
- **Pattern**: an existing file to imitate,
- **Done when**: testable acceptance criteria.

Split along module boundaries. Express ordering as dependencies (`Depends on: T-1`). Parallel-safe tasks get no edge between them.

## 3. Import
- **Framework `/tasks` output.** Columns are ID | Task | Owner role | Files | Depends on | ACs | Verification. Run:
  `agent-flow import-tasks tasks.md --spec spec.md --dry-run`, then run it again without `--dry-run`.
- **Spec Kit** (`- [ ] T001 [P] …`): `agent-flow import-tasks specs/<feature>/tasks.md`.
- **OpenSpec change folder**: `agent-flow import-tasks openspec/changes/<name>`.
- **Legacy `.agent/backlog/items.md`**: `agent-flow import-backlog`.

Always show the dry run to the user and get approval before the real import. Re-imports are idempotent: each ticket keeps an external key of `file#T-n`.

## 4. After the import
- `agent-flow tree <epic>` checks the dependency graph.
- `agent-flow edit <id> --add-label agent-ok` marks tickets an autonomous loop may take.
- Tickets land in `ready`, but dependents stay blocked until their blockers are done.

From here on, the tracker owns status. The checkboxes in `tasks.md` are only a derived view. When implementation shows the spec was wrong, update the spec and file follow-up tickets; don't edit closed tickets.
