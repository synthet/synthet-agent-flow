---
name: flow-triage
description: Find and resolve stale agent-flow tickets — backlog or ready work nobody touched, long-blocked or long-in-review tickets, claim churn — with a read-only agent describing each one and Jev deciding flag, cancel or keep. Use for "triage stale tickets", "clean up the backlog", "housekeeping tickets". Only in projects with an `.agent-flow/` folder (or a projects root holding several).
capability: "stale ticket triage: scan snapshots, agent describes, Jev decides, gated apply"
side_effect_level: local_write
approval_required: true
requires_tools: "agent-flow CLI; synthet-agent-swarm build (describe); Jev System One (decide)"
output_schema: "plan.json and manifest-triage-*.json in a scratch folder; a table item → description → Jev choice → action."
risk_class: medium
---

# flow-triage — stale tickets

Implements the shared housekeeping protocol (synthet-code-framework `docs/housekeeping-protocol.md`). Keep the plan
in a scratch folder, not in a repo.

1. **Scan** (read-only: reads committed `tickets.jsonl` snapshots, opens no database):
   `agent-flow triage scan --root <projects root> --out <scratch>/plan.json` (or `--repo .`).
   Defaults: backlog/ready untouched 30 days, blocked 14, review 7; `--stale-days`, `--blocked-days`,
   `--review-days` change them. Tickets with a live lease, `stale-candidate` or `needs-human` are skipped.
2. **Describe**: `agent-flow triage describe --plan <scratch>/plan.json --swarm <synthet-agent-swarm>/agent-orchestrator/dist/index.js`.
   A read-only agent reads the repo and says whether each ticket looks done, obsolete or still wanted. Ticket text is
   redacted going out; the reply is redacted coming back. Exit 3 means no swarm was given.
3. **Jev decides**: send `agent-flow triage jev --plan <scratch>/plan.json --json` (its `result` is the
   `{state, questions}` payload) as one `jev_system_one` batch, save the response, then
   `agent-flow triage decide --plan <scratch>/plan.json --answers <scratch>/answers.json`. Without Jev, ask the owner
   the same questions once. Re-ask `hold` items once with more evidence, then leave them.
4. **Dry run**: `agent-flow triage apply --plan <scratch>/plan.json` and read every line.
5. **Apply** as an agent identity: `agent-flow triage apply --plan <scratch>/plan.json --apply --actor housekeeping:<run>`.
   `flag` adds the `stale-candidate` label and a note. `cancel` cannot be undone (cancelled tickets cannot be
   reopened), so it needs the owner's per-id approval: ask once with ids and titles, then pass
   `--approve T0003,T0007 --approval-note "<owner's words>"`. In a repo whose mailbox or GitHub mirror is enabled,
   every write needs approval, because it leaves the machine. Tickets in review are only ever flagged.
6. **Verify**: `agent-flow triage verify --manifest <manifest>`; `triage restore` prints how to undo flags.
7. **Report** a table: ticket → description → Jev choice and confidence → action; then held and skipped items.

Never run `apply` to try things out: notes land in the hash-chained audit log and cannot be removed.
