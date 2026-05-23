import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyCandidate,
  buildCursorAgentArgs,
  buildWorkerPrompt,
  cleanupTask,
  createResearchTask,
  createReviewTask,
  createTeamTask,
  DEFAULT_CURSOR_MODEL,
  defaultConfig,
  extractRecommendedCandidate,
  findNestedGitRepos,
  formatCandidateComparison,
  formatPlan,
  loadConfig,
  loadTask,
  planTask,
  researchWorkerLabels,
  renderInspect,
  renderLogs,
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
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, workspace, workerLabel }) + "\\n", "utf8");

if (workerLabel === "builder-a") {
  fs.writeFileSync(path.join(workspace, "src", "app.txt"), "builder-a\\n", "utf8");
}
if (workerLabel === "builder-b") {
  fs.writeFileSync(path.join(workspace, "src", "new.txt"), "builder-b\\n", "utf8");
}

console.log(JSON.stringify({ type: "input", text: prompt }));
console.log(JSON.stringify({ type: "progress", text: workerLabel + " progress" }));
if (workerLabel === "reviewer") {
  console.log(JSON.stringify({ type: "final", text: "Recommend builder-a. builder-a is the best candidate with fewer risks." }));
} else {
  console.log(JSON.stringify({ type: "final", text: workerLabel + " done" }));
}
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath, logPath };
}

function makeCancellingReviewerAgent(repo, taskId) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-cancel-"));
  const scriptPath = path.join(fakeDir, "fake-cancelling-cursor-agent.mjs");
  const taskFile = path.join(repo, ".composer-swarm", "state", "tasks", `${taskId}.json`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const prompt = process.argv.at(-1);
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";
if (workerLabel === "reviewer") {
  const task = JSON.parse(fs.readFileSync(${JSON.stringify(taskFile)}, "utf8"));
  task.status = "cancelled";
  task.cancelledAt = "2026-05-23T00:00:00.000Z";
  fs.writeFileSync(${JSON.stringify(taskFile)}, JSON.stringify(task, null, 2) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "final", text: workerLabel + " done" }));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function makeRetryingCursorAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-retry-"));
  const scriptPath = path.join(fakeDir, "fake-retrying-cursor-agent.mjs");
  const markerPath = path.join(fakeDir, "builder-b-failed-once");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
const prompt = args[args.length - 1];
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";

if (workerLabel === "builder-b" && !fs.existsSync(${JSON.stringify(markerPath)})) {
  fs.writeFileSync(${JSON.stringify(markerPath)}, "failed once\\n", "utf8");
  console.error("Error: ENOENT: no such file or directory, rename '/Users/test/.cursor/cli-config.json.tmp' -> '/Users/test/.cursor/cli-config.json'");
  process.exit(1);
}

if (workerLabel === "builder-a") {
  fs.writeFileSync(path.join(workspace, "src", "app.txt"), "builder-a\\n", "utf8");
}
if (workerLabel === "builder-b") {
  fs.writeFileSync(path.join(workspace, "src", "retry.txt"), "builder-b retry\\n", "utf8");
}

console.log(JSON.stringify({ type: "final", text: workerLabel === "reviewer" ? "Recommend builder-b." : workerLabel + " done" }));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function makeHangingResearchAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-hang-"));
  const scriptPath = path.join(fakeDir, "fake-hanging-cursor-agent.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1);
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";

if (workerLabel === "research-b") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "final", text: workerLabel + " done" }));
}
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function configWithCursor(command) {
  const config = defaultConfig();
  return {
    ...config,
    workers: {
      ...config.workers,
      composer: {
        ...config.workers.composer,
        command
      }
    }
  };
}

test("plans default worker labels without defined roles", () => {
  const plan = planTask(defaultConfig(), "ship the feature");
  assert.equal(plan.workers.length, 4);
  assert.equal(plan.workers[0].label, "planner");
  assert.equal(plan.workers[1].label, "builder-a");
  assert.equal(plan.workers[2].label, "builder-b");
  assert.equal(plan.workers[3].label, "reviewer");
  assert.equal("agentId" in plan.workers[1], false);
  assert.equal("objective" in plan.workers[1], false);
  assert.equal("roles" in plan, false);
});

