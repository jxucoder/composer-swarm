# Composer Swarm

> **Claude or Codex stays in charge. Fast Composer workers search, think, and draft options.**

Composer Swarm is a repo-local ComposerDelegate runtime. It lets Claude Code or Codex delegate repository
work to local Cursor/Composer workers without making the human drive a second CLI. Composer is fast and
low-cost enough to run parallel passes for wider code search, extra reasoning, alternate implementations,
and review-only checks while the main agent keeps control of judgment and apply.

The design borrows OpenAI Swarm's lightweight routines-and-handoffs pattern: the host skill or plugin is the
routine, CLI commands are tool calls, Composer workers are bounded handoffs, and task state is explicit on
disk.

## What You Get

- `/composer:team` to hand a coding task to isolated Composer workers for broader search and candidate patches
- `/composer:research` for read-only repo search while the main agent keeps investigating
- `/composer:review` for review-only broader search and extra critique
- `/composer:status` and `/composer:result` to follow detached local runs
- `/composer:inspect` and `/composer:logs` to inspect local state, worktrees, patches, and worker transcripts
- `/composer:verify` to run configured checks against candidates
- `/composer:apply` to apply exactly one selected candidate patch

## Requirements

- Node.js 20 or later
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting an implementation team

## Install

Composer Swarm v1 is repo-only. Clone this repository and install the local plugin or skill from this
checkout. See [repo-only release notes](docs/repo-only-release.md) for full install and release-check steps.

**Claude Code** — from this checkout, add the repo-local marketplace and install the `composer` plugin:

```bash
/plugin marketplace add /path/to/composer-swarm/.claude-plugin/marketplace.json
/plugin install composer@jxucoder-composer-swarm
/reload-plugins
```

Then, from the repository you want Composer Swarm to work on, run:

```bash
/composer:setup
```

**Codex** — install the repo-local plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into your Codex skills directory.

**CLI only** — call the CLI directly from your target project:

```bash
node /path/to/composer-swarm/bin/composer-swarm.mjs setup
```

One simple first run is:

```text
/composer:team fix the failing tests --background
/composer:research map the config loading flow --background
/composer:status
/composer:inspect
/composer:logs
/composer:result
```

`--background` means Composer Swarm starts a detached local runner and records progress on disk. It is not a
hosted Cursor Background Agent, hosted Codex task, or separate task UI. When a task finishes, Claude Code or
Codex should use the extra Composer search and thinking, inspect the result, verify candidates, review the
actual patch, and ask before applying one.

## Codex

Codex support is skill/plugin based. Codex will not load this repo just because it exists on disk, but if
your Codex environment supports local skills or plugins, install the repo-local plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into your Codex skills directory.

Then ask Codex naturally from the project you want to work on:

```text
Use Composer Swarm to review this project.
Use Composer Swarm to research how config loading works with three workers.
Use Composer Swarm to review this project with three scouts.
Use Composer Swarm to fix the failing tests with two builders.
```

With the skill installed, Codex runs setup/status/inspect/logs/result/verify/apply commands from your project
when the workflow calls for them. Without skill support, tell Codex to use the CLI directly; those commands
are in the [technical spec](docs/technical-spec.md).

Conceptually, the host agent is calling:

```text
use_composer(task, mode, scope, context)
```

In v1 that maps to explicit CLI commands: `research` for read-only evidence, `team` for candidate patches,
`review` for critique, `inspect`/`logs` for local state, and `verify`/`apply` for guarded finalization.

## What Stays Safe

- workers use isolated git worktrees
- research and review are read-only, can snapshot dirty/untracked checkouts, and have no apply path
- Cursor workers are pinned to `composer-2.5-fast`
- generated state stays under `.composer-swarm/state/`
- apply is manual and requires an explicit selected candidate
- `--recommended` should only be used after inspecting the result

## Current Limitations

- no npm publish yet
- no external marketplace submission yet
- no hosted background task UI; `--background` is a local detached process
- see [repo-only release notes](docs/repo-only-release.md) for the full list

## More Detail

- [Technical spec](docs/technical-spec.md)
- [Repo-only release notes](docs/repo-only-release.md)
- [Architecture](docs/architecture.md)
- [Worker protocol](docs/protocol.md)
- [Host adapters](docs/adapters.md)

## License

[MIT](LICENSE)
