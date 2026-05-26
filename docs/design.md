# Design

Composer Swarm is a three-scout pack for delegation economics: a main
agent (Opus 4.7, Codex xhigh) keeps its tokens on synthesis while cheap
fast Cursor Composer scouts handle the marginal-value sub-tasks.

The design goal is to make the scouts *good at their specific shape* of
work without adding ceremony or shared protocol.

## The three scouts

The job space the main agent is delegating splits into three shapes:

| Shape | Scout | Discipline |
|---|---|---|
| Find the surface area | `composer-wide-search` | Coverage. Group by role. Don't early-exit. |
| Trace one behavior | `composer-deep-search` | Depth. One thread. Follow to terminal state. |
| Execute and summarize | `composer-runner` | One command. Return signal, not noise. |

Other marginal-value tasks (research, validation, summarization) map
onto one of these three. Research is wide-search with broader scope.
Validation is deep-search verifying a claim against source. There is no
fourth scout because the prompt for one of the existing three covers it.

## Budget knob

Every scout takes a `budget` hint in the main agent's dispatch prompt:

- **quick** — 1-2 min. Map the obvious sites / trace the happy path /
  run the named command and headline pass-fail. May miss edges.
- **thorough** — full coverage of likely paths plus immediate
  neighbors. Default.
- **exhaustive** — enumerate every adjacent path, every guard, every
  test, every doc. No early exit. Use before high-stakes decisions.

The knob removes the standing hedge between "be fast" and "be thorough"
that every search prompt has to negotiate. The main agent declares
intent; the scout's prompt has three regimes that match.

Budget is honor-system — nothing enforces a `quick` scout actually
finishes in 2 minutes. But labeling intent shifts the scout's behavior
the same way it shifts a human's. A scout told to be quick stops
sooner; a scout told to be exhaustive keeps looking.

## Adjacent surprises footer

Every scout's output ends with:

```text
Adjacent surprises:
- <path:line>: <thing the main agent didn't ask about>
```

1-3 entries. Each tied to a `path:line` (the runner scout may
substitute a test name when the surprise comes from test output).
Each something a junior engineer would point at and say "wait, is
that supposed to be like that?" — TODOs, orphan tests, suspicious
comments, dead paths, deprecation warnings, off-by-one risks.

This footer is the single most novel part of the design. Most search
tools answer exactly the question. A scout that says "you asked X but Y
also looks suspicious" attacks the main agent's blindspots specifically.
The main agent doesn't know what it doesn't know; scouts see the
surroundings the main agent doesn't.

The risk is the scout hedges and lists vague concerns. The prompt
explicitly forbids that — every surprise must cite `path:line`, and the
footer is empty when nothing actually surprised the scout. Padding the
list with hedges is worse than leaving it empty.

## Read-only by default, execute by exception

Two of three scouts are read-only (`permission: read-only`,
`permissionMode: plan`). The third — `composer-runner` — has shell
access (`permission: execute`, `permissionMode: default`,
`tools: Read, Glob, Grep, Bash`). Safety contract:

- Runner accepts one command from the main agent and runs only that.
- Runner refuses dangerous-looking commands (`rm`, `deploy`, `drop`,
  `force-push`, anything destructive against shared state) and asks
  the main agent to confirm.
- Runner does not branch into additional shell work even when it looks
  helpful — return to the main agent first.

The split exists because the user's marginal-value job space includes
"run tests" and "validate by execution," which read-only cannot cover.
Running tests inline pollutes the main agent's context with raw output;
the runner scout summarizes.

## No shared protocol between scouts

The scouts return structured reports independently; the main agent does
what it always does (synthesize, spot-check the `path:line` references
that matter, decide). There is no mandatory artifact, no inter-scout
adjudication, no required cross-reference between scout outputs.

## Source-of-truth and sync

Scout prompts live in `.agents/composer-*.md`. The plugin bundle at
`plugins/composer-swarm/agents/` is a byte-mirror produced by
`npm run sync`, and the test suite asserts that mirror is current.
There is no runtime layer that resolves scout files at dispatch time;
hosts read them from the bundle directly. See `CONTRIBUTING.md` for
the edit workflow.

## What this avoids

- **No playbooks.** Common usage patterns appear as README examples,
  not as Markdown files the main agent has to load.
- **No shared artifact.** Reports return to the main agent's
  conversation; persistence is the main agent's call.
- **No structured verification format.** Scouts cite `path:line`
  evidence; that is enough for the main agent to spot-check.
- **No scout-on-scout pairing.** The main agent can dispatch multiple
  scouts at different angles if it wants; the plugin does not enforce a
  structure.
- **No fourth scout for "validation" or "research."** Those map onto
  the three existing scouts via different prompts.
