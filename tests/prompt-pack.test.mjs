import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function frontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, "agent should start with YAML frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const index = line.indexOf(":");
      assert.notEqual(index, -1, `invalid frontmatter line: ${line}`);
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
  );
}

const AGENT_NAMES = [
  "composer-wide-search",
  "composer-deep-search",
  "composer-runner"
];
const EXPECTED_VERSION = "1.1.0";

const AGENT_SPECS = {
  "composer-wide-search": {
    title: "# Composer Wide Search",
    permission: "read-only",
    permissionMode: "plan",
    tools: "Read, Glob, Grep",
    expected: [
      /wide-search scout/i,
      /\*\*coverage\*\*/i,
      /Map:/,
      /Role:/,
      /Cross-references:/,
      /Adjacent surprises:/,
      /Gaps:/
    ]
  },
  "composer-deep-search": {
    title: "# Composer Deep Search",
    permission: "read-only",
    permissionMode: "plan",
    tools: "Read, Glob, Grep",
    expected: [
      /deep-search scout/i,
      /\*\*depth\*\*/i,
      /Trace:/,
      /State touched:/,
      /Error paths:/,
      /Tests covering this trace:/,
      /Adjacent surprises:/,
      /Gaps:/
    ]
  },
  "composer-runner": {
    title: "# Composer Runner",
    permission: "execute",
    permissionMode: "default",
    tools: "Read, Glob, Grep, Bash",
    expected: [
      /runner scout/i,
      /one command/i,
      /Command:/,
      /Exit:/,
      /Summary:/,
      /Key signals:/,
      /Side effects:/,
      /Adjacent surprises:/,
      /refused/,
      /Gaps:/
    ]
  }
};

const SCOUT_PATH = (name) => `plugins/composer-swarm/agents/${name}.md`;

test("scouts have correct frontmatter and role-specific output schema", () => {
  for (const [name, spec] of Object.entries(AGENT_SPECS)) {
    const body = read(SCOUT_PATH(name));
    const meta = frontmatter(body);
    assert.equal(meta["run-agent"], "cursor-agent", `${name} should use Cursor CLI`);
    assert.equal(meta.permission, spec.permission, `${name} permission`);
    assert.equal(meta.permissionMode, spec.permissionMode, `${name} permissionMode`);
    assert.equal(meta.tools, spec.tools, `${name} tools`);
    assert.ok(body.includes(spec.title), `${name} should have title ${spec.title}`);
    for (const pattern of spec.expected) {
      assert.match(body, pattern, `${name} body should match ${pattern}`);
    }
  }
});

