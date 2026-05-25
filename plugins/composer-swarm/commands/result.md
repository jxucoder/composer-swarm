---
description: Show scout output, candidate comparison, reviewer notes, synthesis, findings, JSON, and next steps for a Composer Swarm task
argument-hint: '[task-id] [--verbose|--findings|--synthesis|--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" result "$ARGUMENTS"`

Present the command output directly. Do not summarize or condense it.
Preserve task IDs, synthesis coverage, verification summaries, parsed research/review findings, verification tiers, source workers, research angles, candidate IDs, recommendation hints, patch paths, worktree paths, verifier checks, baseline versus candidate-specific failures, apply warnings, reviewer notes, validation guidance, and next steps.
