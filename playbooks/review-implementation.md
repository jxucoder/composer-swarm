---
name: review-implementation
description: Review an existing diff or candidate implementation before keeping it.
agents: composer-implementation-reviewer, composer-reviewer, composer-deep-search
---

# review-implementation

Use this when a diff, current worktree change, or candidate implementation exists.

## Context Brief

- Requested behavior and original plan, if any.
- Changed files or diff summary.
- Known tests and checks already run.
- Compatibility, release, or security constraints.

## Fan-Out

- `composer-implementation-reviewer`: compare the diff to behavior, integration points, tests, and release risk.
- `composer-reviewer`: look for concrete defects, regressions, security issues, and missing tests.
- Targeted `composer-deep-search`: trace one changed behavior from the diff through callers, state, errors, and tests.

## Host Gate

Verify findings before keeping the diff, changing it, committing it, or pushing it.

## Quality Signals

- Findings verified or discarded by the host.
- Changed behavior traced through relevant call sites.
- Tests or checks run after review.
- Remaining release or compatibility risks.
