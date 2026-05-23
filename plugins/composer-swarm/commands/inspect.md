---
description: Show local state paths, transcripts, worktrees, patch artifacts, and useful commands for a Composer Swarm task
argument-hint: '[task-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" inspect "$ARGUMENTS"`

Present the command output directly. Preserve task IDs, state paths, transcript paths, worktree paths, patch paths, worker labels, and useful follow-up commands.
