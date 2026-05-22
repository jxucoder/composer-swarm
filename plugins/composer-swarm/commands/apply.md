---
description: Apply exactly one stored composer-swarm candidate patch
argument-hint: '<task-id> --candidate <candidate-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" apply $ARGUMENTS`

Return the command output directly. Do not reinterpret it.
