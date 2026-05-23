# Technical Spec

Composer Swarm v1 is a repo-only Node CLI with thin host adapters for Claude Code and Codex. The CLI is the
runtime; plugins and skills only invoke it.

## Runtime Model

`composer-swarm` resolves the target git workspace, reads `.composer-swarm/config.json`, creates isolated
worktrees, launches workers, records transcripts, stores patch artifacts, verifies candidates, and applies
exactly one selected patch.

Runtime state:

```text
.composer-swarm/
  config.json
  state/
    tasks/<task-id>.json
    transcripts/<task-id>/<role>.jsonl
    artifacts/<task-id>/<candidate-id>.patch
    worktrees/<task-id>/<role>/
```

Commit `.composer-swarm/config.json` when the team configuration is useful. Ignore `.composer-swarm/state/`.

## Config Schema

The runtime reads `.composer-swarm/config.json` in the target git workspace. See
[swarm.config.example.json](../swarm.config.example.json) for a full example, or print the default with:

```bash
composer-swarm example-config
```

Top-level fields:

| Field | Purpose |
|---|---|
| `version` | Config format version |
| `swarm` | Swarm name, state directory, default roles |
| `distribution` | Host and worker defaults |
| `agents` | Worker definitions used by `doctor`, `team`, and `review` |

**Enforced at runtime:**

- `distribution.defaultWorkerModel` must be `composer-2.5-fast`. Other values fail `doctor` and are rejected
  when launching workers.
- Cursor worker agents must resolve to an available `cursor-agent` command.
- `verify` requires a shell `verifier` agent when that command is run. The default config includes one.

**Informational only:**

- `distribution.userPromise`, `primaryHosts`, and `defaultWorkerKind` are shown in `doctor` output but are
  not otherwise enforced.
- `swarm.defaultRoles` documents the default team shape; task commands choose roles directly.

**Ignored if present:**

- `policies` is stripped during `loadConfig` and has no effect in v1. Do not rely on policy fields for
  enforcement.

## Worker Model

Composer workers are launched through `cursor-agent` with:

```text
--print --output-format stream-json --workspace <worktree> --model composer-2.5-fast
```

`composer-2.5-fast` is pinned. Other `--model` values are rejected. The worker model assumes Composer is
fast and low-cost enough to spend on wider code search, additional reasoning, review-only passes, and
alternate implementation attempts while the host agent owns final judgment.

Default roles:

- `planner`: decomposes the task and identifies risks
- `builder-a`: attempts the smallest direct implementation
- `builder-b`: attempts an alternate implementation or parallel subtask
- `reviewer`: reviews candidate patches for defects and regressions
- `verifier`: runs deterministic shell checks

Planner and reviewer workers run in Cursor plan mode. Builders run with edit access inside isolated git
worktrees only.

## CLI Reference

```text
composer-swarm init [--force] [--trust]
composer-swarm setup [--init] [--trust] [--force] [--json]
composer-swarm doctor
composer-swarm agents
composer-swarm plan <task text> [--roles a,b,c]
composer-swarm team <task text> [--builders 2] [--background|--wait]
composer-swarm review [--preset repo|security|tests] [--scouts 0..4] [--background|--wait]
composer-swarm status [task-id]
composer-swarm result [task-id] [--verbose]
composer-swarm verify <task-id> [--candidate <id>] [--no-baseline]
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm apply <task-id> --recommended
composer-swarm cancel <task-id>
composer-swarm cleanup [task-id]
```

`team` waits by default. `--background` starts a detached local runner and stores task state so `status` and
`result` can inspect it later.

`setup` checks git, config, Node, configured Cursor agents, and configured shell verifier commands. `setup
--init --trust` writes `.composer-swarm/config.json` with trusted Cursor worker args.

## Reviews

Review presets avoid long prompts:

```bash
composer-swarm review
composer-swarm review --preset security
composer-swarm review --preset tests
```

Review tasks run planner and reviewer workers, plus optional read-only scouts. They do not create builder patches.

## Results

`result` shows candidate IDs, changed-file counts, patch size, verifier status, reviewer notes, and the
detected recommendation when one can be parsed. Use `--verbose` for patch paths, worktree paths, and failed
check output.

## Verification

`verify` runs configured shell checks, defaulting to `npm test`, against candidate worktrees:

```bash
composer-swarm verify <task-id>
composer-swarm verify <task-id> --candidate builder-a
```

By default, verification also runs against the unmodified base commit. Failures already present on the base
are tagged `baseline`; new failures are tagged `candidate-specific`.

## Apply

Manual apply is required. `--recommended` is only a shortcut after a human has inspected and approved the
detected recommendation.

```bash
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm apply <task-id> --recommended
```

Apply requires a clean tracked checkout and checks whether the patch applies cleanly before changing files.

## Repo Targeting

If the current directory is not inside a git repository, Composer Swarm searches nearby directories and
suggests `cd` paths to nested git repos. Read-only commands such as `status`, `result`, and `cleanup` can run
without a git checkout.

## Host Adapters

Claude Code local plugin files live in `plugins/composer-swarm`. They expose:

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

The command files copy the `codex-plugin-cc` pattern: preserve `$ARGUMENTS`, return foreground output
verbatim, and use the host background task primitive for background runs.

Codex plugin metadata lives in `.agents/plugins/marketplace.json`, and the Codex skill lives in
`skills/composer-swarm/SKILL.md`. Codex environments must explicitly support and install local skills or
plugins before they will use that file. The skill requires Codex to inspect results and ask before running
`apply`.

## Plugin Runtime Resolution

When the Claude plugin runs in place, it finds `bin/composer-swarm.mjs` relative to the plugin root. If the
plugin directory is copied elsewhere, either put `composer-swarm` on `PATH` or set:

```bash
export COMPOSER_SWARM_REPO=/path/to/composer-swarm
```

## Packaging

The package is MIT-licensed and requires Node `>=20.0.0` (`package.json` `engines.node`).

Release packaging excludes local generated state, tarballs, `node_modules/`, and local reference checkouts
through `.gitignore` and `.npmignore`.

GitHub CI runs on Node 20 and Node 22:

1. **Syntax check** — `node --check` on `bin/composer-swarm.mjs`, `src/runtime.mjs`, `src/args.mjs`, and
   packaged plugin scripts under `plugins/composer-swarm/scripts/`.
2. **Tests** — `npm test` (`node --test tests/*.test.mjs`).
3. **CLI smoke** — `node bin/composer-swarm.mjs --help` and `node bin/composer-swarm.mjs example-config`.
4. **Package smoke** — `npm pack --dry-run --json`.

## Known Limits

- no npm publish yet
- no external marketplace submission yet
- no MCP server in v1
- no auto-merge; apply requires explicit user action
- `cursor-agent` is the only real worker backend
- recommendation parsing is heuristic; inspect `result --verbose` before `--recommended`
