# Worker Protocol

Composer Swarm uses JSONL for worker events. JSONL is easy for every CLI worker to emit and easy for host
integrations to parse incrementally.

The protocol is centered on candidate patches. Multiple Composer workers may attempt the same task in
isolated worktrees; the host later chooses which candidate to apply.

## Task Envelope

```json
{
  "schema": "composer-swarm.task.v1",
  "taskId": "task_01",
  "candidateId": "task_01-builder-a",
  "workspaceRoot": "/path/to/repo",
  "worktreeRoot": ".composer-swarm/state/worktrees/task_01/builder-a",
  "worker": "builder-a",
  "objective": "Fix the checkout regression with the smallest coherent patch.",
  "acceptanceCriteria": [
    "Keep the patch narrowly scoped",
    "Run the relevant checkout tests if available",
    "Return a patch summary and risk assessment"
  ],
  "context": {
    "baseRef": "main",
    "focus": "checkout validation regression"
  },
  "limits": {
    "canEdit": true,
    "canRunCommands": true,
    "network": false
  }
}
```

## Event Types

All adapter output should be newline-delimited JSON.

### `started`

```json
{"type":"started","taskId":"task_01","candidateId":"task_01-builder-a","workerId":"composer-builder-a","timestamp":"2026-05-22T19:00:00.000Z"}
```

### `progress`

```json
{"type":"progress","taskId":"task_01","candidateId":"task_01-builder-a","phase":"editing","message":"Updating checkout validation"}
```

### `claim`

```json
{"type":"claim","taskId":"task_01","candidateId":"task_01-builder-a","paths":["src/checkout/**"],"ttlSeconds":600}
```

### `candidate`

```json
{
  "type": "candidate",
  "taskId": "task_01",
  "candidateId": "task_01-builder-a",
  "worker": "builder-a",
  "summary": "Fixed checkout validation with a narrow guard.",
  "risk": "low",
  "patchFile": ".composer-swarm/state/artifacts/task_01-builder-a.patch",
  "worktree": ".composer-swarm/state/worktrees/task_01/builder-a",
  "checks": [
    {"command": "npm test -- checkout", "status": "passed"}
  ]
}
```

### `review`

```json
{
  "type": "review",
  "taskId": "task_01",
  "candidateId": "task_01-builder-a",
  "status": "accepted",
  "summary": "Candidate A is narrow and has relevant test coverage.",
  "findings": []
}
```

### `selection`

```json
{
  "type": "selection",
  "taskId": "task_01",
  "selectedCandidateId": "task_01-builder-a",
  "reason": "Smallest patch with passing checks"
}
```

### `error`

```json
{"type":"error","taskId":"task_01","candidateId":"task_01-builder-a","message":"cursor-agent is not authenticated","retryable":false}
```

## Adapter Invocation

Every adapter receives the task envelope through one of these mechanisms:

1. `--task-file <path>`
2. stdin JSON
3. MCP tool argument
4. HTTP request body

The CLI should prefer `--task-file` for long prompts and reproducibility.

Example:

```bash
composer-swarm adapter run composer-builder --task-file .composer-swarm/state/tasks/task_01-builder-a.json
```

## Final Result Contract

Every candidate must end with exactly one terminal event:

- `candidate`
- `review`
- `error`

Every task must end with a host-visible task result:

- selected candidate
- applied patch status
- checks that passed or failed
- any unresolved conflicts or blocked work

This lets Claude Code, Codex, or a generic host show results without understanding worker internals.
