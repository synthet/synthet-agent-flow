# Integrations

## synthet-code-framework

agent-flow implements the framework's **backlog-provider contract** (`.agent/backlog/README.md`):

| Framework | agent-flow |
|---|---|
| Logical states Backlog/Ready/Claimed/In Progress/Blocked/Review/Done | The same statuses, one to one |
| 1. Pick from the ready queue | `agent-flow ready` / `flow_ready`. The queue is computed from dependencies. |
| 2. Claim (record an owner) | `agent-flow claim` is atomic and leased, which Local Markdown and GitHub Issues cannot offer |
| 3. In Progress on first commit | done automatically by the PostToolUse hook |
| 4. Block with reason + unblock condition | `agent-flow block --reason --until` |
| 5. PR references the item | `Refs <id>`, and `agent-flow github pr` writes it for you |
| `/tasks` `T-n` table with deps, `AC-n`, verification | `agent-flow import-tasks tasks.md --spec spec.md` creates an epic and tickets with blocking edges |
| `validate-implementation` verdicts Verified/Failed/Unknown, Verified needs evidence | `agent-flow ac verify`, with the same rules |
| `autonomous-run-contract` | `agent-flow loop start|run` writes the contract into `loop.json` |
| `hook-loopback-safety` | Hooks read stdin through zod, fail open, and never emit `allow` |
| SKILL.md frontmatter (`capability`, `side_effect_level`, `approval_required`, `requires_tools`, `output_schema`, `risk_class`) | Present on every plugin skill, so `check_agent_frontmatter.py` passes when they are vendored |

Adopt in a seeded project with `agent-flow install --framework .`. The kit and the upstreaming notes are in [`integrations/synthet-code-framework/`](../integrations/synthet-code-framework/README.md).

## synthet-agent-mailbox

agent-flow owns tickets; the mailbox only carries notifications. The mailbox's own `task.*` events are not used, so there is never a second source of truth.

```bash
agent-flow config set mailbox.enabled true
agent-flow config set mailbox.scope '"team-flow"'      # a journal scope your agents subscribe to
agent-flow config set mailbox.reviewPeer '"Laptop"'    # optional: direct, encrypted peer message for review requests
agent-flow mailbox test
```

- Events are mapped to kinds:

  | Event | Kind |
  |---|---|
  | `ticket.claimed` | `claimed` |
  | `ticket.submitted` | `review` |
  | `ticket.rejected` | `rejected` |
  | `ticket.blocked` | `blocked` |
  | `ticket.escalated` | `needs_human` |
  | `ticket.approved` / `ticket.closed` | `done` |
  | `lease.expired` | `lease_expired` |

  `mailbox.notifyOn` filters which kinds are sent.
- Delivery:
  - Journal notifications go through the mailbox's own MCP server: `agent-mail mcp --no-listen`, one process per outbox flush. It runs `mailbox_register_session`, then `mailbox_subscribe` (scope), then `mailbox_publish`.
    - Why MCP: the journal only lets **scope members** publish to group/topic audiences, and only the MCP surface exposes `mailbox_subscribe`. The CLI has `register` and `publish` but no `subscribe`.
    - Each publish carries a content-derived `idempotency_key`, so a retried job comes back `duplicate: true` instead of posting twice.
  - Review requests also run `agent-mail send <reviewPeer> --text …` over the CLI's encrypted peer path. Exit code 2 (queued) counts as success.
  - Prerequisite: the machine has a mailbox identity (`agent-mail init --name <pc>`). Without one, the outbox error says so, and jobs retry with backoff.
  - Verified against a real synthet-agent-mailbox 0.3.0 build:
    - CLI test message, claim/block notifications and review requests all arrived, the review requests reaching a second, trusted peer's inbox.
    - Mailbox wart found along the way: `agent-mail identity` output includes `origin` and `agent` keys that `trust --file` rejects. Strip them before trusting.
- Bodies hold the ticket id, title, actor, reason, unblock condition, branch, project and event seq. Ticket specs are never included, and secrets are redacted.
- Delivery goes through the outbox, with exponential backoff and at most 10 attempts. The CLI flushes it, bounded to 8 s per command. The MCP server flushes after tool calls, and the dashboard server flushes every 30 s. A broken mailbox never blocks a tracker write.

