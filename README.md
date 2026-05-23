# Composer Swarm

Composer Swarm gives Claude Code or Codex a local team of Cursor/Composer workers.

It is a repo-only v1 for agents: install the local Claude Code plugin, or give Codex the included skill
instructions if your Codex environment supports local skills/plugins. The agent runs the CLI from your
project, inspects candidate patches, verifies them, and asks before applying one.

## Quick Start

Clone Composer Swarm once:

```bash
git clone https://github.com/jxucoder/composer-swarm
```

Prerequisites for projects where your agent will use Composer Swarm:

- Node 18.18 or newer
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting a team

## Claude Code

Add the local marketplace and install the `composer` plugin:

```bash
/plugin marketplace add /path/to/composer-swarm
/plugin install composer@composer-swarm-local
/reload-plugins
```

Then ask Claude Code to use it:

```text
/composer:setup
/composer:team fix the failing tests
/composer:review --preset repo
```

Claude Code will choose whether to wait or run longer work in the background, then use `/composer:status`,
`/composer:result`, and `/composer:verify` as needed.

If Claude Code copies the plugin directory instead of using it in place, either put `composer-swarm` on
`PATH` or set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

## Codex

Codex does not automatically load this repo's skill file just because the repo was cloned. If your Codex
environment supports local skills or plugins, install the repo-local plugin from
[.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), or copy
[skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md) into the skills directory your Codex setup
uses.

Then ask Codex naturally from the project you want it to work on:

```text
Use Composer Swarm to review this project.
Use Composer Swarm to fix the failing tests with two builders.
```

With the skill installed, Codex should run setup/status/result/verify/apply commands from your project when
the workflow calls for them. Without skill support, tell Codex to use the CLI directly; the commands are in
the [technical spec](docs/technical-spec.md).

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
