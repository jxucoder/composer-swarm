---
description: Run configured shell checks against composer-swarm candidate worktrees
argument-hint: '<task-id> [--candidate <candidate-id>] [--no-baseline]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" verify "$ARGUMENTS"`

Return the command output directly. Preserve baseline versus candidate-specific classifications.
