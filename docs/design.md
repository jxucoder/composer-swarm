# Design

Composer Swarm is a playbook-first prompt pack. It uses Cursor Composer as a parallel read-only operation
layer for a stronger host agent such as Codex xhigh or Claude Code. Playbook contracts live in `playbooks/`
and are duplicated inside `plugins/composer-swarm/playbooks/` for plugin installs.

The design goal is not a fully autonomous swarm. The goal is to make the host faster and better informed
while keeping judgment, write access, verification, commits, and pushes in one place.

## Lessons Applied

The current design applies these operating lessons:

- **Lower the interface cost**: users invoke named playbooks instead of remembering agent combinations.
- **Keep the process inspectable**: host-visible artifacts show what was searched, challenged, verified, and ignored.
- **Preserve control**: Composer agents are read-only specialists; irreversible actions remain host/user gates.
- **Specialize repeated operations**: wide search, deep trace, reasoning critique, plan review, implementation review, and defect review are reusable operation templates.
- **Manage context deliberately**: each agent gets a concise context brief plus one angle, then returns a compact report.
- **Benchmark the harness**: a useful run should improve coverage, reduce uncertainty, or catch a risk the host did not already have.

## Playbook Lifecycle

1. **Host starts locally**: inspect the repo, form an initial hypothesis, and avoid delegating before knowing the task shape.
2. **Host writes a context brief**: objective, known files, current hypothesis, constraints, and already-run checks.
3. **Host fans out read-only Composer agents**: choose the smallest playbook and assign distinct angles.
4. **Agents return artifacts**: maps, traces, critiques, review findings, evidence, and verification gaps.
5. **Host synthesizes**: verify important claims, discard weak leads, resolve contradictions, and decide the next action.
6. **Host gates action**: edits, broad rewrites, commits, pushes, and release decisions happen only after host verification.
7. **Host records quality signals**: coverage, claims verified, checks run, unresolved gaps, and whether fan-out changed the plan.

## Standard Artifacts

`Context Brief`

- Objective
- Scope and known files
- Current hypothesis or plan
- Constraints and non-goals
- Checks already run or intentionally skipped

`Agent Report`

- Agent name and angle
- Files or behavior covered
- Evidence with file references where available
- Findings or critique
- Verification gaps
- Suggested host follow-up

`Host Synthesis`

- Playbook used
- Local work performed while agents ran
- Agent reports considered
- Verified evidence
- Discarded or unverified claims
- Contradictions and resolution
- Decision and next action

`Quality Signals`

- Agents launched: count and names
- Angles covered: distinct angles
- Files or flows mapped: high-signal coverage
- Claims verified: verified count or list
- Checks run: commands or none
- Remaining gaps: explicit unknowns
- Fan-out changed plan: yes or no, with why

## Playbook Contracts

`investigate-bug`

- Use when the cause is unclear.
- Fan out wide search, deep search, and reasoning review.
- Gate on a verified cause before editing.
- Success means the host has a source-backed cause, likely edit points, and a test/check target.

`review-plan`

- Use before executing a non-trivial plan.
- Fan out plan review, reasoning review, and targeted wide search.
- Targeted wide search starts from the plan's seed files and maps adjacent source, tests, docs, configs, and call sites.
- Gate on plan changes or explicit acceptance before editing.
- Success means missed files, risky sequencing, and test gaps are surfaced before implementation.

`review-implementation`

- Use when a diff or candidate implementation exists.
- Fan out implementation review, defect review, and targeted deep search.
- Targeted deep search traces one changed behavior from the diff through callers, state, errors, and tests.
- Gate on verified findings before keeping the diff.
- Success means correctness, integration, test strength, and release risk were inspected from separate angles.

`explore-subsystem`

- Use when entering unfamiliar code.
- Fan out wide search, deep search, and reasoning review.
- Gate on an evidence map before high-impact changes.
- Success means the host knows entry points, call sites, tests, docs, and likely risks.

`pre-commit-risk-check`

- Use before preserving local changes.
- Fan out implementation review, defect review, and plan review.
- Gate on local checks and host synthesis before commit or push.
- Success means unresolved risks are explicit and release-blocking claims are verified.

## What This Avoids

- No runtime state format to maintain.
- No autonomous apply step.
- No hidden worker vote.
- No requirement that users learn a graph or node system.
- No pressure to make Composer write before the read-only harness proves its value.
