# Composer Swarm

Composer Swarm gives Claude Code or Codex users a local team of Cursor/Composer workers.

It is a repo-only v1: clone this repository, run the Node CLI, and optionally install the local Claude Code
commands or Codex skill. Composer workers produce candidate patches in isolated worktrees; you inspect,
verify, and apply one.

## Quick Start

Prerequisites:

- Node 18.18 or newer
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting a team

Clone Composer Swarm, then run commands from the project you want to work on:

```bash
git clone https://github.com/jxucoder/composer-swarm
cd /path/to/your/project
node /path/to/composer-swarm/bin/composer-swarm.mjs setup --init --trust
node /path/to/composer-swarm/bin/composer-swarm.mjs team "fix the failing tests" --builders 2
node /path/to/composer-swarm/bin/composer-swarm.mjs result <task-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs verify <task-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs apply <task-id> --candidate <candidate-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs cleanup <task-id>
```

Use `--background` for longer work, then check `status` and `result`.

For review-only work:

```bash
node /path/to/composer-swarm/bin/composer-swarm.mjs review --preset repo
node /path/to/composer-swarm/bin/composer-swarm.mjs review --preset security
```

## Claude Code

Add the local marketplace and install the `composer` plugin:

```bash
/plugin marketplace add /path/to/composer-swarm
/plugin install composer@composer-swarm-local
/reload-plugins
```

Then run:

```bash
/composer:setup
/composer:team fix the failing tests
/composer:status
/composer:result
/composer:verify <task-id>
```

If Claude Code copies the plugin directory instead of using it in place, either put `composer-swarm` on
`PATH` or set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

## Codex

Codex users can install the repo-local Codex plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into their Codex skills directory.

Then ask Codex to use Composer Swarm for delegation or review.

## Safety Defaults

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
