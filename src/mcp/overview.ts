/** `flow://workflow/overview` — agents read this first (Backlog.md pattern). Also embedded in skills. */
export const WORKFLOW_OVERVIEW = `# agent-flow workflow

agent-flow is this project's backlog provider and the single source of truth for work.
Never track work in TODO.md files, ad-hoc checklists or chat. File discovered work as tickets.

## States
backlog → ready → claimed → in_progress → review → done   (+ blocked, cancelled)
- **ready** is a pull queue: unblocked (all \`blocks\` deps done), unclaimed, ordered expedite-lane first, then priority, then age.
- A claim is atomic and leased (default 30 min). Heartbeat while working; expired leases return to ready.
- Epics roll up automatically from their children; never claim an epic.

## Five-step loop (synthet-code-framework backlog contract)
1. **Pick** — \`flow_ready\` (or \`agent-flow ready\`). Empty queue → don't pick work on your own. When the user asks for work, file it first
   (\`flow_create {title, acceptance, ready:true}\` for a bug or chore, or the \`flow-plan\` skill for a feature), then claim it.
2. **Claim** — \`flow_claim {next:true}\` or \`{id}\`. Work on the returned \`branch\` (one branch/worktree per ticket).
3. **Start** — \`flow_transition {action:"start"}\` (the PostToolUse hook does this on your first commit).
4. **Block** — \`flow_transition {action:"block", reason, unblock_condition}\` the moment progress stops.
5. **Reference** — the PR body says \`Refs <ticket-id>\` (and \`Closes #<issue>\` when mirrored to GitHub).

## Done means evidence
- Each acceptance criterion needs a verdict: \`flow_ac {op:"verify", ac_id, verdict:"Verified", evidence}\`. Verified needs evidence
  (test output, command, file:line). Unknown never counts as a pass.
- Before \`submit\`: write a **handoff** note (\`flow_comment {kind:"handoff"}\`): what changed, decisions and why, what's left, gotchas.
- \`submit\` runs the project's Definition-of-Done commands and refuses on red.
- \`approve\` is done by someone who did not work on the ticket. An agent approver must record its own Verified verdict on every
  criterion. For your own ticket, call \`flow_review_brief {id}\` and hand its \`prompt\` to a fresh subagent (Claude Code:
  agent-flow:flow-reviewer); it acts with \`actor: <reviewer>\`. Swarm review or a human can approve too. Rejections send the ticket back;
  after \`maxAttempts\` rejections it escalates to **blocked + needs-human**.

## Discovered work
\`flow_create {title, discovered_from:<current id>}\` — link it, don't silently expand scope.

## Ids and actors
Ticket ids look like \`af-k3x9q\`. Pass your \`actor\` (e.g. \`claude:<session>\`) on write calls when the server default is shared.
Errors are structured: \`{code, message, retryable, next_steps}\` — follow \`next_steps\`.
`;
