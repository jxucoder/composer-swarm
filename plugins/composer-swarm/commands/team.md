---
description: Launch a local Composer worker team for a task
argument-hint: '<task> [--builders 2] [--background|--wait] [--model <model>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team $ARGUMENTS`

Return the command output directly. Do not reinterpret it.
