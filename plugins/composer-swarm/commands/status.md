---
description: Show active and recent composer-swarm tasks for this repository
argument-hint: '[task-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" status $ARGUMENTS`

Return the command output directly. Do not reinterpret it.
