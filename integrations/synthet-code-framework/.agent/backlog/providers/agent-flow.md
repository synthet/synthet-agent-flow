# agent-flow backlog provider

[agent-flow](https://github.com/synthet/synthet-agent-flow) is a tracker built for agents. It provides:
- a dependency-aware ready queue
- **atomic, leased claims**, so parallel agents never take the same item
- acceptance criteria that need evidence
- review gates
- a hash-chained audit log
- a web Kanban dashboard
- an MCP server (`flow_*`) and Claude Code hooks/skills

Use it whenever more than one agent works the backlog, or when you want PR state and the board kept in sync automatically.

## Setup

```bash
npm i -g github:synthet/synthet-agent-flow   # or: clone, npm i, npm link
agent-flow init --dod "<your test command>"
agent-flow install --harness claude          # MCP + hooks + CLAUDE.md block (or install the Claude Code plugin)
agent-flow import-backlog .agent/backlog/items.md   # optional: migrate the Local Markdown backlog
```

State lives in `.agent-flow/`:
- `flow.db` is local and shared by every git worktree.
- `tickets.jsonl` is the committed snapshot.
- `config.json` holds WIP limits, DoD commands, and the GitHub, mailbox and swarm settings.

## Status mapping

agent-flow statuses are exactly the logical states in [README](../README.md):

| Logical state | agent-flow status | How it is entered |
|---|---|---|
| Backlog | `backlog` | `agent-flow create` (no `--ready`) |
| Ready | `ready` | `--ready` or `agent-flow promote`; claimable only when every dependency is done |
| Claimed | `claimed` | `agent-flow claim` (atomic, leased) |
| In Progress | `in_progress` | automatic on the first commit (PostToolUse hook), or `agent-flow start` |
| Blocked | `blocked` | `agent-flow block --reason --until` |
| Review | `review` | `agent-flow submit` (needs a handoff note and a green DoD) |
| Done | `done` | `agent-flow approve` (a reviewer, not the owner), or the PR is merged (`agent-flow github reconcile`) |

## Five-step contract

1. **Pick.** `agent-flow ready [--label agent-ok]`. An empty queue means stop and ask; don't invent work.
2. **Claim.** `agent-flow claim <id>` or `agent-flow claim --next`. This records the owner and a lease.
   - `CLAIM_CONFLICT` means another agent won; pick again.
3. **Start.** The first commit moves the item to `in_progress` (the hook does this). Otherwise run `agent-flow start <id>`.
4. **Block.** `agent-flow block <id> --reason "<why>" --until "<unblock condition>"`.
5. **Reference.** The PR body contains `Refs <id>`, plus `Closes #<n>` when the ticket is mirrored with `agent-flow github push`.
   Then: `agent-flow note <id> --handoff "…"` → `agent-flow submit <id>` → a reviewer runs `agent-flow approve` or `reject`.

`/task-claim <id> --provider agent-flow` corresponds to step 2.

## SDD hand-off

Import `/tasks` output (a `T-n` table with dependencies and `AC-n` coverage) as an epic with tickets:

```bash
agent-flow import-tasks specs/<feature>/tasks.md --spec specs/<feature>/spec.md --dry-run
agent-flow import-tasks specs/<feature>/tasks.md --spec specs/<feature>/spec.md
```

Spec Kit `tasks.md` and OpenSpec `openspec/changes/<name>/` folders are detected automatically.
From then on the tracker owns status. The checkboxes in `tasks.md` become a derived view.

## Provider-specific notes

- **IDs** look like `af-k3x9q` (hash-style, so they merge cleanly). The prefix is configurable.
- **Labels:**
  - `agent-ok` marks tickets the autonomous loop may take.
  - `skill:<x>` routes a ticket to agents that advertise skill `<x>`.
  - `needs-human` is added automatically after repeated rejections.
- **WIP:** `wip.perAgent` (default 1) and `wip.columns.in_progress` (default 4), both in config.
- **Dashboard:** `agent-flow serve` → http://127.0.0.1:8790.
