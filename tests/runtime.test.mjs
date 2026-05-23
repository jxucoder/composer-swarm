import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyCandidate,
  buildCursorAgentArgs,
  buildRolePrompt,
  cleanupTask,
  createReviewTask,
  createTeamTask,
  DEFAULT_CURSOR_MODEL,
  defaultConfig,
  extractRecommendedCandidate,
  findNestedGitRepos,
  formatCandidateComparison,
  formatPlan,
  loadTask,
  planTask,
  renderResult,
  renderStatus,
  resolveWorkspaceContext,
  resolveCursorModel,
  reviewObjective,
  runDoctor,
  runTaskWorkflow,
  saveTask,
  verifyCandidate,
  writeDefaultConfig
} from "../src/runtime.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.txt"), "base\n", "utf8");
  git(dir, ["add", "src/app.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function makeFakeCursorAgent(dir) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-fake-"));
  const scriptPath = path.join(fakeDir, "fake-cursor-agent.mjs");
  const logPath = path.join(fakeDir, "cursor-args.jsonl");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
const prompt = args[args.length - 1];
const role = /Role: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, workspace, role }) + "\\n", "utf8");

if (role === "builder-a") {
  fs.writeFileSync(path.join(workspace, "src", "app.txt"), "builder-a\\n", "utf8");
}
if (role === "builder-b") {
  fs.writeFileSync(path.join(workspace, "src", "new.txt"), "builder-b\\n", "utf8");
}

console.log(JSON.stringify({ type: "input", text: prompt }));
console.log(JSON.stringify({ type: "progress", text: role + " progress" }));
if (role === "reviewer") {
  console.log(JSON.stringify({ type: "final", text: "Recommend builder-a. builder-a is the best candidate with fewer risks." }));
} else {
  console.log(JSON.stringify({ type: "final", text: role + " done" }));
}
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath, logPath };
}

function configWithCursor(command) {
  const config = defaultConfig();
  return {
    ...config,
    agents: config.agents.map((agent) =>
      agent.kind === "cursor-cli"
        ? {
            ...agent,
            command
          }
        : agent
    )
  };
}

test("plans default roles using configured agents", () => {
  const plan = planTask(defaultConfig(), "ship the feature");
  assert.equal(plan.roles.length, 5);
  assert.equal(plan.roles[0].role, "planner");
  assert.equal(plan.roles[1].agentId, "composer-builder-a");
  assert.equal(plan.roles[2].agentId, "composer-builder-b");
  assert.equal(plan.roles[3].agentId, "composer-reviewer");
});

test("formats plan with objective and role mappings", () => {
  const text = formatPlan(planTask(defaultConfig(), "fix tests", { roles: ["builder-a", "reviewer"] }));
  assert.match(text, /Objective: fix tests/);
  assert.match(text, /builder-a: composer-builder-a/);
  assert.match(text, /reviewer: composer-reviewer/);
});

test("doctor reports host-driven agents without failing", () => {
  const config = {
    ...defaultConfig(),
    agents: [{ id: "claude", kind: "claude-code", role: "architect", canEdit: false }]
  };
  const report = runDoctor(config);
  assert.equal(report.ok, true);
  assert.match(report.lines.join("\n"), /host-driven/);
});

test("cursor-agent args use stream-json, workspace, model, and plan mode for non-editing roles", () => {
  const args = buildCursorAgentArgs({
    role: "reviewer",
    worktree: "/tmp/worktree",
    prompt: "review this",
    model: "test-model"
  });
  assert.deepEqual(args.slice(0, 5), ["--print", "--output-format", "stream-json", "--workspace", "/tmp/worktree"]);
  assert.equal(args.includes("--mode=plan"), true);
  assert.deepEqual(args.slice(5, 7), ["--model", "test-model"]);
  assert.equal(args.at(-1), "review this");

  const builderArgs = buildCursorAgentArgs({ role: "builder-a", worktree: "/tmp/w", prompt: "build" });
  assert.equal(builderArgs.includes("--mode=plan"), false);
});

test("Composer workers are pinned to Composer 2.5 Fast", () => {
  const config = defaultConfig();
  assert.equal(config.distribution.defaultWorkerModel, DEFAULT_CURSOR_MODEL);
  assert.equal(resolveCursorModel(config), DEFAULT_CURSOR_MODEL);
  assert.equal(resolveCursorModel(config, DEFAULT_CURSOR_MODEL), DEFAULT_CURSOR_MODEL);
  assert.throws(() => resolveCursorModel(config, "auto"), /composer-2\.5-fast/);

  const repo = makeRepo();
  const task = createTeamTask(config, repo, "pin model", { taskId: "task_model" });
  assert.equal(task.options.model, DEFAULT_CURSOR_MODEL);
  assert.throws(() => createTeamTask(config, repo, "wrong model", { model: "auto" }), /composer-2\.5-fast/);
});

