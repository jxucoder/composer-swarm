import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { normalizeArgv, normalizePluginArgv, splitRawArgumentString } from "../src/args.mjs";
import { createResearchTask, defaultConfig } from "../src/runtime.mjs";
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

function makeFailingCursorAgent() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-bin-"));
  const scriptPath = path.join(binDir, "cursor-agent");
  fs.writeFileSync(
    scriptPath,
    "#!/usr/bin/env sh\nprintf '%s\\n' '{\"type\":\"final\",\"text\":\"failed worker\"}'\nexit 1\n",
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

async function waitForStoredTask(repo, taskId, predicate) {
  const taskFile = path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(taskFile)) {
      const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
      if (predicate(task)) {
        return task;
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

test("Claude Code command files preserve plugin UX and quote raw arguments", () => {
  const team = read("plugins/composer-swarm/commands/team.md");
  const research = read("plugins/composer-swarm/commands/research.md");
  const review = read("plugins/composer-swarm/commands/review.md");
  const setup = read("plugins/composer-swarm/commands/setup.md");
  const result = read("plugins/composer-swarm/commands/result.md");
  const status = read("plugins/composer-swarm/commands/status.md");
  const inspect = read("plugins/composer-swarm/commands/inspect.md");
  const logs = read("plugins/composer-swarm/commands/logs.md");
  const apply = read("plugins/composer-swarm/commands/apply.md");

  assert.match(team, /disable-model-invocation: true/);
  assert.match(team, /AskUserQuestion/);
  assert.match(team, /Run in background/);
  assert.match(team, /Wait for results/);
  assert.match(team, /\(Recommended\)/);
  assert.match(team, /--from-plan <file>/);
  assert.match(team, /--json/);
  assert.match(team, /Composer planning pass/);
  assert.match(team, /team "\$ARGUMENTS"\n/);
  assert.match(team, /Do not apply any candidate patch/);
  assert.match(team, /Preserve the user's arguments exactly/);
  assert.match(team, /run_in_background: true/);
  assert.match(team, /Bash\(\{/);
  assert.doesNotMatch(team, /team "\$ARGUMENTS" --(?:wait|background)/);
  assert.match(team, /composer-2\.5-fast/);
  assert.doesNotMatch(team, /--model <model>/);

  assert.match(research, /disable-model-invocation: true/);
  assert.match(research, /research-only/i);
  assert.match(research, /--json/);
  assert.match(research, /main agent should continue its own repo investigation/i);
  assert.match(research, /AskUserQuestion/);
  assert.match(research, /research "\$ARGUMENTS"\n/);
  assert.match(research, /Preserve the user's arguments exactly/);
  assert.match(research, /run_in_background: true/);
  assert.match(research, /Bash\(\{/);
  assert.doesNotMatch(research, /research "\$ARGUMENTS" --(?:wait|background)/);
  assert.match(research, /composer-2\.5-fast/);

  assert.match(review, /disable-model-invocation: true/);
  assert.match(review, /review-only/i);
  assert.match(review, /--json/);
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
  assert.match(result, /--synthesis/);
  assert.match(result, /synthesis coverage/i);
  assert.match(result, /Do not summarize or condense/i);
  assert.match(result, /verification tiers/i);
  assert.match(result, /baseline versus candidate-specific/i);
  assert.match(result, /patch paths/i);

  assert.match(status, /status "\$ARGUMENTS"/);
  assert.match(status, /worker states/i);
  assert.match(status, /next-step commands/i);

  assert.match(inspect, /inspect "\$ARGUMENTS"/);
  assert.match(inspect, /state paths/i);
  assert.match(inspect, /transcript paths/i);

  assert.match(logs, /logs "\$ARGUMENTS"/);
  assert.match(logs, /worker transcripts/i);
  assert.match(logs, /timeout details/i);

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
  for (const pattern of [".composer-swarm/state/", ".composer-swarm/config.json", "node_modules/", "repos/", "*.tgz", "docs/release-*-attempts-and-lessons.md"]) {
    assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const pattern of [".composer-swarm/", "node_modules/", "repos/", "*.tgz", "docs/release-*-attempts-and-lessons.md"]) {
    assert.match(npmignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const exampleConfig = JSON.parse(read("swarm.config.example.json"));
  assert.equal(exampleConfig.distribution.defaultWorkerModel, "composer-2.5-fast");
  assert.equal("verifier" in exampleConfig.workers, false);
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
  assert.deepEqual(splitRawArgumentString('fix "quoted task" --background'), [
    "fix",
    "quoted task",
    "--background"
  ]);
  assert.deepEqual(normalizeArgv(['fix "quoted task" --background']), [
    "fix",
    "quoted task",
    "--background"
  ]);
  assert.deepEqual(normalizeArgv(["fix", "quoted task", "--background"]), [
    "fix",
    "quoted task",
    "--background"
  ]);
  assert.deepEqual(normalizeArgv(['fix "quoted task" --background', "--wait"]), [
    'fix "quoted task" --background',
    "--wait"
  ]);
  assert.deepEqual(normalizePluginArgv(['fix "quoted task" --background', "--wait"]), [
    "fix",
    "quoted task",
    "--background",
    "--wait"
  ]);
  assert.deepEqual(normalizePackagedPluginArgv(['fix "quoted task" --background', "--wait"]), [
    "fix",
    "quoted task",
    "--background",
    "--wait"
  ]);
});

test("CLI accepts quoted raw slash-command arguments", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [CLI, "plan", 'fix "quoted task"'],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Objective: fix quoted task/);
  assert.match(result.stdout, /Worker passes:/);
  assert.match(result.stdout, /implementation pass A \(can edit\)/);
  assert.match(result.stdout, /review pass \(read-only\)/);
  assert.doesNotMatch(result.stdout, /composer-builder-a/);
});

test("CLI rejects removed plan role selection flag", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [CLI, "plan", "fix this", "--roles", "planner,builder-a"],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /plan no longer accepts worker selection flags/);
  assert.match(result.stderr, /team --builders/);
  assert.match(result.stderr, /review --scouts/);
});

test("CLI research runs a read-only workflow with quoted arguments", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  const result = spawnSync(
    process.execPath,
    [CLI, "research", "map", "quoted flow", "--focus", "docs", "--angles", "api,tests"],
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
  assert.match(result.stdout, /Started task_/);
  assert.match(result.stdout, /Objective: map quoted flow/);
  assert.match(result.stdout, /Research:/);
  assert.match(result.stdout, /Result: composer-swarm result task_.* --verbose/);
  assert.doesNotMatch(result.stdout, /Apply:/);

  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "research command should print a task id");
  const task = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`), "utf8"));
  assert.equal(task.options.workers, 2);
  assert.deepEqual(task.options.researchAngles, ["api", "tests"]);

  const inspect = spawnSync(process.execPath, [CLI, "inspect", taskId], { cwd: repo, encoding: "utf8" });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, new RegExp(`Task: ${taskId}`));
  assert.match(inspect.stdout, /composer-swarm logs .* --worker research-a/);

  const statusJson = spawnSync(process.execPath, [CLI, "status", taskId, "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(statusJson.status, 0, statusJson.stderr);
  const statusPayload = JSON.parse(statusJson.stdout);
  assert.equal(statusPayload.schema, "composer-swarm.status.v1");
  assert.equal(statusPayload.task.taskId, taskId);
  assert.equal(statusPayload.task.mode, "research");
  assert.equal(statusPayload.task.status, "completed");

  const logs = spawnSync(process.execPath, [CLI, "logs", taskId, "--worker", "research-a"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(logs.status, 0, logs.stderr);
  assert.match(logs.stdout, /Worker: research-a/);
  assert.match(logs.stdout, /ok/);

  const synthesis = spawnSync(process.execPath, [CLI, "result", taskId, "--synthesis"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(synthesis.status, 0, synthesis.stderr);
  assert.match(synthesis.stdout, /Host synthesis brief/);
  assert.match(synthesis.stdout, /Mode: research/);
});

test("internal task runner exits non-zero when the stored workflow fails", () => {
  const repo = makeRepo();
  const fakeBin = makeFailingCursorAgent();
  const task = createResearchTask(defaultConfig(), repo, "surface worker failure status", {
    taskId: "task_internal_runner_failure",
    workers: 1
  });

  const result = spawnSync(process.execPath, [CLI, "__run-task", task.taskId], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
    }
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);

  const stored = JSON.parse(
    fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${task.taskId}.json`), "utf8")
  );
  assert.equal(stored.status, "failed");
  assert.equal(stored.research[0].status, "failed");
  assert.equal(stored.research[0].exitCode, 1);
});

test("CLI research can derive worker angles from a host-authored plan file", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  fs.mkdirSync(path.join(repo, "plans"));
  fs.writeFileSync(
    path.join(repo, "plans", "research.md"),
    [
      "# Auth flow investigation",
      "",
      "- entry points: find command and API entry points",
      "- data flow: trace token storage"
    ].join("\n"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [CLI, "research", "--from-plan", "plans/research.md"],
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
  assert.match(result.stdout, /Objective: Auth flow investigation/);

  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "research --from-plan should print a task id");
  const task = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`), "utf8"));
  assert.equal(task.options.workers, 2);
  assert.equal(task.options.researchPlanFile, "plans/research.md");
  assert.deepEqual(task.options.researchAngles, [
    "entry points: find command and API entry points",
    "data flow: trace token storage"
  ]);
});

test("CLI team can execute a host-authored implementation plan file", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  fs.mkdirSync(path.join(repo, "plans"));
  fs.writeFileSync(
    path.join(repo, "plans", "implement.md"),
    [
      "# Implementation plan",
      "",
      "Objective: implement the planned change",
      "",
      "- Inspect README.md.",
      "- Make the smallest compatible edit.",
      "- Report risks and checks."
    ].join("\n"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [CLI, "team", "--from-plan", "plans/implement.md", "--builders", "1"],
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
  assert.match(result.stdout, /Started task_/);
  assert.match(result.stdout, /Objective: implement the planned change/);
  assert.match(result.stdout, /Implementation plan: plans\/implement\.md/);

  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "team --from-plan should print a task id");
  const task = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`), "utf8"));
  assert.deepEqual(
    task.workers.map((worker) => worker.label),
    ["builder-a", "reviewer"]
  );
  assert.equal(task.options.implementationPlanFile, "plans/implement.md");
  assert.equal(task.planner.worker, "host");
  assert.equal(fs.existsSync(path.join(repo, ".composer-swarm", "state", "worktrees", taskId, "planner")), false);
});

