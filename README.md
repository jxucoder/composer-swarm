# Composer Swarm

> Cheap, fast, parallel Cursor Composer scouts your main agent fans out
> marginal-value work to.

Three Cursor Composer scouts — two read-only (`composer-wide-search`,
`composer-deep-search`) and one execution-capable (`composer-runner`,
locked to a single named command) — that take any sub-task the main
agent doesn't want to spend its own tokens on: mapping a subsystem,
tracing one behavior end-to-end, running a test and summarizing the
output. Each scout takes a budget hint and flags adjacent things the
main agent didn't think to ask about.

Pair with an Opus 4.7 or Codex xhigh main agent that handles the
synthesis, the edits, and the judgment.

## Why this exists

The main agent has expensive tokens and a finite context. Every grep
loop it runs inline, every test output it parses, every codebase map it
builds in its head — all that work pollutes its context and slows its
reasoning.

The built-in `Explore` subagent handles cheap one-shot greps, but it is
Haiku-grade and one-shot — it cannot chase multi-hop traces and it
cannot run commands. The main agent *can* do both, but burns context to
do them.

Composer Swarm fills the gap: cheap agentic scouts that handle three
shapes of marginal-value work the main agent shouldn't do inline.

## The three scouts

| Scout | When | Returns |
|---|---|---|
| `composer-wide-search` | "Map every place X is used in this codebase" | `Map:` grouped by role, `Cross-references:`, `Adjacent surprises:`, `Gaps:`, plus `Budget:` and `Coverage:` headers |
| `composer-deep-search` | "Trace what happens when Y is called" | `Trace:` sequential steps, `State touched:`, `Error paths:`, `Tests covering this trace:`, `Adjacent surprises:`, `Gaps:`, plus `Budget:` and `Coverage:` headers |
| `composer-runner` | "Run `npm test -- auth/login` and tell me what failed" | `Command:`, `Exit:`, `Summary:`, `Key signals:`, `Side effects:`, `Adjacent surprises:`, `Gaps:`, plus `Budget:` header |

All three accept a `budget` knob: `quick` / `thorough` / `exhaustive`.
Two scouts (wide-search, deep-search) are read-only: frontmatter
declares `permission: read-only` and `permissionMode: plan`. The
runner has shell access (`permission: execute`, `permissionMode:
default`) but is locked to the one command the main agent names and
refuses anything dangerous.

## What "adjacent surprises" means

After completing the assigned task, every scout flags 1-3 things the
main agent didn't explicitly ask about but probably wants to know —
TODOs along the trace, orphaned tests in the map, suspicious comments,
deprecation warnings in command output, off-by-one risks, dead paths.

This is the single largest reason to fan out scouts instead of grepping
inline: scouts see the surroundings; the main agent doesn't. A scout
that says "you asked X but Y looks suspicious" attacks the main agent's
blindspots specifically — which is the whole point of delegation.

## Worked patterns

These are usage examples, not files. The main agent invokes them as
needed; nothing in the plugin enforces structure.

### Bug investigation

```text
Use composer-wide-search to map all files in src/auth, budget thorough.
Use composer-deep-search to trace what happens when login() is called
  with an expired token, budget exhaustive.
Use composer-runner to run `npm test -- auth/login`, budget thorough.
```

Three scouts in parallel. Main agent gets a map, a trace, and a test
summary — synthesizes into a root-cause hypothesis without grepping or
test-running inline.

### PR review

```text
Use composer-deep-search to trace each behavior the diff changes,
  budget thorough.
Use composer-runner to run `npm run typecheck`, budget quick.
Use composer-wide-search to find every caller of the functions the
  diff modifies, budget thorough.
```

Three scouts cover the three review questions: what does it do, does
it compile, who else is affected.

### Refactor planning

```text
Use composer-wide-search on budget exhaustive to find every caller
  and test of the function being refactored.
Use composer-deep-search on budget exhaustive to trace the most-used
  caller's full path.
```

Coverage + depth on the highest-risk path. Main agent plans from a
complete picture.

## Install

Three pieces: Cursor CLI, Runner (the dispatcher), Composer Swarm
(this plugin).

**1. Cursor CLI**

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

**2. Runner**

Claude Code:

```text
/plugin marketplace add shinpr/sub-agents-skills
/plugin install runner@sub-agents-skills
```

Codex:

```text
codex plugin marketplace add shinpr/sub-agents-skills
```

Then install **Runner** from `/plugins` → restart.

**3. Composer Swarm**

Claude Code:

```text
/plugin marketplace add jxucoder/composer-swarm
/plugin install composer-swarm@jxucoder-composer-swarm
```

Codex:

```text
codex plugin marketplace add jxucoder/composer-swarm
```

Install **Composer Swarm** → restart.

## Design advantages

1. **Three shapes, not one generic scout.** The job space splits into coverage (wide-search), depth (deep-search), and execution (runner). A single "search agent" prompt can't serve all three well — each has a different discipline and stopping condition.
2. **Budget knob removes the fast-vs-thorough hedge.** Every scout takes `quick` / `thorough` / `exhaustive`. The main agent declares intent; the scout has three regimes that match. No standing tension in the prompt.
3. **Adjacent surprises attack blindspots.** Scouts flag 1-3 things the main agent didn't ask about, each cited at `path:line`. Most search tools answer exactly the question — scouts also answer what you forgot to ask.
4. **Severity calibration separates observation from speculation.** Findings split into observed (cited at `path:line`), inferred ("implies..." / "may cause..."), and hypotheses (need evidence). Scouts cannot call something "broken" without citing the behavior.
5. **Task restatement catches misunderstanding early.** Every scout echoes a `Task:` line restating what it understood. Drift there tells the main agent the brief was unclear — before reading a report built on the wrong premise.
6. **Convergence over count.** When multiple scouts fan out, the strongest signal is independent rediscovery — two scouts hitting the same issue from different angles. The `Task:` echo makes this diffable.
7. **Hypotheses bucket keeps speculation honest.** Suspicions that lack evidence go in a separate section, not mixed into findings. The main agent decides whether to re-dispatch a runner or deeper trace to substantiate.
8. **PR comment filter prevents noise.** Scout output is a working draft. Only findings with cited evidence, cross-scout convergence or clear blast radius, and in-PR actionability earn a comment. Hypotheses and marginal surprises stay in notes.
9. **~60x cheaper than inline work.** Scouts run on Cursor Composer 2.5 (~$0.07/task) while the main agent stays on Opus/Codex. Read-only search and test summarization don't need frontier reasoning — they need coverage and structured output.
10. **Markdown-only, no runtime.** The entire plugin is prompt files and frontmatter. No daemon, no state format, no sync step, no code to maintain. Scouts are defined by their discipline, not by infrastructure.

## How it differs from neighbors

| Tool | What it does | Where Composer Swarm differs |
|---|---|---|
| Claude Code `Explore` | Cheap one-shot grep, Haiku-grade | Not agentic, no multi-hop traces, no command execution, no adjacent-surprises footer |
| `shinpr/sub-agents-skills` | Routes Markdown agents to multiple backends | The router; Composer Swarm is what you route |
| `wshobson/agents` | 191 generic agents | Prose output, no budget knob, no adjacent-surprises footer, no execution scout |

## Docs

- [`docs/design.md`](docs/design.md) — scout disciplines, budget regimes, why the surprises footer
- [`plugins/composer-swarm/skills/composer-swarm/SKILL.md`](plugins/composer-swarm/skills/composer-swarm/SKILL.md) — main-agent dispatch protocol (shipped to npm consumers)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — edit workflow and release checklist

## License

[MIT](LICENSE)
