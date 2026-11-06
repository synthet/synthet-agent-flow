# Architecture

```text
             ┌──────────── surfaces ─────────────┐
 agents ───▶ │ CLI (agent-flow)  MCP (flow_*)    │ ─┐
 humans ───▶ │ REST + SSE  ·  web dashboard      │  │   service layer (src/core/service.ts)
 Claude ───▶ │ hooks · statusline · mod snapshot │  │   DoD runner · branch naming
             └───────────────────────────────────┘  ▼
                         FlowStore (src/core/store.ts) ── transitions (states.ts) · gates · WIP · leases
                                   │
                 .agent-flow/flow.db (SQLite, WAL)  ◀── shared by every worktree (git-common-dir)
                                   │
              events (append-only, hash-chained) ──▶ listeners ──▶ outbox ──▶ agent-mail / gh
                                   │
                 .agent-flow/tickets.jsonl (deterministic snapshot, committed)
```

## Storage

- **Location.** `resolveRoot()` follows `git rev-parse --git-common-dir`, so linked worktrees share one tracker. `AGENT_FLOW_HOME` overrides the location.
- **`node:sqlite`.** The tracker uses Node's built-in SQLite, so there are no native modules and no ABI rebuilds. Settings: WAL, `busy_timeout = 10s`, foreign keys on. Migrations are append-only and keyed on `PRAGMA user_version`.
- **Tables.**
  - Work items: `tickets`, `acceptance_criteria`, `deps` (kinds `blocks`, `parent`, `discovered-from`), `comments` (kinds `note`, `handoff`, `review`, `system`).
  - People and runs: `sessions` holds transcript *pointers*, never transcripts. `agents` records who has been seen.
  - Infrastructure: `events`, `outbox`, `locks`, `kv`.
- **Snapshot.** `tickets.jsonl` holds one ticket per line in canonical JSON (sorted keys), sorted by id. It is rewritten atomically (tmp file plus rename) after every committed mutation. `.gitattributes` marks it `merge=union`. On a fresh clone the DB is rebuilt from it. `agent-flow import` merges a teammate's snapshot, and the newer `updated_at` wins.
- **IDs** look like `<prefix>-<5 base36>`. They are hash-style, so tickets created on different branches or machines never collide.

## Concurrency

- Every mutation runs in `BEGIN IMMEDIATE`, so writers serialise on the SQLite write lock.
- **Claim** is a compare-and-set: `UPDATE … WHERE status='ready' AND (lease expired)`, and it only succeeds if exactly one row changed. The WIP check, dependency check and reap all happen inside the same transaction.
  - `test/cli.test.ts` spawns 8 processes racing for 5 tickets. Exactly 5 claims succeed, all on different tickets, and the other 3 get `NOT_FOUND`.
- **Leases** default to 30 minutes and are extended by `heartbeat`. The PostToolUse hook heartbeats every 5 minutes while the owner works. `reap()` runs lazily on reads and on a server timer.
- **Optimistic concurrency** for edits: `version` is incremented on every change, and `update(…, expectedVersion)` throws `VERSION_CONFLICT` if it doesn't match.
- **Worktree creation** is serialised through a TTL lock row. Parallel `git worktree add` races on `.git` locks; see anthropics/claude-code#55724 and #104026.

## Lifecycle rules (`src/core/states.ts`)

A single transition table decides which actions are legal from which statuses. Some actions need the owner, some need a reason, and `unblock` resolves dynamically: back to `in_progress` if the ticket has an owner, otherwise to `ready`. On top of the table, the store enforces these gates:

| Gate | Rule |
|---|---|
| submit | handoff note since claim (`requireHandoff`), DoD passed, no AC marked Failed |
| approve | every AC Verified (Verified requires evidence), approver ≠ owner (`allowSelfApprove`) |
| close | only when `requireReview` is off, or with `--force` from a human |
| reject | reason required; `rework_count++`; at `maxAttempts` the ticket goes to `blocked` with `needs-human` |
| force | only `human:` and `system:` actors |

Actor kinds come from the actor prefix: `human:…`, `system:…`, and anything else (`claude:…`, `codex:…`) is an agent.

## Audit chain

Each event's hash is computed as follows:

```text
hash = sha256(prev_hash + canonical({seq, ts, actor, actor_kind, action, ticket_id, payload}))
```

The chain starts from a zero genesis hash. SQLite triggers reject `UPDATE` and `DELETE` on `events`. `agent-flow audit verify` re-hashes the whole chain and reports the first broken `seq`. Canonical JSON follows the same contract as synthet-agent-mailbox (`src/fabric/canonical.ts`).

## Security model

- **Dashboard and REST**
  - The server binds to loopback.
  - It rejects any non-loopback `Host` header with 421, which guards against DNS rebinding.
  - It sends a strict CSP (`script-src 'self'`, no inline script or style). Every value is rendered with `textContent`, because ticket text is written by agents and is untrusted.
  - Writes need `Authorization: Bearer <token>` from `.agent-flow/serve.json` (mode 0600). Cross-origin writes are refused.
  - The GitHub webhook checks the `X-Hub-Signature-256` HMAC.
- **Hooks**
  - stdin is parsed with a permissive zod schema, and anything unexpected produces `{}`.
  - Hooks fail open on internal errors.
  - They never emit `permissionDecision: "allow"`; they only deny.
  - This follows the framework's `hook-loopback-safety` rules.
- **MCP**
  - Every tool input is validated with zod.
  - Tools carry read and write annotations.
  - Destructive and bulk tools (`flow_cancel`, `flow_reopen`, `flow_import_tasks`) need `confirmed: true`.
  - Errors are structured as `{code, message, details, retryable, next_steps}`.
- **Outbound data**
  - Mailbox messages carry ids, titles and reasons, never ticket bodies.
  - Swarm prompts and GitHub bodies go through secret redaction (ported from synthet-agent-swarm).
