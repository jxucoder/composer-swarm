# Host And Agent Adapters

Composer Swarm is host-first: Claude Code or Codex is the user's cockpit, while Cursor/Composer workers
provide fast parallel search, extra reasoning, review passes, and candidate execution.

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
/composer:setup
/composer:team [task]
/composer:review [--preset repo|security|tests] [--scouts 0..4]
/composer:status [task-id]
/composer:result [task-id]
/composer:verify <task-id>
/composer:apply [task-id] [--candidate <id>|--recommended]
/composer:cancel [task-id]
```

The command files should be thin, similar to `codex-plugin-cc`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS"
```

Foreground commands return CLI output verbatim. Background commands should use the host's background task
primitive and preserve `$ARGUMENTS` exactly instead of rewriting flags in the command markdown.

If the plugin directory is copied outside this checkout, set `COMPOSER_SWARM_REPO` to the cloned
composer-swarm repository so the wrapper can reach `bin/composer-swarm.mjs`; otherwise the wrapper falls
back to a `composer-swarm` executable on `PATH`.

If Agent Teams are enabled, Claude teammates can still use `/composer:*` commands, but Composer workers
remain CLI-backed workers, not native Claude teammates.

## Codex Integration

Codex environments that support local skills or plugins should get a skill with simple operating rules:

- use `composer-swarm setup` before starting; run `setup --init --trust` when config is missing
- use `composer-swarm team "<task>"` to launch Composer workers
- keep Composer workers on Cursor model `composer-2.5-fast`
- inspect candidate summaries and patches
- run `composer-swarm verify` before recommending a candidate
- apply the selected patch through `composer-swarm apply` only after explicit user approval

Codex does not automatically load the repo-root skill just because the repository was cloned. Install the
repo-local Codex plugin from `.agents/plugins/marketplace.json`, or copy `skills/composer-swarm/SKILL.md`
into the skills directory your Codex setup uses. Keep the plugin-packaged skill copy in sync with the
repo-root skill file.

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
