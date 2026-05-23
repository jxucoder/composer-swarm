---
description: Run read-only Composer Swarm research while the main agent keeps investigating
argument-hint: '<question> [--workers 2] [--focus architecture|tests|security|docs|release] [--include-untracked|--snapshot-current] [--background|--wait]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Launch a read-only Composer Swarm research task through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is research-only.
- Dirty and untracked checkouts are allowed. The runtime snapshots current changes into read-only worker worktrees when needed.
- Composer workers use Cursor model `composer-2.5-fast` only.
- Do not fix issues, create patches, verify candidates, or apply anything from this command.
- Composer output is evidence and scout leads for the main agent; it is not authority or a reviewer of record.
- The main agent should continue its own repo investigation and cross-check important Composer findings.
- Workers run in read-only plan mode; if shell/test execution is unavailable, treat that as a verification gap.
- Return the runtime output directly after launch or completion.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, use Claude background Bash execution when available. The
  runtime itself records a detached local run.
- Otherwise, estimate research size before asking:
  - Run `git status --short --untracked-files=all`.
  - Repository research often takes a while, so recommend background unless the question is clearly tiny.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra research instructions or rewrite the user's question.

Foreground flow:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" research "$ARGUMENTS"
```

- Return stdout and stderr without summarizing or rewriting.
- Do not act on research findings unless the user asks in a later message.

Detached/background flow:
- Launch the wrapper with `Bash` background execution:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" research "$ARGUMENTS"`,
  description: "Composer Swarm research",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Composer Swarm research started as a detached local run. Continue the main investigation and check `/composer:status` for progress."

Output rules:
- Present foreground stdout and stderr without summarizing or rewriting.
- Do not act on research findings unless the user asks in a later message.
