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
  "composer-reasoning-reviewer",
  "composer-plan-reviewer",
  "composer-implementation-reviewer",
  "composer-reviewer"
];

const PLAYBOOK_NAMES = [
  "investigate-bug",
  "review-plan",
  "review-implementation",
  "explore-subsystem",
  "pre-commit-risk-check"
];

test("operation agents are read-only Cursor agents with distinct jobs", () => {
  const agents = {
    "composer-wide-search": {
      file: ".agents/composer-wide-search.md",
      expected: [/wide-search role/i, /Coverage:/, /Cross-links:/, /Suggested deep searches:/]
    },
    "composer-deep-search": {
      file: ".agents/composer-deep-search.md",
      expected: [/deep-search role/i, /Trace:/, /Failure modes:/, /Host follow-up:/]
    },
    "composer-reasoning-reviewer": {
      file: ".agents/composer-reasoning-reviewer.md",
      expected: [/reasoning-review role/i, /Weak assumptions:/, /Alternative interpretations:/, /Evidence needed:/]
    },
    "composer-plan-reviewer": {
      file: ".agents/composer-plan-reviewer.md",
      expected: [/plan-review role/i, /Verdict:/, /Missing verification:/, /Alternative angle:/]
    },
    "composer-implementation-reviewer": {
      file: ".agents/composer-implementation-reviewer.md",
      expected: [/implementation-review role/i, /Test gaps:/, /Release risks:/, /Implementation under review:/]
    },
    "composer-reviewer": {
      file: ".agents/composer-reviewer.md",
      expected: [/defect/i, /Severity:/, /Suggested fix:/, /Verification gaps:/]
    }
  };

  for (const [name, agent] of Object.entries(agents)) {
    const body = read(agent.file);
    const meta = frontmatter(body);
    assert.equal(meta["run-agent"], "cursor-agent", `${name} should use Cursor CLI`);
    assert.equal(meta.permission, "read-only", `${name} should be read-only`);
    assert.equal(meta.tools, "Read, Glob, Grep", `${name} should expose only read/search tools`);
    assert.doesNotMatch(JSON.stringify(meta), /\b(Shell|Write|Apply|Task)\b/);
    assert.match(body, new RegExp(`# ${name.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())}`));
    assert.doesNotMatch(body, /permission: safe-edit/);
    assert.match(body, /one read-only artifact in a host-supervised playbook run/i);
    assert.match(body, /The host decides edits, tests, commits, pushes, and final answers/i);
    assert.match(body, /Do not run shell commands, tests, package installs, or state-changing tools/i);
    assert.match(body, /Do not commit, push/i);
    assert.match(body, /Agent:/);
    assert.match(body, /Angle:/);
    assert.match(body, /Playbook:/);
    for (const pattern of agent.expected) {
      assert.match(body, pattern);
    }
  }
});

