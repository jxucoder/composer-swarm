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
Each something that could plausibly share a root cause with the
assigned task, sit on the same code path, or change the answer to
it — TODOs along the trace, orphan tests in the map, suspicious
comments near the touched code, deprecation warnings on the
exercised path. Random oddities elsewhere are out, even if
interesting; that bar exists because earlier versions of the
prompt drowned PR comments in unrelated noise.

This footer is the single most novel part of the design. Most search
tools answer exactly the question. A scout that says "you asked X but Y
also looks suspicious" attacks the main agent's blindspots specifically.
The main agent doesn't know what it doesn't know; scouts see the
surroundings the main agent doesn't.

The risk is the scout hedges and lists vague concerns. The prompt
explicitly forbids that — every surprise must cite `path:line`, and the
footer is empty when nothing actually surprised the scout. Padding the
list with hedges is worse than leaving it empty.

## Severity calibration

Scouts split findings into three buckets: observed behavior cited at
`path:line` (or measured output for the runner), inferred consequences
prefixed with "implies..." / "may cause...", and hypotheses that need
new evidence (a runner pass, a wider trace, an endpoint timing). The
prompt forbids the words "bug", "broken", "fails", or "invalid" unless
the scout can cite the observed behavior.

The motivation is a real failure mode of cheap scouts: they trace a
contract mismatch — producer says X, consumer assumes Y — and report
it as "X is broken" or "Y is invalid." The actual finding is
ambiguity, not failure. Either label hedges in the wrong direction and
burns reviewer trust when posted as a PR comment.

The hypotheses bucket lets scouts surface suspicion without pretending
they have evidence. The main agent decides whether to re-dispatch a
runner (or a deeper trace) to substantiate before acting.

## Task restatement

Every scout echoes a `Task:` line at the top of its report — a
one-sentence restatement of what it understood the main agent to be
asking. The field is cheap (one line) and earns its place two ways:

- Parallel scouts become distinguishable. Three scouts fanned out at
  the same wide-search shape show three different restated tasks, so
  their reports cross-reference cleanly.
- Misunderstanding surfaces immediately. If the scout's restatement
  drifts from what the main agent meant, the main agent sees it
  before reading the body and can re-dispatch.

The dispatch protocol stays at 1-2 sentences from the main agent. The
restatement happens scout-side; the main agent does not have to coin
a slug.

## Convergence over count

When the main agent fans out multiple scouts on the same
investigation, the strongest signal is *independent rediscovery* — two
scouts hitting the same issue from different angles. The `Task:`
header each scout echoes makes convergence visible: the main agent
scans what each scout understood the question to be, then diffs the
findings.

Single-scout flags get extra skepticism, especially in the hypotheses
and adjacent-surprises sections. Convergence is not inter-scout
ceremony — there is still no protocol between scouts — it is
pattern-matching the main agent does at synthesis time.

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
