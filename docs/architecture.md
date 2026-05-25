# Architecture

Composer Swarm is a repo-local ComposerDelegate runtime. Claude Code or Codex stays in charge; local
Cursor/Composer workers provide breadth for read-only research, read-only review, and isolated implementation
candidates.

## Product Shape

```text
User
  -> Claude Code, Codex, or a CLI caller
    -> Composer Swarm command or skill
      -> composer-swarm Node CLI
        -> cursor-agent workers using composer-2.5-fast
          -> read-only snapshots or isolated git worktrees
```

The host agent owns planning judgment, result interpretation, final verification, and apply. Composer workers
do not apply patches or own final decisions. Read-only review and research output is scout signal, not a
reviewer of record.

## Host Surfaces

Claude Code exposes slash commands:

```text
/composer:setup
/composer:review
/composer:research
/composer:team
/composer:status
/composer:inspect
/composer:logs
/composer:result
/composer:verify
/composer:apply
/composer:cancel
```

Codex uses the installed `composer-swarm` skill. The skill tells Codex when to call the CLI, how many workers
to use, how to inspect results, and when to ask before applying.

Generic users can call the same runtime directly:

```bash
composer-swarm review --current
composer-swarm research "map auth token flow" --pack flow --background
composer-swarm team "fix flaky login test" --builders 2 --background
composer-swarm team --from-plan plans/login-fix.md --builders 3 --background
```

## Runtime

The CLI is the runtime. It resolves the target git workspace, reads config, creates worktrees, launches
workers, records transcripts, stores candidate patches, verifies candidates, and applies exactly one approved
patch.

Current commands:

```text
setup
doctor
plan
review
research
team
ls
status
inspect
logs
result
verify
apply
cancel
cleanup
config
example-config
```

There is no daemon, MCP server, hosted background service, or separate task UI in v1.

## Worker Model

Workers are launched through `cursor-agent` and pinned to `composer-2.5-fast`.

Read-only workers run in Cursor plan mode and may not be able to execute shell/test commands:

- `research-*`
- `planner`
- `scout-*`
- `reviewer`

Implementation workers can edit their isolated worktree:

- `builder-a`
- `builder-b`
- `builder-c`
- `builder-d`

Worker labels are runtime labels, not user-configured personas or roles.

## Task Modes

### Research

`research` runs one to four read-only workers. Research packs and host-supplied angles assign distinct search
directions so workers broaden the host model's investigation instead of duplicating it. It produces evidence for the host agent and has no candidate
patches, verifier checks, recommendation, or apply path.

Dirty or untracked checkouts are allowed. The runtime snapshots current tracked modifications and untracked
files into each read-only worker worktree.

Each task records a bounded shared repo context summary in task state. Worker prompts put this shared context
at the top before task-specific metadata, worker labels, and angle assignments, which keeps prompt prefixes
cache-friendly without adding a separate cache workflow or sharing worker reasoning.

### Review

`review` runs a read-only reviewer for quick no-scout reviews. When scouts are requested, it adds a
read-only planner to coordinate scout angles before the final reviewer pass. It is designed for repository
review and the common "review my current changes before I commit" workflow.

Dirty or untracked checkouts are allowed and snapshotted into worker worktrees. Review workers are prompted
to return structured findings with severity, file, issue, rationale, suggested fix, confidence, evidence, and
verification gaps. The host agent must validate important findings against source and local checks.

### Team

`team` normally runs a planner, one to four builders, and a reviewer. The main checkout must be clean before
the task starts, aside from Composer Swarm runtime state. Each builder edits a separate git worktree and the
runtime collects the diff as a candidate patch.

When the host model already wrote the implementation plan, `team --from-plan <file>` skips the Composer
planner and launches builders directly from that host-authored plan. This keeps planning and final synthesis
with the main model while using Composer for independent implementation attempts.

The reviewer can recommend a candidate, but the host/user must inspect and approve before `apply`.

## State Layout

Runtime state lives in the target repository:

```text
.composer-swarm/
  config.json
  state/
    tasks/<task-id>.json
    transcripts/<task-id>/<worker-label>.jsonl
    artifacts/<task-id>/<candidate-id>.patch
    worktrees/<task-id>/<worker-label>/
```

Keep `.composer-swarm/config.json` local by default because it may contain trust flags or verifier commands.
Share reviewed templates such as `swarm.config.example.json`. Ignore `.composer-swarm/state/`.

## Local Background Mode

`--background` starts a detached local Node process and records progress under `.composer-swarm/state/`.
Users inspect it with:

```bash
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm logs <task-id> --worker <label>
composer-swarm result <task-id> --synthesis
composer-swarm result <task-id> --verbose
```

This is not Cursor Background Agents, a hosted Codex task, or a managed job queue.

## Apply Boundary

`apply` is intentionally narrow:

- requires a clean checkout still at the task's recorded base commit, aside from Composer Swarm runtime state
- applies exactly one selected candidate patch
- checks that the patch applies cleanly first
- never runs for research or review tasks

`--recommended` is only a shortcut after inspecting the detected reviewer recommendation.

## Non-Goals For V1

- No native Claude Agent Teams dependency.
- No hosted background task UI.
- No MCP server yet.
- No npm publish or external marketplace submission yet.
- No user-facing role/persona system.
- No automatic merge or auto-apply.
