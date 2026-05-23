# Repo-Only Release

This v1 release is intentionally repo-only. Do not publish to npm or submit to external marketplaces yet.

Licensed under [MIT](../LICENSE). Requires Node `>=20.0.0` (`package.json` `engines.node`).

## Install

Clone the repo and call the CLI with Node:

```bash
git clone <composer-swarm-repo-url>
node /path/to/composer-swarm/bin/composer-swarm.mjs setup
```

Optional shell convenience:

```bash
alias composer-swarm='node /path/to/composer-swarm/bin/composer-swarm.mjs'
```

## Prerequisites

- Node 20+
- git
- authenticated `cursor-agent`
- Cursor model `composer-2.5-fast` for all Composer workers
- a target project that is a git repository
- clean tracked files before `team` and before `apply`

## Raw CLI Quickstart

From the target project:

```bash
composer-swarm setup --init --trust
composer-swarm team "implement the requested change" --builders 2
composer-swarm research "map the config loading flow" --workers 3 --background
composer-swarm review --preset repo --scouts 2 --background
composer-swarm status <task-id>
composer-swarm result <task-id>
composer-swarm verify <task-id>
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

The repo includes local plugin files under `plugins/composer-swarm` and a repo-local marketplace file under
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json). The plugin name is `composer`; the
marketplace id is `jxucoder-composer-swarm`.

From a Claude Code session, add the local marketplace with the absolute path to this checkout, install the
plugin, and reload:

```bash
/plugin marketplace add /path/to/composer-swarm/.claude-plugin/marketplace.json
/plugin install composer@jxucoder-composer-swarm
/reload-plugins
```

If your local plugin install copies the plugin directory instead of using it in place, set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

Commands:

```text
/composer:setup
/composer:team fix the failing tests --builders 2
/composer:research map the config loading flow --workers 3
/composer:status <task-id>
/composer:result <task-id>
/composer:verify <task-id>
/composer:apply <task-id> --candidate <candidate-id>
/composer:cancel <task-id>
```

The command files are thin wrappers. Foreground commands return CLI output directly; background commands use
Claude Code's background task support and preserve raw `$ARGUMENTS`.

## Codex Plugin And Skill

If your Codex environment supports local skills or plugins, install the repo-local Codex plugin from
[`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json), or copy
[`skills/composer-swarm/SKILL.md`](../skills/composer-swarm/SKILL.md) into the skills directory your Codex
setup uses. The plugin-packaged copy lives at `plugins/composer-swarm/skills/composer-swarm/SKILL.md` and
should stay identical to the repo-root skill file.

The skill tells Codex to:

- run `setup`; use `setup --init --trust` when config is missing
- for broad repo understanding, start its own investigation and launch `research --workers <1-4>` in parallel
- choose `team --builders <1-4>` or `review --scouts <0-4>` from the user's request
- inspect `status` and `result`
- run `verify` before recommending a candidate when patches exist
- review patch artifacts before recommending a candidate
- ask the user before running `apply`

## Config Notes

Runtime config lives at `.composer-swarm/config.json` in the target project. See
[swarm.config.example.json](../swarm.config.example.json) or run `composer-swarm example-config`.

- `distribution.defaultWorkerModel` must stay `composer-2.5-fast`.
- `workers.composer` configures the `cursor-agent` command used for Composer workers.
- `verify` requires `workers.verifier`. The default config runs `npm test`.
- Older `defaultRoles`, `agents[].role`, and `plan --roles` usage has been replaced by worker count flags:
  `team --builders`, `review --scouts`, and `research --workers`.
- A top-level `policies` field is ignored if present; it is stripped during config load and has no effect in
  v1.

## State Layout

Runtime state is stored in the target project:

```text
.composer-swarm/
  config.json
  state/
    tasks/<task-id>.json
    transcripts/<task-id>/<worker-label>.jsonl
    artifacts/<task-id>/<candidate-id>.patch
    worktrees/<task-id>/<worker-label>/
```

Commit `.composer-swarm/config.json` if the worker commands are useful to the project. Ignore
`.composer-swarm/state/`.

## Manual Release Checks

Match CI before tagging a release:

```bash
node --check bin/composer-swarm.mjs
node --check src/runtime.mjs
node --check src/args.mjs
node --check plugins/composer-swarm/scripts/composer-swarm.mjs
node --check plugins/composer-swarm/scripts/lib/args.mjs
npm test
node bin/composer-swarm.mjs --help
node bin/composer-swarm.mjs example-config >/dev/null
npm pack --dry-run --json
```

Then, in a disposable git repository with authenticated `cursor-agent`:

```bash
node /path/to/composer-swarm/bin/composer-swarm.mjs setup --init --trust
node /path/to/composer-swarm/bin/composer-swarm.mjs team "make a tiny safe edit" --builders 2
node /path/to/composer-swarm/bin/composer-swarm.mjs result <task-id>
```

## Known Limits

- no npm publish
- no external marketplace submission
- no MCP server
- no auto-ranking
- no auto-merge
- no worker backend other than `cursor-agent`
- config `policies` fields are not enforced
