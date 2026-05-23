---
description: List or print Composer Swarm worker transcripts for a task
argument-hint: '[task-id] [--worker <label>] [--tail 80]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" logs "$ARGUMENTS"`

Present the command output directly. If no worker is selected, preserve the transcript list and usage hint. If a worker is selected, preserve event timestamps, event types, worker output, errors, and timeout details.
