---
name: flow-work
description: Implement the claimed agent-flow ticket test-first against its acceptance criteria, recording evidence and filing discovered work. Use after flow-next, or when resuming a ticket you hold. Only in projects with an `.agent-flow/` folder.
argument-hint: "[ticket-id]"
capability: "implement claimed ticket"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI, git, project build/test commands"
output_schema: "Changes made and AC evidence recorded on the ticket."
risk_class: medium
---

# flow-work — implement the ticket

Ticket: `$ARGUMENTS`. If no id is given, use the ticket bound to the current branch (`agent-flow show`).

1. **Re-read the ticket.** Run `agent-flow show <id>`. The spec is your prompt.
   - Stay inside `scope_paths` unless the spec says discovery is needed.
   - Follow the "pattern" files it names.
2. **Plan small.** Use your own task list for steps inside this ticket only. One ticket is meant to fit one context window and one PR.
3. **Write tests first** for each acceptance criterion where that is feasible. Then make the smallest change that turns them green.
4. **Commit early.** Use Conventional Commits, for example `feat(orders): add pagination`.
   - Run `agent-flow start <id>` after the first commit.
   - Run `agent-flow heartbeat <id>` before the lease ends. If the hooks are installed, this and `start` are automatic.
5. **Record evidence as you go.** For each criterion:
   `agent-flow ac verify <id> AC-n --evidence "<command + result, or file:line>"`.
   Use `--verdict Failed` with the reason if one cannot be met.
6. **Discovered work.** Run `agent-flow create "<title>" --discovered-from <id> --body "<details>" [--type bug]`.
   - Do not expand scope.
   - If the discovered work blocks you, run `agent-flow dep add <id> <new-id>` and then `agent-flow block <id> --reason … --until …`.
7. **Blocked by something outside your control** (credentials, a decision, another ticket):
   `agent-flow block <id> --reason "<why>" --until "<condition>"`. Then stop and say so.
8. When every criterion has evidence, continue with `flow-complete`.
