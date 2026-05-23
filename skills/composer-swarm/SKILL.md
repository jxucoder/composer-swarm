---
name: composer-swarm
description: Delegate repo tasks to local Composer/Cursor worker teams, compare candidate patches, verify checks, and apply an approved candidate.
---

# Composer Swarm

Use this skill when the user asks Codex to delegate implementation or review work to Composer/Cursor workers, compare swarm candidates, verify candidates, or apply a selected patch.

Role split: Codex plans and reviews. Composer writes isolated candidates. Codex verifies, compares, and applies only after explicit approval.

## Runtime

- Prefer `composer-swarm` when it is on `PATH`.
- Otherwise run `node <composer-swarm-repo>/bin/composer-swarm.mjs ...`.
- Run commands from the target repository.
- Composer workers must use Cursor model `composer-2.5-fast` only.
- Composer workers edit isolated git worktrees; the Codex host supervises and chooses.

## Default Flow

1. Check setup before the first task:

   ```bash
   composer-swarm setup
   ```

   If config is missing, initialize with trusted worktrees:

   ```bash
   composer-swarm setup --init --trust
   ```

2. Start a task. Prefer background for broad or multi-step work:

   ```bash
   composer-swarm team "<task>" --builders 2 --background
   ```

   For review-only work:

   ```bash
   composer-swarm review --preset repo --background
   composer-swarm review --preset security --background
   composer-swarm review --preset tests --background
   ```

3. Inspect progress and output:

   ```bash
   composer-swarm status <task-id>
   composer-swarm result <task-id>
   composer-swarm result <task-id> --verbose
   ```

4. Verify candidates before recommending one when implementation patches exist:

   ```bash
   composer-swarm verify <task-id>
   composer-swarm verify <task-id> --candidate builder-a
   ```

5. Review the actual patch files listed by `result`; do not rely only on summaries or heuristic recommendations.

6. Ask the user which candidate to apply. After explicit approval, apply exactly that candidate:

   ```bash
   composer-swarm apply <task-id> --candidate <candidate-id>
   composer-swarm apply <task-id> --recommended
   ```

7. Run normal repo checks after apply and clean up worktrees:

   ```bash
   composer-swarm cleanup <task-id>
   ```

## Operating Rules

- Do not apply a candidate patch without explicit user approval in the current conversation.
- `--recommended` is only a shortcut after the user approves the detected recommendation.
- Treat reviewer recommendations as heuristic. Inspect patches yourself.
- `verify` distinguishes baseline failures from candidate-specific failures.
- If the current directory is not a git repo, use the setup/status guidance to choose the correct repository.
- Do not edit worker worktrees manually unless debugging Composer Swarm itself.
