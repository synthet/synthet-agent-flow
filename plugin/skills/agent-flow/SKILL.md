---
name: agent-flow
description: Core rules for projects tracked by agent-flow, meaning the repo root has an `.agent-flow/` folder. Use there whenever the user mentions tickets, backlog, queue, "what's next", claiming work, blockers, handoffs, review, or epics, or when you find work outside your current ticket. In those projects agent-flow is the only place work is tracked. Without that folder, do not use this skill.
capability: "agent-flow ticket workflow rules"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI or the agent-flow MCP server (flow_* tools)"
output_schema: "Ticket ids and state changes reported inline."
risk_class: low
---

# agent-flow: how work is tracked here

The tracker lives in `.agent-flow/`. `flow.db` holds live state and is shared by every worktree. `tickets.jsonl` is the committed snapshot.
You can drive it two ways, and they behave the same:
- the MCP tools `flow_*`. Read `flow://workflow/overview` once if it isn't in context.
- the CLI `agent-flow` (alias `af`). Add `--json` for machine-readable output.

Your actor id looks like `claude:1a2b3c4d`. If the hooks are installed they inject it at session start and the CLI reads it from `AGENT_FLOW_ACTOR`. Without the hooks, pass `--actor <harness>:<short-id>` to every CLI call, because the CLI otherwise acts as `human:<user>`. The MCP server sets its own actor, and it refuses `human:` and `system:` actors from an agent.

## Rules
1. **The tracker is the source of truth.** Never keep work in TODO.md files, checklists in chat, or code comments.
   - Use Claude Code's own task list only for steps *inside* one ticket.
2. **Pull, don't invent.** Take work from the ready queue (`agent-flow ready`).
   - If it is empty, stop and ask the maintainer to promote or create tickets.
3. **Claim before touching code.**
   - Claim with `agent-flow claim <id>` or `claim --next`. The claim is atomic and leased.
   - `CLAIM_CONFLICT` means someone else won; pick again.
   - `WIP_LIMIT` means finish or release what you hold.
4. **One ticket = one branch = one PR.** Use the branch the claim returns (`af/<id>-<slug>`).
   - With several agents in parallel, use `agent-flow worktree create <id>`.
5. **Scope discipline.** Found something else (a bug, a refactor, a missing test)? File it and keep going:
   `agent-flow create "<title>" --discovered-from <current-id> --body "<what/where/why>"`.
6. **Block loudly.** The moment progress stops, run `agent-flow block <id> --reason "<why>" --until "<unblock condition>"`.
7. **Evidence, not vibes.** Every acceptance criterion gets a verdict with evidence:
   `agent-flow ac verify <id> AC-n --evidence "<test output / command / file:line>"`.
   - `Unknown` never counts as a pass.
8. **Handoff before you stop.** `agent-flow note <id> --handoff "<what changed · decisions and why · what's left · gotchas>"`.
   - If the hooks are installed, the Stop hook reminds you.
9. **Never self-approve.** `submit` moves the ticket to review. A reviewer approves:
   - the `flow-reviewer` subagent, when the plugin is installed,
   - `agent-flow review --swarm`,
   - or a human on the dashboard (`agent-flow serve`).
10. **PRs reference the ticket.** Put `Refs <id>` in the PR body, plus `Closes #<n>` if the ticket is mirrored to a GitHub issue.

## Lifecycle at a glance
`backlog → ready → claimed → in_progress → review → done` (plus `blocked`, `cancelled`).

| Situation | Command |
|---|---|
| What's next? | `agent-flow ready` · `agent-flow prime` |
| Take it | `agent-flow claim --next [--label agent-ok]` |
| First commit | `agent-flow start <id>` (automatic if the hooks are installed) |
| Still working | `agent-flow heartbeat <id>` before the lease ends, or claim with `--lease <minutes>` (automatic if the hooks are installed) |
| Stuck | `agent-flow block <id> --reason … --until …` |
| Done | the `flow-complete` skill |
| Give it back | `agent-flow release <id> --reason "<why it failed>"` |

## Related skills
- `flow-next`, `flow-work`, `flow-complete` — the three steps for one ticket.
- `flow-review` — review someone else's ticket.
- `flow-plan` — spec → tasks → tickets.
- `flow-loop` — capped autonomous run.
- `flow-land` — end-of-session wrap-up.

## Cross-machine handoffs
If the synthet-agent-mailbox `agent-mailbox` skill is available, publish blockers and handoffs there as well. agent-flow can also notify the mailbox automatically (`mailbox.enabled` in `.agent-flow/config.json`).
