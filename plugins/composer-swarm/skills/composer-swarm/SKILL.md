---
name: composer-swarm
description: Fan out cheap fast Cursor Composer scouts for marginal-value work — wide search, deep search, or command execution — each with a budget knob and adjacent-surprises footer.
---

# Composer Swarm

Use this skill when the user asks for Composer Swarm, cheap parallel
scouts, wide search, deep search, multi-hop tracing, test running
delegation, or research a main agent could do itself but shouldn't.

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

- The sub-task takes more than 5 main-agent grep/read tool calls.
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

- A structured body (`Map:` / `Trace:` / `Command:` summary).
- An **Adjacent surprises** footer (1-3 things the main agent did not
  ask about; each cites `path:line`).
- A **Gaps** section (what the scout couldn't cover).

Read the surprises footer carefully. Scouts see the surroundings the
main agent doesn't. A surprise often points at the root cause faster
than the assigned task does.

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
