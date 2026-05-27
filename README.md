# Composer Swarm

> Cheap Cursor Composer scouts the main agent fans out marginal-value
> work to — mapping, tracing, test-running — so its context stays clean.

Three scouts: `composer-wide-search` (read-only, coverage),
`composer-deep-search` (read-only, depth), `composer-runner`
(single-command execution). Each takes a budget hint (`quick` /
`thorough` / `exhaustive`), separates observed findings from
speculation, and flags adjacent things the main agent didn't ask about.

Triggers on task shape — "find every file that touches X", "trace what
happens when Y is called", "run the tests and tell me what failed" —
no need to mention Composer Swarm by name. Pair with Opus 4.7 or Codex
xhigh for synthesis and edits; scouts run on Composer 2.5 Fast (~$0.44/task).

## Why this exists

The main agent's context is finite and expensive. Inline grep loops,
test output parsing, and codebase mapping all pollute it. The built-in
`Explore` subagent is Haiku-grade and one-shot — no multi-hop traces,
no command execution. Composer Swarm fills the gap: cheap agentic
scouts for three shapes of work the main agent shouldn't do inline.

## The three scouts

| Scout | When | Returns |
|---|---|---|
| `composer-wide-search` | "Map every place X is used in this codebase" | `Task:`, `Budget:`, `Coverage:`, `Map:` grouped by role, `Cross-references:`, `Hypotheses (need evidence):`, `Adjacent surprises:`, `Gaps:` |
| `composer-deep-search` | "Trace what happens when Y is called" | `Task:`, `Budget:`, `Coverage:`, `Trace:` sequential steps, `State touched:`, `Error paths:`, `Tests covering this trace:`, `Hypotheses (need evidence):`, `Adjacent surprises:`, `Gaps:` |
| `composer-runner` | "Run `npm test -- auth/login` and tell me what failed" | `Task:`, `Budget:`, `Command:`, `Exit:`, `Summary:`, `Key signals:`, `Side effects:`, `Hypotheses (need evidence):`, `Adjacent surprises:`, `Gaps:` |

Wide-search and deep-search are read-only (`permission: read-only`,
`permissionMode: plan`). Runner has shell access but is locked to the
one command the main agent names; refuses anything dangerous.

## Adjacent surprises

Every scout flags 1-3 things plausibly tied to the assigned task —
same root cause, same code path, or changes the answer — each cited
at `path:line`. Unrelated oddities are filtered out. Scouts see the
surroundings the main agent doesn't; "you asked X but Y looks
suspicious" attacks blindspots directly.

## Severity discipline

Scouts separate observation from speculation:

- **Observed** — cited at `path:line`. Stated directly.
- **Inferred** — prefixed "implies..." / "may cause...", names
  confirming evidence.
- **Hypothesis** — no citation. Goes in `Hypotheses (need evidence)`,
  not findings or surprises.

"Bug", "broken", "fails", "invalid" require a cited behavior. A
producer/consumer mismatch is *ambiguity* until someone cites the
failure path.

## Worked patterns

Usage examples, not files. Nothing in the plugin enforces structure.

### Bug investigation

```text
Use composer-wide-search to map all files in src/auth, budget thorough.
Use composer-deep-search to trace login() with an expired token, budget exhaustive.
Use composer-runner to run `npm test -- auth/login`, budget thorough.
```

Three scouts in parallel. Main agent synthesizes a root-cause
hypothesis from the map, trace, and test summary.

### PR review

```text
Use composer-deep-search to trace each behavior the diff changes, budget thorough.
Use composer-runner to run `npm run typecheck`, budget quick.
Use composer-wide-search to find every caller the diff modifies, budget thorough.
```

Three review questions: what does it do, does it compile, who else
is affected.

### Refactor planning

```text
Use composer-wide-search on budget exhaustive to find every caller and test.
Use composer-deep-search on budget exhaustive to trace the most-used caller's path.
```

Coverage + depth on the highest-risk path.

## Install

Three pieces: Cursor CLI, Runner (dispatcher), Composer Swarm (scouts).

**1. Cursor CLI**
```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

**2. Runner** — Claude Code:
```text
/plugin marketplace add shinpr/sub-agents-skills
/plugin install runner@sub-agents-skills
```
Codex:
```text
codex plugin marketplace add shinpr/sub-agents-skills
```
Install **Runner** from `/plugins` → restart.

**3. Composer Swarm** — Claude Code:
```text
/plugin marketplace add jxucoder/composer-swarm
/plugin install composer-swarm@jxucoder-composer-swarm
```
Codex:
```text
codex plugin marketplace add jxucoder/composer-swarm
```
Install → restart.

## Design advantages

1. **Three shapes, not one generic scout.** Coverage (wide-search), depth (deep-search), execution (runner) — each with its own discipline and stopping condition.
2. **Budget knob.** `quick` / `thorough` / `exhaustive` — main agent declares intent, scout matches regime. No fast-vs-thorough hedge.
3. **Adjacent surprises.** 1-3 things plausibly tied to the task the main agent didn't ask about, each cited `path:line`. Answers what you forgot to ask.
4. **Severity calibration.** Observed (cited `path:line`) vs inferred ("implies...") vs hypothesis (needs evidence). Can't say "broken" without citing the behavior.
5. **Task restatement.** Scout echoes a `Task:` line restating what it understood. Drift = bad brief, caught before trusting the report.
6. **Convergence over count.** Two scouts hitting the same issue from different angles > one scout flagging it alone. `Task:` echo makes reports diffable.
7. **Hypotheses bucket.** Suspicions without evidence go in a separate section, not mixed into findings. Main agent decides whether to substantiate.
8. **PR comment filter.** Only findings with cited evidence + cross-scout convergence or clear blast radius + in-PR actionability earn a comment.
9. **~10x cheaper.** Scouts on Composer 2.5 Fast (~$0.44/task) vs Opus/Codex main agent (~$4+/task). Read-only search and test summarization need coverage, not frontier reasoning.
10. **Markdown-only, no runtime.** Prompt files and frontmatter. No daemon, state format, sync step, or code to maintain.

## How it differs from neighbors

| Tool | What it does | Where Composer Swarm differs |
|---|---|---|
| Claude Code `Explore` | Cheap one-shot grep, Haiku-grade | Not agentic, no multi-hop traces, no command execution, no severity calibration, no adjacent-surprises footer |
| `shinpr/sub-agents-skills` | Routes Markdown agents to multiple backends | The router; Composer Swarm is what you route |
| `wshobson/agents` | 191 generic agents | Prose output, no budget knob, no severity/hypothesis split, no task restatement, no adjacent-surprises footer, no execution scout |
| `addyosmani/agent-skills` | Parallel fan-out with personas | No budget knob, no severity calibration, no convergence framing, no adjacent-surprises footer |

## Docs

- [`docs/design.md`](docs/design.md) — scout disciplines, budget regimes, why the surprises footer
- [`plugins/composer-swarm/skills/composer-swarm/SKILL.md`](plugins/composer-swarm/skills/composer-swarm/SKILL.md) — main-agent dispatch protocol (shipped to npm consumers)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — edit workflow and release checklist

## License

[MIT](LICENSE)
