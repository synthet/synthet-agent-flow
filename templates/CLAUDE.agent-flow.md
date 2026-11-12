<!-- BEGIN AGENT-FLOW -->
## Work tracking: agent-flow

This project tracks all work in **agent-flow** (`.agent-flow/`). It is the backlog provider.
- Pick from the ready queue (`agent-flow ready`). Claim before you code (`agent-flow claim <id>`). One ticket = one branch = one PR.
- Every acceptance criterion needs evidence (`agent-flow ac verify`). Write a handoff note before you stop. `agent-flow submit` moves a ticket to review. Never self-approve: `agent-flow review <id> --brief` gives an independent subagent the reviewer id and prompt to approve it.
- File discovered work with `agent-flow create … --discovered-from <id>`. Never use TODO.md files.
- PR bodies say `Refs <ticket-id>`.
- Dashboard: `agent-flow serve`. MCP: the `flow_*` tools. Skills: `/agent-flow:flow-next`, `/agent-flow:flow-work`, `/agent-flow:flow-complete`.
<!-- END AGENT-FLOW -->
