---
name: composer-swarm
description: Delegate repo tasks to local Composer/Cursor workers for read-only research, candidate patches, verification, and approved apply.
---

# Composer Swarm

Use this skill when the user asks Codex to delegate repo research, implementation, or review work to Composer/Cursor workers, compare swarm candidates, verify candidates, or apply a selected patch.

Operating split: Codex is the main agent. Fast, low-cost Composer workers provide broader code search, extra reasoning, read-only research, isolated candidate patches, and review-only checks. Codex verifies, compares, and applies only after explicit approval.

## Runtime

- Prefer `composer-swarm` when it is on `PATH`.
- Otherwise run `node <composer-swarm-repo>/bin/composer-swarm.mjs ...`.
- Run commands from the target repository.
- Composer workers must use Cursor model `composer-2.5-fast` only.
- Composer workers edit isolated git worktrees; the Codex host supervises, compares, and chooses.
- Research workers are read-only and produce evidence for Codex to verify.

## Default Flow

1. Check setup before the first task:

   ```bash
   composer-swarm setup
   ```

   If config is missing, initialize with trusted worktrees:

   ```bash
   composer-swarm setup --init --trust
   ```

2. For broad, uncertain, or high-impact repo understanding, start your own normal investigation first. Then launch Composer Swarm research in the background and keep researching locally while it runs.

   ```bash
   composer-swarm research "<question>" --workers <1-4> --background
   ```

   Good research questions ask for evidence, not conclusions:
   - map a flow across files
   - find every place a behavior is created, transformed, stored, or logged
   - compare tests, docs, and config around a subsystem
   - identify release, security, or maintenance risks

   Use `--focus architecture|tests|security|docs|release` when the user asked for a narrower angle. Research output is leads; cross-check important claims yourself before answering or editing.

3. Choose an implementation or review swarm shape from the user's request. Prefer background for broad or multi-step work.

   Recommended defaults:
   - tiny implementation: 1 builder
   - normal implementation: 2 builders
   - broad or ambiguous implementation: 3-4 builders
   - focused research: 1-2 workers
   - broad research: 3-4 workers
   - quick read-only review: 0-1 scouts
   - repo/release/security review: 2-4 scouts

   ```bash
   composer-swarm team "<task>" --builders <1-4> --background
   ```

   For review-only work:

   ```bash
   composer-swarm review --preset repo --scouts <0-4> --background
   composer-swarm review --preset security --scouts <0-4> --background
   composer-swarm review --preset tests --scouts <0-4> --background
   ```

4. Inspect progress and output:

   ```bash
   composer-swarm status <task-id>
   composer-swarm result <task-id>
   composer-swarm result <task-id> --verbose
   ```

5. Verify candidates before recommending one when implementation patches exist:

   ```bash
   composer-swarm verify <task-id>
   composer-swarm verify <task-id> --candidate builder-a
   ```

6. Review the actual patch files listed by `result`; do not rely only on summaries or heuristic recommendations.

7. Ask the user which candidate to apply. After explicit approval, apply exactly that candidate:

   ```bash
   composer-swarm apply <task-id> --candidate <candidate-id>
   composer-swarm apply <task-id> --recommended
   ```

8. Run normal repo checks after apply and clean up worktrees:

   ```bash
   composer-swarm cleanup <task-id>
   ```

## Operating Rules

- Do not apply a candidate patch without explicit user approval in the current conversation.
- Do not use research output as authority. Use it as evidence-backed leads and verify important claims.
- When using research, continue Codex's own local search instead of waiting idly for Composer.
- `--recommended` is only a shortcut after the user approves the detected recommendation.
- Treat reviewer recommendations as heuristic. Inspect patches yourself.
- `verify` distinguishes baseline failures from candidate-specific failures.
- If the current directory is not a git repo, use the setup/status guidance to choose the correct repository.
- Do not edit worker worktrees manually unless debugging Composer Swarm itself.
