# agent-flow — Claude Code plugin

This plugin connects Claude Code to [agent-flow](https://github.com/synthet/synthet-agent-flow), a tracker built for coding agents. The tracker gives agents:
- a dependency-aware ready queue
- atomic, leased claims
- review gates that need evidence
- a hash-chained audit log
- a live Kanban dashboard

## What you get
- **Skills**
  - `/agent-flow:flow-next` claims the next ticket and sets up its branch or worktree.
  - `/agent-flow:flow-work` implements test-first against the acceptance criteria.
  - `/agent-flow:flow-complete` runs DoD, pushes, opens the PR, writes a handoff and submits.
  - `/agent-flow:flow-review` is the review gate (optionally with synthet-agent-swarm).
  - `/agent-flow:flow-plan` turns a spec into tasks, then an epic and tickets.
  - `/agent-flow:flow-loop` runs a capped autonomous loop.
  - `/agent-flow:flow-land` wraps up a session.
  - `/agent-flow:flow-status` summarises the board.
  - `agent-flow` holds the core rules and is model-invoked.
- **Hooks**
  - SessionStart injects the ticket bound to your branch (spec, AC, last handoff) or the ready queue, and exports your actor id.
  - PreToolUse blocks force-pushes, pushes to the default branch and `rm -r` outside the worktree, and enforces WIP.
  - PostToolUse auto-starts a ticket on its first commit and sends heartbeats.
  - Stop runs the capped next-ticket loop and nudges you to write a handoff.
  - StopFailure halts the loop.
  - PreCompact and SessionEnd record transcript pointers.
  - TaskCompleted is an optional DoD gate.
- **Agents**: `flow-reviewer` (independent AC verification) and `flow-planner` (spec → ticket graph).
- **MCP**: the `agent-flow` server with `flow_*` tools and `flow://workflow/overview`.

## Setup
1. Install the CLI: `npm i -g github:synthet/synthet-agent-flow`, or clone, then `npm i && npm link`. Set `AGENT_FLOW_BIN` to use a specific build.
2. In your repo, run `agent-flow init --dod "npm test"`.
3. Add the plugin:
   ```
   /plugin marketplace add synthet/synthet-agent-flow
   /plugin install agent-flow@synthet-agent-flow
   ```
4. Optional status line (merge into `settings.json`): `{"statusLine": {"type": "command", "command": "agent-flow statusline"}}`.

Hooks fail open: if the CLI is missing, or the repo has no `.agent-flow/`, they do nothing.
