# API reference

All surfaces share one service layer and one error envelope:

```json
{ "error": { "code": "CLAIM_CONFLICT", "message": "…", "details": {}, "retryable": true, "next_steps": ["…"] } }
```

Codes are `NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_TRANSITION`, `CLAIM_CONFLICT`, `NOT_OWNER`, `WIP_LIMIT`, `BLOCKED_BY_DEPENDENCY`, `GATE_FAILED`, `CYCLE`, `VERSION_CONFLICT`, `NOT_INITIALIZED`, `CONFIRMATION_REQUIRED`, `EXTERNAL_FAILURE`, `UNAUTHORIZED` and `INTERNAL`.

## CLI

`agent-flow <command> [--json] [--actor id] [-C dir]`. Exit codes: `0` ok · `1` error · `2` conflict, blocked or gate failed. Run `agent-flow help <command>` to see every flag.

| Group | Commands |
|---|---|
| setup | `init [--prefix af] [--dod cmd]… [--no-review]` · `where` · `config get\|set` · `install` · `uninstall` |
| tickets | `create <title> [--ready] [--type] [-p p0-p3] [--lane] [-l label]… [--scope path]… [--ac text]… [--parent epic] [--dep id]… [--discovered-from id] [--body\|--body-file]` · `edit <id> …` · `show [<id>]` · `list [--status s,s] [--mine] [--label] [--epic] [-q]` · `ready [--label] [--epic] [--skills a,b]` · `board` · `tree [<epic>]` · `log [<id>] [--since seq]` · `stats` · `adoption [--root dir] [--since 30d]` (cross-repo: commits by the repo user vs tickets; flags commits with no tickets) |
| AC / deps / notes | `ac add <id> <text>` · `ac verify <id> AC-n --verdict Verified\|Failed\|Unknown --evidence …` · `ac list <id>` · `dep add\|rm <id> <on> [--kind blocks\|parent\|discovered-from]` · `comment <id> <text> [--kind]` · `note [<id>] <text> [--handoff] [--file -]` |
| lifecycle | `claim [<id>\|--next] [--label] [--lease min]` · `heartbeat` · `start` · `release [--reason]` · `block --reason --until` · `unblock` · `submit [--skip-dod]` · `approve` · `reject --reason` · `close` · `reopen --reason` · `cancel` · `promote <id>…` · `demote` |
| agents | `prime [--ticket] [--branch]` · `branch <id>` · `dod` · `agent register --harness --skills` · `agent list` · `worktree create\|rm\|path <id>` · `hook <event>` · `statusline` · `snapshot [--session id]` |
| sdd | `import-tasks <file\|dir> [--format auto\|framework\|speckit\|openspec\|checklist] [--spec spec.md] [--epic id] [--no-epic] [--backlog] [--dry-run]` · `import-backlog [items.md]` |
| integrations | `github push [<id>…]\|reconcile\|pr <id>\|body <id>` · `mailbox test\|flush\|status` · `review <id> --swarm [--agents …] [--dry-run]` |
| automation | `loop start\|run\|stop\|status [--max N] [--label l] [--harness claude\|codex] [--max-turns N]` |
| servers | `serve [--port 8791] [--open] [--no-registry]` · `workspaces [list]\|add [dir…]\|remove <id\|dir>…\|scan [root] [--dry-run]` · `mcp` |
| data | `export [--out f\|--stdout]` · `import [file]` · `reap` · `audit verify` |

When a lifecycle or detail command gets no `<id>`, it uses the ticket bound to the current branch (`af/<id>-…`). If no ticket is bound, it falls back to the actor's active ticket.

## MCP (`agent-flow mcp`, stdio)

