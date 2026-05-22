---
description: Check whether composer-swarm, git, and cursor-agent are ready for this repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" setup`

Return the command output directly. Do not reinterpret it.
