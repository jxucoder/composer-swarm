---
description: Cancel a running composer-swarm task
argument-hint: '<task-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" cancel $ARGUMENTS`

Return the command output directly. Do not reinterpret it.
