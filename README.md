# Composer Swarm

> **Read-only Composer operation fan-out for making Codex xhigh stronger and faster.**

Composer Swarm is an installable prompt plugin for using Cursor Composer as a parallel evidence and critique
layer. The host agent, such as Codex xhigh, stays in charge of judgment, edits, verification, commits, and
pushes. Composer agents fan out read-only operations that make the host faster and better informed: wide
search, deep tracing, reasoning critique, plan review, implementation review, and defect review.

## Pattern

Composer Swarm follows a **host-supervised operation fan-out** pattern.

```text
Codex xhigh or Claude Code host
  keeps working locally
  fans out read-only Composer agents in parallel
    - wide search
    - deep tracing
    - reasoning critique
    - plan review
    - implementation review
    - defect review
  reconciles evidence and critique
  verifies important claims
  decides what to edit, test, commit, or answer
```

This is closer to manager-worker or agents-as-tools than autonomous swarm handoff. Composer agents are
specialists that return evidence and critique. The host is the only decision-maker.

## Problems Solved

High-reasoning coding agents are strong at synthesis, but they can still lose time or miss evidence when a
task has a large search space. Composer Swarm helps with:

- **Search latency**: while the host keeps working, Composer agents map files, call sites, tests, docs, and configs.
- **Coverage gaps**: different agents inspect the same problem from different angles.
- **Reasoning blind spots**: a reasoning reviewer challenges assumptions and alternative explanations.
- **Plan risk**: plan reviewers check sequencing, missed files, test strategy, migration risk, and edge cases before implementation.
- **Implementation risk**: implementation reviewers inspect diffs against behavior, integration points, and test gaps.
- **Context overload**: subagents return compact evidence instead of forcing the host to personally inspect every path first.

The goal is not to make Composer decide. The goal is to make the host's final decision better and faster.

## Design Principles

Composer Swarm is designed around a few practical agent-operating lessons:

- **Playbooks over agent wiring**: the user asks for `review-plan` or `investigate-bug`, not a hand-built agent graph.
- **Artifacts over hidden traces**: every run should leave compact, inspectable evidence the host can verify.
- **Host control over autonomy**: Composer agents return search and critique; the host decides edits, tests, commits, and pushes.
- **Context once, then reuse**: the host gives each agent the same short context brief plus a distinct angle.
- **Human gates for irreversible steps**: commits, pushes, releases, and broad rewrites stay explicit host/user decisions.
- **Measure the lift**: record coverage, verified claims, contradictions, checks run, and unresolved gaps.

## Playbooks

Use playbooks as the simple interface. Each playbook picks a small set of agents and gives them distinct
angles. The packaged playbook contracts live in `playbooks/` and are duplicated inside the plugin bundle.

| Playbook | Use When | Fan Out |
|---|---|---|
| `investigate-bug` | failure cause or behavior is unclear | wide search, deep search, reasoning review |
| `review-plan` | Codex has a plan and wants pressure-testing before editing | plan review, reasoning review, targeted wide search |
| `review-implementation` | a diff or candidate implementation exists | implementation review, defect review, targeted deep search |
| `explore-subsystem` | entering an unfamiliar area | wide search, deep search, reasoning review |
| `pre-commit-risk-check` | before keeping or committing changes | implementation review, defect review, plan review |

`Targeted` means the host gives the agent seed files, a diff, a failing output, or a narrowed question. A
targeted wide search starts from those seeds and maps adjacent source, tests, docs, configs, and call sites. A
targeted deep search traces one specific behavior through callers, state, errors, and tests.

Example:

```text
Use the Composer Swarm review-plan playbook on this migration plan. Keep working locally, fan out the relevant
Composer agents with different angles, and return a host synthesis.
```

## Run Contract

A playbook run should be visible enough to trust without exposing unnecessary internal reasoning. The host
should produce these artifacts:

1. `Context Brief`: objective, known files, current hypothesis, constraints, and what the host already checked.
2. `Fan-Out`: agents launched, each agent's angle, and why that angle is useful.
3. `Agent Reports`: evidence maps, traces, critiques, findings, and verification gaps returned by Composer.
4. `Host Synthesis`: verified evidence, discarded claims, contradictions, decision, and next edit or answer.
5. `Quality Signals`: files covered, claims verified, tests or checks run, unresolved gaps, and whether fan-out changed the plan.

For review-like work, the host should not move forward just because multiple agents agree. Agreement is a
signal to verify, not a vote. For commit, push, release, or broad rewrite decisions, the host should surface
the synthesis and checks before acting.

Use this quality-signal shape when reporting a substantial run:

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

## Agents

