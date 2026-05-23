# Composer Swarm

> **Claude or Codex stays in charge. Fast Composer workers search, think, and draft options.**

Composer Swarm lets Claude Code or Codex delegate repository work to local Cursor/Composer workers without
making the human drive a second CLI. Composer is fast and low-cost enough to run parallel passes for wider
code search, extra reasoning, alternate implementations, and review-only checks while the main agent keeps
control of judgment and apply.

## What You Get

- `/composer:team` to hand a coding task to isolated Composer workers for broader search and candidate patches
- `/composer:review` for a review-only planner + optional scout + reviewer pass
- `/composer:status` and `/composer:result` to follow background work
- `/composer:verify` to run configured checks against candidates
- `/composer:apply` to apply exactly one selected candidate patch

## Requirements

- Node.js 20 or later
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting an implementation team

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add jxucoder/composer-swarm
```

Install the plugin:

```bash
/plugin install composer@jxucoder-composer-swarm
```

Reload plugins:

```bash
/reload-plugins
```

Then, from the repository you want Composer Swarm to work on, run:

```bash
/composer:setup
```

`/composer:setup` will tell you whether Composer Swarm, git, and `cursor-agent` are ready for the current
repository. If config is missing, it can initialize the repo for trusted Composer worktrees.

After install, you should see the `/composer:*` slash commands listed in Claude Code.

One simple first run is:

```text
/composer:team fix the failing tests --background
/composer:status
/composer:result
```

Claude Code will choose whether to wait or run longer work in the background. When a task finishes, Claude
Code should use the extra Composer search and thinking, inspect the result, verify candidates, review the
actual patch, and ask before applying one.

## Codex

Codex support is skill/plugin based. Codex will not load this repo just because it exists on disk, but if
your Codex environment supports local skills or plugins, install the repo-local plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into your Codex skills directory.

Then ask Codex naturally from the project you want to work on:

```text
Use Composer Swarm to review this project.
Use Composer Swarm to review this project with three scouts.
Use Composer Swarm to fix the failing tests with two builders.
```

With the skill installed, Codex runs setup/status/result/verify/apply commands from your project when the
workflow calls for them. Without skill support, tell Codex to use the CLI directly; those commands are in the
[technical spec](docs/technical-spec.md).

## What Stays Safe

- workers use isolated git worktrees
- Cursor workers are pinned to `composer-2.5-fast`
- generated state stays under `.composer-swarm/state/`
- apply is manual and requires an explicit selected candidate
- `--recommended` should only be used after inspecting the result

## More Detail

- [Technical spec](docs/technical-spec.md)
- [Repo-only release notes](docs/repo-only-release.md)
- [Architecture](docs/architecture.md)
- [Agent protocol](docs/protocol.md)
- [Host adapters](docs/adapters.md)

## License

MIT
