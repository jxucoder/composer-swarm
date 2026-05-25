---
name: explore-subsystem
description: Build an evidence map before high-impact work in unfamiliar code.
agents: composer-wide-search, composer-deep-search, composer-reasoning-reviewer
---

# explore-subsystem

Use this when entering an unfamiliar subsystem or before broad changes.

## Context Brief

- Subsystem, feature, or behavior to understand.
- Known entry points or filenames.
- Questions the host needs answered.
- Constraints, non-goals, and checks already performed.

## Fan-Out

- `composer-wide-search`: map source, tests, docs, configs, entry points, call sites, and adjacent paths.
- `composer-deep-search`: trace one representative behavior end to end.
- `composer-reasoning-reviewer`: challenge the host's mental model and identify missing evidence.

## Host Gate

Produce an evidence map before high-impact edits.

## Quality Signals

- Entry points, call sites, tests, and docs identified.
- Duplicate or compatibility paths found.
- Follow-up searches narrowed.
- Remaining unknowns explicit.