test("formats plan with objective and worker passes", () => {
  const text = formatPlan(planTask(defaultConfig(), "fix tests", { builders: 1 }));
  assert.match(text, /Objective: fix tests/);
  assert.match(text, /Worker passes:/);
  assert.match(text, /implementation pass A \(can edit\)/);
  assert.match(text, /review pass \(read-only\)/);
  assert.doesNotMatch(text, /composer-builder-a/);
  assert.doesNotMatch(text, /Produce the smallest direct implementation/);
});

test("doctor reports configured workers", () => {
  const config = defaultConfig();
  config.workers.composer.command = process.execPath;
  const report = runDoctor(config);
  assert.equal(report.ok, true);
  assert.match(report.lines.join("\n"), /Workers:/);
  assert.match(report.lines.join("\n"), /composer: ok/);
  assert.match(report.lines.join("\n"), /verifier: not configured/);
});

test("legacy agent configs still load without exposing default worker catalogs", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".composer-swarm"));
  fs.writeFileSync(
    path.join(repo, ".composer-swarm", "config.json"),
    JSON.stringify(
      {
        version: 1,
        swarm: {
          name: "legacy",
          stateDir: ".composer-swarm/state",
          defaultRoles: ["planner", "builder-a", "reviewer"]
        },
        agents: [
          {
            id: "legacy-builder",
            kind: "cursor-cli",
            role: "builder-a",
            command: process.execPath,
            args: ["--trust"],
            canEdit: true
          },
          {
            id: "legacy-verifier",
            kind: "shell",
            role: "verifier",
            command: "bash",
            args: ["-lc", "true"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const config = loadConfig(repo);
  assert.equal("defaultRoles" in config.swarm, false);
  const report = runDoctor(config);
  assert.equal(report.ok, true);
  assert.match(report.lines.join("\n"), /composer: ok/);
  const task = createTeamTask(config, repo, "legacy config task", { builders: 1, taskId: "task_legacy" });
  assert.equal(task.workers.find((worker) => worker.label === "builder-a").agentId, "legacy-builder");
});

test("cursor-agent args use stream-json, workspace, model, and plan mode for read-only labels", () => {
  const args = buildCursorAgentArgs({
    workerLabel: "reviewer",
    worktree: "/tmp/worktree",
    prompt: "review this",
    model: "test-model"
  });
  assert.deepEqual(args.slice(0, 5), ["--print", "--output-format", "stream-json", "--workspace", "/tmp/worktree"]);
  assert.equal(args.includes("--mode=plan"), true);
  assert.deepEqual(args.slice(5, 7), ["--model", "test-model"]);
  assert.equal(args.at(-1), "review this");

  const builderArgs = buildCursorAgentArgs({ workerLabel: "builder-a", worktree: "/tmp/w", prompt: "build" });
  assert.equal(builderArgs.includes("--mode=plan"), false);

  const scoutArgs = buildCursorAgentArgs({ workerLabel: "scout-a", worktree: "/tmp/w", prompt: "inspect" });
  assert.equal(scoutArgs.includes("--mode=plan"), true);

  const researchArgs = buildCursorAgentArgs({ workerLabel: "research-a", worktree: "/tmp/w", prompt: "research" });
  assert.equal(researchArgs.includes("--mode=plan"), true);
});

test("Composer workers are pinned to Composer 2.5 Fast", () => {
  const config = defaultConfig();
  assert.equal(config.distribution.defaultWorkerModel, DEFAULT_CURSOR_MODEL);
  assert.equal("agents" in config, false);
  assert.equal("defaultRoles" in config.swarm, false);
  assert.equal("policies" in config, false);
  assert.equal(resolveCursorModel(config), DEFAULT_CURSOR_MODEL);
  assert.equal(resolveCursorModel(config, DEFAULT_CURSOR_MODEL), DEFAULT_CURSOR_MODEL);
  assert.throws(() => resolveCursorModel(config, "auto"), /composer-2\.5-fast/);

  const repo = makeRepo();
  const task = createTeamTask(config, repo, "pin model", { taskId: "task_model" });
  assert.equal(task.options.model, DEFAULT_CURSOR_MODEL);
  assert.throws(() => createTeamTask(config, repo, "wrong model", { model: "auto" }), /composer-2\.5-fast/);
});

test("worker prompts include objective, label, planner output, and candidate context", () => {
  const task = { taskId: "task_test", objective: "fix checkout", baseSha: "abc123" };
  const builderPrompt = buildWorkerPrompt("builder-a", task, { plannerOutput: "touch src/checkout.js" });
  assert.match(builderPrompt, /Worker label: builder-a/);
  assert.match(builderPrompt, /Objective: fix checkout/);
  assert.match(builderPrompt, /touch src\/checkout.js/);

  const reviewerPrompt = buildWorkerPrompt("reviewer", task, { candidateText: "Candidate A patch" });
  assert.match(reviewerPrompt, /Candidate A patch/);
  assert.match(reviewerPrompt, /Do not choose for the user/);

  const reviewOnlyPrompt = buildWorkerPrompt("reviewer", { ...task, options: { review: true } });
  assert.match(reviewOnlyPrompt, /Repository review pass/);
  assert.match(reviewOnlyPrompt, /Scout notes/);
  assert.doesNotMatch(reviewOnlyPrompt, /Candidate patches to review/);

  const reviewPlannerPrompt = buildWorkerPrompt("planner", { ...task, options: { review: true } });
  assert.match(reviewPlannerPrompt, /Review planning pass/);
  assert.doesNotMatch(reviewPlannerPrompt, /implementation plan for the builders/);

  const scoutPrompt = buildWorkerPrompt("scout-a", { ...task, options: { review: true } }, { plannerOutput: "inspect runtime" });
  assert.match(scoutPrompt, /Scout pass/);
  assert.match(scoutPrompt, /Do not edit files/);
  assert.match(scoutPrompt, /plan\/read-only mode/);
  assert.match(scoutPrompt, /inspect runtime/);
  assert.match(scoutPrompt, /Severity, File, Issue, Why it matters, Suggested fix, Confidence, and Evidence/);

  const reviewPrompt = buildWorkerPrompt("reviewer", { ...task, options: { review: true, snapshotCurrent: true } });
  assert.match(reviewPrompt, /snapshot of the user's current uncommitted checkout/);
  assert.match(reviewPrompt, /Severity: high\|medium\|low/);
  assert.match(reviewPrompt, /Suggested fix:/);
  assert.match(reviewPrompt, /Confidence: high\|medium\|low/);

  const researchPrompt = buildWorkerPrompt("research-a", { ...task, options: { research: true, focus: "architecture" } });
  assert.match(researchPrompt, /Research pass/);
  assert.match(researchPrompt, /Do not edit files/);
  assert.match(researchPrompt, /Final answer only/);
  assert.match(researchPrompt, /Required output format/);
  assert.match(researchPrompt, /Requested focus: architecture/);
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

  const candidateA = stored.candidates.find((candidate) => candidate.workerLabel === "builder-a");
  const candidateB = stored.candidates.find((candidate) => candidate.workerLabel === "builder-b");
  assert.ok(candidateA.patchFile);
  assert.ok(candidateB.patchFile);
  assert.equal(candidateA.summary, "builder-a done");
  assert.doesNotMatch(stored.reviewer.notes, /reviewer progress/);
  assert.match(fs.readFileSync(candidateA.patchFile, "utf8"), /builder-a/);
  assert.match(fs.readFileSync(candidateB.patchFile, "utf8"), /new file mode/);
  assert.deepEqual(candidateA.changedFiles, ["src/app.txt"]);
  assert.deepEqual(candidateB.changedFiles, ["src/new.txt"]);

  for (const worker of stored.workers) {
    assert.ok(fs.existsSync(worker.worktree), `${worker.label} worktree should exist`);
    assert.ok(fs.existsSync(worker.transcript), `${worker.label} transcript should exist`);
  }

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 4);
  assert.equal(invocations.find((entry) => entry.workerLabel === "planner").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.workerLabel === "reviewer").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.workerLabel === "builder-a").args.includes("--mode=plan"), false);

  const resultText = renderResult(config, repo, task.taskId);
  assert.match(resultText, /Candidate: task_test-builder-a/);
  assert.match(resultText, /Apply: composer-swarm apply task_test --candidate task_test-builder-a/);
  assert.match(resultText, /Comparison:/);
  assert.match(resultText, /Recommended: task_test-builder-a/);
  assert.doesNotMatch(resultText, /You are a Composer worker/);
  assert.match(renderStatus(config, repo, task.taskId), /Status: completed/);
  assert.match(renderStatus(config, repo, task.taskId), /Next steps:/);

  const inspectText = renderInspect(config, repo, task.taskId);
  assert.match(inspectText, /State file: \.composer-swarm\/state\/tasks\/task_test\.json/);
  assert.match(inspectText, /composer-swarm logs task_test --worker planner/);
  assert.match(inspectText, /Candidate artifacts:/);
  assert.match(inspectText, /task_test-builder-a/);

  const logsList = renderLogs(config, repo, task.taskId);
  assert.match(logsList, /Available transcripts:/);
  assert.match(logsList, /builder-a: \.composer-swarm\/state\/transcripts\/task_test\/builder-a\.jsonl/);

  const builderLog = renderLogs(config, repo, task.taskId, { worker: "builder-a", tail: 20 });
  assert.match(builderLog, /Worker: builder-a/);
  assert.match(builderLog, /builder-a progress/);
  assert.match(builderLog, /builder-a done/);
});

test("workflow does not overwrite a cancellation after reviewer finishes", async () => {
  const repo = makeRepo();
  const taskId = "task_cancel_after_review";
  const fake = makeCancellingReviewerAgent(repo, taskId);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "cancel during review", { builders: 1, taskId });

  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.reviewer.status, "cancelled");
});

