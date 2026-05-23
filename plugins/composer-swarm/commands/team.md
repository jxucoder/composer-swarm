---
description: Launch a local Composer worker team for a task
argument-hint: '<task> [--builders 2] [--background|--wait]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Launch a Composer Swarm implementation team through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- Composer workers edit only isolated git worktrees.
- Composer workers use Cursor model `composer-2.5-fast` only.
- Do not apply any candidate patch from this command.
- Return the runtime output directly after launch or completion.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, start the task in the background.
- Otherwise, estimate task size before asking:
  - Run `git status --short --untracked-files=all`.
  - If the request sounds broad, multi-step, or touches more than a trivial change, recommend background.
  - Recommend waiting only for a tiny task where the user clearly wants immediate results.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

When the user already supplied `--wait` or `--background`, preserve the arguments exactly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS"
```

Otherwise append the chosen mode as a separate CLI flag after the raw arguments.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS" --wait
```

Background flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS" --background
```

Composer Swarm uses CLI `--background` to spawn a detached Node runner and record its PID. This keeps background tasks observable through `/composer:status` and `/composer:result` without relying on host-specific background Bash APIs.

Output rules:
- Present stdout and stderr without summarizing or rewriting.
- If background mode starts successfully, tell the user to check `/composer:status` and `/composer:result`.
