---
name: review-plan
description: Pressure-test a host-authored plan before implementation.
agents: composer-plan-reviewer, composer-reasoning-reviewer, composer-wide-search
---

# review-plan

Use this before executing a non-trivial implementation or migration plan.

## Context Brief

- The plan under review.
- Intended behavior and non-goals.
- Known target files, tests, and migration constraints.
- Host assumptions and checks already performed.

## Fan-Out

- `composer-plan-reviewer`: inspect sequencing, missed files, test strategy, and rollback risk.
- `composer-reasoning-reviewer`: challenge assumptions, tradeoffs, and alternative decompositions.
- Targeted `composer-wide-search`: start from the plan's files and search adjacent source, tests, docs, configs, and call sites that could invalidate the plan.

## Host Gate

Accept, revise, or reject the plan before implementation.

## Quality Signals

- Missed files or integration points found.
- Risky sequencing or migration steps identified.
- Test gaps surfaced.
- Whether fan-out changed the plan.
