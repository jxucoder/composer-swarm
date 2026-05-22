# Repo-Only Release

This v1 release is intentionally repo-only. Do not publish to npm or submit to external marketplaces yet.

## Install

Clone the repo and call the CLI with Node:

```bash
git clone <composer-swarm-repo-url>
node /path/to/composer-swarm/bin/composer-swarm.mjs doctor
```

Optional shell convenience:

```bash
alias composer-swarm='node /path/to/composer-swarm/bin/composer-swarm.mjs'
```

## Prerequisites

- Node 18.18+
- git
- authenticated `cursor-agent`
- a target project that is a git repository
- clean tracked files before `team` and before `apply`

## Raw CLI Quickstart

From the target project:

```bash
composer-swarm init
composer-swarm doctor
composer-swarm team "implement the requested change" --builders 2
composer-swarm status <task-id>
composer-swarm result <task-id>
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cleanup <task-id>
```

Use `--background` for long-running tasks:

```bash
composer-swarm team "investigate the regression" --builders 2 --background
composer-swarm status <task-id>
composer-swarm result <task-id>
```

## Claude Code Local Plugin

The repo includes local plugin files under `plugins/composer-swarm` and a local marketplace file under
`.claude-plugin/marketplace.json`.

For local testing, install the plugin from this checkout using Claude Code's local plugin flow. If your local
plugin install copies the plugin directory instead of using it in place, set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

Commands:

```text
/composer:setup
/composer:team fix the failing tests --builders 2
/composer:status <task-id>
/composer:result <task-id>
/composer:apply <task-id> --candidate <candidate-id>
/composer:cancel <task-id>
```

The command files are thin wrappers. They return CLI output directly.

## Codex Skill

Copy or reference `skills/composer-swarm/SKILL.md` in your Codex skills directory. The skill tells Codex to:

- run `doctor`
- launch `team`
- inspect `status` and `result`
- review patch artifacts before recommending a candidate
- ask the user before running `apply`

## State Layout

Runtime state is stored in the target project:

```text
.composer-swarm/
  config.json
  state/
    tasks/<task-id>.json
    transcripts/<task-id>/<role>.jsonl
    artifacts/<task-id>/<candidate-id>.patch
    worktrees/<task-id>/<role>/
```

Commit `.composer-swarm/config.json` if the team configuration is useful to the project. Ignore
`.composer-swarm/state/`.

## Manual Release Checks

```bash
node --test tests/*.test.mjs
node bin/composer-swarm.mjs doctor
```

Then, in a disposable git repository with authenticated `cursor-agent`:

```bash
node /path/to/composer-swarm/bin/composer-swarm.mjs init
node /path/to/composer-swarm/bin/composer-swarm.mjs team "make a tiny safe edit" --builders 2
node /path/to/composer-swarm/bin/composer-swarm.mjs result <task-id>
```

## Known Limits

- no npm package
- no marketplace submission
- no MCP server
- no auto-ranking
- no auto-merge
- no worker backend other than `cursor-agent`
