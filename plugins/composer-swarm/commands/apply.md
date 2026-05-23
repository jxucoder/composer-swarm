---
description: Apply exactly one stored composer-swarm candidate patch
argument-hint: '<task-id> --candidate <candidate-id>|--recommended'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" apply "$ARGUMENTS"`

Apply only the candidate explicitly requested by the slash-command arguments.
`--recommended` is allowed only when the user intentionally invoked this apply command with that flag.
Return the command output directly. Do not reinterpret it.
