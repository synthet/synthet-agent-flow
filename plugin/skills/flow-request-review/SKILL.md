---
name: flow-request-review
description: Get your submitted agent-flow ticket approved by an independent reviewer subagent, because you cannot approve a ticket you worked on. Use right after `submit`, when approve fails with "self-approval is disabled" or "cannot be its reviewer", or when the user says "get it reviewed", "review and merge", "approve it". Only in projects with an `.agent-flow/` folder.
argument-hint: "[ticket-id]"
capability: "request an independent subagent review of a ticket in review"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI or MCP (flow_review_brief), a subagent tool (Claude Code: Agent with agent-flow:flow-reviewer)"
output_schema: "Reviewer id, verdict per criterion, and the ticket's new state (done, or back in progress with fixes)."
risk_class: medium
---

# flow-request-review — an independent reviewer approves

You wrote the change, so the tracker will not take your approval. It approves an agent only when that agent:
- never claimed, started or submitted the ticket, and
- recorded its **own** `Verified` verdict on every acceptance criterion.

A fresh subagent with its own reviewer identity meets both. Your evidence is something it checks, not something it inherits.

1. **Make sure the ticket is in review.** If not, finish it with `flow-complete` first.
2. **Get a brief.** It records `review.requested` and returns a fresh reviewer id plus a complete review prompt:
   - CLI: `agent-flow review <id> --brief --json` (fields `reviewer`, `prompt`, `commands`)
   - MCP: `flow_review_brief` with `{ id }`
3. **Hand the prompt to a fresh subagent.** Don't review it yourself under the new name.
   - **Claude Code:** call the Agent tool with `subagent_type: "agent-flow:flow-reviewer"` and the brief's `prompt` as the prompt.
     The subagent passes `--actor <reviewer>` (or MCP `actor`) on every tracker call.
   - **Other harnesses:** give the same prompt to the harness's own subagent or a separate session.
   - **No subagent available:** run `agent-flow review <id> --swarm` for a multi-harness vote (it approves only on a real majority, when `swarm.autoApproveOnMajority` is on), or ask a human to approve on the dashboard.
4. **Act on the result.**
   - **Approved:** the ticket is `done`. If the user asked you to merge, the PR can now be merged; merging is still a separate step.
   - **Rejected:** the ticket is back `in_progress` with numbered fixes in a review comment. Fix them, then `flow-complete` and this skill again.
     After `maxAttempts` rejections the ticket escalates to `needs-human`.
5. **Report** the reviewer id, its verdict table and the ticket state.

Never record verdicts or approve under the reviewer id yourself. The id is for the subagent, and the audit log shows who requested the review.
