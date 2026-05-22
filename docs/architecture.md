# Architecture

## Goal

Composer Swarm should let users already working in Claude Code, Codex, or another coding assistant add a
team of Cursor/Composer workers.

The product should feel like a native extension of the user's current host:

- Claude Code user: `/composer:team ...`
- Codex user: `Use composer-swarm to run this through a Composer team`
- Generic agent user: `composer-swarm team ...`

The key implementation shift is that Claude Code and Codex are not the default workers. They are the
operator surfaces. Cursor/Composer workers are the team.

## Product Insight

The X/Grok thread points to three useful facts:

- Developers like the planner/executor split: Claude or Codex can supervise while Composer writes quickly.
- Claude Code Agent Teams are not a native way to add non-Claude teammates, so we should not depend on
  that path for distribution.
- The successful adoption pattern is host-native commands, like `codex-plugin-cc` and `cursor-plugin-cc`,
  not a separate coordination app users must switch into.

Source: https://x.com/i/grok/share/513b827b6d264c15a7c2e1ecb0ceef98

## Layers

### 1. Host Cockpit

The host cockpit is where the user already is:

- Claude Code
- Codex
- another CLI or IDE agent

Host integrations should be thin and native. They should expose a few commands and then call the runtime.

Claude Code:

```text
/composer:team
/composer:status
/composer:result
/composer:cancel
```

Codex:

```text
composer-swarm skill: run a Composer team, inspect results, merge selected patch
```

### 2. Core Runtime

The core runtime is a repo-aware CLI and optional daemon:

```text
composer-swarm
  init
  doctor
  plan
  team
  status
  result
  apply
  cancel
  cleanup
```

Responsibilities:

- resolve workspace root
- load `.composer-swarm/config.json`
- maintain task state
- create isolated worktrees for Composer workers
- assign leases and scopes
- record event transcripts
- collect artifacts and summaries
- collect candidate patches
- help the host select and merge the best patch
- expose the same commands to all hosts

The runtime should not try to be an all-purpose agent team. Its first job is to make Composer delegation
reliable from existing hosts.

### 3. Composer Worker Pool

Composer workers are launched through `cursor-agent` or a compatible Cursor/Composer CLI.

Default roles:

- `planner`: identifies decomposition and risks
- `builder-a`: attempts the smallest direct implementation
- `builder-b`: attempts an alternate implementation or parallel subtask
- `reviewer`: reviews candidate patches and points out concrete defects
- `verifier`: runs deterministic checks where possible

Every worker adapter implements the same contract:

```text
input:  task envelope + workspace context + role instructions
output: JSONL events + final result envelope
```

Adapters can be implemented using:

- direct CLI process spawning
- MCP tool calls
- HTTP services
- manual/human workers

## State Layout

Repo-local state is useful for collaboration, but runtime metadata should be easy to ignore:

```text
.composer-swarm/
  config.json
  state/
    swarm.json
    tasks/
      task-*.json
    transcripts/
      task-*/
        planner.jsonl
        builder-a.jsonl
    artifacts/
      task-*/
        task-*-builder-a.patch
    worktrees/
      task-*/
        builder-a/
```

Recommended `.gitignore`:

```text
.composer-swarm/state/
```

Config can be committed; state usually should not be.

## Task Lifecycle

```text
created -> running -> patches-collected -> completed -> applied|failed|cancelled
```

Each task has:

- task id
- role
- objective
- acceptance criteria
- allowed files or scope
- parent task id
- worktree path
- lease holder
- events
- final result

## Roles

Default role mapping:

- host/operator -> Claude Code or Codex
- planner -> Composer
- builder-a -> Composer
- builder-b -> Composer
- reviewer -> Composer, optionally Codex as a second-opinion reviewer
- verifier -> shell commands or Composer

## Isolation

The swarm should prefer isolated git worktrees over shared-checkout file locks.

Each Composer worker gets its own worktree:

```text
.composer-swarm/state/worktrees/task_123/builder-a
.composer-swarm/state/worktrees/task_123/builder-b
```

The runtime collects each worker's patch with `git diff`, then the host reviews and applies one selected
patch to the main checkout.

File leases still matter for scoped subtasks.

Lease shape:

```json
{
  "taskId": "task_123",
  "agentId": "composer-builder-a",
  "paths": ["src/auth/**"],
  "expiresAt": "2026-05-22T20:00:00.000Z"
}
```

If two agents need the same paths, the coordinator should serialize them or split the task.

## Recommended MVP

1. Ship `composer-swarm` as a repo-only CLI that can create worktrees and launch `cursor-agent`.
2. Ship a local Claude Code plugin with `/composer:setup`, `/composer:team`, `/composer:status`, `/composer:result`, `/composer:apply`, and `/composer:cancel`.
3. Ship a Codex skill that calls the same CLI and asks before applying patches.
4. List candidate patches, summaries, changed files, checks, and reviewer notes.
5. Defer MCP until the CLI worker loop is stable.