- `.agents/composer-wide-search.md`: broad maps across source, tests, docs, config, entry points, and call sites.
- `.agents/composer-deep-search.md`: close tracing of one behavior, bug, flow, or design question.
- `.agents/composer-reasoning-reviewer.md`: critique assumptions, alternatives, and reasoning gaps.
- `.agents/composer-plan-reviewer.md`: review a plan from repo, sequencing, risk, and verification angles.
- `.agents/composer-implementation-reviewer.md`: review an implementation or diff for correctness and integration risk.
- `.agents/composer-reviewer.md`: defect-focused review after the relevant surface has been found.

All agents use:

```markdown
---
run-agent: cursor-agent
permission: read-only
---
```

There is no runtime, daemon, apply command, or local state format in this repo. The plugin bundles plain
Markdown agents and a host-facing skill.

## Install

There is one setup pattern:

1. Install Cursor CLI.
2. Install Runner once.
3. Install Composer Swarm from this checkout.

### 1. Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

### 2. Runner

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

### 3. Composer Swarm

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

Use the fallback only when you want direct Runner prompts without installing the plugin.

## Usage

Prefer playbooks for normal use:

```text
Use the Composer Swarm investigate-bug playbook for this failing config test.
Use the Composer Swarm review-plan playbook for this implementation plan.
Use the Composer Swarm review-implementation playbook for this diff.
Use the Composer Swarm explore-subsystem playbook for package release behavior.
Use the Composer Swarm pre-commit-risk-check playbook before I commit.
```

Use individual agents when you know the exact operation you want:

```text
Use the composer-wide-search agent to find every config loading, normalization, and validation path.
Use the composer-deep-search agent to trace how config defaults flow from CLI flags into runtime state.
Use the composer-reasoning-reviewer agent to critique my current conclusion about config precedence.
Use the composer-plan-reviewer agent to review this implementation plan from migration and test-risk angles.
Use the composer-implementation-reviewer agent to review this diff against the plan and nearby call sites.
Use the composer-reviewer agent to review my current changes after the search pass.
```

For custom broad or risky work, ask for operation fan-out:

```text
Keep investigating locally, and fan out composer-wide-search, composer-deep-search, composer-plan-reviewer,
and composer-reasoning-reviewer in parallel on config loading. Use different angles and return evidence for
host synthesis.
```

In Codex, prefix with `$runner:sub-agents` if Runner does not auto-route the request.

Good playbook prompts include:

- the subsystem, behavior, bug, or decision under investigation
- known files or failing output
- what counts as relevant evidence
- the current hypothesis, plan, implementation, or diff under review
- the angles you want covered, such as correctness, tests, migration risk, security, or release risk
- what the host has already checked

Sub-agents start with fresh context. Make each delegated request stand on its own.

## Operation Fan-Out

Composer Swarm does not replace the host agent's thinking. It adds parallel evidence and critique. The host
agent keeps working locally, then fans out a few read-only Composer agents when extra coverage or independent
review is useful.

Use fan-out when:

- the relevant files are not obvious
- behavior crosses multiple modules
- a change has release, security, or compatibility risk
- a plan needs independent review before implementation
- an implementation needs review from multiple angles
- the host wants assumptions challenged before committing to a path
- the host wants independent confirmation before editing

Use different angles so the agents do not duplicate work:

- wide search: map files, call sites, tests, docs, configs, and adjacent paths
- deep search: trace one behavior end to end
- reasoning review: challenge assumptions, alternatives, and evidence gaps
- plan review: inspect sequencing, missed files, test strategy, and risk
- implementation review: inspect the diff, integration points, and test gaps
- reviewer: look for concrete defects and missing tests in the found surface

The host owns synthesis. Compare reports, verify important claims, discard weak leads, then decide what to
edit or answer. Do not treat sub-agent output as a vote.

## Operating Model

Use Composer for parallel operations, not authority:

- fan out read-only agents for parallel evidence and critique when the work is broad or risky
- wide search before high-impact edits when the relevant files are not obvious
- deep search before subtle bug fixes or behavior changes
- reasoning review before relying on a fragile conclusion
- plan review before executing a multi-step change
- implementation review before keeping a candidate diff
- reviewer after wide/deep search when you want defect-focused scrutiny
- host agent verification before edits, commits, pushes, or release decisions

Prompt permissions are behavioral guardrails, not hard sandboxing. These agents are read-only, but the host
agent should still verify important claims against source and local checks.

## Repository Layout

```text
.agents/
  composer-wide-search.md
  composer-deep-search.md
  composer-reasoning-reviewer.md
  composer-plan-reviewer.md
  composer-implementation-reviewer.md
  composer-reviewer.md
  plugins/marketplace.json
.claude-plugin/
  marketplace.json
playbooks/
  investigate-bug.md
  review-plan.md
  review-implementation.md
  explore-subsystem.md
  pre-commit-risk-check.md
plugins/composer-swarm/
  .codex-plugin/plugin.json
  .claude-plugin/plugin.json
  agents/
  playbooks/
  skills/
docs/
  design.md
  prompt-agents.md
tests/
  prompt-pack.test.mjs
```

## License

[MIT](LICENSE)
