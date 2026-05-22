# Composer Swarm

Use this skill when the user asks Codex to delegate a repo task to a local Composer/Cursor worker team, compare candidate patches, or apply a candidate produced by `composer-swarm`.

## Requirements

- Run commands from the target git repository.
- Use `node <composer-swarm-repo>/bin/composer-swarm.mjs` unless `composer-swarm` is already on `PATH`.
- Before starting the first task in a repo, run `composer-swarm doctor` and report missing prerequisites.
- Do not apply a candidate patch without an explicit user approval in the current conversation.

## Workflow

1. Check setup:

   ```bash
   composer-swarm doctor
   ```

2. Start the worker team:

   ```bash
   composer-swarm team "<task>" --builders 2
   ```

   Use `--background` only when the user wants Codex to continue other work while Composer runs.

3. Inspect progress and results:

   ```bash
   composer-swarm status <task-id>
   composer-swarm result <task-id>
   ```

4. Review the candidate patches yourself before recommending one. Inspect the patch files listed by `result`; do not rely only on summaries.

5. Ask the user which candidate to apply. After approval, apply exactly that candidate:

   ```bash
   composer-swarm apply <task-id> --candidate <candidate-id>
   ```

6. Run normal repo checks after apply when appropriate.

## Operating Rules

- Treat Claude Code and Codex as host/operator surfaces; Composer workers are launched through `cursor-agent`.
- Candidate selection is manual. The CLI reports facts and does not auto-rank.
- Worktree isolation is mandatory for editing workers.
- The v1 repo-only release has no MCP server, no npm package, no marketplace submission, and no auto-merge.