test("role prompts include objective, role, planner output, and candidate context", () => {
  const task = { taskId: "task_test", objective: "fix checkout", baseSha: "abc123" };
  const builderPrompt = buildRolePrompt("builder-a", task, { plannerOutput: "touch src/checkout.js" });
  assert.match(builderPrompt, /Role: builder-a/);
  assert.match(builderPrompt, /Objective: fix checkout/);
  assert.match(builderPrompt, /touch src\/checkout.js/);

  const reviewerPrompt = buildRolePrompt("reviewer", task, { candidateText: "Candidate A patch" });
  assert.match(reviewerPrompt, /Candidate A patch/);
  assert.match(reviewerPrompt, /Do not choose for the user/);

  const reviewOnlyPrompt = buildRolePrompt("reviewer", { ...task, options: { review: true } });
  assert.match(reviewOnlyPrompt, /Repository review task/);
  assert.doesNotMatch(reviewOnlyPrompt, /Candidate patches to review/);

  const reviewPlannerPrompt = buildRolePrompt("planner", { ...task, options: { review: true } });
  assert.match(reviewPlannerPrompt, /Review planning task/);
  assert.doesNotMatch(reviewPlannerPrompt, /implementation plan for the builders/);
});

test("workflow creates worktrees, records transcripts, captures modified and new-file patches", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);

  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_test" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.candidates.length, 2);
  assert.equal(stored.reviewer.status, "completed");

  const candidateA = stored.candidates.find((candidate) => candidate.role === "builder-a");
  const candidateB = stored.candidates.find((candidate) => candidate.role === "builder-b");
  assert.ok(candidateA.patchFile);
  assert.ok(candidateB.patchFile);
  assert.match(fs.readFileSync(candidateA.patchFile, "utf8"), /builder-a/);
  assert.match(fs.readFileSync(candidateB.patchFile, "utf8"), /new file mode/);
  assert.deepEqual(candidateA.changedFiles, ["src/app.txt"]);
  assert.deepEqual(candidateB.changedFiles, ["src/new.txt"]);

  for (const worker of stored.workers) {
    assert.ok(fs.existsSync(worker.worktree), `${worker.role} worktree should exist`);
    assert.ok(fs.existsSync(worker.transcript), `${worker.role} transcript should exist`);
  }

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 4);
  assert.equal(invocations.find((entry) => entry.role === "planner").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.role === "reviewer").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.role === "builder-a").args.includes("--mode=plan"), false);

  const resultText = renderResult(config, repo, task.taskId);
  assert.match(resultText, /Candidate: task_test-builder-a/);
  assert.match(resultText, /Apply: composer-swarm apply task_test --candidate task_test-builder-a/);
  assert.match(resultText, /Comparison:/);
  assert.match(resultText, /Recommended: task_test-builder-a/);
  assert.doesNotMatch(resultText, /You are a Composer worker/);
  assert.match(renderStatus(config, repo, task.taskId), /Status: completed/);
  assert.match(renderStatus(config, repo, task.taskId), /Next steps:/);
});

test("applyCandidate applies exactly one stored patch", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_apply" });
  await runTaskWorkflow(config, repo, task.taskId);

  const result = applyCandidate(config, repo, task.taskId, "builder-a");
  assert.match(result.lines.join("\n"), /Applied task_apply-builder-a/);
  assert.equal(fs.readFileSync(path.join(repo, "src", "app.txt"), "utf8"), "builder-a\n");
  assert.equal(fs.existsSync(path.join(repo, "src", "new.txt")), false);
  assert.equal(loadTask(config, repo, task.taskId).status, "applied");
});

test("applyCandidate --recommended applies the reviewer recommendation", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_recommended" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.recommendedCandidateId, "task_recommended-builder-a");

  const result = applyCandidate(config, repo, task.taskId, null, { recommended: true });
  assert.match(result.lines.join("\n"), /Applied task_recommended-builder-a/);
});

test("applyCandidate rejects missing candidates and dirty main checkout", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_dirty" });
  await runTaskWorkflow(config, repo, task.taskId);

  assert.throws(() => applyCandidate(config, repo, task.taskId, "missing"), /Candidate not found/);
  fs.writeFileSync(path.join(repo, "src", "app.txt"), "dirty\n", "utf8");
  assert.throws(() => applyCandidate(config, repo, task.taskId, "builder-a"), /checkout has changes/);
});

test("applyCandidate rejects a clean checkout when the patch conflicts", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_conflict" });
  await runTaskWorkflow(config, repo, task.taskId);

  fs.writeFileSync(path.join(repo, "src", "app.txt"), "different base\n", "utf8");
  git(repo, ["add", "src/app.txt"]);
  git(repo, ["commit", "-q", "-m", "diverge"]);

  assert.throws(() => applyCandidate(config, repo, task.taskId, "builder-a"), /Patch does not apply cleanly/);
});