test("CLI team --from-plan stores subdirectory plan paths relative to the repo", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  const subdir = path.join(repo, "subdir");
  fs.mkdirSync(subdir);
  fs.writeFileSync(
    path.join(subdir, "plan.md"),
    ["# Implementation plan", "", "Objective: implement from subdir", "", "- Change app text."].join("\n"),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [CLI, "team", "--from-plan", "plan.md", "--builders", "1"],
    {
      cwd: subdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Implementation plan: subdir\/plan\.md/);

  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "team --from-plan should print a task id");
  const task = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`), "utf8"));
  assert.equal(task.options.implementationPlanFile, "subdir/plan.md");
});

test("CLI verify exits non-zero when candidate checks fail", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  fs.mkdirSync(path.join(repo, ".composer-swarm"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".composer-swarm", "config.json"),
    JSON.stringify(
      {
        version: 1,
        workers: {
          composer: { kind: "cursor-cli", command: "cursor-agent" },
          verifier: { kind: "shell", command: "bash", args: ["-lc", "exit 1"] }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const team = spawnSync(process.execPath, [CLI, "team", "make", "a", "change", "--builders", "2"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
    }
  });
  assert.equal(team.status, 0, team.stderr);
  const taskId = /Started (task_[^\s.]+)/.exec(team.stdout)?.[1];
  assert.ok(taskId, "team command should print a task id");

  const verify = spawnSync(process.execPath, [CLI, "verify", taskId], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /Verified .*builder-a/);
  assert.match(verify.stdout, /Verified .*builder-b/);
  assert.match(verify.stdout, /Result: failed/);
  assert.match(verify.stdout, /Classification: baseline/);
});

test("CLI review can snapshot dirty untracked current checkout", () => {
  const repo = makeRepo();
  const fakeBin = makeFakeCursorAgent();
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "src", "prototype.js"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "tests", "prototype.test.js"), "import '../src/prototype.js';\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [CLI, "review", "--preset", "repo", "--include-untracked"],
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
  assert.match(result.stdout, /Started task_/);
  assert.doesNotMatch(result.stdout, /Apply:/);

  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "review command should print a task id");
  assert.equal(fs.existsSync(path.join(repo, ".composer-swarm", "state", "worktrees", taskId, "planner")), false);
  assert.ok(fs.existsSync(path.join(repo, ".composer-swarm", "state", "worktrees", taskId, "reviewer", "src", "prototype.js")));
  assert.ok(
    fs.existsSync(path.join(repo, ".composer-swarm", "state", "worktrees", taskId, "reviewer", "tests", "prototype.test.js"))
  );

  const task = JSON.parse(fs.readFileSync(path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`), "utf8"));
  assert.equal(task.options.review, true);
  assert.equal(task.options.snapshotCurrent, true);
  assert.match(task.options.snapshotStatus, /\?\? src\//);
  assert.match(task.options.snapshotStatus, /\?\? tests\//);
});

