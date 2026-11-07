---
name: flow-next
description: Pick and claim the next agent-flow ticket, then set up its branch or worktree. Use when the user says "next ticket", "pick up work", "what should I do next", or when the loop asks for the next ticket. Only in projects with an `.agent-flow/` folder.
argument-hint: "[ticket-id] [--label agent-ok] [--epic <id>]"
capability: "claim next ready ticket"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI, git"
output_schema: "Claimed ticket id, branch, acceptance criteria."
risk_class: low
---

# flow-next — claim the next ticket

Arguments: `$ARGUMENTS`, either a ticket id or filters like `--label agent-ok --epic af-xxxx`.

1. **Check what you already hold.** Run `agent-flow list --mine --status claimed,in_progress`.
   If you hold a ticket, resume it with `flow-work` instead of claiming another.
2. **Look at the queue.** Run `agent-flow ready $ARGUMENTS`.
   - Empty → stop and report "ready queue empty". Do not invent work.
   - Prefer the head of the queue unless the user named a ticket. The queue is already ordered: expedite lane, then priority, then age.
3. **Claim it atomically.** Run `agent-flow claim <id> --json`, or `agent-flow claim --next $ARGUMENTS --json`.
   - `CLAIM_CONFLICT` → run `ready` again and pick the next one.
   - `WIP_LIMIT` → finish or release your current ticket first.
4. **Set up the workspace on the returned `branch`.**
   - Single agent: `git switch -c <branch>`, or `git switch <branch>` if it already exists.
   - Parallel agents: `agent-flow worktree create <id>`, then work inside the printed path. Worktrees are created one at a time.
5. **Load the context.** Run `agent-flow show <id>` and read:
   - the spec,
   - the scope paths,
   - the acceptance criteria,
   - any earlier handoff or review notes. A ticket that was rejected before has reviewer feedback; address it first.
6. Report back: id, title, branch, and the acceptance criteria. Continue with the `flow-work` skill.
