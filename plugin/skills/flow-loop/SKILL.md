---
name: flow-loop
description: Start a capped autonomous next-ticket loop over agent-flow tickets labelled agent-ok — claim, implement, verify, submit, repeat — under an explicit run contract with budget and stop conditions. Only when the user explicitly asks to run autonomously. Only in projects with an `.agent-flow/` folder.
argument-hint: "[--max 3] [--label agent-ok] [--outer]"
disable-model-invocation: true
capability: "autonomous ticket loop"
side_effect_level: remote_write
approval_required: true
requires_tools: "agent-flow CLI, git, gh (optional)"
output_schema: "Run contract, then a per-ticket summary when the loop stops."
risk_class: high
---

# flow-loop — capped autonomous run

## 1. Write the run contract first
This follows the synthet-code-framework `autonomous-run-contract`. State it to the user and get a yes:
- **Scope:** tickets labelled `--label` (default `agent-ok`). Nothing else.
- **Budget:** at most `--max` tickets (default 3). If the hooks are installed, the Stop hook also caps continuations.
- **Stop conditions:**
  - the ready queue is empty,
  - the `.agent-flow/STOP` file exists,
  - a StopFailure (rate limit, billing, …),
  - no progress since the last continuation,
  - a ticket goes `blocked`, or `needs-human` comes up.
- **Revert rule:** never leave red work. Release with a reason, or block, instead.
- **Human gates:** PR merges, and anything destructive.

## 2. Arm the loop
```
agent-flow loop start --max <N> --label agent-ok
```
This writes `.agent-flow/loop.json`. If the hooks are installed, the Stop hook then keeps the session going while matching ready work remains. Without the hooks, use `loop run` below. It does not re-feed one prompt; it tells you the next concrete step.

For long runs, prefer fresh contexts per ticket. That is the most robust tier, and it avoids context rot:
```
agent-flow loop run --max <N> --label agent-ok --max-turns 80
```
This starts one headless `claude -p` session per ticket.

## 3. Per iteration
`flow-next` → `flow-work` → `flow-complete`. One ticket at a time; WIP stays at 1.

## 4. Stopping
- Halt: `touch .agent-flow/STOP`, or `agent-flow loop stop`.
- Report every ticket touched: id → final state → PR.
- If the hooks are installed, Claude Code caps consecutive Stop-hook continuations at 8 by default. Raise `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, or use `loop run`, for longer loops.
