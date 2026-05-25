---
name: investigate-bug
description: Find a likely bug cause before editing.
agents: composer-wide-search, composer-deep-search, composer-reasoning-reviewer
---

# investigate-bug

Use this when the failure cause or behavior is unclear.

## Context Brief

- Failing command, error, symptom, or user-visible behavior.
- Known files, recent changes, and current hypothesis.
- Checks the host already ran or intentionally skipped.
- Constraints, non-goals, and compatibility concerns.

## Fan-Out

- `composer-wide-search`: map source, tests, docs, configs, entry points, and adjacent references.
- `composer-deep-search`: trace the most likely failing flow end to end.
- `composer-reasoning-reviewer`: challenge the current hypothesis and look for alternative causes.

## Host Gate

Verify the likely cause against source or a local check before editing.

## Quality Signals

- New relevant files or flows found.
- Claims verified against source or host-run checks.
- Alternative causes ruled in or out.
- Remaining uncertainty before implementation.
