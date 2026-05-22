# Composer Swarm

Composer Swarm gives an existing Claude Code or Codex user a local team of Cursor/Composer workers.

Repo-only v1 is a dependency-free Node CLI. Users clone this repo, run `bin/composer-swarm.mjs`, and can
optionally install the local Claude Code commands or Codex skill from the repo. There is no npm package or
marketplace submission yet.

## What It Does

- launches `cursor-agent` workers with `--print --output-format stream-json --workspace <worktree>`
- creates isolated git worktrees under `.composer-swarm/state/worktrees/<task-id>/`
- runs a planner, parallel builders, and a reviewer
- stores task state, transcripts, and patch artifacts under `.composer-swarm/state/`
- reports candidate patches for the host to inspect
- applies exactly one candidate only when the user runs `apply`

Claude Code or Codex remains the host/operator. Composer workers produce candidates; the host decides.

## Prerequisites

- Node 18.18 or newer
- git
- authenticated `cursor-agent` on `PATH`
- a clean tracked git checkout before starting a team

## Quick Start

```bash
git clone <this-repo-url>
cd /path/to/your/project
node /path/to/composer-swarm/bin/composer-swarm.mjs init
node /path/to/composer-swarm/bin/composer-swarm.mjs doctor
node /path/to/composer-swarm/bin/composer-swarm.mjs team "fix the failing tests" --builders 2
node /path/to/composer-swarm/bin/composer-swarm.mjs result <task-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs apply <task-id> --candidate <candidate-id>
```

Add `.composer-swarm/state/` to the project `.gitignore`. The config can be committed; runtime state usually
should not be committed.

## CLI

```text
composer-swarm init [--force]
composer-swarm doctor
composer-swarm agents
composer-swarm plan <task text> [--roles a,b,c]
composer-swarm team <task text> [--builders 2] [--background|--wait] [--model <model>]
composer-swarm status [task-id]
composer-swarm result [task-id]
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cancel <task-id>
composer-swarm cleanup [task-id]
```

`team` waits by default. Use `--background` to return immediately and poll with `status`.

## Host Integrations

Claude Code local plugin files live in [plugins/composer-swarm](plugins/composer-swarm). They expose:

```text
/composer:setup
/composer:team
/composer:status
/composer:result
/composer:apply
/composer:cancel
```

Codex skill instructions live in [skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md). The skill
requires Codex to inspect results and ask before running `apply`.

See [docs/repo-only-release.md](docs/repo-only-release.md) for local install notes and known limits.

## Design Docs

- [Architecture](docs/architecture.md)
- [Agent protocol](docs/protocol.md)
- [Host adapters](docs/adapters.md)
- [Implementation strategy](docs/implementation-strategy.md)

## Known Limits

- no npm package yet
- no Claude marketplace submission yet
- no MCP server in v1
- no auto-ranking or auto-merge
- `cursor-agent` is the only real worker backend