test("cleanup removes worktrees and process metadata", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  config.agents = config.agents.map((agent) =>
    agent.role === "verifier" ? { ...agent, command: "bash", args: ["-lc", "true"], kind: "shell" } : agent
  );
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_cleanup" });
  await runTaskWorkflow(config, repo, task.taskId);
  verifyCandidate(config, repo, task.taskId, "builder-a");

  const stored = loadTask(config, repo, task.taskId);
  stored.workers[0].pid = 99999999;
  saveTask(config, repo, stored);
  const baselineWorktree = path.join(repo, ".composer-swarm", "state", "worktrees", task.taskId, "__baseline__");
  assert.equal(fs.existsSync(baselineWorktree), true);
  const worktrees = [...stored.workers.map((worker) => worker.worktree).filter(Boolean), baselineWorktree];
  const cleanup = cleanupTask(config, repo, task.taskId);
  assert.match(cleanup.lines.join("\n"), /Cleaned task_cleanup/);
  for (const worktree of worktrees) {
    assert.equal(fs.existsSync(worktree), false);
  }
  assert.equal("pid" in loadTask(config, repo, task.taskId).workers[0], false);
});

test("reviewObjective returns preset text and rejects unknown presets", () => {
  assert.match(reviewObjective("repo"), /comprehensive repository review/i);
  assert.match(reviewObjective("security"), /security-focused/i);
  assert.throws(() => reviewObjective("unknown"), /Unknown review preset/);
});

test("createReviewTask uses planner and reviewer only", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createReviewTask(config, repo, "tests", { taskId: "task_review" });
  assert.equal(task.options.review, true);
  assert.deepEqual(
    task.workers.map((worker) => worker.role),
    ["planner", "reviewer"]
  );
});

test("createTeamTask rejects zero builders outside review mode", () => {
  const repo = makeRepo();
  assert.throws(() => createTeamTask(defaultConfig(), repo, "no builders", { builders: 0 }), /requires 1 to 4 builders/);
});

test("writeDefaultConfig --trust adds --trust to cursor-cli agents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-trust-"));
  const filePath = writeDefaultConfig(dir, { trust: true });
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const cursorAgents = config.agents.filter((agent) => agent.kind === "cursor-cli");
  assert.ok(cursorAgents.length > 0);
  for (const agent of cursorAgents) {
    assert.deepEqual(agent.args, ["--trust"]);
  }
});

test("resolveWorkspaceContext finds nested git repos when cwd is outside git", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-nested-"));
  const repo = makeRepo();
  const nestedRepo = path.join(parent, "inner-repo");
  fs.renameSync(repo, nestedRepo);
  const nestedRepoRoot = fs.realpathSync(nestedRepo);
  const nested = findNestedGitRepos(parent);
  assert.deepEqual(nested, [nestedRepoRoot]);
  assert.throws(() => resolveWorkspaceContext(parent), /Nearby git repositories/);

  const ctx = resolveWorkspaceContext(parent, { requireGit: false });
  assert.equal(ctx.gitRoot, null);
  assert.deepEqual(ctx.nearbyGitRepos, [nestedRepoRoot]);
});

test("verifyCandidate runs shell checks and classifies baseline failures", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  config.agents = config.agents.map((agent) =>
    agent.role === "verifier"
      ? { ...agent, command: "bash", args: ["-lc", "npm test"], kind: "shell" }
      : agent
  );
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }, null, 2),
    "utf8"
  );
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "-q", "-m", "add failing test"]);

  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_verify" });
  await runTaskWorkflow(config, repo, task.taskId);

  const result = verifyCandidate(config, repo, task.taskId, "builder-a");
  assert.match(result.lines.join("\n"), /Classification: baseline/);
  assert.equal(result.check.classification, "baseline");

  const stored = loadTask(config, repo, task.taskId);
  const candidate = stored.candidates.find((entry) => entry.role === "builder-a");
  assert.equal(candidate.checks.length, 1);
  assert.equal(candidate.checks[0].classification, "baseline");
});

test("formatCandidateComparison summarizes patch size and checks", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_compare" });
  await runTaskWorkflow(config, repo, task.taskId);
  const stored = loadTask(config, repo, task.taskId);
  const comparison = formatCandidateComparison(stored);
  assert.match(comparison, /Comparison:/);
  assert.match(comparison, /task_compare-builder-a/);
  assert.match(comparison, /Recommended:/);
});

test("extractRecommendedCandidate parses reviewer notes", () => {
  const task = {
    candidates: [
      { candidateId: "t-builder-a", role: "builder-a", patchFile: "/a.patch", status: "completed" },
      { candidateId: "t-builder-b", role: "builder-b", patchFile: "/b.patch", status: "completed" }
    ],
    reviewer: { notes: "I recommend builder-a for this task." }
  };
  assert.equal(extractRecommendedCandidate(task), "t-builder-a");
});
