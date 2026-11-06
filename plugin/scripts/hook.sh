#!/bin/sh
# Hook shim: if the CLI is not installed, stay silent (fail open) instead of erroring every event.
# Exit code 2 from `agent-flow hook` (e.g. a failing DoD gate) is passed through.
if [ -n "$AGENT_FLOW_BIN" ]; then exec $AGENT_FLOW_BIN hook "$1"; fi
if command -v agent-flow >/dev/null 2>&1; then exec agent-flow hook "$1"; fi
cat >/dev/null
echo '{}'
exit 0
