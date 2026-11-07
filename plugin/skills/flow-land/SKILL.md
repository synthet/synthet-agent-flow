---
name: flow-land
description: Land the plane at the end of a session — sync the tracker, push branches, write handoff notes for every ticket you hold, release what you won't finish, export the snapshot. Use when the user says "wrap up the session", "land the plane", "I'm done for today", or before context runs out. Only in projects with an `.agent-flow/` folder.
capability: "end-of-session handoff"
side_effect_level: local_write
approval_required: false
requires_tools: "agent-flow CLI, git"
output_schema: "Per-ticket state summary."
risk_class: low
---

# flow-land — leave a clean starting point

1. List what you hold: `agent-flow list --mine --status claimed,in_progress,review,blocked`.
2. For each ticket still `claimed` or `in_progress`:
   - Commit work in progress on its branch and push it (`git push origin <branch>`).
   - Write a handoff: `agent-flow note <id> --handoff "Changed … | Decisions … | Left … | Gotchas … | Next step …"`.
   - If you will not continue it, release it: `agent-flow release <id> --reason "<state it is in>"`. The handoff stays for the next agent.
3. File any discovered work you noted but did not file yet: `agent-flow create … --discovered-from <id>`.
4. Write the snapshot (`agent-flow export`) and commit `.agent-flow/tickets.jsonl` if the project tracks it.
5. Report a table of ticket → state → next step.
