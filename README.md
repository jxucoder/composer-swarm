# Composer Swarm

> **Claude Code or Codex stays in charge. Fast Composer workers search, review, and draft options.**

Composer Swarm is a repo-local ComposerDelegate runtime. It lets the coding agent you already use delegate
repository research, review, and implementation attempts to local Cursor/Composer workers running
`composer-2.5-fast`.

The main agent keeps judgment and control. Composer workers provide breadth: wider code search, extra
reasoning, review-only leads, and isolated candidate patches.

## What You Get

- `/composer:review` for read-only repo review leads, including dirty and untracked work
- `/composer:research` for read-only codebase research while the main agent keeps investigating
- `/composer:team` for isolated implementation candidates when the checkout is clean
- `/composer:status`, `/composer:inspect`, `/composer:logs`, and `/composer:result` to inspect local runs
- `/composer:verify` to run configured checks against candidate worktrees
- `/composer:apply` to apply exactly one approved candidate patch

## Requirements

- Node.js 20 or later
- git
- authenticated `cursor-agent` on `PATH`
- clean tracked files before `team` and `apply`
- dirty or untracked files are supported for read-only `research` and `review`
- `verify` needs a repo-specific `workers.verifier`; the host agent should choose it when needed

## Install

Composer Swarm v1 is repo-only. Clone this repository first:

```bash
git clone https://github.com/jxucoder/composer-swarm.git
```

### Claude Code

From Claude Code, add the repo-local marketplace and install the plugin:

```bash
/plugin marketplace add /path/to/composer-swarm/.claude-plugin/marketplace.json
/plugin install composer@jxucoder-composer-swarm
/reload-plugins
```

Then run this from the repository you want Composer Swarm to work on:

```bash
/composer:setup
```

### Codex

Install the Codex skill and put the CLI on `PATH`:

```bash
mkdir -p ~/.codex/skills/composer-swarm ~/.local/bin
cp /path/to/composer-swarm/skills/composer-swarm/SKILL.md ~/.codex/skills/composer-swarm/SKILL.md
ln -sfn /path/to/composer-swarm/bin/composer-swarm.mjs ~/.local/bin/composer-swarm
```

Restart Codex after installing the skill. Then ask naturally from the target repository:

```text
Use Composer Swarm to review my current changes.
Use Composer Swarm to research how config loading works with three workers.
Use Composer Swarm to fix the failing tests with two builders.
```

### CLI Only

From the target repository:

```bash
node /path/to/composer-swarm/bin/composer-swarm.mjs setup --init --trust
```

Optional convenience:

```bash
alias composer-swarm='node /path/to/composer-swarm/bin/composer-swarm.mjs'
```

## Quickstart

Start with a read-only review. This works even when the current checkout has dirty or untracked prototype
files:

```bash
/composer:review --preset repo --include-untracked
/composer:status
/composer:result
```

The CLI equivalent is:

```bash
composer-swarm setup --init --trust
composer-swarm review --preset repo --include-untracked
composer-swarm result
```

## Typical Flows

### Review Current Work

Use this before committing a rewrite, prototype, or broad local change:

```bash
composer-swarm review --preset repo --include-untracked
composer-swarm result <task-id> --verbose
```

Review is read-only. It snapshots tracked modifications and untracked files into isolated worker worktrees
so Composer can inspect the code without changing the main checkout. Treat the output as scout leads; the
main agent should verify file references, severity, and behavior before calling anything release-blocking.

### Research A Code Path

Use research when the main agent needs wider search or independent evidence:

```bash
composer-swarm research "Find every place config is loaded or normalized" --workers 3 --background
composer-swarm status <task-id>
composer-swarm logs <task-id>
composer-swarm result <task-id> --verbose
```

The main agent should continue its own investigation and treat Composer output as leads to verify.
Read-only workers run in Cursor plan mode, so test execution may be unavailable; use local checks for final
behavioral claims.

### Try Implementation Candidates

Implementation teams require a clean tracked checkout:

```bash
composer-swarm team "fix the failing tests" --builders 2 --background
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm result <task-id>
composer-swarm verify <task-id>
```

After inspecting the candidate patch and verification output, apply exactly one selected candidate:

```bash
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cleanup <task-id>
```

`cleanup` removes worker worktrees but keeps task metadata and transcripts under `.composer-swarm/state/` so
`result`, `inspect`, and `logs` still work until you delete that state directory.

## Commands

```text
composer-swarm setup [--init] [--trust]
composer-swarm research "<question>" [--workers 1..4] [--include-untracked|--snapshot-current]
composer-swarm review [--preset repo|security|tests] [--scouts 0..4] [--include-untracked|--snapshot-current]
composer-swarm team "<task>" [--builders 1..4]
composer-swarm status [task-id]
composer-swarm inspect [task-id]
composer-swarm logs [task-id] [--worker <label>] [--tail 80]
composer-swarm result [task-id] [--verbose]
composer-swarm verify <task-id> [--candidate <candidate-id>]
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cancel <task-id>
composer-swarm cleanup [task-id]
```

Claude Code exposes the same workflow through `/composer:*` slash commands.

## Safety Model

- Codex or Claude Code is the main agent; Composer is a delegate, not the decision-maker.
- Research and review are read-only, have no apply path, and are not reviewers of record.
- Dirty and untracked checkouts are snapshotted only for read-only research/review.
- Implementation workers edit isolated git worktrees.
- Cursor workers are pinned to `composer-2.5-fast`.
- Task JSON, transcripts, patches, and worktrees live under `.composer-swarm/state/`.
- `apply` requires a clean checkout and applies exactly one selected candidate patch.
- `--recommended` should only be used after inspecting the result.

## FAQ

### Is `--background` a Cursor Background Agent?

No. In repo-only v1, `--background` starts a detached local Node process and records progress under
`.composer-swarm/state/`. It is not a hosted Cursor Background Agent, hosted Codex task, or separate task UI.

### Can Composer Swarm review dirty work?

Yes. Use `research` or `review` with `--include-untracked` or `--snapshot-current`. Read-only workers get a
snapshot of the current checkout, including untracked files where available.

### Is review output authoritative?

No. `review` and `research` are scout workflows. They broaden search and return evidence, confidence, and
verification gaps. The main agent or user should validate important claims against source and local checks.

### What verifier does setup create?

None. `setup --init` does not guess test commands. The main agent should inspect the repo and add
`workers.verifier` to `.composer-swarm/config.json` only when it knows the right command.

### Can Composer Swarm implement from a dirty checkout?

No. `team` and `apply` require a clean tracked checkout. This prevents candidate patches from accidentally
including unrelated local work.

### Does Composer Swarm apply changes automatically?

No. Composer workers can produce candidate patches, but the main agent or user must inspect, verify, and
explicitly apply one candidate.

### What is ComposerDelegate?

It is the mental model:

```text
use_composer(task, mode, scope, context)
```

In v1 this maps to CLI commands rather than a typed SDK API: `research`, `review`, `team`, `status`,
`inspect`, `logs`, `result`, `verify`, and `apply`.

### How does this relate to OpenAI Swarm?

Composer Swarm borrows the lightweight routines-and-handoffs pattern: the host skill or plugin is the
routine, CLI commands are tool calls, Composer workers are bounded handoffs, and task state is explicit on
disk. The runtime is a local Node CLI, not the OpenAI Swarm Python package.

## More Detail

- [Technical spec](docs/technical-spec.md)
- [Repo-only release notes](docs/repo-only-release.md)
- [Architecture](docs/architecture.md)
- [Worker protocol](docs/protocol.md)
- [Host adapters](docs/adapters.md)

## License

[MIT](LICENSE)