test("workflow retries the transient Cursor config rename race", async () => {
  const repo = makeRepo();
  const fake = makeRetryingCursorAgent();
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "retry cursor config race", {
    builders: 2,
    taskId: "task_retry_cursor_config"
  });

  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  const builderB = stored.workers.find((worker) => worker.label === "builder-b");
  const candidateB = stored.candidates.find((candidate) => candidate.workerLabel === "builder-b");
  assert.equal(stored.status, "completed");
  assert.equal(builderB.status, "completed");
  assert.ok(candidateB.patchFile);
  assert.match(fs.readFileSync(candidateB.patchFile, "utf8"), /builder-b retry/);
  assert.match(fs.readFileSync(builderB.transcript, "utf8"), /cursor-cli-config-race/);
});

test("review workflow can fan out to read-only scouts", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);

  const task = createReviewTask(config, repo, "repo", { scouts: 2, taskId: "task_review_scouts" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.options.review, true);
  assert.equal(stored.options.scouts, 2);
  assert.equal(stored.candidates.length, 0);
  assert.deepEqual(
    stored.scouts.map((scout) => scout.worker),
    ["scout-a", "scout-b"]
  );
  assert.match(stored.reviewer.notes, /Recommend builder-a/);

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 4);
  assert.equal(invocations.find((entry) => entry.workerLabel === "scout-a").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.workerLabel === "scout-b").args.includes("--mode=plan"), true);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /Review report:/);
  assert.match(resultText, /Scout notes:/);
  assert.match(resultText, /scout-a done/);
  assert.match(resultText, /not a reviewer of record/);
  assert.doesNotMatch(resultText, /No candidates have been collected/);
});

