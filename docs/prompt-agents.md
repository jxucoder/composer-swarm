# Prompt Agents

Composer Swarm is intentionally just prompt files. The useful pattern is operation fan-out:

1. The host agent keeps working locally.
2. Fan out read-only Composer agents when the search, reasoning, plan, or implementation is broad or risky.
3. Give each agent a different angle so they return complementary evidence.
4. Reconcile the reports with the host agent's own findings.
5. Keep final judgment, edits, tests, commits, and pushes in the host agent.

This is evidence fan-out, not delegation of judgment.

## Design Summary

The user-facing surface is a playbook, not an agent graph. A good run produces inspectable artifacts:

- `Context Brief`: objective, known files, current hypothesis, constraints, and checks already done.
- `Fan-Out`: selected agents, distinct angles, and why those angles matter.
- `Agent Reports`: evidence, critique, findings, and verification gaps.
- `Host Synthesis`: verified claims, rejected leads, contradictions, decision, and next action.
- `Quality Signals`: coverage, claims verified, checks run, unresolved gaps, and whether fan-out changed the plan.

This keeps the workflow transparent without requiring users to manage low-level orchestration.

## Playbooks

Use playbooks as the normal interface:

- `investigate-bug`: wide search + deep search + reasoning review
- `review-plan`: plan review + reasoning review + targeted wide search
- `review-implementation`: implementation review + defect review + targeted deep search
- `explore-subsystem`: wide search + deep search + reasoning review
- `pre-commit-risk-check`: implementation review + defect review + plan review

The host should choose the smallest playbook that covers the risk. It can add or remove agents when the user
asks for a specific angle.

Packaged playbook contracts live in `playbooks/` and `plugins/composer-swarm/playbooks/`.

`Targeted` means the host gives seed files, a diff, failing output, or a narrowed question:

- Targeted wide search starts from the seeds and maps adjacent source, tests, docs, configs, and call sites.
- Targeted deep search traces one specific changed behavior through callers, state, errors, and tests.

Each playbook has a gate:

- `investigate-bug`: verify the likely cause before editing.
- `review-plan`: accept or revise the plan before implementation.
- `review-implementation`: verify findings before keeping the diff.
- `explore-subsystem`: produce an evidence map before high-impact changes.
- `pre-commit-risk-check`: run local checks and surface unresolved risks before commit or push.

## Agent Roles

### `composer-wide-search`

Use this when the relevant files are not obvious. It should return a map of source, tests, docs, config,
entry points, call sites, duplicate paths, and likely follow-up searches.

### `composer-deep-search`

Use this when the important surface is known but the behavior is subtle. It should trace entry points,
transformations, state, errors, tests, assumptions, and failure modes.

### `composer-reasoning-reviewer`

Use this when the host has a hypothesis, conclusion, or tradeoff that deserves critique. It should identify
weak assumptions, unsupported claims, alternative explanations, and evidence still needed.

### `composer-plan-reviewer`

Use this before executing a plan. It should inspect target files, sequencing, missed behavior, test strategy,
migration risk, and alternative decompositions.

### `composer-implementation-reviewer`

Use this after a diff or candidate implementation exists. It should inspect correctness, integration points,
test strength, compatibility, and release risk.

### `composer-reviewer`

Use this after search when you want a defect-focused pass. It should report actionable findings with
severity, file references, evidence, confidence, and verification gaps.

Every agent report should identify the `Agent`, assigned `Angle`, and `Playbook` before role-specific fields.
Those labels make parallel reports easier for the host to reconcile.

## Operation Fan-Out

The host agent should keep working instead of waiting idly. Composer subagents run in parallel to increase
coverage, add critique, and reduce blind spots.

Use fan-out when:

- the relevant files are not obvious
- a behavior crosses multiple modules
- a change may have release, security, or compatibility risk
- a plan needs independent review before implementation
- an implementation needs multiple review angles
- the current reasoning depends on assumptions that should be challenged
- independent confirmation would help before editing

Use different angles:

- `composer-wide-search`: map source, tests, docs, config, entry points, call sites, and adjacent paths.
- `composer-deep-search`: trace one behavior end to end through state, errors, and tests.
- `composer-reasoning-reviewer`: critique assumptions, alternatives, and evidence gaps.
- `composer-plan-reviewer`: review sequencing, missed files, test strategy, and risk.
- `composer-implementation-reviewer`: review a diff or candidate implementation against behavior and integration points.
- `composer-reviewer`: inspect the found surface for concrete bugs, regressions, and missing tests.

The host agent owns synthesis. It should compare reports, verify important claims, discard weak leads, and
then decide what to edit or answer.

## Setup

Use the same three-step setup for Codex and Claude Code:

1. Install Cursor CLI.
2. Install Runner once.
3. Install Composer Swarm from this checkout.

### Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

### Runner

Codex:

```text
codex plugin marketplace add shinpr/sub-agents-skills
```

Then open `/plugins`, install `Runner`, and restart Codex.

Claude Code:

```text
/plugin marketplace add shinpr/sub-agents-skills
/plugin install runner@sub-agents-skills
/reload-plugins
```

### Composer Swarm

Codex:

```text
codex plugin marketplace add /path/to/composer-swarm/.agents/plugins/marketplace.json
```

Then open `/plugins`, install `Composer Swarm`, and restart Codex.

Claude Code:

```text
/plugin marketplace add /path/to/composer-swarm/.claude-plugin/marketplace.json
/plugin install composer-swarm@jxucoder-composer-swarm
/reload-plugins
```

Manual fallback:

```bash
mkdir -p .agents
cp /path/to/composer-swarm/.agents/composer-*.md .agents/
```

Use the fallback only when you want direct Runner prompts without installing the plugin. The installed plugin
bundles a host skill plus the same agent definitions.

## Example Delegations

```text
Use the Composer Swarm investigate-bug playbook for this failing config test.
Use the Composer Swarm review-plan playbook for this implementation plan.
Use the Composer Swarm review-implementation playbook for this diff.
Use the Composer Swarm explore-subsystem playbook for package release behavior.
Use the Composer Swarm pre-commit-risk-check playbook before I commit.

Use the composer-wide-search agent to map every place package metadata affects release behavior.
Use the composer-deep-search agent to trace how a command argument is parsed and forwarded.
Use the composer-reasoning-reviewer agent to critique my conclusion about command argument handling.
Use the composer-plan-reviewer agent to review this release-plan draft from packaging and rollback angles.
Use the composer-implementation-reviewer agent to review this diff against the release plan.
Use the composer-reviewer agent to review the current prompt-agent docs and tests.

Keep working locally, and fan out composer-wide-search, composer-deep-search, composer-plan-reviewer, and
composer-reasoning-reviewer in parallel on package metadata release behavior. Use different angles and return
evidence for host synthesis.
```

In Codex, prefix with `$runner:sub-agents` if Runner does not auto-route the request.

## Review Discipline

Composer output is evidence and critique, not a decision. The host agent should:

- verify important claims against source
- run local checks before changing behavior
- resolve contradictions between multiple searches
- avoid treating unverified hypotheses as bugs
- keep commits and pushes outside sub-agent prompts

For substantial runs, the host response should include a short `Host Synthesis` with the playbook used,
verified evidence, contradictions, checks run, unresolved gaps, and the next action.

Use a measurable `Quality Signals` section:

```text
Quality Signals:
- Agents launched: <count and names>
- Angles covered: <distinct angles>
- Files or flows mapped: <high-signal coverage>
- Claims verified: <verified count or list>
- Checks run: <commands or none>
- Remaining gaps: <explicit unknowns>
- Fan-out changed plan: yes|no, <why>
```
