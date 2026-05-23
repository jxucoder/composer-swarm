import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "composer-swarm.mjs");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "composer-swarm");

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
  const apply = read("plugins/composer-swarm/commands/apply.md");

  assert.match(team, /AskUserQuestion/);
  assert.match(team, /Run in background/);
  assert.match(team, /Wait for results/);
  assert.match(team, /\(Recommended\)/);
  assert.match(team, /team "\$ARGUMENTS/);
  assert.match(team, /Do not apply any candidate patch/);

  assert.match(review, /review-only/i);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /review "\$ARGUMENTS/);

  assert.match(setup, /setup --json "\$ARGUMENTS"/);
  assert.match(setup, /Initialize with trust \(Recommended\)/);
  assert.match(setup, /setup --init --trust "\$ARGUMENTS"/);

  assert.match(result, /result "\$ARGUMENTS"/);
  assert.match(result, /Do not summarize or condense/i);
  assert.match(apply, /apply "\$ARGUMENTS"/);
  assert.match(apply, /explicitly requested/i);
});

test("plugin manifests expose both Claude Code and Codex plugin metadata", () => {
  const claude = JSON.parse(read("plugins/composer-swarm/.claude-plugin/plugin.json"));
  assert.equal(claude.name, "composer");
  assert.equal(claude.author.name, "local");

  const codex = JSON.parse(read("plugins/composer-swarm/.codex-plugin/plugin.json"));
  assert.equal(codex.name, "composer-swarm");
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.interface.displayName, "Composer Swarm");

  const marketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  assert.equal(marketplace.plugins[0].name, "composer-swarm");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/composer-swarm");
  assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");
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
