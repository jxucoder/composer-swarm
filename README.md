# Composer Swarm

> **Claude or Codex plans. Composer writes candidates. Your agent reviews and applies.**

Composer Swarm lets Claude Code or Codex delegate repository work to local Cursor/Composer workers without
making the human drive a second CLI. The coding agent runs the swarm from your project, compares candidate
patches, verifies them, and asks before applying exactly one.

## What You Get

- `/composer:team` to hand a coding task to isolated Composer workers
- `/composer:review` for a review-only planner + reviewer pass
- `/composer:status` and `/composer:result` to follow background work
- `/composer:verify` to run configured checks against candidates
- `/composer:apply` to apply exactly one selected candidate patch

## Requirements

- Node.js 18.18 or later
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting an implementation team

## Claude Code

Add the marketplace from GitHub:

```bash
/plugin marketplace add jxucoder/composer-swarm
/plugin install composer@jxucoder-composer-swarm
/reload-plugins
/composer:setup
```

For local development from a checkout, add the checkout path instead:

```bash
/plugin marketplace add /path/to/composer-swarm
```

Then run the same install, reload, and setup commands above.

One simple implementation run is:

```text
/composer:team fix the failing tests
/composer:status
/composer:result
```

Claude Code will choose whether to wait or run longer work in the background. When a task finishes, Claude
Code should inspect the result, verify candidates, review the actual patch, and ask before applying one.

If Claude Code copies the plugin directory instead of using it in place, either put `composer-swarm` on
`PATH` or set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

## Codex

Codex support is skill/plugin based. Codex will not load this repo just because it exists on disk, but if
your Codex environment supports local skills or plugins, install the repo-local plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into your Codex skills directory.

Then ask Codex naturally from the project you want to work on:

```text
Use Composer Swarm to review this project.
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
