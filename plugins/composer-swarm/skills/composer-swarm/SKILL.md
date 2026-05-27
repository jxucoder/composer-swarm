---
name: composer-swarm
description: Map every file in a subsystem, trace a behavior end-to-end across files, or run a test and summarize the result — without polluting the main agent's context. Use when the task would take 3+ greps, spans multiple files to trace, or produces noisy output the main agent shouldn't read raw.
---

# Composer Swarm

Use this skill when:
- The user asks to map, find, or list all files/callers/tests in a
  subsystem ("find every file that touches X", "who calls Y")
- The user asks to trace a behavior end-to-end ("what happens when Z
  is called", "follow this from entry to database")
- The user asks to run a command and wants just the result ("run the
  tests and tell me what failed", "check if it compiles")
- The user mentions Composer Swarm, scouts, or delegation directly
- The main agent is about to do 3+ consecutive greps in the same area,
  read 4+ files to follow one call chain, or run a command whose output
  would pollute its context

Composer Swarm is delegation economics. The main agent owns synthesis,
edits, tests, commits, and pushes. Three Cursor Composer scouts handle
marginal-value sub-tasks the main agent shouldn't burn its own tokens
on.

Bundled scouts:

- `composer-wide-search` — coverage-disciplined map of a subsystem.
- `composer-deep-search` — depth-disciplined trace of one behavior.
- `composer-runner` — execution of one named command, structured
  summary returned.

## When to dispatch

A scout is right when:

- A wide search across a subsystem would take more than 3 greps inline.
- A deep search tracing one behavior would cross 4+ files.
- The sub-task is parallelizable with main-agent reasoning.
- The sub-task's raw output (test logs, full file dumps) would pollute
  the main agent's context.
- The sub-task is concrete enough to define in 1-2 sentences.

A scout is wrong when:

- The sub-task requires judgment (write a fix, decide between options).
- The sub-task is irreducibly part of the main agent's reasoning chain.
- The sub-task is small enough that delegation overhead exceeds
  savings.

## Dispatch protocol

For each delegation:

1. Name the scout (`composer-wide-search`, `composer-deep-search`, or
   `composer-runner`).
2. State the task in 1-2 sentences. Wide-search needs a subsystem;
   deep-search needs a behavior; runner needs an exact command.
3. Name the budget (`quick`, `thorough`, `exhaustive`). Default
   `thorough`.
4. Optional: seed files, starting point, or working directory.

Example dispatches:

```text
Use composer-wide-search to map all files in src/auth that touch JWT
verification. Budget thorough.

Use composer-deep-search to trace what happens when login() is called
with an expired refresh token. Start at src/auth/login.ts:42. Budget
exhaustive.

Use composer-runner to run `npm test -- auth/login`. Budget thorough.
```

## Reading reports

Each scout returns:

- A `Task:` line — the scout's one-sentence restatement of what it
  understood. Read this first. If the restatement drifts from what you
  meant, re-dispatch with a clearer prompt before trusting the rest.
- A structured body (`Map:` / `Trace:` / `Command:` summary).
- A `Hypotheses (need evidence)` section — suspicions the scout could
  not cite at `path:line`. Treat as leads, not findings.
- An **Adjacent surprises** footer (1-3 things plausibly tied to the
  task; each cites `path:line`).
- A **Gaps** section (what the scout couldn't cover).

Read the surprises footer carefully. Scouts see the surroundings the
main agent doesn't. A surprise often points at the root cause faster
than the assigned task does.

## Convergence

When multiple scouts fan out on the same investigation, weight findings
by *independent rediscovery*. A finding two scouts hit from different
angles is far stronger than a finding one scout flagged. The `Task:`
header each scout echoes makes this comparable — scan it to see what
each scout actually understood the question to be, then diff their
reports.

Single-scout flags need extra skepticism, especially under `Hypotheses`
or `Adjacent surprises`. The main agent decides whether to re-dispatch
a runner or a deeper trace to substantiate.

## Filtering to PR comments

Scout output is a working draft, not a comment thread. Before posting
to a PR, drop findings that don't meet all three of:

1. Cited evidence at `path:line`, or a measured signal from runner output.
2. Cross-scout convergence, or a blast radius you can articulate in one
   sentence.
3. Actionable in this PR — the reviewer can resolve it without further
   speculation.

Hypotheses, marginal adjacent surprises, and single-scout severity
claims stay in your notes, not the PR. Two or three high-conviction
comments beat ten hedged ones.

## Human gates

- Verify high-stakes claims against source before editing. Scout reports
  cite `path:line`; spot-check the few that matter.
- Do not ask scouts to commit, push, install packages, edit files, or
  perform sub-task work outside the scout's defined shape.
- The runner scout may run only the one command the main agent named —
  do not ask it to "investigate" failures by running more commands.
  Dispatch another runner instead.

## Setup

If the user reports scouts are not visible, give them:

1. Install Cursor CLI; run `cursor-agent login`.
2. Install Runner from `shinpr/sub-agents-skills`.
3. Install Composer Swarm from this repo's marketplace.
