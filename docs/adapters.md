# Host And Agent Adapters

Composer Swarm is host-first: Claude Code or Codex is the user's cockpit, while Cursor/Composer workers
provide fast parallel search, extra reasoning, review passes, and candidate patch attempts.

## Adapter Model

An adapter maps a swarm task to a concrete execution method. The user config stays small:

```json
{
  "workers": {
    "composer": {
      "kind": "cursor-cli",
      "command": "cursor-agent",
      "args": ["--trust"]
    },
    "verifier": {
      "kind": "shell",
      "command": "bash",
      "args": ["-lc", "npm test"]
    }
  }
}
```

Adapters should stay small. The swarm runtime owns task state; adapters only translate task envelopes into
worker invocations and translate output back into events.

## Claude Code Integration

Claude Code should use slash commands that call the runtime:

```text
/composer:setup
/composer:team [task]
/composer:research [question] [--workers 1..4] [--focus architecture|tests|security|docs|release] [--include-untracked|--snapshot-current]
/composer:review [--preset repo|security|tests] [--scouts 0..4] [--include-untracked|--snapshot-current]
/composer:status [task-id]
/composer:inspect [task-id]
/composer:logs [task-id] [--worker <label>] [--tail 80]
/composer:result [task-id]
/composer:verify <task-id>
/composer:apply <task-id> --candidate <id>|--recommended
/composer:cancel [task-id]
```

The command files should be thin, similar to `codex-plugin-cc`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/composer-swarm.mjs" team "$ARGUMENTS"
```

Foreground commands return CLI output verbatim. When a host supports background command execution, command
files may use it and must preserve `$ARGUMENTS` exactly instead of rewriting flags in the command markdown.
The portable runtime behavior for `--background` is still a detached local process with state under
`.composer-swarm/state/`, not a hosted background-agent service.

If the plugin directory is copied outside this checkout, set `COMPOSER_SWARM_REPO` to the cloned
composer-swarm repository so the wrapper can reach `bin/composer-swarm.mjs`; otherwise the wrapper falls
back to a `composer-swarm` executable on `PATH`.

If Agent Teams are enabled, Claude teammates can still use `/composer:*` commands, but Composer workers
remain CLI-backed workers, not native Claude teammates.

## Codex Integration

Codex environments that support local skills or plugins should get a skill with simple operating rules:

- use `composer-swarm setup` before starting; run `setup --init --trust` when config is missing
- when repo understanding is broad, uncertain, or high-impact, start Codex's own investigation and launch
  `composer-swarm research "<question>" --workers <1-4> --background` as a detached local run
- for "review my current changes" requests, use read-only review with snapshotting:
  `composer-swarm review --preset repo --include-untracked`
- treat research/review output as evidence-backed scout leads and cross-check important claims
- use `composer-swarm team "<task>"` to launch Composer workers
- keep Composer workers on Cursor model `composer-2.5-fast`
- check `.composer-swarm/config.json` after setup when verification matters; setup infers common verifiers such
  as `swift test` for Swift packages
- inspect candidate summaries and patches
- use `composer-swarm inspect` and `composer-swarm logs` when detached local runs need local-state detail
- run `composer-swarm verify` before recommending a candidate
- apply the selected patch through `composer-swarm apply` only after explicit user approval

Codex does not automatically load the repo-root skill just because the repository was cloned. Install the
repo-local Codex plugin from `.agents/plugins/marketplace.json`, or copy the skill and put the CLI on `PATH`:

```bash
mkdir -p ~/.codex/skills/composer-swarm ~/.local/bin
cp /path/to/composer-swarm/skills/composer-swarm/SKILL.md ~/.codex/skills/composer-swarm/SKILL.md
ln -sfn /path/to/composer-swarm/bin/composer-swarm.mjs ~/.local/bin/composer-swarm
```

Restart Codex after installing. Keep the plugin-packaged skill copy in sync with the repo-root skill file.

This lets Codex users get Composer parallelism without leaving Codex.

## Cursor/Composer Integration

The Cursor/Composer adapter should be treated as a worker adapter:

```json
{
  "kind": "cursor-cli",
  "command": "cursor-agent",
  "args": ["--trust"]
}
```

If the local Cursor CLI exposes a stable non-interactive mode, the adapter can invoke it directly.
Otherwise, a `cursor-plugin-cc` style bridge can act as the adapter.

## Generic Shell Agent

The generic shell adapter is the compatibility escape hatch for deterministic checks:

```json
{
  "kind": "shell",
  "command": "bash",
  "args": ["-lc", "npm test"]
}
```

Generic shell workers are useful for deterministic checks, formatting, local scripts, and human-provided
commands.

## MCP Server Wrapper Future Work

There is no MCP server in repo-only v1. A later MCP server should wrap the same runtime operations instead of
introducing a second orchestration model:

- `setup`
- `research`
- `review`
- `team`
- `ls`
- `status`
- `inspect`
- `logs`
- `result`
- `verify`
- `apply`
- `cancel`
- `cleanup`

MCP is the best path for agents that cannot safely shell out but can call tools.