test("CLI launch commands can emit machine-readable JSON", async () => {
  const fakeBin = makeFakeCursorAgent();
  function runLaunch(args, repo = makeRepo()) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Started task_/);
    return JSON.parse(result.stdout);
  }

  const team = runLaunch(["team", "make", "a", "change", "--builders", "1", "--json"]);
  assert.equal(team.schema, "composer-swarm.launch.v1");
  assert.equal(team.mode, "team");
  assert.equal(team.status, "completed");
  assert.equal(team.team.builders, 1);
  assert.match(team.commands.statusJson, new RegExp(`composer-swarm status ${team.taskId} --json`));
  assert.match(team.commands.resultJson, new RegExp(`composer-swarm result ${team.taskId} --json`));
  assert.match(team.commands.verify, new RegExp(`composer-swarm verify ${team.taskId}`));
  assert.equal(team.commands.apply, undefined);

  const research = runLaunch(["research", "map", "flow", "--workers", "1", "--json"]);
  assert.equal(research.mode, "research");
  assert.equal(research.research.workers, 1);
  assert.match(research.commands.synthesis, new RegExp(`composer-swarm result ${research.taskId} --synthesis`));
  assert.equal(research.commands.apply, undefined);

  const review = runLaunch(["review", "--preset", "repo", "--scouts", "0", "--json"]);
  assert.equal(review.mode, "review");
  assert.equal(review.review.scouts, 0);
  assert.match(review.commands.findings, new RegExp(`composer-swarm result ${review.taskId} --findings`));
  assert.equal(review.commands.apply, undefined);

  const backgroundRepo = makeRepo();
  const background = runLaunch(["research", "map", "flow", "--workers", "1", "--background", "--json"], backgroundRepo);
  assert.equal(background.schema, "composer-swarm.launch.v1");
  assert.equal(background.mode, "research");
  assert.equal(background.background, true);
  assert.equal(background.status, "queued");
  assert.equal(typeof background.backgroundPid, "number");
  assert.match(background.commands.status, new RegExp(`composer-swarm status ${background.taskId}`));
  assert.match(background.commands.statusJson, new RegExp(`composer-swarm status ${background.taskId} --json`));

  const completed = await waitForStoredTask(backgroundRepo, background.taskId, (task) => task.status !== "queued" && task.status !== "running");
  assert.equal(completed.status, "completed");

  const cleanup = spawnSync(process.execPath, [CLI, "cleanup", background.taskId], {
    cwd: backgroundRepo,
    encoding: "utf8"
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
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
  assert.equal(config.distribution.defaultWorkerModel, "composer-2.5-fast");
  assert.equal("agents" in config, false);
  assert.equal("defaultRoles" in config.swarm, false);
  assert.deepEqual(config.workers.composer.args, ["--trust"]);
  assert.equal("verifier" in config.workers, false);
});

