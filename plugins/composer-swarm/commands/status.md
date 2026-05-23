---
description: Show active and recent Composer Swarm tasks for this repository
argument-hint: '[task-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" status "$ARGUMENTS"`

If the user did not pass a task ID, present the compact task table directly.
If the user passed a task ID, present the full status output directly.
Preserve task IDs, worker states, background PID hints, elapsed timing, and next-step commands.
