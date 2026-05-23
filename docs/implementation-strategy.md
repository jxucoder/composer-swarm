# Implementation Strategy

## Rethink

The first scaffold treated Claude Code, Codex, Composer, and shell agents as peers in one generic swarm.
That is technically portable, but it is not the best distribution path.

The better product is:

```text
Your current agent + a team of Composer workers
```

Claude Code and Codex users already have a cockpit. The layer should make that cockpit better by giving it
Composer capacity: multiple fast, low-cost workers for wider code search, additional thinking, isolated
attempts, patch summaries, and a clean merge path.

## Insight From The Grok Share

The shared Grok conversation highlights a current pattern on X:

- users want Claude/Codex to remain the main agent that plans, supervises, and reviews
- users want Composer 2.5/Cursor to search, think, review, and execute quickly
- official Claude Agent Teams do not make Codex or Composer native teammates
- plugin-style delegation is the proven adoption path

That means our layer should not compete with Claude Code Agent Teams or Codex. It should be the adapter
that gives either host a Composer team.

Source: https://x.com/i/grok/share/513b827b6d264c15a7c2e1ecb0ceef98

## User Promise

For Claude Code:

```text
/composer:team fix the failing checkout flow
```

For Codex:

```text
Use composer-swarm to spin up two Composer builders and one Composer reviewer.
```

Expected result:

```text
Composer team finished.

Candidate A: smallest patch, tests pass.
Candidate B: broader refactor, one conflict.
Recommended: Candidate A.
Apply it? y/n
```

## Technical Shape

### 1. Host-Native Entry Points

Claude Code plugin:

- `/composer:team`
- `/composer:status`
- `/composer:result`
- `/composer:apply`
- `/composer:cancel`

Codex skill/plugin:

- tells Codex to call `composer-swarm`
- gives Codex rules for reviewing candidate patches
- lets Codex apply selected patches with ordinary repo tools

### 2. Worktree-Isolated Composer Workers

For each task:

1. Snapshot the current repo state.
2. Create N git worktrees under `.composer-swarm/state/worktrees/<task-id>/`.
3. Start one `cursor-agent` process per worker with a role-specific prompt.
4. Capture each worker's transcript, diff, status, and checks.
5. Summarize candidates for the host.
6. Apply the selected patch into the main checkout.

This avoids multiple Composer workers fighting in the same working tree.

### 3. Candidate Patch Model

Each worker returns:

```json
{
  "candidateId": "task_123-builder-a",
  "role": "builder-a",
  "worktree": ".composer-swarm/state/worktrees/task_123/builder-a",
  "summary": "Fixed checkout validation with a narrow guard.",
  "patchFile": ".composer-swarm/state/artifacts/task_123-builder-a.patch",
  "checks": [
    {"command": "npm test -- checkout", "status": "passed"}
  ],
  "risk": "low"
}
```

### 4. Host Review Step

Composer can review candidates, but the host should make the final recommendation:

- Claude Code can reason over summaries and ask to apply.
- Codex can run an adversarial review before applying.
- A generic host can print candidate metadata and wait for a manual choice.

## Distribution Plan

### Claude Code First

Follow the pattern that made `codex-plugin-cc` and `cursor-plugin-cc` easy to adopt:

```text
/plugin marketplace add <publisher>/composer-swarm
/plugin install composer-swarm@<publisher>
/composer:setup
/composer:team ...
```

The Claude plugin should be thin. It calls the CLI and returns stdout.

### Codex Second

Ship a Codex skill:

```text
composer-swarm
  - how to check setup
  - how to start a team
  - how to inspect candidates
  - how to ask before applying the selected patch
```

Codex users should not need to learn Claude plugin mechanics.

### Generic CLI Third

Keep the raw CLI useful:

```bash
composer-swarm team "fix flaky login test" --builders 2
composer-swarm status
composer-swarm result
composer-swarm apply task_123 --candidate builder-a
```

## What Not To Build First

- Do not start with a full multi-vendor social protocol.
- Do not depend on Claude Agent Teams for Composer workers.
- Do not make users switch into a new app.
- Do not run multiple editing workers in the same checkout.
- Do not make Codex and Claude mandatory. They are host surfaces and optional reviewers.
- Do not ship npm, marketplace, or MCP support before the repo-only CLI is stable.
