---
description: Show candidate comparison, reviewer notes, and next steps for a composer-swarm task
argument-hint: '[task-id] [--verbose]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" result "$ARGUMENTS"`

Present the command output directly. Do not summarize or condense it.
Preserve task IDs, candidate IDs, recommendation hints, patch paths, worktree paths, verifier checks, baseline versus candidate-specific failures, apply warnings, reviewer notes, and next steps.