test("research workflow runs read-only workers without candidates or clean-checkout gating", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  fs.writeFileSync(path.join(repo, "src", "app.txt"), "dirty main checkout\n", "utf8");

  const task = createResearchTask(config, repo, "map config loading", {
    workers: 2,
    focus: "architecture",
    taskId: "task_research"
  });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.options.research, true);
  assert.equal(stored.options.focus, "architecture");
  assert.equal(stored.options.snapshotCurrent, true);
  assert.equal(stored.options.snapshotReason, "dirty-worktree");
  assert.equal(stored.candidates.length, 0);
  assert.equal(stored.reviewer, null);
  assert.deepEqual(
    stored.workers.map((worker) => worker.label),
    ["research-a", "research-b"]
  );
  assert.deepEqual(researchWorkerLabels(2), ["research-a", "research-b"]);
  assert.equal(stored.research.length, 2);

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 2);
  assert.equal(invocations.find((entry) => entry.workerLabel === "research-a").args.includes("--mode=plan"), true);
  assert.equal(invocations.find((entry) => entry.workerLabel === "research-b").args.includes("--mode=plan"), true);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /Research question: map config loading/);
  assert.match(resultText, /research pass A:/);
  assert.match(resultText, /Main agent guidance:/);
  assert.doesNotMatch(resultText, /research-a progress/);
  assert.doesNotMatch(resultText, /Candidate:/);
  assert.doesNotMatch(resultText, /Apply:/);
  assert.doesNotMatch(renderStatus(config, repo, task.taskId), /Verify:/);
  assert.equal(
    fs.readFileSync(path.join(stored.workers[0].worktree, "src", "app.txt"), "utf8"),
    "dirty main checkout\n"
  );
  assert.equal(fs.readFileSync(path.join(repo, "src", "app.txt"), "utf8"), "dirty main checkout\n");
});