| Tool | Kind | Input |
|---|---|---|
| `flow_ready` | read | `label?, epic?, lane?, skills?, limit` |
| `flow_list` | read | `status?[], owner?, label?, epic?, type?, query?, include_closed?, limit` |
| `flow_get` | read | `id, events` |
| `flow_board` | read | `epic?, label?` |
| `flow_events` | read | `since?, ticket_id?, limit` |
| `flow_context` | read | `branch?, ticket_id?, actor?, label?` → `{ticket, text}` markdown |
| `flow_stats` | read | — |
| `flow_create` | write | `title, body?, type?, priority?, lane?, labels?, scope_paths?, acceptance?[], parent?, depends_on?, discovered_from?, ready, actor?` |
| `flow_update` | write | `id, …fields, expected_version?, actor?` |
| `flow_claim` | write | `id? \| next: true, label?, epic?, skills?, lease_minutes?, actor?` |
| `flow_heartbeat` | write | `id, lease_minutes?, actor?` |
| `flow_release` | write | `id, reason?, actor?` |
| `flow_transition` | write | `id, action: start\|block\|unblock\|submit\|approve\|reject\|close\|promote\|demote, reason?, unblock_condition?, skip_dod?, actor?` |
| `flow_comment` | write | `id, body, kind: note\|handoff\|review, actor?` |
| `flow_ac` | write | `id, op: add\|verify, ac_id?, text?, verdict?, evidence?, actor?` |
| `flow_dep` | write | `id, depends_on, kind, remove?, actor?` |
| `flow_cancel` | destructive | `id, reason?, confirmed` |
| `flow_reopen` | destructive | `id, reason, confirmed` |
| `flow_import_tasks` | bulk | `path, format, spec?, epic_title?, no_epic?, backlog?, dry_run?, confirmed` |

Resources: `flow://workflow/overview` (markdown; read it first), `flow://board` (JSON) and `flow://ticket/{id}` (markdown context).

The server's default actor comes from `--actor`, then `AGENT_FLOW_ACTOR`, then the session environment. Agents pass `actor` (for example `claude:<session>`) on write calls; the SessionStart hook tells them their id.

Deviation from the framework's `mcp-server-design`: only destructive and bulk tools require `confirmed: true`. Ordinary lifecycle writes don't, so the agent loop isn't stalled by confirmation prompts. Every write is still audited and gated by the store.

## REST (`agent-flow serve`)

Loopback only. One server is a hub for every project in the workspace registry. Writes need `Authorization: Bearer <token>`, using either the hub token (`~/.agent-flow/serve.json`, next to the registry) or the target project's own `.agent-flow/serve.json`. The actor comes from `X-Flow-Actor` or `body.actor`, and defaults to the server's `human:` actor.