test("setup --init creates git metadata in a brand-new directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-new-dir-"));
  const fakeBin = makeFakeCursorAgent();
  const result = spawnSync(
    process.execPath,
    [CLI, "setup", "--init", "--trust", "--json"],
    {
      cwd: dir,
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
  assert.equal(payload.gitRoot, fs.realpathSync(dir));
  assert.equal(payload.initializedGit, fs.realpathSync(dir));
  assert.equal(fs.existsSync(path.join(dir, ".git")), true);
  assert.equal(fs.existsSync(path.join(dir, ".composer-swarm", "config.json")), true);
});

test("CLI review --current initializes and snapshots a prototype directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-current-"));
  const fakeBin = makeFakeCursorAgent();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "prototype.js"), "export const value = 1;\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [CLI, "review", "--current"],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Started task_/);
  const taskId = /Started (task_[^\s.]+)/.exec(result.stdout)?.[1];
  assert.ok(taskId, "review --current should print a task id");
  assert.equal(fs.existsSync(path.join(dir, ".git")), true);
  assert.ok(fs.existsSync(path.join(dir, ".composer-swarm", "state", "worktrees", taskId, "reviewer", "src", "prototype.js")));
});

test("plugin script forwards a single raw argument string to the CLI", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, "scripts", "composer-swarm.mjs"), "plan", 'fix "quoted task"'],
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
  assert.match(result.stdout, /implementation pass A \(can edit\)/);
  assert.match(result.stdout, /review pass \(read-only\)/);
  assert.doesNotMatch(result.stdout, /composer-reviewer/);
});

test("plugin script forwards multi-token arguments to the CLI", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [
      path.join(PLUGIN_ROOT, "scripts", "composer-swarm.mjs"),
      "plan",
      "fix",
      "quoted task"
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
  assert.match(result.stdout, /review pass \(read-only\)/);
});
