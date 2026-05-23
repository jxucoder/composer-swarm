import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeArgv, normalizePluginArgv, splitRawArgumentString } from "../src/args.mjs";
import { normalizePluginArgv as normalizePackagedPluginArgv } from "../plugins/composer-swarm/scripts/lib/args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "composer-swarm.mjs");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "composer-swarm");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-plugin-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function makeFakeCursorAgent() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-bin-"));
  const scriptPath = path.join(binDir, "cursor-agent");
  fs.writeFileSync(
    scriptPath,
    "#!/usr/bin/env sh\nprintf '%s\\n' '{\"type\":\"final\",\"text\":\"ok\"}'\n",
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

test("Claude Code command files preserve plugin UX and quote raw arguments", () => {
  const team = read("plugins/composer-swarm/commands/team.md");
  const review = read("plugins/composer-swarm/commands/review.md");
  const setup = read("plugins/composer-swarm/commands/setup.md");
  const result = read("plugins/composer-swarm/commands/result.md");
  const status = read("plugins/composer-swarm/commands/status.md");
  const apply = read("plugins/composer-swarm/commands/apply.md");

  assert.match(team, /disable-model-invocation: true/);
  assert.match(team, /AskUserQuestion/);
  assert.match(team, /Run in background/);
  assert.match(team, /Wait for results/);
  assert.match(team, /\(Recommended\)/);
  assert.match(team, /team "\$ARGUMENTS"\n/);
  assert.match(team, /Do not apply any candidate patch/);
  assert.match(team, /Preserve the user's arguments exactly/);
  assert.match(team, /run_in_background: true/);
  assert.match(team, /Bash\(\{/);
  assert.doesNotMatch(team, /team "\$ARGUMENTS" --(?:wait|background)/);
  assert.match(team, /composer-2\.5-fast/);
  assert.doesNotMatch(team, /--model <model>/);

  assert.match(review, /disable-model-invocation: true/);
  assert.match(review, /review-only/i);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /review "\$ARGUMENTS"\n/);
  assert.match(review, /Preserve the user's arguments exactly/);
  assert.match(review, /run_in_background: true/);
  assert.match(review, /Bash\(\{/);
  assert.doesNotMatch(review, /review "\$ARGUMENTS" --(?:wait|background)/);
  assert.match(review, /composer-2\.5-fast/);
  assert.doesNotMatch(review, /--model <model>/);

  assert.match(setup, /disable-model-invocation: true/);
  assert.match(setup, /setup --json "\$ARGUMENTS"/);
  assert.match(setup, /Initialize with trust/);
  assert.doesNotMatch(setup, /Initialize with trust \(Recommended\)/);
  assert.match(setup, /setup --init --trust "\$ARGUMENTS"/);
  assert.match(setup, /setup "\$ARGUMENTS"/);

  assert.match(result, /result "\$ARGUMENTS"/);
  assert.match(result, /Do not summarize or condense/i);
  assert.match(result, /baseline versus candidate-specific/i);
  assert.match(result, /patch paths/i);

  assert.match(status, /status "\$ARGUMENTS"/);
  assert.match(status, /worker states/i);
  assert.match(status, /next-step commands/i);

  assert.match(apply, /apply "\$ARGUMENTS"/);
  assert.match(apply, /explicitly requested/i);
  assert.match(apply, /clean tracked git checkout/i);
});

test("plugin manifests expose both Claude Code and Codex plugin metadata", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, PACKAGE_VERSION);
  assert.equal(packageJson.license, "MIT");
  assert.ok(fs.existsSync(path.join(ROOT, "LICENSE")), "MIT license file should exist");

  const claude = JSON.parse(read("plugins/composer-swarm/.claude-plugin/plugin.json"));
  assert.equal(claude.name, "composer");
  assert.equal(claude.version, PACKAGE_VERSION);
  assert.equal(claude.author.name, "jxucoder");
  assert.equal(claude.homepage, "https://github.com/jxucoder/composer-swarm");
  assert.equal(claude.repository, "https://github.com/jxucoder/composer-swarm");
  assert.equal(claude.license, "MIT");

  const codex = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  assert.equal(codex.name, "composer-swarm");
  assert.equal(codex.version, PACKAGE_VERSION);
  assert.equal(codex.author.name, "jxucoder");
  assert.equal(codex.license, "MIT");
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.interface.displayName, "Composer Swarm");
  assert.equal(codex.interface.developerName, "jxucoder");
  assert.equal(codex.homepage, "https://github.com/jxucoder/composer-swarm");
  assert.equal(codex.repository, "https://github.com/jxucoder/composer-swarm");

  const marketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  assert.equal(marketplace.name, "composer-swarm");
  assert.equal(marketplace.interface.displayName, "Composer Swarm");
  assert.equal(marketplace.plugins[0].name, "composer-swarm");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/composer-swarm");
  assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");

  const claudeMarketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(claudeMarketplace.name, "jxucoder-composer-swarm");
  assert.equal(claudeMarketplace.owner.name, "jxucoder");
  assert.equal(claudeMarketplace.metadata.version, PACKAGE_VERSION);
  assert.equal(claudeMarketplace.plugins[0].version, PACKAGE_VERSION);
});

test("release packaging excludes local generated state and reference checkouts", () => {
  const gitignore = read(".gitignore");
  const npmignore = read(".npmignore");
  for (const pattern of [".composer-swarm/state/", "node_modules/", "repos/", "*.tgz"]) {
    assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const pattern of [".composer-swarm/", "node_modules/", "repos/", "*.tgz"]) {
    assert.match(npmignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const exampleConfig = JSON.parse(read("swarm.config.example.json"));
  assert.equal(exampleConfig.distribution.defaultWorkerModel, "composer-2.5-fast");
  assert.equal("policies" in exampleConfig, false);
  assert.ok(fs.existsSync(path.join(ROOT, ".github", "workflows", "ci.yml")), "GitHub CI workflow should exist");
  assert.ok(
    fs.statSync(path.join(ROOT, "bin", "composer-swarm.mjs")).mode & 0o111,
    "CLI bin should be executable when installed directly or symlinked"
  );
});

test("Codex skill packaging stays synced between repo root and plugin bundle", () => {
  const rootSkill = read("skills/composer-swarm/SKILL.md");
  const pluginSkill = read("plugins/composer-swarm/skills/composer-swarm/SKILL.md");
  assert.equal(pluginSkill, rootSkill);
});

test("splitRawArgumentString and normalizeArgv handle quoted slash-command args", () => {
  assert.deepEqual(splitRawArgumentString('fix "quoted task" --roles reviewer'), [
    "fix",
    "quoted task",
    "--roles",
    "reviewer"
  ]);
  assert.deepEqual(normalizeArgv(['fix "quoted task" --roles reviewer']), [
    "fix",
    "quoted task",
    "--roles",
    "reviewer"
  ]);
  assert.deepEqual(normalizeArgv(["fix", "quoted task", "--roles", "reviewer"]), [
    "fix",
    "quoted task",
    "--roles",
    "reviewer"
  ]);
  assert.deepEqual(normalizeArgv(['fix "quoted task" --roles reviewer', "--wait"]), [
    'fix "quoted task" --roles reviewer',
    "--wait"
  ]);
  assert.deepEqual(normalizePluginArgv(['fix "quoted task" --roles reviewer', "--wait"]), [
    "fix",
    "quoted task",
    "--roles",
    "reviewer",
    "--wait"
  ]);
  assert.deepEqual(normalizePackagedPluginArgv(['fix "quoted task" --roles reviewer', "--wait"]), [
    "fix",
    "quoted task",
    "--roles",
    "reviewer",
    "--wait"
  ]);
});

test("CLI accepts quoted raw slash-command arguments", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [CLI, "plan", 'fix "quoted task" --roles builder-a,reviewer'],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Objective: fix quoted task/);
  assert.match(result.stdout, /builder-a: composer-builder-a/);
  assert.match(result.stdout, /reviewer: composer-reviewer/);
  assert.doesNotMatch(result.stdout, /builder-b:/);
});

test("setup can initialize trusted config from the friendly entrypoint", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  const result = spawnSync(
    process.execPath,
    [CLI, "setup", "--init", "--trust", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.configExists, true);
  assert.match(payload.initialized, /\.composer-swarm\/config\.json$/);

  const config = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "config.json"), "utf8"));
  const cursorAgents = config.agents.filter((agent) => agent.kind === "cursor-cli");
  assert.equal(config.distribution.defaultWorkerModel, "composer-2.5-fast");
  assert.ok(cursorAgents.length > 0);
  for (const agent of cursorAgents) {
    assert.deepEqual(agent.args, ["--trust"]);
  }
});

test("plugin script forwards a single raw argument string to the CLI", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, "scripts", "composer-swarm.mjs"), "plan", 'fix "quoted task" --roles reviewer'],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSER_SWARM_REPO: ROOT
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Objective: fix quoted task/);
  assert.match(result.stdout, /reviewer: composer-reviewer/);
  assert.doesNotMatch(result.stdout, /builder-a:/);
});

test("plugin script forwards multi-token arguments to the CLI", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [
      path.join(PLUGIN_ROOT, "scripts", "composer-swarm.mjs"),
      "plan",
      "fix",
      "quoted task",
      "--roles",
      "reviewer"
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSER_SWARM_REPO: ROOT
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Objective: fix quoted task/);
  assert.match(result.stdout, /reviewer: composer-reviewer/);
});