Every project route below is served under `/api/w/<workspace-id>/…`. The bare `/api/…` form addresses the default workspace, which is the project `serve` was started in. It returns 404 when the hub has no default workspace.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspaces` | `{default, actor, registry, workspaces: [{id, name, root, default, status: ok\|missing\|error, counts, ready, needs_human, done_last_7d, review[], in_flight[], agents[], last_event}]}` |
| POST | `/api/workspaces/:id/forget` | Remove a workspace from the registry (its files are untouched). Needs the hub token. |
| GET | `/api/stream` | SSE from every workspace; each event has `workspace`. `/api/w/:id/stream` is one workspace and replays with `Last-Event-ID` / `?since=`. |

Per-project routes:

| Method | Path | Notes |
|---|---|---|
| GET | `/`, `/app.js`, `/app.css` | dashboard (CSP `script-src 'self'`) |
| GET | `/health` | `{ok, last_seq}` |
| GET | `/api/meta` | statuses, lanes, transition map, config summary |
| GET | `/api/board?epic&label&lane&q` | columns with WIP limits |
| GET | `/api/ready?label&epic` · `/api/tickets?status&owner&label&epic&type&q&all=1` · `/api/tickets/:id` | |
| GET | `/api/events?since&ticket&limit` · `/api/agents` · `/api/stats` · `/api/epics` · `/api/sessions` | |
| GET | `/api/stream` | SSE `event: flow` per audit event; tails each project's DB, so CLI and agent writes appear live |
| POST | `/api/tickets` | create (`ready: true` for the queue) |
| PATCH | `/api/tickets/:id` | edit (`expected_version` supported) |
| POST | `/api/tickets/:id/transition` | `{action, reason?, unblock_condition?, force?, skip_dod?}` |
| POST | `/api/tickets/:id/move` | `{to: status}`: a board drag, mapped to the single legal action |
| POST | `/api/tickets/:id/comments` · `/ac` · `/deps` | |
| POST | `/hooks/github[/:workspace]` | GitHub webhook (`pull_request`, `pull_request_review`). HMAC with `$AGENT_FLOW_GITHUB_SECRET`. Only when that workspace has `github.enabled` set. |

HTTP statuses: 400 invalid, 401 unauthorised, 403 not owner, 404 not found, 409 conflict or transition, 421 non-loopback host, 422 gate or cycle, 428 confirmation required.

## Hooks (`agent-flow hook <event>`)

| Event | Reads | Emits |
|---|---|---|
| `session-start` | `session_id, cwd, source, transcript_path` | `hookSpecificOutput.additionalContext` (ticket or queue, plus actor id); appends `export AGENT_FLOW_ACTOR=…` to `$CLAUDE_ENV_FILE` |
| `pre-tool` | `tool_name=Bash, tool_input.command` | `permissionDecision: "deny"` + reason, or `{}` |
| `post-tool` | `tool_name, tool_input, tool_response` | `additionalContext` when the first commit starts the ticket, or once per session when a real commit or `gh pr create` happens while you hold no ticket (`hooks.untrackedNudge`) |
| `stop` | `stop_hook_active` | `{decision: "block", reason}` while the loop has work, or a single handoff nudge |
| `stop-failure` | `error` | halts the loop |
| `task-completed` | — | exit 2 + stderr when the DoD fails (needs `hooks.taskCompletedDod`) |
| `pre-compact` / `session-end` | `transcript_path, trigger/reason` | records the session pointer; flags a missing handoff on end |

Hooks always exit 0 with `{}` on malformed input or internal errors (they fail open). The one deliberate exception is the DoD gate's exit 2.

## Config (`.agent-flow/config.json`)

```jsonc
{
  "prefix": "af", "leaseMinutes": 30, "maxAttempts": 3,
  "wip": { "perAgent": 1, "columns": { "in_progress": 4, "review": 6 } },
  "requireReview": true, "requireHandoff": true, "allowSelfApprove": false,
  "dod": ["npm test"], "dodTimeoutMs": 600000, "autoExport": true,
  "defaultBranch": "main", "branchPattern": "af/{id}-{slug}", "worktreeDir": "../{repo}.worktrees",
  "loop": { "maxTickets": 5, "label": "agent-ok", "maxTurns": 80, "harness": "claude" },
  "github": { "enabled": false, "repo": null, "labelPrefix": "status:", "issueLabel": "agent-flow", "reconcileMinutes": 5, "webhookSecretEnv": "AGENT_FLOW_GITHUB_SECRET" },
  "mailbox": { "enabled": false, "bin": "agent-mail", "session": "agent-flow", "scope": null, "audience": "group", "notifyOn": ["claimed", "review", "rejected", "blocked", "needs_human", "done", "lease_expired"], "reviewPeer": null },
  "swarm": { "enabled": false, "path": null, "harnesses": [], "autoApproveOnMajority": false, "timeoutMs": 300000 },
  "wiki": { "enabled": false, "root": null, "outDir": "wiki/notes/agent-flow", "ingest": true, "bin": "llmwiki" },
  "hooks": { "taskCompletedDod": false, "handoffOnStop": true, "untrackedNudge": true, "heartbeatMinutes": 5 },
  "server": { "host": "127.0.0.1", "port": 8791 }
}
```

Environment overrides:

| Variable | What it sets |
|---|---|
| `AGENT_FLOW_HOME` | project root |
| `AGENT_FLOW_DB` | DB file |
| `AGENT_FLOW_ACTOR` | actor id |
| `AGENT_FLOW_BIN` | how the plugin, mod and installer invoke the CLI |
| `AGENT_MAIL_BIN` | the mailbox CLI |
| `AGENT_FLOW_SWARM_PATH` | the swarm checkout |
