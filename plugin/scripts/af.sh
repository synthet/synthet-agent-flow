#!/bin/sh
# Resolve the agent-flow CLI: $AGENT_FLOW_BIN, then PATH, then npx (slow, last resort).
if [ -n "$AGENT_FLOW_BIN" ]; then exec $AGENT_FLOW_BIN "$@"; fi
if command -v agent-flow >/dev/null 2>&1; then exec agent-flow "$@"; fi
exec npx --yes --package=github:synthet/synthet-agent-flow agent-flow "$@"
