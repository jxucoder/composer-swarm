---
description: Health-check Composer Swarm, git, and cursor-agent for this repository
argument-hint: '[--init] [--trust] [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Check whether Composer Swarm is ready in this repository.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" setup --json "$ARGUMENTS"
```

If the JSON says `configExists` is false:
- Use `AskUserQuestion` exactly once to ask whether to initialize this repository.
- Put the init option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Initialize with trust`
  - `Show setup report only`
- If the user chooses init, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" setup --init --trust "$ARGUMENTS"
```

- If the user skips init, present the setup report from the first command without rerunning it.

If config already exists:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" setup "$ARGUMENTS"
```

Output rules:
- Present the final setup output directly.
- Preserve guidance about `cursor-agent`, git, config, and next commands.
