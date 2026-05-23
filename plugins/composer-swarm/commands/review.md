---
description: Run a review-only Composer Swarm pass with optional scout workers
argument-hint: '[--preset repo|security|tests] [--scouts 0..4] [--include-untracked|--snapshot-current] [--background|--wait]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a review-only Composer Swarm task through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is review-only.
- Dirty and untracked checkouts are allowed. The runtime snapshots current changes into read-only worker worktrees when needed.
- Composer workers use Cursor model `composer-2.5-fast` only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- The task is read-only; optional scout passes add broader search, and no implementation patches are created.
- Return the runtime output directly after launch or completion.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, use Claude background Bash execution when available. The
  runtime itself records a detached local run.
- Otherwise, estimate review size before asking:
  - Run `git status --short --untracked-files=all`.
  - Repository reviews often take a while, so recommend background unless the repo/change is clearly tiny.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.

Foreground flow:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" review "$ARGUMENTS"
```

- Return stdout and stderr without summarizing or rewriting.
- Do not act on review findings unless the user asks in a later message.

Detached/background flow:
- Launch the wrapper with `Bash` background execution:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" review "$ARGUMENTS"`,
  description: "Composer Swarm review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Composer Swarm review started as a detached local run. Check `/composer:status` for progress."

Output rules:
- Present foreground stdout and stderr without summarizing or rewriting.
- Do not act on review findings unless the user asks in a later message.
