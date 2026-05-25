# Repo-Only Release

This v1 release is intentionally repo-only. Do not publish to npm or submit to external marketplaces yet.

Licensed under [MIT](../LICENSE). Requires Node `>=20.0.0` (`package.json` `engines.node`).

## Install

Clone the repo and call the CLI with Node:

```bash
git clone https://github.com/jxucoder/composer-swarm.git
node /path/to/composer-swarm/bin/composer-swarm.mjs setup --init --trust
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
- a clean checkout before `team` and before `apply`, aside from Composer Swarm runtime state
- dirty or untracked files are allowed for read-only `research` and `review`; they are snapshotted into
  worker worktrees

## Raw CLI Quickstart

From the target project:

```bash
composer-swarm setup --init --trust
composer-swarm team "implement the requested change" --builders 2
composer-swarm team --from-plan plans/implementation.md --builders 3
composer-swarm research "map the config loading flow" --pack flow --json
composer-swarm research "map the config loading flow" --pack flow --background
composer-swarm review --preset repo --scouts 2 --current --background
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm logs <task-id> --worker <label>
composer-swarm result <task-id>
composer-swarm verify <task-id>
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cleanup <task-id>
```

Use `--background` for long-running tasks. In repo-only v1 this starts a detached local process and writes
task state under `.composer-swarm/state/`; it is not a hosted background-agent service or separate task UI.

```bash
composer-swarm team "investigate the regression" --builders 2 --background
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm logs <task-id>
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
/composer:team --from-plan plans/fix.md --builders 3
/composer:research map the config loading flow --pack flow
/composer:status <task-id>
/composer:inspect <task-id>
/composer:logs <task-id> --worker <label>
/composer:result <task-id>
/composer:verify <task-id>
/composer:apply <task-id> --candidate <candidate-id>
/composer:cancel <task-id>
```

The command files are thin wrappers. Foreground commands return CLI output directly. When Claude Code
supports background Bash execution, the command files can use it while preserving raw `$ARGUMENTS`; otherwise
the runtime's portable background behavior is the detached local process described above.

The runtime also records a bounded shared repo context summary in each task. This is not a model-internal KV
cache, but it keeps shared repository metadata stable at the top of worker prompts so repeated worker calls
are friendlier to provider prompt-prefix caches.

## Codex Plugin And Skill

If your Codex environment supports local plugins, install the repo-local Codex plugin from
[`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json). For a manual skill install, copy the
skill and put the CLI on `PATH`:

```bash
mkdir -p ~/.codex/skills/composer-swarm ~/.local/bin
cp /path/to/composer-swarm/skills/composer-swarm/SKILL.md ~/.codex/skills/composer-swarm/SKILL.md
ln -sfn /path/to/composer-swarm/bin/composer-swarm.mjs ~/.local/bin/composer-swarm
```

Restart Codex after installing. The plugin-packaged copy lives at
`plugins/composer-swarm/skills/composer-swarm/SKILL.md` and should stay identical to the repo-root skill file.

The skill tells Codex to:

- run `setup`; use `setup --init --trust` when config is missing
- for broad repo understanding, start its own investigation and launch `research --pack <name>` or
  `research --angles <a,b>` in parallel; for host-authored decomposition, write a short Markdown plan and run
  `research --from-plan <file>`
- choose `team --builders <1-4>` or `review --scouts <0-4>` from the user's request; when Codex already wrote
  an implementation plan, use `team --from-plan <file>` so Composer builders execute that host plan
- inspect `status` and `result`
- add launch `--json` when it needs task ids and useful commands without scraping human stdout
- inspect local state and transcripts with `inspect` and `logs` when needed
- run `verify` before recommending a candidate when patches exist
- review patch artifacts before recommending a candidate
- ask the user before running `apply`

## Config Notes

Runtime config lives at `.composer-swarm/config.json` in the target project. See
[swarm.config.example.json](../swarm.config.example.json) or run `composer-swarm example-config`.

- `distribution.defaultWorkerModel` must stay `composer-2.5-fast`.
- `workers.composer` configures the `cursor-agent` command used for Composer workers.
- `verify` requires `workers.verifier`. `setup --init` does not infer it; the host agent should inspect the
  repo and set the project-specific check command when verification is needed.
- Read-only `research` and `review` snapshot current dirty/untracked checkouts into isolated worktrees.
  Implementation `team` and `apply` still require a clean checkout, aside from Composer Swarm runtime state.
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

Keep `.composer-swarm/config.json` local by default because it may contain trust flags or verifier commands.
Share reviewed templates such as `swarm.config.example.json`. Ignore `.composer-swarm/state/`.

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
mkdir -p src tests
printf 'export const answer = 42;\n' > src/prototype.js
printf 'import { answer } from "../src/prototype.js";\n\nconsole.log(answer);\n' > tests/prototype.test.js
node /path/to/composer-swarm/bin/composer-swarm.mjs review --current
node /path/to/composer-swarm/bin/composer-swarm.mjs result <review-task-id> --findings
rm -rf src tests
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