test("playbook contracts are first-class and bundled with the plugin", () => {
  for (const playbookName of PLAYBOOK_NAMES) {
    const rootPath = `playbooks/${playbookName}.md`;
    const pluginPath = `plugins/composer-swarm/playbooks/${playbookName}.md`;
    const body = read(rootPath);

    assert.equal(read(pluginPath), body, `${playbookName} should stay synced between root and plugin bundle`);
    assert.match(body, new RegExp(`name: ${playbookName}`));
    assert.match(body, /## Context Brief/);
    assert.match(body, /## Fan-Out/);
    assert.match(body, /## Host Gate/);
    assert.match(body, /## Quality Signals/);
  }
});

test("repo stays focused on the prompt pack", () => {
  const removedPaths = [
    "bin/composer-swarm.mjs",
    "src/runtime.mjs",
    "src/args.mjs",
    "swarm.config.example.json",
    "skills/composer-swarm",
    ".composer-swarm/config.json"
  ];

  for (const relativePath of removedPaths) {
    assert.equal(exists(relativePath), false, `${relativePath} should not exist`);
  }
});

test("plugin manifests make the prompt pack installable", () => {
  const codexMarketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  assert.equal(codexMarketplace.name, "composer-swarm");
  assert.equal(codexMarketplace.plugins[0].name, "composer-swarm");
  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/composer-swarm");
  assert.equal(codexMarketplace.plugins[0].policy.installation, "AVAILABLE");
  assert.equal(codexMarketplace.plugins[0].policy.authentication, "ON_INSTALL");

  const claudeMarketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(claudeMarketplace.name, "jxucoder-composer-swarm");
  assert.equal(claudeMarketplace.plugins[0].name, "composer-swarm");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/composer-swarm");

  const codexPlugin = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  assert.equal(codexPlugin.name, "composer-swarm");
  assert.equal(codexPlugin.skills, "./skills/");
  assert.equal(codexPlugin.interface.displayName, "Composer Swarm");

  const claudePlugin = JSON.parse(read("plugins/composer-swarm/.claude-plugin/plugin.json"));
  assert.equal(claudePlugin.name, "composer-swarm");
  assert.equal(claudePlugin.version, "0.4.0");
});

test("plugin-bundled agents stay synced with root Runner agents", () => {
  for (const agentName of AGENT_NAMES) {
    assert.equal(
      read(`plugins/composer-swarm/agents/${agentName}.md`),
      read(`.agents/${agentName}.md`),
      `${agentName} should stay synced between root .agents and plugin bundle`
    );
  }
});

test("docs describe operation fan-out usage without legacy runtime instructions", () => {
  const readme = read("README.md");
  const promptDocs = read("docs/prompt-agents.md");
  const combined = `${readme}\n${promptDocs}`;

  assert.match(readme, /Composer operation fan-out/);
  for (const agentName of AGENT_NAMES) {
    assert.match(combined, new RegExp(agentName));
  }
  assert.match(combined, /plugin marketplace add/);
  assert.match(combined, /one setup pattern/i);
  assert.match(combined, /Playbooks/);
  for (const playbook of PLAYBOOK_NAMES) {
    assert.match(combined, new RegExp(playbook));
  }
  assert.match(combined, /Packaged playbook contracts live in `playbooks\/`/);
  assert.match(combined, /Targeted wide search starts from/i);
  assert.match(combined, /Targeted deep search traces/i);
  assert.match(combined, /Manual fallback/);
  assert.match(combined, /Use the fallback only/i);
  assert.doesNotMatch(combined, /composer-swarm (setup|team|verify|apply|cleanup)/);
  assert.doesNotMatch(combined, /legacy runtime/i);
});

test("docs frame parallel fan-out as host-owned evidence and critique", () => {
  const combined = `${read("README.md")}\n${read("docs/prompt-agents.md")}`;

  assert.match(combined, /host-supervised operation fan-out/i);
  assert.match(combined, /Problems Solved/);
  assert.match(combined, /Search latency/);
  assert.match(combined, /Coverage gaps/);
  assert.match(combined, /Reasoning blind spots/);
  assert.match(combined, /Plan risk/);
  assert.match(combined, /Implementation risk/);
  assert.match(combined, /Context overload/);
  assert.match(combined, /Operation Fan-Out/);
  assert.match(combined, /parallel evidence and critique/i);
  assert.match(combined, /host agent keeps working locally/i);
  assert.match(combined, /different angles/i);
  assert.match(combined, /host owns synthesis/i);
  assert.match(combined, /not delegation of judgment/i);
  assert.match(combined, /Do not treat sub-agent output as a vote/i);
});

test("design makes playbook artifacts, gates, and quality signals explicit", () => {
  const combined = `${read("README.md")}\n${read("docs/prompt-agents.md")}\n${read("docs/design.md")}`;
  const skill = read("plugins/composer-swarm/skills/composer-swarm/SKILL.md");

  for (const phrase of [
    "Context Brief",
    "Fan-Out",
    "Agent Reports",
    "Host Synthesis",
    "Quality Signals",
    "Human gates",
    "claims verified",
    "unresolved gaps",
    "whether fan-out changed the plan"
  ]) {
    assert.match(combined, new RegExp(phrase, "i"));
  }

  for (const phrase of [
    "Prepare a short context brief",
    "Give each agent the same context brief and a distinct angle",
    "return a compact host synthesis",
    "Quality Signals",
    "Do not ask Composer agents to commit, push, install packages, or edit files"
  ]) {
    assert.match(skill, new RegExp(phrase, "i"));
  }
});

test("plugin default prompts prefer playbooks", () => {
  const codexPlugin = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  const defaults = codexPlugin.interface.defaultPrompt.join("\n");

  for (const playbook of [
    "investigate-bug",
    "review-plan",
    "review-implementation",
    "pre-commit-risk-check"
  ]) {
    assert.match(defaults, new RegExp(playbook));
  }
});

test("package ships prompt-pack plugin artifacts", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, "0.4.0");
  assert.equal(packageJson.license, "MIT");
  assert.equal("private" in packageJson, false);
  assert.deepEqual(packageJson.files, [
    ".agents/",
    ".claude-plugin/",
    "playbooks/",
    "plugins/",
    "docs/",
    "README.md",
    "LICENSE"
  ]);
  assert.equal("bin" in packageJson, false);
});