## synthet-agent-swarm

```bash
agent-flow config set swarm.path '"/path/to/synthet-agent-swarm"'   # needs agent-orchestrator/dist built
agent-flow review af-k3x9q --swarm [--agents codex,claude,antigravity] [--dry-run]
```

1. agent-flow builds a read-only review task. It contains the spec, the acceptance criteria with the author's claimed evidence, the handoff note and `git diff --stat <default>...<branch>`. The task is redacted and capped at 8000 characters.
2. It starts the swarm's MCP server (`node <swarm>/agent-orchestrator/dist/index.js`, with `WORKSPACE_ROOT` set to the repo). Then it calls `swarm_run {mode: "review", task, files: <scope_paths>, harnesses?, timeoutMs, dryRun}`. This is the swarm's current API; the legacy `swarm` CLI wrapper is not used.
3. Each judge must end its reply with a flat JSON object: `{"verdict":"approve|reject","AC-1":"pass|fail|unknown",…,"reason":"…"}`.
4. Two or more harnesses: the swarm's strict-majority `agreement` is parsed. With a single installed harness the swarm returns no agreement, so agent-flow reads that judge's `outputFile` (`stdout.md`) and takes its last JSON object. Ties stay "disputed". The result is recorded as a `review` comment plus a `swarm.reviewed` event.
5. With `swarm.autoApproveOnMajority: true`, the ticket is approved as `system:swarm`, but only with at least **two** parsed judges, an approve verdict, and a majority pass on every criterion. A single harness never auto-approves.

Verified against a real synthet-agent-swarm build with the Claude Code harness. `--dry-run` lists the planned `claude -p` command. A real run reviewed the diff and recorded a per-criterion pass in about 16 s. The swarm writes run artifacts to `.agent-runs/` in the workspace; gitignore it.

## GitHub

The mirror is one-way. agent-flow owns agent state; GitHub owns the issue's title and body once it exists.

```bash
agent-flow config set github.enabled true      # repo comes from `gh repo view` unless github.repo is set
agent-flow github push                          # tickets → issues; epic children → sub-issues; status:* labels
agent-flow github pr af-k3x9q                   # PR with Refs/Closes + AC checklist
agent-flow github reconcile                     # PR state → tickets (also runs at SessionStart, rate-limited)
```

| PR state | Ticket effect |
|---|---|
| open | `pr_url` recorded |
| open + CHANGES_REQUESTED (ticket in review) | reject with a link → `in_progress` |
| closed without merge (ticket in review) | reject |
| merged | approve, as `system:github`; the human merge is the approval |

Each (PR, state, decision) is applied once, which prevents echo loops. Status changes on mirrored tickets queue a label update in the outbox.

To get push-style updates instead of polling, point a GitHub webhook at `/hooks/github`, for example through a tunnel to the loopback server. Set `AGENT_FLOW_GITHUB_SECRET`.

## Claude Code, Cursor and Codex

- **Claude Code:** use the plugin (recommended) or `agent-flow install --harness claude`. See [README](../README.md#claude-code-integration).
- **Cursor:** `agent-flow install --harness cursor` adds the MCP server plus an always-on rule.
- **Codex:** `agent-flow install --harness codex` adds `[mcp_servers.agent-flow]` to `~/.codex/config.toml`. `agent-flow loop run --harness codex` drives `codex exec` with a CLI-only prompt.

Every install is additive, backs up each file it touches and writes a receipt. `agent-flow uninstall` restores a file only if its sha256 still matches what the install wrote.

## Transcripts and memory

agent-flow stores **pointers** in the `sessions` table: session id, `transcript_path`, branch, commit and reason. It never stores transcript contents, which are large, noisy and can contain secrets.

The valuable artefact is the **handoff note**, which `submit` requires and the Stop hook nudges for. For human-readable archives, pair agent-flow with SpecStory. For semantic memory, pair it with claude-mem. Both can read the `transcript_path` values agent-flow records.
