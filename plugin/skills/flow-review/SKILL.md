---
name: flow-review
description: Review an agent-flow ticket in the review column against its acceptance criteria and approve or reject it with actionable feedback. Optionally gather a multi-harness verdict with synthet-agent-swarm. Use for "review af-xxxx", "check the review queue", or when acting as reviewer. Only in projects with an `.agent-flow/` folder.
argument-hint: "[ticket-id] [--swarm]"
capability: "ticket review gate"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI, git; synthet-agent-swarm optional"
output_schema: "Per-AC verdicts with evidence; approve or reject with reasons."
risk_class: medium
---

# flow-review — the review gate

You must not be the ticket's owner. The tracker refuses self-approval by default.

1. **Pick a ticket.** Use `$ARGUMENTS`, or the oldest ticket in `agent-flow list --status review`.
2. **Load it.** Run `agent-flow show <id>`. Read the spec, the criteria, the handoff note, the branch and the PR.
3. **Inspect the change.** Run `git fetch && git diff <default-branch>...<branch>`, and read the tests.
   Run the verification commands named in the criteria and the DoD (`agent-flow dod`) on the branch.
4. **Give each criterion a verdict.** Run `agent-flow ac verify <id> AC-n --verdict Verified|Failed --evidence "<what you ran / saw>"`.
5. **Optional: multi-model review.** Run `agent-flow review --swarm <id>`. This needs synthet-agent-swarm and records each harness's vote as a review comment.
   Votes are evidence, not ground truth. Read the dissent.
6. **Decide.**
   - Every criterion is Verified and the code is acceptable: `agent-flow approve <id>`.
   - Otherwise: `agent-flow reject <id> --reason "<specific, actionable list: what fails, where, what done looks like>"`.
     After `maxAttempts` rejections the ticket escalates to `needs-human` automatically.
7. If the PR is open and approval is final, say so. Merging stays with a human unless the project says otherwise.
