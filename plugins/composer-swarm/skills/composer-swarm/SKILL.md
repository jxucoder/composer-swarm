---
name: composer-swarm
description: Delegate repo tasks to local Composer/Cursor workers for read-only research, candidate patches, verification, and approved apply.
---

# Composer Swarm

Use this skill when the user asks Codex to delegate repo research, implementation, or review work to Composer/Cursor workers, compare swarm candidates, verify candidates, or apply a selected patch.

Operating split: Codex is the main agent. Fast, low-cost Composer workers provide broader code search, extra reasoning, read-only scout leads, isolated candidate patches, and review-only checks. Codex verifies, compares, and applies only after explicit approval.

Design model: follow OpenAI Swarm-style routines and handoffs. This skill is the routine that decides when to call CLI tools. Each `composer-swarm` command is a tool call. Launching Composer workers is a bounded handoff to isolated worker processes. `.composer-swarm/state/` is the explicit context store. Control returns to Codex for verification, approval, and final action.

## Runtime

- Prefer `composer-swarm` when it is on `PATH`.
- Otherwise run `node <composer-swarm-repo>/bin/composer-swarm.mjs ...`.
- Run commands from the target repository.
- Composer workers must use Cursor model `composer-2.5-fast` only.
- Composer workers edit isolated git worktrees; the Codex host supervises, compares, and chooses.
- Research and review workers are read-only and produce evidence for Codex to verify. Treat them as scouts, not reviewers of record.
- The runtime injects shared repo context at the top of worker prompts before task-specific and
  worker-specific text. Treat this as application-level prompt-prefix caching support, not shared worker
  reasoning or a model-internal KV cache.

## Default Flow

1. Check setup before the first task:

   ```bash
   composer-swarm setup
   ```

   If config is missing, initialize with trusted worktrees:

   ```bash
   composer-swarm setup --init --trust
   ```

   After initialization, check `.composer-swarm/config.json` if verification matters. The runtime does not infer test commands. Codex should inspect the repo and set `workers.verifier` only when it knows the right project-specific check.

2. For broad, uncertain, or high-impact repo understanding, start your own normal investigation first. Then launch Composer Swarm research as a detached local run and keep researching locally while it runs.

   ```bash
   composer-swarm research "<question>" --workers <1-4> --background
   composer-swarm research "<question>" --pack bugs --background
   composer-swarm research "<question>" --angles "entry points,data flow,tests,edge cases" --background
   composer-swarm research --from-plan <plan.md> --background
   ```

   Dirty and untracked checkouts are OK for read-only research and review. Use `review --current` for prototype/current-work reviews, or `--snapshot-current`/`--include-untracked` when you need the explicit lower-level flag.

   Good research questions ask for evidence, not conclusions:
   - map a flow across files
   - find every place a behavior is created, transformed, stored, or logged
   - compare tests, docs, and config around a subsystem
   - identify release, security, or maintenance risks

   Use `--pack broad|bugs|flow|tests|design|release|security`, `--angles <a,b>`, or `--from-plan <file>` when the main model needs deliberately different research directions. Use `--from-plan` when Codex has already written a short Markdown decomposition for Composer to execute. Use `--focus architecture|tests|security|docs|release` when the user asked for a narrower topic boundary. Research output is leads; cross-check important claims yourself before answering or editing.

3. Choose an implementation or review swarm shape from the user's request. Prefer detached local mode for broad or multi-step work.

   Sizing hints, not hard rules:
   - tiny implementation: 1 builder
   - normal implementation: 2 builders
   - broad or ambiguous implementation: 3-4 builders
   - focused research: 1-2 workers
   - broad research: 3-4 workers
   - quick read-only review: 0-1 scouts
   - repo/release/security review: 1-2 scouts
   - wide exploratory review: 3-4 scouts only when the user asks for breadth

   A review with 0 scouts runs only the read-only reviewer for speed. Add scouts when the main model wants
   broader independent coverage; scout reviews include a lightweight planning pass to coordinate angles.

   ```bash
   composer-swarm team "<task>" --builders <1-4> --background
   ```

   If Codex has already written a concrete implementation plan, save it to a short Markdown file and use:

   ```bash
   composer-swarm team --from-plan <plan.md> --builders <1-4> --background
   ```

   This skips the Composer planning worker and sends Composer builders directly to independent implementations
   of the main model's plan.

   Add `--json` to `team`, `research`, or `review` when Codex needs a machine-readable task id, mode, worker
   list, and useful commands instead of human launch text.

   For review-only work:

   ```bash
   composer-swarm review --preset repo --scouts <0-4> --background
   composer-swarm review --preset security --scouts <0-4> --background
   composer-swarm review --preset tests --scouts <0-4> --background
   ```

   For "review my current changes" or prototype repos with untracked files, use:

   ```bash
   composer-swarm review --current
   ```

4. Inspect progress and output:

   ```bash
   composer-swarm status <task-id>
   composer-swarm status <task-id> --json
   composer-swarm inspect <task-id>
   composer-swarm result <task-id>
   composer-swarm result <task-id> --verbose
   composer-swarm result <task-id> --synthesis
   composer-swarm result <task-id> --findings
   composer-swarm result <task-id> --json
   composer-swarm logs <task-id>
   composer-swarm logs <task-id> --worker <worker-label>
   ```

5. Verify candidates before recommending one when implementation patches exist:

   ```bash
   composer-swarm verify <task-id>
   composer-swarm verify <task-id> --candidate builder-a
   ```

6. Review the actual patch files listed by `result`; do not rely only on summaries or heuristic recommendations.
   Apply will fail if the main checkout has advanced from the task's recorded base commit, so re-run `team`
   after rebasing, pulling, or committing unrelated work.

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
- Do not use research or review output as authority. Use `result --synthesis`, `result --findings`, or `result --json` as evidence-backed scout leads and verify important claims.
- When using research, continue Codex's own local search instead of waiting idly for Composer.
- Read-only workers run in Cursor plan mode. If they cannot execute shell/tests, do not treat that as a task failure; record it as a verification gap and run local checks yourself when needed.
- `--recommended` is only a shortcut after the user approves the detected recommendation.
- Treat reviewer recommendations as heuristic. Inspect patches yourself.
- `verify` distinguishes baseline failures from candidate-specific failures and exits non-zero when any
  checked candidate fails verification or any candidate cannot be checked.
- If the current directory is not a git repo, use the setup/status guidance to choose the correct repository.
- Do not edit worker worktrees manually unless debugging Composer Swarm itself.