test("every scout has budget regimes and an adjacent-surprises footer", () => {
  for (const name of AGENT_NAMES) {
    const body = read(SCOUT_PATH(name));
    assert.match(body, /## Budget regimes/, `${name} needs Budget regimes section`);
    assert.match(body, /\*\*quick\*\*/i, `${name} needs quick budget`);
    assert.match(body, /\*\*thorough\*\*/i, `${name} needs thorough budget`);
    assert.match(body, /\*\*exhaustive\*\*/i, `${name} needs exhaustive budget`);
    assert.match(body, /Budget: quick\|thorough\|exhaustive/, `${name} output must include Budget field`);
    assert.match(body, /Adjacent surprises:/, `${name} output must include Adjacent surprises footer`);
    assert.match(body, /1-3 things/, `${name} surprises footer must demand 1-3 entries`);
    assert.match(body, /path:line/, `${name} must require path:line evidence`);
  }
});

test("every scout echoes Task, has Severity discipline, and Hypotheses bucket", () => {
  // These three pieces are the v0.8.0 calibration additions. Drift would
  // re-open the noise/overclaim failure mode the swarm-feedback edit fixed.
  for (const name of AGENT_NAMES) {
    const body = read(SCOUT_PATH(name));
    assert.match(body, /^Task: <one-line restatement/m, `${name} output must include Task restatement field`);
    assert.match(body, /## Severity discipline/, `${name} must have Severity discipline section`);
    assert.match(body, /observed/i, `${name} severity section must name 'observed' bucket`);
    assert.match(body, /inferred/i, `${name} severity section must name 'inferred' bucket`);
    assert.match(body, /Hypotheses \(need evidence\):/, `${name} output must include Hypotheses bucket`);
  }
});

test("read-only scouts enforce no-shell discipline; runner is the exception", () => {
  for (const name of ["composer-wide-search", "composer-deep-search"]) {
    const body = read(SCOUT_PATH(name));
    assert.match(body, /Read-only/, `${name} should declare Read-only`);
    assert.match(body, /Do not edit/i);
    assert.match(body, /commit, push/i);
    assert.match(body, /run shell commands/i);
  }
  const runner = read(SCOUT_PATH("composer-runner"));
  assert.match(runner, /shell access/i, "runner should declare shell access");
  assert.match(runner, /one command, exactly as the main agent named it/i);
  assert.match(runner, /looks dangerous/i);
  assert.match(runner, /refuse/i);
  assert.match(runner, /Do not branch into other shell work/);
});

test("repo stays focused on the prompt pack", () => {
  const removedPaths = [
    "bin/composer-swarm.mjs",
    "src/runtime.mjs",
    "src/args.mjs",
    "swarm.config.example.json",
    "skills/composer-swarm",
    ".composer-swarm/config.json",
    ".composer-swarm/receipt-001.md",
    // v0.5 reviewer-era agents
    ".agents/composer-reasoning-reviewer.md",
    ".agents/composer-plan-reviewer.md",
    ".agents/composer-implementation-reviewer.md",
    ".agents/composer-reviewer.md",
    // v0.6 adversarial-era agents
    ".agents/composer-affirm.md",
    ".agents/composer-refute.md",
    // v0.7 root scout duplicates (collapsed to bundle-only in this commit)
    ".agents/composer-wide-search.md",
    ".agents/composer-deep-search.md",
    ".agents/composer-runner.md",
    // sync infra (no longer needed without dual scout copies)
    "scripts",
    "scripts/sync-bundle.mjs",
    "playbooks",
    "plugins/composer-swarm/playbooks",
    "plugins/composer-swarm/opencode",
    "docs/prompt-agents.md"
  ];

  for (const relativePath of removedPaths) {
    assert.equal(exists(relativePath), false, `${relativePath} should not exist`);
  }
});

test("plugin manifests pin the same version", () => {
  const codexMarketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  assert.equal(codexMarketplace.name, "composer-swarm");
  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/composer-swarm");

  const claudeMarketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(claudeMarketplace.plugins[0].version, EXPECTED_VERSION);
  assert.equal(claudeMarketplace.metadata.version, EXPECTED_VERSION);

  const codexPlugin = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  assert.equal(codexPlugin.version, EXPECTED_VERSION);
  assert.equal(codexPlugin.interface.displayName, "Composer Swarm");

  const claudePlugin = JSON.parse(read("plugins/composer-swarm/.claude-plugin/plugin.json"));
  assert.equal(claudePlugin.version, EXPECTED_VERSION);
});

test("plugin bundle contains no extra files of any kind (one-way migration enforcement)", () => {
  // Strict: any file in the bundle agents dir must be one of the declared scouts.
  // The previous version filtered by /^composer-.*\.md$/ and would have missed any
  // junk file dropped in (e.g. notes.md, README.md, .DS_Store would slip past both
  // the sync deletion loop AND this assertion). Now we list every non-hidden file
  // and require an exact match.
  const bundleDir = path.join(ROOT, "plugins/composer-swarm/agents");
  const present = fs
    .readdirSync(bundleDir)
    .filter((name) => !name.startsWith("."))
    .sort();
  assert.deepEqual(
    present,
    [...AGENT_NAMES].sort().map((n) => `${n}.md`),
    "bundle dir should contain exactly the declared scout files (no extras of any kind)"
  );
});

test("docs frame delegation economics — three scouts, budget knob, surprises", () => {
  const readme = read("README.md");
  const design = read("docs/design.md");
  const skill = read("plugins/composer-swarm/skills/composer-swarm/SKILL.md");
  const claudeMd = read("CLAUDE.md");
  const contributing = read("CONTRIBUTING.md");
  // CLAUDE.md and CONTRIBUTING.md are not shipped to npm consumers but they live
  // in the repo and contribute to the maintainer-facing documentation surface.
  // We scan them for legacy-term leakage too.
  const combined = `${readme}\n${design}\n${skill}\n${claudeMd}\n${contributing}`;

  for (const agentName of AGENT_NAMES) {
    assert.match(combined, new RegExp(agentName), `docs should mention ${agentName}`);
  }

  for (const phrase of [
    "delegation",
    "marginal-value",
    "wide search",
    "deep search",
    "budget",
    "quick",
    "thorough",
    "exhaustive",
    "Adjacent surprises",
    "path:line",
    "Cursor Composer",
    "Severity calibration",
    "Task restatement",
    "Convergence",
    "Filtering to PR comments",
    "Hypotheses"
  ]) {
    assert.match(combined, new RegExp(phrase, "i"), `docs should mention ${phrase}`);
  }

  assert.match(readme, /plugin marketplace add/);

  // CLAUDE.md/CONTRIBUTING.md intentionally mention "no playbook" and "no
  // receipt/predicate ceremony" as removed concepts. The legacy scan below
  // forbids the *active feature names* of removed designs but not the
  // negative statement words themselves. Bare "playbook" / "receipt" /
  // "predicate" can therefore appear in negative framing.
  for (const legacy of [
    "composer-affirm",
    "composer-refute",
    "composer-reasoning-reviewer",
    "composer-plan-reviewer",
    "composer-implementation-reviewer",
    "composer-reviewer",
    "investigate-bug",
    "review-plan",
    "review-implementation",
    "explore-subsystem",
    "pre-commit-risk-check",
    "proof-carrying",
    "predicate-bearing",
    "adversarial pairing",
    "receipt-<run-id>"
  ]) {
    assert.doesNotMatch(combined, new RegExp(legacy, "i"), `docs should not reference legacy: ${legacy}`);
  }
});

test("plugin default prompts surface the three scouts (cross-host parity)", () => {
  const codexPlugin = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  const claudePlugin = JSON.parse(read("plugins/composer-swarm/.claude-plugin/plugin.json"));

  // Both hosts must surface the same dispatch prompts to keep the install UX
  // consistent across Codex and Claude Code. Asserting structural equality
  // ensures the two manifests don't silently drift.
  assert.deepEqual(
    claudePlugin.interface.defaultPrompt,
    codexPlugin.interface.defaultPrompt,
    "Claude and Codex defaultPrompt arrays must stay in lock-step"
  );

  for (const [hostName, plugin] of [["codex", codexPlugin], ["claude", claudePlugin]]) {
    const defaults = plugin.interface.defaultPrompt.join("\n");
    for (const name of AGENT_NAMES) {
      assert.match(defaults, new RegExp(name), `${hostName} defaultPrompt should mention ${name}`);
    }
    assert.match(defaults, /budget/i, `${hostName} defaultPrompt should mention budget`);

    for (const legacy of [
      "investigate-bug",
      "review-plan",
      "review-implementation",
      "pre-commit-risk-check",
      "composer-affirm",
      "composer-refute",
      "certify"
    ]) {
      assert.doesNotMatch(defaults, new RegExp(legacy), `${hostName} defaultPrompt should not reference legacy ${legacy}`);
    }
  }
});

test("package ships prompt-pack plugin artifacts", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(packageJson.license, "MIT");
  assert.equal("private" in packageJson, false);
  assert.deepEqual(packageJson.files, [
    ".agents/plugins/",
    ".claude-plugin/",
    "plugins/",
    "docs/",
    "README.md",
    "LICENSE"
  ]);
  assert.equal("bin" in packageJson, false);
});
