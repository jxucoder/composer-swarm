---
name: composer-swarm
description: Use read-only Composer operation fan-out to strengthen host search, reasoning, plan review, and implementation review.
---

# Composer Swarm

Use this skill when the user asks for Composer Swarm, Composer fan-out, Composer search, reasoning review,
plan review, implementation review, review from multiple angles, or parallel read-only repository
investigation.

Composer Swarm is operation fan-out, not delegation of judgment. The host agent keeps working locally and
owns synthesis, edits, tests, commits, and pushes. Composer agents provide parallel evidence and critique.

Packaged playbook contracts live in `../../playbooks/`.

## Host Protocol

When the task is broad, risky, or unclear:

1. Start your own local search or reasoning first.
2. Prepare a short context brief: objective, known files, current hypothesis or plan, constraints, and checks
   already run.
3. Choose the smallest playbook that covers the risk:
   - `investigate-bug`: `composer-wide-search`, `composer-deep-search`, `composer-reasoning-reviewer`
   - `review-plan`: `composer-plan-reviewer`, `composer-reasoning-reviewer`, targeted `composer-wide-search`
   - `review-implementation`: `composer-implementation-reviewer`, `composer-reviewer`, targeted `composer-deep-search`
   - `explore-subsystem`: `composer-wide-search`, `composer-deep-search`, `composer-reasoning-reviewer`
   - `pre-commit-risk-check`: `composer-implementation-reviewer`, `composer-reviewer`, `composer-plan-reviewer`
   Targeted wide search starts from seed files, a diff, failing output, or a narrowed question and maps
   adjacent source, tests, docs, configs, and call sites. Targeted deep search traces one specific behavior
   through callers, state, errors, and tests.
4. Launch the playbook's read-only Composer agents in parallel when Runner/sub-agent dispatch is available.
5. Give each agent the same context brief and a distinct angle.
6. Continue local search, reasoning, or implementation while they run.
7. Reconcile reports with your own work:
   - verify file references
   - discard unsupported claims
   - resolve contradictions
   - decide next action yourself
8. Do not edit based only on sub-agent output.

For substantial runs, return a compact host synthesis:

```text
Playbook: <name>
Context Brief: <objective, scope, hypothesis, constraints>
Fan-Out: <agents and angles>
Agent Reports: <brief report summaries by agent and angle>
Local Work: <what the host checked while agents ran>
Verified Evidence: <claims checked against source or commands>
Contradictions: <conflicts and resolution>
Decision: <edit, answer, revise plan, or no-op>
Quality Signals: <agents launched, angles covered, files or flows mapped, claims verified, checks run, unresolved gaps, whether fan-out changed the plan>
```

Human gates:

- Verify a likely bug cause before editing.
- Accept or revise a plan before implementing it.
- Verify review findings before keeping a diff.
- Run local checks and surface unresolved risks before commit, push, or release.
- Do not ask Composer agents to commit, push, install packages, or edit files.

## Dispatch

Use the installed Runner/sub-agents workflow:

```text
Use the Composer Swarm review-plan playbook on <topic>.
Use different angles and return evidence for host synthesis.
```

If Runner or the bundled agents are not visible, give the user the consolidated setup:

1. Install Cursor CLI and run `cursor-agent login`.
2. Install Runner.
3. Install Composer Swarm from this repo's marketplace file.

All bundled agents are read-only. Do not ask them to commit, push, install packages, or edit files.
