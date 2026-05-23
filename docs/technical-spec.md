# Technical Spec

Composer Swarm v1 is a repo-only Node CLI with thin host adapters for Claude Code and Codex. The CLI is the
runtime; plugins and skills only invoke it.

## OpenAI Swarm Pattern

The design follows the useful parts of [OpenAI Swarm](https://github.com/openai/swarm)'s educational model
without depending on the Python package. OpenAI Swarm is intentionally lightweight and now superseded by the
[OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) for production OpenAI agent apps, so Composer
Swarm copies the primitives rather than the dependency:

- **Routine:** The Codex skill or Claude command file is the host routine. It tells the main agent when to
  call setup, research, review, team, status, inspect, logs, result, verify, apply, cancel, and cleanup.
- **Tools:** CLI commands are the tool boundary. The host agent invokes `composer-swarm` commands and receives
  structured task state, transcripts, patches, and verifier output.
- **Handoff:** Starting a Composer worker is a handoff from the host agent to an isolated worker process. The
  handoff is explicit, bounded by a worker label, worktree, prompt, timeout, and transcript.
- **Context variables:** `.composer-swarm/state/` is the durable context store. The runtime records task
  status, worker output, candidate patches, verifier checks, and selected candidates instead of relying on
  hidden model memory.
- **Return to host:** Composer workers do not apply patches or own final judgment. Results return to the host
  agent, which cross-checks evidence, asks for approval, and runs final checks.

This keeps the Swarm-style control loop small: call a routine, run tool-backed handoffs, update explicit
state, then return control to the main agent.

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
    transcripts/<task-id>/<worker-label>.jsonl
    artifacts/<task-id>/<candidate-id>.patch
    worktrees/<task-id>/<worker-label>/
```

Commit `.composer-swarm/config.json` when the worker commands are useful. Ignore `.composer-swarm/state/`.

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
| `swarm` | Swarm name and state directory |
| `distribution` | Host and worker defaults |
| `workers.composer` | The Cursor/Composer CLI command used for all Composer workers |
| `workers.verifier` | Optional shell command used by `verify` |

**Enforced at runtime:**

- `distribution.defaultWorkerModel` must be `composer-2.5-fast`. Other values fail `doctor` and are rejected
  when launching workers.
- `workers.composer.command` must resolve to an available `cursor-agent` command.
- `verify` requires `workers.verifier` when that command is run. The default config includes one.

**Informational only:**

- `distribution.userPromise`, `primaryHosts`, and `defaultWorkerKind` are shown in `doctor` output but are
  not otherwise enforced.
- The runtime chooses internal worker labels from `team --builders`, `review --scouts`, or `research --workers`.
- Existing legacy configs with an `agents` array are still accepted, but new configs should not use it.

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

Research work uses one to four read-only Composer workers. It does not create candidates, verifier checks,
recommendations, or apply commands. Research is designed to run while the host agent continues its own repo
investigation and later reconciles the Composer evidence. If one research worker fails or times out, completed
worker outputs are still recorded so the host agent can use the partial evidence.

Default implementation work uses one planning pass, one to four isolated implementation attempts, and one
review pass. Review-only work uses one planning pass, optional read-only scout passes, and one review pass.
These worker labels are runtime state, not user-configured personas.

Planning, research, scout, and review passes run in Cursor plan mode. Implementation workers run with edit
access inside isolated git worktrees only.

Workers have a conservative inactivity timeout so a silent `cursor-agent` process cannot block a task
indefinitely. Timed-out workers are marked failed with the timeout reason in task status and transcripts.

## CLI Reference

```text
composer-swarm init [--force] [--trust]
composer-swarm setup [--init] [--trust] [--force] [--json]
composer-swarm doctor
composer-swarm plan <task text>
composer-swarm team <task text> [--builders 2] [--background|--wait]
composer-swarm research <question> [--workers 2] [--focus <area>] [--include-untracked|--snapshot-current] [--background|--wait]
composer-swarm review [--preset repo|security|tests] [--scouts 0..4] [--include-untracked|--snapshot-current] [--background|--wait]
composer-swarm ls
composer-swarm status [task-id]
composer-swarm inspect [task-id]
composer-swarm logs [task-id] [--worker <label>] [--tail 80]
composer-swarm result [task-id] [--verbose]
composer-swarm verify <task-id> [--candidate <id>] [--no-baseline]
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm apply <task-id> --recommended
composer-swarm cancel <task-id>
composer-swarm cleanup [task-id]
```

`team` waits by default. `--background` starts a detached local runner and stores task state so `status` and
`result` can inspect it later. This is local process detachment, not a hosted Cursor Background Agent,
hosted Codex task, or managed task UI.

`setup` checks git, config, Node, the configured Composer worker command, and the configured shell verifier
command. `setup --init --trust` writes `.composer-swarm/config.json` with trusted Composer worker args.

Dirty-check behavior is mode-specific:

| Mode | Dirty checkout behavior |
|---|---|
| `research` | Allowed; snapshots current tracked and untracked files into read-only worker worktrees |
| `review` | Allowed; snapshots current tracked and untracked files into read-only worker worktrees |
| `team` | Blocked until the main checkout is clean, aside from Composer Swarm runtime state |
| `verify` | Runs against stored candidate worktrees |
| `apply` | Blocked until the main checkout is clean, aside from Composer Swarm runtime state |

## Research

Research tasks are read-only and return evidence for the host agent:

```bash
composer-swarm research "Find every place config is loaded or normalized" --workers 3 --background
composer-swarm research "Map the release flow and risky manual steps" --workers 4 --focus release
composer-swarm research "Review the current rewrite" --snapshot-current
```

Use `--workers 1..4` to choose breadth. Use `--focus` for a coarse area such as `architecture`, `tests`,
`security`, `docs`, or `release`. The host agent should continue its own search while research runs, then
read `result --verbose` and cross-check important claims against the cited files or commands.

Read-only research can run against dirty and untracked checkouts. When the checkout has non-runtime changes,
the runtime automatically snapshots tracked modifications and untracked files into each read-only worker
worktree. `--snapshot-current` or `--include-untracked` makes that intent explicit.

## ComposerDelegate Interface

The conceptual host-agent interface is:

```ts
use_composer({
  task: string,
  mode: "research" | "implement" | "review",
  scope?: string[],
  context?: string
})
```

This is not a public TypeScript API in v1. It is the mental model used by the Codex skill and Claude command
files. The mapping is:

| Conceptual call | v1 command |
|---|---|
| `mode: "research"` | `composer-swarm research "<question>" --workers <1-4>` |
| `mode: "implement"` | `composer-swarm team "<task>" --builders <1-4>` |
| `mode: "review"` | `composer-swarm review --preset repo --scouts <0-4>` |
| inspect task state | `composer-swarm inspect <task-id>` |
| inspect worker output | `composer-swarm logs <task-id> --worker <label>` |
| verify candidate patches | `composer-swarm verify <task-id>` |
| apply approved candidate | `composer-swarm apply <task-id> --candidate <candidate-id>` |

`scope` and `context` should be folded into the natural-language task text for now, for example:
`composer-swarm research "Map auth token flow. Focus on src/auth and tests/auth. Context: release blocker."`

## Reviews

Review presets avoid long prompts:

```bash
composer-swarm review
composer-swarm review --preset security
composer-swarm review --preset tests
composer-swarm review --preset repo --include-untracked
```

Review tasks run a read-only review workflow with optional scout passes. They do not create implementation
patches. Dirty and untracked checkouts are supported by snapshotting current files into read-only worker
worktrees. This supports the common "review my current changes before I commit" workflow without weakening
the clean-checkout requirement for implementation and apply.

## Results

`result` shows candidate IDs, changed-file counts, patch size, verifier status, reviewer notes, and the
detected recommendation when one can be parsed. Use `--verbose` for patch paths, worktree paths, and failed
check output.

For research tasks, `result --verbose` shows each research worker's evidence and transcript path. It never
prints apply commands.

## Inspect And Logs

`inspect` shows the local task file, state root, worker transcript paths, worktree paths, candidate patch
paths, and useful next commands:

```bash
composer-swarm inspect <task-id>
```

`logs` lists available worker transcripts when no worker is selected:

```bash
composer-swarm logs <task-id>
```

To print one worker transcript:

```bash
composer-swarm logs <task-id> --worker builder-a --tail 80
```

Use `--tail 0` to print the full transcript. These commands are the local substitute for a hosted background
task UI in repo-only v1.

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

Apply requires a clean checkout, aside from Composer Swarm runtime state, and checks whether the patch applies
cleanly before changing files.

## Repo Targeting

If the current directory is not inside a git repository, Composer Swarm searches nearby directories and
suggests `cd` paths to nested git repos. Local-state commands such as `ls`, `status`, `inspect`, `logs`,
`result`, and `cleanup` can run without a git checkout when task state is available.

## Host Adapters

Claude Code local plugin files live in `plugins/composer-swarm`. They expose:

```text
/composer:setup
/composer:team
/composer:research
/composer:review
/composer:status
/composer:inspect
/composer:logs
/composer:result
/composer:verify
/composer:apply
/composer:cancel
```

The command files copy the `codex-plugin-cc` pattern: preserve `$ARGUMENTS`, return foreground output
verbatim, and use host background command execution when the host provides it. The runtime's portable
background mode remains the local detached runner described above.

Codex plugin metadata lives in `.agents/plugins/marketplace.json`, and the Codex skill lives in
`skills/composer-swarm/SKILL.md`. Codex environments must explicitly support and install local skills or
plugins before they will use that file. For manual skill installs, copy `SKILL.md` into
`~/.codex/skills/composer-swarm/` and put `bin/composer-swarm.mjs` on `PATH`. The skill requires Codex to
inspect results and ask before running `apply`.

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
