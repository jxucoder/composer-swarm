---
description: Launch a planner and reviewer for a preset repository review
argument-hint: '[--preset repo|security|tests] [--background|--wait] [--model <model>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a review-only Composer Swarm task through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- The task uses planner + reviewer workers only; no builder patches are created.
- Return the runtime output directly after launch or completion.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, start the review in the background.
- Otherwise, estimate review size before asking:
  - Run `git status --short --untracked-files=all`.
  - Repository reviews often take a while, so recommend background unless the repo/change is clearly tiny.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" review "$ARGUMENTS --wait"
```

Background flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" review "$ARGUMENTS --background"
```

If the user already supplied `--wait` or `--background`, preserve the arguments exactly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" review "$ARGUMENTS"
```

Output rules:
- Present stdout and stderr without summarizing or rewriting.
- Do not act on review findings unless the user asks in a later message.
