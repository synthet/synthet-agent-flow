---
name: flow-status
description: Summarise the agent-flow board — what is in flight, blocked, waiting for review, ready next, and what needs a human. Use for "status", "where are we", "what's blocked", "standup". Only in projects with an `.agent-flow/` folder.
capability: "board status report"
side_effect_level: read_only
approval_required: false
requires_tools: "agent-flow CLI"
output_schema: "Short markdown status report."
risk_class: low
---

# flow-status — board summary

1. Gather the data:
   - `agent-flow stats --json`
   - `agent-flow board --json`
   - `agent-flow list --label needs-human --json`
   - `agent-flow log --limit 30`
2. Report the board in this order:
   - **Needs a human:** blocked tickets with `needs-human`, each with its unblock condition.
   - **In review:** id, title, owner, AC n/m.
   - **In flight:** owner and lease time left. Flag expired or nearly expired leases.
   - **Blocked:** reason → unblock condition.
   - **Ready next:** the top 5 of `agent-flow ready`.
   - **Last 24h:** done count, rejects, escalations.
3. Suggest one next action. Mention `agent-flow serve` for the live dashboard.
