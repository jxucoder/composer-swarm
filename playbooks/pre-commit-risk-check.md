---
name: pre-commit-risk-check
description: Surface unresolved risk before preserving local changes.
agents: composer-implementation-reviewer, composer-reviewer, composer-plan-reviewer
---

# pre-commit-risk-check

Use this before committing, pushing, or treating local changes as ready.

## Context Brief

- Diff summary and intended behavior.
- Important files changed.
- Tests, checks, or manual verification already run.
- Known shortcuts, risks, or unresolved questions.

## Fan-Out

- `composer-implementation-reviewer`: inspect changed behavior, tests, integration, and release risk.
- `composer-reviewer`: find concrete defects and missing tests.
- `composer-plan-reviewer`: compare the final diff to the intended plan and identify missed steps.

## Host Gate

Run local checks and surface unresolved risks before commit or push.

## Quality Signals

- Release-blocking findings verified or dismissed.
- Checks run after review.
- Unresolved gaps stated explicitly.
- Commit or push decision made by the host.