test("research workflow times out idle workers and preserves completed notes", async () => {
  const repo = makeRepo();
  const fake = makeHangingResearchAgent();
  const config = configWithCursor(fake.scriptPath);
  config.swarm.workerIdleTimeoutMs = 1000;
  config.swarm.workerTimeoutKillGraceMs = 50;

  const task = createResearchTask(config, repo, "find stale docs", {
    workers: 2,
    taskId: "task_research_timeout"
  });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.research.length, 2);

  const completed = stored.research.find((entry) => entry.worker === "research-a");
  const timedOut = stored.research.find((entry) => entry.worker === "research-b");
  assert.equal(completed.status, "completed");
  assert.match(completed.notes, /research-a done/);
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error, /produced no output/);
  assert.match(timedOut.notes, /did not provide notes/);

  const timedOutWorker = stored.workers.find((worker) => worker.label === "research-b");
  assert.equal("pid" in timedOutWorker, false);
  assert.match(timedOutWorker.error, /produced no output/);
  assert.match(fs.readFileSync(timedOutWorker.transcript, "utf8"), /"type":"timeout"/);

  const statusText = renderStatus(config, repo, task.taskId);
  assert.match(statusText, /research-b: failed/);
  assert.match(statusText, /produced no output/);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /research pass A:/);
  assert.match(resultText, /research pass B:/);
  assert.match(resultText, /research-a done/);
  assert.match(resultText, /produced no output/);
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
  config.workers.verifier = { kind: "shell", command: "bash", args: ["-lc", "true"] };
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

test("createReviewTask can add read-only scout workers", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createReviewTask(config, repo, "tests", { taskId: "task_review", scouts: 2 });
  assert.equal(task.options.review, true);
  assert.equal(task.options.scouts, 2);
  assert.deepEqual(
    task.workers.map((worker) => worker.label),
    ["planner", "scout-a", "scout-b", "reviewer"]
  );
  assert.equal(task.workers.find((worker) => worker.label === "scout-a").canEdit, false);
  assert.throws(() => createReviewTask(config, repo, "tests", { scouts: 5 }), /requires 0 to 4 scouts/);
});

test("createResearchTask validates worker count", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createResearchTask(config, repo, "find release risks", { taskId: "task_research_shape", workers: 3 });
  assert.equal(task.options.research, true);
  assert.equal(task.options.workers, 3);
  assert.deepEqual(
    task.workers.map((worker) => worker.label),
    ["research-a", "research-b", "research-c"]
  );
  assert.equal(task.workers.some((worker) => worker.canEdit), false);
  assert.throws(() => createResearchTask(config, repo, "too many", { workers: 5 }), /requires 1 to 4 workers/);
});

test("createTeamTask rejects zero builders outside review mode", () => {
  const repo = makeRepo();
  assert.throws(() => createTeamTask(defaultConfig(), repo, "no builders", { builders: 0 }), /requires 1 to 4 builders/);
});

test("writeDefaultConfig --trust adds --trust to the Composer worker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-trust-"));
  const filePath = writeDefaultConfig(dir, { trust: true });
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal("agents" in config, false);
  assert.equal("defaultRoles" in config.swarm, false);
  assert.deepEqual(config.workers.composer.args, ["--trust"]);
});

test("writeDefaultConfig leaves verifier unset for the host agent to choose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-no-verifier-"));
  fs.writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version: 6.0\n", "utf8");

  const filePath = writeDefaultConfig(dir);
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal("verifier" in config.workers, false);
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
  config.workers.verifier = { kind: "shell", command: "bash", args: ["-lc", "npm test"] };
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
  const candidate = stored.candidates.find((entry) => entry.workerLabel === "builder-a");
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
      { candidateId: "t-builder-a", workerLabel: "builder-a", patchFile: "/a.patch", status: "completed" },
      { candidateId: "t-builder-b", workerLabel: "builder-b", patchFile: "/b.patch", status: "completed" }
    ],
    reviewer: { notes: "I recommend builder-a for this task." }
  };
  assert.equal(extractRecommendedCandidate(task), "t-builder-a");
});
