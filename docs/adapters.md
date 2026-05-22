# Host And Agent Adapters

Composer Swarm is host-first: Claude Code or Codex is the user's cockpit, while Cursor/Composer workers
do most of the parallel execution.

## Adapter Model

An adapter maps a swarm task to an agent-specific execution method.

```json
{
  "id": "composer-builder-a",
  "kind": "cursor-cli",
  "role": "builder-a",
  "command": "cursor-agent",
  "canEdit": true
}
```

Adapters should stay small. The swarm runtime owns task state; adapters only translate task envelopes into
agent invocations and translate output back into events.

## Claude Code Integration

Claude Code should use slash commands that call the runtime:

```text
/composer:team [task]
/composer:status [task-id]
/composer:result [task-id]
/composer:apply [task-id] [candidate-id]
/composer:cancel [task-id]
```

The command files should be thin, similar to `codex-plugin-cc`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team $ARGUMENTS
```

If Agent Teams are enabled, Claude teammates can still use `/composer:*` commands, but Composer workers
remain CLI-backed workers, not native Claude teammates.

## Codex Integration

Codex should get a skill with simple operating rules:

- use `composer-swarm doctor` before starting
- use `composer-swarm team "<task>"` to launch Composer workers
- inspect candidate summaries and patches
- run Codex review only after candidate patches exist
- apply the selected patch through `composer-swarm apply`

This lets Codex users get Composer parallelism without leaving Codex.

## Cursor/Composer Integration

The Cursor/Composer adapter should be treated as a worker adapter:

```json
{
  "id": "composer-builder-a",
  "kind": "cursor-cli",
  "role": "builder-a",
  "command": "cursor-agent",
  "canEdit": true
}
```

If the local Cursor CLI exposes a stable non-interactive mode, the adapter can invoke it directly.
Otherwise, a `cursor-plugin-cc` style bridge can act as the adapter.

## Generic Shell Agent

The generic adapter is the compatibility escape hatch:

```json
{
  "id": "shell-verifier",
  "kind": "shell",
  "role": "verifier",
  "command": "bash",
  "args": ["-lc", "npm test"]
}
```

Generic shell agents are useful for deterministic checks, formatting, local scripts, and human-provided
commands.

## MCP Server Wrapper Future Work

There is no MCP server in repo-only v1. A later MCP server should expose the same runtime operations:

- `swarm_create_task`
- `swarm_list_tasks`
- `swarm_create_candidate_worktree`
- `swarm_append_event`
- `swarm_complete_candidate`
- `swarm_get_result`
- `swarm_apply_candidate`

MCP is the best path for agents that cannot safely shell out but can call tools.
