---
description: Show candidate patches and reviewer notes for a composer-swarm task
argument-hint: '[task-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" result $ARGUMENTS`

Return the command output directly. Do not reinterpret it.
