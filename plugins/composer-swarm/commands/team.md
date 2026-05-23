---
description: Delegate a repository task to fast Composer workers for broader search and candidate patches
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
- If the raw arguments include `--background`, use Claude background Bash execution when available. The
  runtime itself records a detached local run.
- Otherwise, estimate task size before asking:
  - Run `git status --short --untracked-files=all`.
  - If the request sounds broad, multi-step, or touches more than a trivial change, recommend background.
  - Recommend waiting only for a tiny task where the user clearly wants immediate results.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra task instructions or rewrite the user's intent.

Foreground flow:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS"
```

- Return stdout and stderr without summarizing or rewriting.
- Do not apply any candidate patch.

Detached/background flow:
- Launch the wrapper with `Bash` background execution:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS"`,
  description: "Composer Swarm team",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Composer Swarm started as a detached local run. Check `/composer:status` for progress."

Output rules:
- Present foreground stdout and stderr without summarizing or rewriting.
- If background mode starts successfully, tell the user to check `/composer:status` and `/composer:result`.
