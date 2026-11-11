# Spec: agents use agent-flow through the whole SDD/SLC flow

## Problem
agent-flow is installed (Claude Code plugin, CLI, MCP for Codex, Gemini and Cursor), and 43 repos have a tracker. Agents still don't track their work:

- With an empty ready queue, the session-start context says "do not invent work". Agents read that as "don't track the user's request".
- The framework SDD commands never import, claim, verify or submit:
  - `/tasks` writes an importable table but doesn't import it;
  - `/implement` doesn't claim;
  - `/test-and-fix` doesn't record acceptance-criteria evidence;
  - `/pr-ready` doesn't hand off or submit.
- Hooks stay silent when an agent commits or opens a PR in a tracked repo without a ticket.
- Nothing measures adoption.

## Goal
In any repo with `.agent-flow/`, the work an agent does for the user becomes a ticket. The agent claims it, records evidence and submits it, and a report shows where that isn't happening.

## Acceptance criteria
- **AC-1**: WHEN the ready queue is empty THEN the context (session-start hook and `flow_context`) tells the agent not to pick work on its own, and to file the user's request as a ticket (`agent-flow create … --ready`, or `flow-plan` for a feature) before claiming it. The MCP overview, the `flow-next` skill and the framework provider doc say the same.
- **AC-2**: WHEN an agent in a tracked repo makes a real commit (HEAD moved) or runs `gh pr create` while holding no claimed ticket THEN the post-tool hook adds a one-time reminder to create or claim a ticket and reference it in the PR. The hook never denies or allows.
- **AC-3**: WHEN the nudge already fired in a session, or `hooks.untrackedNudge` is `false`, THEN the post-tool hook stays silent.
- **AC-4**: WHEN `agent-flow adoption --root <dir> --since <window>` runs THEN it lists every child repo with a tracker, with tickets created, claimed and done in the window plus the commit count, and flags repos that have commits but no tickets. It is read-only and supports `--json`.
- **AC-5**: WHEN the framework SDD commands run in a repo with `.agent-flow/config.json` THEN they route to agent-flow: `/spec` and `/plan` size the work, `/tasks` imports the table, `/implement` claims a ticket and branches from it, `/test-and-fix` records acceptance-criteria evidence, and `/pr-ready` writes a handoff and submits.
- **AC-6**: WHEN the work is done THEN the 4 legacy `.agent/backlog/items.md` files with no open items are gone, and each `flow-*` skill exists once per harness for Claude Code (from the plugin).
