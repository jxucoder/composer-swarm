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
- Shared repo context at the top of worker prompts so workers start from the same bounded repository summary
  before task-specific instructions and independent angles

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
/composer:review --current
/composer:status
/composer:result
```

The CLI equivalent is:

```bash
composer-swarm setup --init --trust
composer-swarm review --current
composer-swarm result
```

## Typical Flows

### Review Current Work

Use this before committing a rewrite, prototype, or broad local change:

```bash
composer-swarm review --current
composer-swarm result <task-id> --synthesis
composer-swarm result <task-id> --findings
```

Review is read-only. It snapshots tracked modifications and untracked files into isolated worker worktrees
so Composer can inspect the code without changing the main checkout. The default no-scout review runs only
the reviewer for speed; add `--scouts` when the main agent wants broader independent coverage. Treat the
output as scout leads; the main agent should verify file references, severity, and behavior before calling
anything release-blocking.

### Research A Code Path

Use research when the main agent needs wider search or independent evidence:

```bash
composer-swarm research "Find every place config is loaded or normalized" --workers 3 --background
composer-swarm research "Look for release-blocking defects" --pack bugs --background
composer-swarm research "Map auth behavior" --angles "entry points,data flow,tests,edge cases" --background
composer-swarm research --from-plan plans/auth-research.md --background
composer-swarm status <task-id>
composer-swarm logs <task-id>
composer-swarm result <task-id> --synthesis
composer-swarm result <task-id> --findings
composer-swarm result <task-id> --verbose
```

The main agent should continue its own investigation and treat Composer output as leads to verify.
Read-only workers run in Cursor plan mode, so test execution may be unavailable; use local checks for final
behavioral claims. Use `result --synthesis` when the host model needs a compact coverage and verification
brief, and use `result --json` when it needs parsed research findings plus machine-readable synthesis fields
such as worker coverage, verification counts, source worker, angle, evidence, confidence, verification tier,
and follow-up checks.

### Try Implementation Candidates

Implementation teams require a clean tracked checkout:

```bash
composer-swarm team "fix the failing tests" --builders 2 --background
composer-swarm team --from-plan plans/implementation.md --builders 3 --background
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm result <task-id>
composer-swarm verify <task-id>
```

Use `team --from-plan <file>` when the main reasoning model has already investigated and written the
implementation plan. In that mode, Composer Swarm skips the Composer planner worker and sends builders
directly to independent isolated implementations of the host-authored plan. The exact plan file is treated as
a task input and does not make the clean-checkout gate fail.

If at least one builder produces a completed candidate while another worker fails, the task is reported as
`partial` instead of `failed`; inspect and verify the completed candidates before deciding whether to continue
or rerun the swarm.

After inspecting the candidate patch and verification output, apply exactly one selected candidate:

```bash
composer-swarm apply <task-id> --candidate <candidate-id>
composer-swarm cleanup <task-id>
```

For host-agent automation, `composer-swarm result <task-id> --json` includes `candidateSummary` with
candidate status counts, verifier check buckets, patch availability, parsed recommendation ambiguity, and the
team reviewer note excerpt. Treat that reviewer signal as supporting evidence; the main agent still chooses
what to recommend or apply.

`cleanup` removes worker worktrees but keeps task metadata and transcripts under `.composer-swarm/state/` so
`result`, `inspect`, and `logs` still work until you delete that state directory.

## Commands

```text
composer-swarm setup [--init] [--trust]
composer-swarm research "<question>" [--workers 1..4] [--focus <area>] [--pack broad|bugs|flow|tests|design|release|security] [--angles <a,b>] [--from-plan <file>] [--include-untracked|--snapshot-current] [--json]
composer-swarm review [--preset repo|security|tests] [--scouts 0..4] [--current|--include-untracked|--snapshot-current] [--json]
composer-swarm team "<task>" [--builders 1..4] [--from-plan <file>] [--json]
composer-swarm status [task-id] [--json]
composer-swarm inspect [task-id]
composer-swarm logs [task-id] [--worker <label>] [--tail 80]
composer-swarm result [task-id] [--verbose|--findings|--synthesis|--json]
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
- `apply` requires a clean checkout at the task base commit and applies exactly one selected candidate patch.
- `--recommended` should only be used after inspecting the result.
- Launch commands accept `--json` for host-agent orchestration. The JSON includes `taskId`, `mode`, worker
  labels, and useful text and JSON inspection/verification commands.

## FAQ

### Is `--background` a Cursor Background Agent?

No. In repo-only v1, `--background` starts a detached local Node process and records progress under
`.composer-swarm/state/`. It is not a hosted Cursor Background Agent, hosted Codex task, or separate task UI.

### Can Composer Swarm review dirty work?

Yes. Use `review --current`, or use `research`/`review` with `--include-untracked` or `--snapshot-current`.
Read-only workers get a snapshot of the current checkout, including untracked files where available.

### Is review output authoritative?

No. `review` and `research` are scout workflows. They broaden search and return evidence, confidence, and
verification gaps. The main agent or user should validate important claims against source and local checks.
For concise host-agent consumption, use `composer-swarm result <task-id> --synthesis`,
`composer-swarm result <task-id> --findings`, or `composer-swarm result <task-id> --json`. Findings output
labels each parsed item with a verification tier so source-read leads are visually distinct from executed
checks. JSON output also includes `synthesis.workerCoverage`, `synthesis.verificationSummary`, and
`synthesis.hostFollowUpChecks` so host agents do not need to parse the prose synthesis.

### Can Composer Swarm use a KV cache?

Not directly. Each worker is a separate `cursor-agent` process, so Composer Swarm cannot pass model-internal
KV tensors between workers. It does keep worker prompts cache-friendly by putting the same bounded repo
context summary at the top of each worker prompt, before task-specific metadata, worker labels, and angles.
That summary lives in task state and is not a separate cache workflow or shared worker reasoning.

### What verifier does setup create?

None. `setup --init` does not guess test commands. The main agent should inspect the repo and add
`workers.verifier` to `.composer-swarm/config.json` only when it knows the right command.
The generated config is local by default; share reviewed templates instead of committing personal trust or
verifier settings.

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
