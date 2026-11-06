---
name: flow-complete
description: Finish an agent-flow ticket — run the Definition of Done, commit and push the branch, open a PR that references the ticket, write the handoff note and submit for review. Use when implementation is done or the user says "wrap up", "complete", "submit", "open the PR".
argument-hint: "[ticket-id]"
capability: "complete ticket and submit for review"
side_effect_level: remote_write
approval_required: false
requires_tools: "agent-flow CLI, git, gh (optional)"
output_schema: "PR URL, DoD summary, ticket now in review."
risk_class: medium
---

# flow-complete — submit for review

1. **Check the acceptance criteria.** Run `agent-flow ac list <id>`.
   Every criterion should be `Verified` with evidence. Fix or record anything that isn't before going on.
2. **Run the Definition of Done.** Run `agent-flow dod`. It runs the commands in `.agent-flow/config.json`.
   If it fails, fix the failures. Never skip a failing test or disable a check.
3. **Commit and push the ticket branch.** Run `git push -u origin <branch>`.
   Never push to the default branch. Never force-push; the hooks refuse both.
4. **Open the PR** (if a git remote exists). Use the body template from the agent-flow repo, `templates/pr-body.md`:
   - first line: `Refs <id>`
   - add `Closes #<issue>` if the ticket has `github_issue`
   - summary, an AC checklist with evidence, and test results.

   Command: `gh pr create --title "<type>(<scope>): <ticket title>" --body-file <file>`.
   Then record the link: `agent-flow edit <id> --spec-ref …` (optional). `agent-flow github reconcile` picks up the PR state later.
5. **Write the handoff note.** This is required:
   ```
   agent-flow note <id> --handoff "Changed: … | Decisions: … (why) | Left: … | Gotchas: … | PR: <url>"
   ```
6. **Submit.** Run `agent-flow submit <id>`. It re-runs the DoD and moves the ticket to `review`.
   - `GATE_FAILED` tells you exactly what is missing. Fix it and submit again.
7. Report the PR URL and the ticket state. Do **not** approve your own ticket. A reviewer does that: `flow-review`, the `flow-reviewer` agent, the swarm, or a human.
