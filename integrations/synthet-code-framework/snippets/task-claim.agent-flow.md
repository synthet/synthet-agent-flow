### agent-flow (atomic claims; preferred when several agents share the backlog)

```bash
agent-flow claim "<item-ref>" --json      # or: agent-flow claim --next [--label agent-ok]
```

- Exit code 2 with `CLAIM_CONFLICT`: someone else holds the item. Pick another one with `agent-flow ready`.
- Exit code 2 with `WIP_LIMIT`: finish or release the item you already hold.
- The JSON output includes `branch` (`af/<id>-<slug>`). Work on that branch. The first commit moves the item to In Progress.

See [`.agent/backlog/providers/agent-flow.md`](../../.agent/backlog/providers/agent-flow.md).
