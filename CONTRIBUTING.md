# Contributing

Composer Swarm is a Markdown-only prompt plugin. The scouts in
`.agents/` are duplicated inside `plugins/composer-swarm/agents/` so
the plugin bundle is self-contained. The tests in
`tests/prompt-pack.test.mjs` assert that the root files and the
bundled copies are byte-identical.

## Editing scouts

The root copies under `.agents/` are the source of truth.

1. Edit a source file under `.agents/composer-*.md`.
2. Run `npm run sync` to copy changes into `plugins/composer-swarm/agents/`.
3. Run `npm test` to verify structure, frontmatter, and bundle parity.

If you forget step 2, the bundle-parity tests fail with a clear
message. `npm run sync` also removes files from the bundle that no
longer exist in the root, so deletions stay in lock-step.

## Adding a new scout

The current design is intentionally three scouts:
`composer-wide-search`, `composer-deep-search`, `composer-runner`.
Before adding more, check whether the new role can be expressed by
prompting one of the existing three with a different task shape.

If you do add one:

- Mirror the frontmatter shape. Read-only scouts use
  `run-agent: cursor-agent`, `permission: read-only`,
  `permissionMode: plan`, `tools: Read, Glob, Grep`. Execution scouts
  use `permission: execute`, `permissionMode: default`,
  `tools: Read, Glob, Grep, Bash` and must explicitly state the
  single-command discipline.
- Every scout output must include a `Budget:` field, an `Adjacent
  surprises:` footer with 1-3 entries citing `path:line`, and a
  `Gaps:` section. Wide-search and deep-search outputs also include
  a `Coverage:` field; wide-search adds `Map:` and `Cross-references:`;
  deep-search adds `Trace:`, `State touched:`, `Error paths:`, and
  `Tests covering this trace:`; runner adds `Command:`, `Exit:`,
  `Summary:`, `Key signals:`, and `Side effects:`.
- Add the new name to `AGENT_NAMES` in `tests/prompt-pack.test.mjs`
  and add per-scout assertions covering its specific output shape.
- Update `README.md` and `docs/design.md` so the docs and tests stay
  in sync.

## Releasing

Bump the version in **all five** locations:

- `package.json` (`version`)
- `.claude-plugin/marketplace.json` (`metadata.version` and
  `plugins[0].version`)
- `plugins/composer-swarm/.claude-plugin/plugin.json` (`version`)
- `plugins/composer-swarm/.codex-plugin/plugin.json` (`version`)
- `tests/prompt-pack.test.mjs` (`EXPECTED_VERSION`)

The `plugin manifests pin the same version` and `package ships
prompt-pack plugin artifacts` tests pin the expected version, so an
incomplete bump will fail CI.
