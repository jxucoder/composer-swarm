# CLAUDE.md

Project-local instructions for the Composer Swarm repo. These override the
parent `work_space/CLAUDE.md` (which is for AIpedia) when working here.

## Repo overview

Composer Swarm is a Markdown-only prompt plugin for Codex and Claude Code.
It ships three Cursor Composer scouts the main agent fans out marginal-value
work to: `composer-wide-search` (coverage-disciplined mapping),
`composer-deep-search` (depth-disciplined tracing), and `composer-runner`
(one-command execution with structured summary). Each scout takes a
`budget` hint (`quick`/`thorough`/`exhaustive`) and ends its output with an
Adjacent surprises footer.

There is no runtime, daemon, apply step, playbook system, or local state
format in this repo.

See `docs/design.md` for the design and `CONTRIBUTING.md` for the edit/sync
workflow.

## Commands

```bash
npm test         # Structural tests for scouts, manifests, docs
npm run sync     # Copy .agents/*.md into plugins/composer-swarm/agents/
```

## Key conventions

- Edits to scouts (`.agents/composer-*.md`) must be mirrored into
  `plugins/composer-swarm/agents/`. Use `npm run sync`.
- Read-only scouts (`composer-wide-search`, `composer-deep-search`) use
  `run-agent: cursor-agent`, `permission: read-only`, `permissionMode: plan`,
  `tools: Read, Glob, Grep`.
- The execution scout (`composer-runner`) uses `permission: execute`,
  `permissionMode: default`, `tools: Read, Glob, Grep, Bash`. Its prompt
  enforces single-command discipline and refuses dangerous commands.
- Every scout output must include `Budget:`, an `Adjacent surprises:`
  footer with 1-3 path:line entries (or empty if nothing surprised), and
  a `Gaps:` section.
- Versions are pinned in five locations: `package.json`,
  `.claude-plugin/marketplace.json` (two fields: `metadata.version`
  and `plugins[0].version`), both `plugin.json` manifests under
  `plugins/composer-swarm/`, and `EXPECTED_VERSION` in
  `tests/prompt-pack.test.mjs`. Tests fail if any drift.

## Out of scope

- No runtime code. Tests enforce that `bin/`, `src/runtime.mjs`,
  `swarm.config.example.json`, `.composer-swarm/config.json`, `playbooks/`,
  and `plugins/composer-swarm/playbooks` do not exist.
- No playbooks. Common usage patterns appear as README examples, not as
  Markdown files the main agent has to load.
- No receipt/predicate ceremony. Scouts return structured reports; the
  main agent verifies the `path:line` references that matter.
