# synthet-code-framework integration kit

This kit lets projects seeded from [synthet-code-framework](https://github.com/synthet/synthet-code-framework) use agent-flow as their backlog provider.

| File | Copy to (in the seeded project) | Purpose |
|---|---|---|
| `.agent/backlog/providers/agent-flow.md` | same path | Provider doc: status mapping, five-step contract, SDD import |
| `backlog-readme-block.md` | appended to `.agent/backlog/README.md` | Names agent-flow as the active provider |
| `snippets/task-claim.agent-flow.md` | section in `.claude/commands/task-claim.md` | `/task-claim --provider agent-flow` |
| `snippets/backlog-queue.agent-flow.md` | provider order in `.claude/skills/backlog-queue/SKILL.md` | Provider resolution |

`agent-flow install --framework <project>` copies the first two files and the CLAUDE.md block. It never overwrites a file, and it writes a receipt so `agent-flow uninstall` can undo the change. Paste the snippets by hand: the framework's `scripts/sync_assistant_trees.py` regenerates the `.cursor/` and `.agents/` mirrors from `.claude/`.

**Upstreaming:** to make agent-flow a built-in provider of the framework, open a PR there that:
- adds the provider doc under `.agent/backlog/providers/`,
- adds the provider to `backlog-queue` and `task-claim`,
- adds an `agent-flow` entry to `scripts/build_plugin_manifests.py` if the framework's marketplace should list this plugin. The `source` would be a `github` object source pointing at `synthet/synthet-agent-flow`, path `plugin`.
