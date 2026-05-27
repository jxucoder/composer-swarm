---
name: composer-swarm
description: Map files in a subsystem, trace behavior end-to-end, or run a test and summarize — delegates to cheap Composer scouts so raw output stays out of main agent context. Triggers on 3+ greps, multi-file traces, noisy command output.
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

To dispatch a scout, run `cursor-agent` via Bash with the scout's
prompt file and the task. The model, mode, and tools are enforced at
the CLI level — no middleware needed.

**Read-only scouts** (wide-search, deep-search):

```bash
cursor-agent \
  --model composer-2.5-fast \
  --mode ask \
  -p "You are a <scout-name> scout. <task>. Budget <budget>."
```

`--mode ask` enforces read-only: the scout can read files but cannot
edit, commit, or run shell commands.

**Execution scout** (runner):

```bash
cursor-agent \
  --model composer-2.5-fast \
  -p "You are a composer-runner scout. Run: <exact command>. Budget <budget>."
```

No `--mode ask` — the runner needs shell access for the one named
command.

### Building the prompt

Each scout has a full prompt in its agent file under
`plugins/composer-swarm/agents/`. When dispatching:

1. Read the scout's `.md` file (strip frontmatter).
2. Append the task: what to map/trace/run, the budget, and optional
   seed files or starting points.
3. Pass as `-p` to `cursor-agent`.

Or for a quick dispatch without reading the full prompt file, include
the key discipline inline:

```bash
cursor-agent \
  --model composer-2.5-fast \
  --mode ask \
  -p "You are a wide-search scout. Map every file in src/auth that
touches JWT verification. Budget thorough. Return: Task (restate what
you understood), Map grouped by role with path:line, Cross-references,
Hypotheses (need evidence), Adjacent surprises (1-3, plausibly tied to
task, each citing path:line), Gaps."
```

### Parallel dispatch

Fan out multiple scouts simultaneously by running them in parallel:

```bash
cursor-agent --model composer-2.5-fast --mode ask \
  -p "Wide-search scout. Map all files in src/auth. Budget thorough. ..." &

cursor-agent --model composer-2.5-fast --mode ask \
  -p "Deep-search scout. Trace login() with expired token. Budget exhaustive. ..." &

cursor-agent --model composer-2.5-fast \
  -p "Runner scout. Run: npm test -- auth/login. Budget thorough. ..." &

wait
```

Main agent collects all three reports, then synthesizes.

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

If `cursor-agent` is not available:

1. Install Cursor CLI: `curl https://cursor.com/install -fsS | bash`
2. Authenticate: `cursor-agent login`
3. Install Composer Swarm from the marketplace.
