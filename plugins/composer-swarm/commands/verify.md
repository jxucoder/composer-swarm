---
description: Run configured checks against Composer Swarm candidate worktrees
argument-hint: '<task-id> [--candidate <candidate-id>] [--no-baseline]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" verify "$ARGUMENTS"`

Return the command output directly. Preserve baseline versus candidate-specific classifications. Treat a
non-zero process status as failed or incomplete verification, not as a command-format error.
