# Composer Swarm

Composer Swarm gives an existing Claude Code or Codex user a local team of Cursor/Composer workers.

Repo-only v1 is a dependency-free Node CLI. Users clone this repo, run `bin/composer-swarm.mjs`, and can
optionally install the local Claude Code commands, Codex plugin, or Codex skill from the repo. There is no
npm package or external marketplace submission yet.

## What It Does

- launches `cursor-agent` workers with `--print --output-format stream-json --workspace <worktree> --model composer-2.5-fast`
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

### Claude Code Plugin

Add the local Claude Code marketplace from this repository, then install the `composer` plugin:

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

If your Claude Code install copies the plugin directory instead of using it in place, either put
`composer-swarm` on `PATH` or set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

For review-only work:

```bash
/composer:review --preset repo
/composer:review --preset security
```

The plugin asks whether to wait or run in the background when the choice is not obvious.

### Shell Or Codex

Codex users can install the repo-local Codex plugin from [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json),
which bundles [skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md), or copy that skill into their Codex skills directory.

```bash
git clone <this-repo-url>
cd /path/to/your/project
node /path/to/composer-swarm/bin/composer-swarm.mjs setup --init --trust
node /path/to/composer-swarm/bin/composer-swarm.mjs team "fix the failing tests" --builders 2
node /path/to/composer-swarm/bin/composer-swarm.mjs result <task-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs verify <task-id>
node /path/to/composer-swarm/bin/composer-swarm.mjs apply <task-id> --recommended
node /path/to/composer-swarm/bin/composer-swarm.mjs cleanup <task-id>
```

Add `.composer-swarm/state/` to the project `.gitignore`. The config can be committed; runtime state usually
should not be committed.

Use `setup --init --trust` when Cursor prompts for worktree trust in isolated agent workspaces.

## CLI

```text
composer-swarm init [--force] [--trust]
composer-swarm setup [--init] [--trust] [--force] [--json]
composer-swarm doctor
composer-swarm agents
composer-swarm plan <task text> [--roles a,b,c]
composer-swarm team <task text> [--builders 2] [--background|--wait]
composer-swarm review [--preset repo|security|tests] [--background|--wait]
composer-swarm status [task-id]
composer-swarm result [task-id] [--verbose]
composer-swarm verify <task-id> [--candidate <id>] [--no-baseline]
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm apply <task-id> --recommended
composer-swarm cancel <task-id>
composer-swarm cleanup [task-id]
```

`team` waits by default. Use `--background` to return immediately and poll with `status`.

`setup` is the friendliest entrypoint. It checks git, config, Node, `cursor-agent`, and verifier readiness,
then prints the next command to run. `setup --init --trust` writes `.composer-swarm/config.json` with trusted
Cursor worker args.

Composer workers are pinned to Cursor model `composer-2.5-fast`. Other `--model` values are rejected.

### Review Presets

Run a repository review without writing a long prompt:

```bash
composer-swarm review
composer-swarm review --preset security
composer-swarm review --preset tests
```

Review tasks run planner and reviewer workers only. They do not create builder patches.

### Result And Comparison

`result` shows a compact candidate comparison table with changed-file count, patch size, verifier checks, and
any detected recommendation. Use `--verbose` for full reviewer notes, patch paths, worktree paths, and failed
check output.

### Verification

Run configured shell checks, defaulting to `npm test`, against candidate worktrees from the host shell:

```bash
composer-swarm verify <task-id>
composer-swarm verify <task-id> --candidate builder-a
```

By default, verification also runs against the unmodified base commit. Failures already present on the base
are tagged `baseline`; new failures are tagged `candidate-specific`.

### Apply

Manual apply is still required. Use `--recommended` only after inspecting the result and approving the
detected recommendation:

```bash
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm apply <task-id> --recommended
```

### Repo Targeting

If the current directory is not inside a git repository, composer-swarm searches nearby directories and
suggests `cd` paths to nested git repos. Read-only commands such as `status`, `result`, and `cleanup` can run
without a git checkout.

### Cleanup

`status` and `result` include next-step guidance. After applying or abandoning a task:

```bash
composer-swarm cleanup <task-id>
```

This removes isolated worktrees under `.composer-swarm/state/worktrees/`, including baseline verification
worktrees. Runtime state in `.composer-swarm/state/` is safe to delete after cleanup.

## Host Integrations

Claude Code local plugin files live in [plugins/composer-swarm](plugins/composer-swarm). They expose:

```text
/composer:setup
/composer:team
/composer:review
/composer:status
/composer:result
/composer:verify
/composer:apply
/composer:cancel
```

Codex plugin metadata lives in [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), and the
skill instructions live in [skills/composer-swarm/SKILL.md](skills/composer-swarm/SKILL.md). The skill
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
- no auto-merge; apply still requires explicit user action
- `cursor-agent` is the only real worker backend
- recommendation parsing is heuristic; inspect `result --verbose` before `--recommended`
