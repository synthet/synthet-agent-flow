---
name: flow-complete
description: Finish an agent-flow ticket — run the Definition of Done, commit and push the branch, open a PR that references the ticket, write the handoff note and submit for review. Use when implementation is done or the user says "wrap up", "complete", "submit", "open the PR". Only in projects with an `.agent-flow/` folder.
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
3. **Commit and push the ticket branch.** Run `git push origin <branch>`.
   Never push to the default branch. Never force-push.
4. **Open the PR** (when there is a git remote). The easiest way is:
   ```
   agent-flow github pr <id>
   ```
   It renders `templates/pr-body.md` with `Refs <id>`, `Closes #<issue>` when the ticket is mirrored, and the AC checklist with evidence, then records `pr_url`.
   Or run `gh pr create` yourself, as long as the body keeps `Refs <id>`.
   Later PR events (changes requested, merged) flow back through `agent-flow github reconcile`, which also runs at session start if the hooks are installed.
5. **Write the handoff note.** This is required:
   ```
   agent-flow note <id> --handoff "Changed: … | Decisions: … (why) | Left: … | Gotchas: … | PR: <url>"
   ```
6. **Submit.** Run `agent-flow submit <id>`. It re-runs the DoD and moves the ticket to `review`.
   - `GATE_FAILED` tells you exactly what is missing. Fix it and submit again.
7. Report the PR URL and the ticket state. Do **not** approve your own ticket. A reviewer does that: `flow-review`, the `flow-reviewer` agent, the swarm, or a human.
