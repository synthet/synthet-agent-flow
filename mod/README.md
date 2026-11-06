# agent-flow-mod

This is a Claude Code mod (in-process UI plugin) for [agent-flow](https://github.com/synthet/synthet-agent-flow). It shows your current ticket inside Claude Code, so you don't have to leave the chat to see it.

- **`/flow-board`** opens a pane with:
  - the ticket bound to your branch or session: status, lease countdown, and its acceptance-criteria checklist with verdicts
  - the last handoff note
  - the head of the ready queue
  - counts for review, blocked and needs-human tickets
- **Band above the prompt** appears when your ticket is in review or blocked, or when tickets need a human.
- **Status line entry** looks like `⚑ af-k3x9q · in_progress · AC 1/3`.
- **Toasts** appear when your ticket changes state.

The mod reads `agent-flow snapshot --json`. It polls every 20 s, and also after any Bash call that touches `agent-flow` or `git commit`. The CLI must be on PATH, or set `AGENT_FLOW_BIN` (for example `node /path/to/bin/agent-flow.js`).

Install:

```
/plugin marketplace add synthet/synthet-agent-flow
/plugin install agent-flow-mod@synthet-agent-flow
```

You can also load it with `claude --plugin-dir mod` while developing.
