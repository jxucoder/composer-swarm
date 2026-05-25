# Implementation Strategy

Composer Swarm v1 is intentionally simple: a repo-local Node CLI with thin Claude Code and Codex adapters.
The runtime exists to give a smart host agent fast Composer capacity without asking the user to switch apps.

## Product Strategy

The product should feel like:

```text
your current coding agent + local Composer workers
```

Claude Code and Codex remain the cockpit. Composer 2.5 Fast workers add:

- broader repo search
- additional read-only reasoning
- review-only scout leads
- isolated implementation candidates
- local transcripts, patches, and verification output

## Current Entry Points

Claude Code:

```text
/composer:setup
/composer:review --current
/composer:research map auth flow --pack flow
/composer:team fix failing tests --builders 2
/composer:team --from-plan plans/fix.md --builders 3
/composer:status
/composer:inspect
/composer:logs
/composer:result
/composer:verify
/composer:apply
```

Codex:

```text
Use Composer Swarm to review my current changes.
Use Composer Swarm to research how config loading works with three workers.
Use Composer Swarm to fix the failing tests with two builders.
```

CLI:

```bash
composer-swarm review --current
composer-swarm research "map auth token flow" --pack flow --background
composer-swarm team "fix flaky login test" --builders 2 --background
```

## Mode Strategy

### Read-Only First

Read-only modes should be useful even in prototype repos:

```bash
composer-swarm review --current
composer-swarm research "review the current rewrite" --snapshot-current
```

For `research` and `review`, dirty and untracked files are snapshotted into isolated worker worktrees. These
modes never create candidate patches and never expose apply commands. The host validates important findings;
Composer review is supporting signal, not the reviewer of record.

### Implementation When Clean

Implementation mode is stricter:

```bash
composer-swarm team "implement the requested change" --builders 2
composer-swarm team --from-plan plans/implementation.md --builders 3
```

`team` requires a clean checkout before it starts, aside from Composer Swarm runtime state. This avoids
candidate patches that accidentally include unrelated user work.

Use `team --from-plan` after the host reasoning model has already investigated and written the implementation
plan. The runtime skips the Composer planner in that mode and launches only builders plus the reviewer.

### Apply After Inspection

The apply path stays explicit:

```bash
composer-swarm result <task-id> --findings
composer-swarm verify <task-id>
composer-swarm apply <task-id> --candidate <candidate-id>
```

The host should inspect the patch and verification output before applying exactly one candidate. Apply also
checks that the main checkout is still at the task's recorded base commit.

## Runtime Strategy

The runtime owns the hard parts:

- resolve the target git workspace
- read `.composer-swarm/config.json`
- create isolated worktrees
- snapshot dirty read-only checkouts when needed
- launch `cursor-agent` with `composer-2.5-fast`
- record worker JSONL transcripts
- collect candidate patch artifacts
- verify candidates against configured shell checks
- apply one selected patch after approval
- clean up task worktrees

Adapters should stay thin. Claude command files and the Codex skill should translate user intent into CLI
commands, then return CLI output without inventing extra state.

## Distribution Strategy

### v1: Repo-Only

Users clone this repository and install local adapters from the checkout. Do not publish to npm or external
marketplaces until the CLI and docs are stable.

Claude Code install:

```text
/plugin marketplace add /path/to/composer-swarm/.claude-plugin/marketplace.json
/plugin install composer@jxucoder-composer-swarm
/reload-plugins
```

Codex install:

```bash
mkdir -p ~/.codex/skills/composer-swarm ~/.local/bin
cp /path/to/composer-swarm/skills/composer-swarm/SKILL.md ~/.codex/skills/composer-swarm/SKILL.md
ln -sfn /path/to/composer-swarm/bin/composer-swarm.mjs ~/.local/bin/composer-swarm
```

### Later

Only after v1 is stable:

- npm package
- external Claude plugin marketplace submission
- MCP wrapper for hosts that cannot shell out
- richer progress if `cursor-agent` exposes structured phases

## Non-Goals

- Do not build a separate coordination app.
- Do not depend on native Claude Agent Teams for Composer workers.
- Do not make Codex and Claude mandatory; they are host surfaces.
- Do not run multiple editing workers in the same checkout.
- Do not expose a role/persona system to users.
- Do not auto-merge or auto-apply.
