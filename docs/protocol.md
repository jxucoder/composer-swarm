# Worker Protocol

Composer Swarm v1 records worker transcripts as JSONL. The transcript format is intentionally simple because
`cursor-agent --output-format stream-json` already emits a stream of JSON events.

The runtime wraps that stream with task metadata and stores it under:

```text
.composer-swarm/state/transcripts/<task-id>/<worker-label>.jsonl
```

## Transcript Events

### `started`

Written before the worker process starts:

```json
{
  "timestamp": "2026-05-23T00:00:00.000Z",
  "type": "started",
  "taskId": "task_abc",
  "worker": "builder-a",
  "agentId": "composer",
  "command": "cursor-agent",
  "args": ["--trust", "--print", "--output-format", "stream-json", "--workspace", "...", "--model", "composer-2.5-fast", "<prompt>"]
}
```

The stored args redact the full prompt in task JSON. Transcript `started` events preserve the same redacted
shape.

### `worker-output`

Written for each stdout or stderr line from `cursor-agent`:

```json
{
  "timestamp": "2026-05-23T00:00:01.000Z",
  "type": "worker-output",
  "taskId": "task_abc",
  "worker": "builder-a",
  "stream": "stdout",
  "event": {"type": "final", "text": "Implemented the requested change."}
}
```

If a line is not JSON, it is stored as:

```json
{
  "timestamp": "2026-05-23T00:00:01.000Z",
  "type": "worker-output",
  "taskId": "task_abc",
  "worker": "builder-a",
  "stream": "stderr",
  "line": "plain text output"
}
```

### `retry`

Written when the runtime retries the known Cursor CLI config rename race:

```json
{
  "timestamp": "2026-05-23T00:00:02.000Z",
  "type": "retry",
  "taskId": "task_abc",
  "worker": "builder-b",
  "reason": "cursor-cli-config-race",
  "nextAttempt": 2
}
```

### `timeout`

Written when a worker produces no output before the configured idle timeout:

```json
{
  "timestamp": "2026-05-23T00:05:00.000Z",
  "type": "timeout",
  "taskId": "task_abc",
  "worker": "research-b",
  "idleTimeoutMs": 300000,
  "lastOutputAt": null,
  "error": "Worker research-b produced no output for 5m..."
}
```

### Terminal Worker Status

The final transcript event for a worker is one of:

- `completed`
- `failed`
- `cancelled`

Example:

```json
{
  "timestamp": "2026-05-23T00:00:10.000Z",
  "type": "completed",
  "taskId": "task_abc",
  "worker": "builder-a",
  "exitCode": 0,
  "signal": null,
  "error": null
}
```

## Task JSON

The task file is the durable source of truth:

```text
.composer-swarm/state/tasks/<task-id>.json
```

It records:

- objective
- status
- base commit and branch
- mode options
- worker states
- research outputs, stored from the worker's final report when the stream marks one
- scout notes, stored from final reports when available
- reviewer notes, stored from final reports when available
- candidates
- selected candidate after apply

Research and review tasks can have `options.snapshotCurrent: true` when the runtime snapshots dirty or
untracked files into read-only worker worktrees.

## Candidate Artifacts

Only `team` tasks produce candidate patches. The runtime collects each completed builder worktree with
`git diff --binary HEAD` and writes:

```text
.composer-swarm/state/artifacts/<task-id>/<candidate-id>.patch
```

Candidate metadata is stored in the task JSON:

```json
{
  "schema": "composer-swarm.candidate.v1",
  "candidateId": "task_abc-builder-a",
  "workerLabel": "builder-a",
  "status": "completed",
  "summary": "Fixed checkout validation with a narrow guard.",
  "patchFile": ".composer-swarm/state/artifacts/task_abc/task_abc-builder-a.patch",
  "patchBytes": 1234,
  "changedFiles": ["src/checkout.js"],
  "worktree": ".composer-swarm/state/worktrees/task_abc/builder-a",
  "transcript": ".composer-swarm/state/transcripts/task_abc/builder-a.jsonl",
  "checks": []
}
```

Research and review tasks do not produce candidate patches and never print apply commands.

## Host Display

Hosts should use the CLI for display instead of parsing task JSON directly:

```bash
composer-swarm status <task-id>
composer-swarm inspect <task-id>
composer-swarm logs <task-id> --worker <label>
composer-swarm result <task-id> --synthesis
composer-swarm result <task-id> --verbose
```

This keeps Claude Code, Codex, and generic shell users on the same result format.
