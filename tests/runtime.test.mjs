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
  cancelTask,
  cleanupTask,
  cleanupTasks,
  createResearchTask,
  createReviewTask,
  createTeamTask,
  defaultResearchWorkerCount,
  DEFAULT_CURSOR_MODEL,
  defaultConfig,
  EMPTY_TREE_SHA,
  extractRecommendedCandidate,
  findNestedGitRepos,
  formatCandidateComparison,
  formatPlan,
  loadConfig,
  loadTask,
  parseReviewFindings,
  planTask,
  parseResearchPlanAngles,
  parseResearchFindings,
  researchWorkerLabels,
  resolveResearchAngles,
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
  verifyCandidatesResult,
  writeDefaultConfig
} from "../src/runtime.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  assert.fail("Timed out waiting for condition.");
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

function makeUnbornRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-unborn-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
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

function makePartialBuilderFailureAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-partial-builders-"));
  const scriptPath = path.join(fakeDir, "fake-partial-builders.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
const prompt = args[args.length - 1];
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";

if (workerLabel === "builder-a") {
  fs.writeFileSync(path.join(workspace, "src", "app.txt"), "builder-a usable patch\\n", "utf8");
}

if (workerLabel === "builder-b") {
  console.log(JSON.stringify({ type: "final", text: "builder-b failed before producing a usable patch" }));
  process.exit(1);
}

console.log(JSON.stringify({ type: "final", text: workerLabel === "reviewer" ? "Recommend builder-a." : workerLabel + " done" }));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function makeChildSpawningAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-process-group-"));
  const scriptPath = path.join(fakeDir, "fake-process-group-agent.mjs");
  const childPidPath = path.join(fakeDir, "child.pid");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");
console.log(JSON.stringify({ type: "progress", text: "spawned child " + child.pid }));
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath, childPidPath };
}

function makeNoisyResearchAgent(lineCount = 40) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-noisy-"));
  const scriptPath = path.join(fakeDir, "fake-noisy-agent.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
for (let index = 0; index < ${Number(lineCount)}; index += 1) {
  console.log(JSON.stringify({ type: "progress", text: "progress " + index }));
}
console.log(JSON.stringify({ type: "final", text: "Noisy research done." }));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function makeToolPayloadReviewAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-tool-review-"));
  const scriptPath = path.join(fakeDir, "fake-tool-review-cursor-agent.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1);
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";

if (workerLabel === "reviewer") {
  console.log(JSON.stringify({
    type: "tool_call",
    name: "CreatePlan",
    input: {
      findings: [
        {
          severity: "high",
          file: "src/app.txt:1",
          issue: "Missing required locator validation.",
          why_it_matters: "Invalid locator input reaches the update path.",
          suggested_fix: "Validate locator fields before applying website updates.",
          confidence: "medium",
          verification: "source_read",
          evidence: "src/app.txt:1"
        }
      ]
    }
  }));
  console.log(JSON.stringify({ type: "final", text: "Review complete." }));
} else {
  console.log(JSON.stringify({ type: "final", text: workerLabel + " done" }));
}
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

function makeStructuredResearchAgent() {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-research-findings-"));
  const scriptPath = path.join(fakeDir, "fake-structured-research-cursor-agent.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1);
const workerLabel = /Worker label: ([^\\n]+)/.exec(prompt)?.[1] ?? "unknown";
const angle = /Assigned research angle: ([^\\n.]+)/.exec(prompt)?.[1] ?? "unknown angle";

console.log(JSON.stringify({
  type: "final",
  text: [
    "Research question: map risky behavior",
    "Angle: " + angle,
    "Confidence: medium",
    "",
    "Findings:",
    "- Finding: " + workerLabel + " found a risky behavior path.",
    "  Evidence: src/app.txt:1",
    "  Why it matters: the host model should inspect this path before deciding.",
    "  Verification: source_read",
    "  Follow-up: confirm whether the path is reachable in the main checkout.",
    "",
    "Open questions:",
    "- none",
    "",
    "Suggested next actions:",
    "- inspect src/app.txt"
  ].join("\\n")
}));
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath };
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

test("loadConfig reports corrupt config JSON with the file path", () => {
  const repo = makeRepo();
  const configDir = path.join(repo, ".composer-swarm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{ bad json", "utf8");

  assert.throws(
    () => loadConfig(repo),
    (error) => {
      assert.match(error.message, /Invalid composer-swarm config JSON/);
      assert.match(error.message, /config\.json/);
      return true;
    }
  );
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
  assert.match(builderPrompt, /independent candidate attempt/);
  assert.match(builderPrompt, /state the tradeoff/);

  const reviewerPrompt = buildWorkerPrompt("reviewer", task, { candidateText: "Candidate A patch" });
  assert.match(reviewerPrompt, /Candidate A patch/);
  assert.match(reviewerPrompt, /Separate verified defects from preferences/);
  assert.match(reviewerPrompt, /supporting signal for the host/);
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
  assert.match(scoutPrompt, /Severity, File, Issue, Why it matters, Suggested fix, Confidence, Verification, and Evidence/);

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
  assert.match(researchPrompt, /Assigned research angle: choose a distinct angle/);
});

test("implementation teams reject dirty tracked checkouts but allow the host plan file", () => {
  const repo = makeRepo();
  const config = defaultConfig();

  fs.writeFileSync(path.join(repo, "src", "app.txt"), "dirty tracked\n", "utf8");
  assert.throws(
    () => createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_dirty_team" }),
    /Main checkout has changes/
  );

  git(repo, ["checkout", "--", "src/app.txt"]);
  fs.mkdirSync(path.join(repo, "plans"), { recursive: true });
  fs.writeFileSync(path.join(repo, "plans", "implementation.md"), "# Host plan\n\n- Change app text\n", "utf8");
  const task = createTeamTask(config, repo, "change the app", {
    builders: 1,
    taskId: "task_host_plan_dirty_file",
    implementationPlan: "# Host plan\n\n- Change app text\n",
    implementationPlanFile: "plans/implementation.md"
  });
  assert.equal(task.options.implementationPlanFile, "plans/implementation.md");

  const spacedRepo = makeRepo();
  fs.writeFileSync(path.join(spacedRepo, "my plan.md"), "# Host plan\n\n- Change app text\n", "utf8");
  const spacedTask = createTeamTask(config, spacedRepo, "change the app", {
    builders: 1,
    taskId: "task_host_plan_spaced_file",
    implementationPlan: "# Host plan\n\n- Change app text\n",
    implementationPlanFile: "my plan.md"
  });
  assert.equal(spacedTask.options.implementationPlanFile, "my plan.md");
});

test("task creation injects shared repo context before worker-specific prompt text", () => {
  const repo = makeRepo();
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "context-fixture", scripts: { test: "node --test" } }, null, 2),
    "utf8"
  );
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "-q", "-m", "package"]);
  const config = defaultConfig();

  const task = createResearchTask(config, repo, "map prompt-friendly context", {
    taskId: "task_repo_context",
    angles: "entry points,data flow"
  });

  assert.equal(task.repoContext.schema, "composer-swarm.repo-context.v1");
  assert.match(task.repoContext.key, /^repo-context-/);
  assert.equal("path" in task.repoContext, false);
  assert.equal("snapshotHash" in task.repoContext, false);
  assert.match(task.repoContext.text, /Package metadata:/);
  assert.match(task.repoContext.text, /name: context-fixture/);
  assert.match(task.repoContext.text, /src\/app\.txt/);

  const promptA = buildWorkerPrompt("research-a", task);
  const promptB = buildWorkerPrompt("research-b", task);
  const sharedIndex = promptA.indexOf("Shared repo context:");
  const taskMetadataIndex = promptA.indexOf("Task metadata:");
  const assignmentIndex = promptA.indexOf("Worker assignment:");
  assert.ok(sharedIndex > 0);
  assert.ok(taskMetadataIndex > sharedIndex);
  assert.ok(assignmentIndex > sharedIndex);
  assert.equal(promptA.slice(0, assignmentIndex), promptB.slice(0, assignmentIndex));
  assert.match(promptA, /Worker label: research-a/);
  assert.match(promptB, /Worker label: research-b/);

  const secondTask = createResearchTask(config, repo, "different question, same repo prefix", {
    taskId: "task_repo_context_second",
    workers: 1
  });
  const secondPrompt = buildWorkerPrompt("research-a", secondTask);
  assert.equal(promptA.slice(0, taskMetadataIndex), secondPrompt.slice(0, secondPrompt.indexOf("Task metadata:")));

  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.repoContext.key, task.repoContext.key);
  assert.equal("text" in json.repoContext, false);
  assert.match(renderStatus(config, repo, task.taskId), /Repo context: \d+ files, \d+ bytes/);
});

test("shared repo context records dirty checkout status without hashing files", () => {
  const repo = makeRepo();
  const config = defaultConfig();

  fs.writeFileSync(path.join(repo, "src", "app.txt"), "dirty context\n", "utf8");
  const dirtyTask = createResearchTask(config, repo, "inspect dirty context", {
    taskId: "task_context_dirty",
    workers: 1
  });

  assert.match(dirtyTask.repoContext.text, /Current checkout status:/);
  assert.match(dirtyTask.repoContext.text, /src\/app\.txt/);
  assert.equal("snapshotHash" in dirtyTask.repoContext, false);
  assert.equal("path" in dirtyTask.repoContext, false);
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
  const statusJson = JSON.parse(renderStatus(config, repo, task.taskId, { json: true }));
  assert.equal(statusJson.schema, "composer-swarm.status.v1");
  assert.equal(statusJson.task.taskId, task.taskId);
  assert.equal(statusJson.task.mode, "team");
  assert.equal(statusJson.task.status, "completed");
  assert.equal(statusJson.task.workerStatusCounts.completed, 4);
  assert.equal(statusJson.task.candidateSummary.total, 2);
  assert.match(statusJson.task.guidance.join("\n"), /composer-swarm verify task_test/);

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

test("team workflow is partial when one builder fails but another produced a usable candidate", async () => {
  const repo = makeRepo();
  const fake = makePartialBuilderFailureAgent();
  const config = configWithCursor(fake.scriptPath);
  config.workers.verifier = { kind: "shell", command: "bash", args: ["-lc", "true"] };

  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_partial_team" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "partial");
  assert.equal(stored.candidates.length, 2);
  assert.equal(stored.candidates.find((candidate) => candidate.workerLabel === "builder-a").status, "completed");
  assert.equal(stored.candidates.find((candidate) => candidate.workerLabel === "builder-b").status, "failed");

  const statusJson = JSON.parse(renderStatus(config, repo, task.taskId, { json: true }));
  assert.equal(statusJson.task.status, "partial");
  assert.equal(statusJson.task.candidateSummary.completed, 1);
  assert.equal(statusJson.task.candidateSummary.failed, 1);
  assert.match(statusJson.task.guidance.join("\n"), /composer-swarm verify task_partial_team/);

  const verify = verifyCandidatesResult(config, repo, task.taskId);
  assert.equal(verify.failed, true);
  assert.deepEqual(verify.skipped, [
    { candidateId: "task_partial_team-builder-b", reason: "candidate status failed" }
  ]);
  assert.match(verify.output, /Verified task_partial_team-builder-a/);
  assert.match(verify.output, /Skipped task_partial_team-builder-b: candidate status failed/);
});

test("workflow recreates stale worker worktrees before launch", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_stale_worker_worktree" });
  const staleWorktree = path.join(repo, ".composer-swarm", "state", "worktrees", task.taskId, "builder-a");
  fs.mkdirSync(staleWorktree, { recursive: true });
  fs.writeFileSync(path.join(staleWorktree, "stale.txt"), "stale\n", "utf8");

  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  const builderWorktree = stored.workers.find((worker) => worker.label === "builder-a").worktree;
  assert.equal(fs.existsSync(path.join(builderWorktree, "stale.txt")), false);
  assert.equal(fs.readFileSync(path.join(builderWorktree, "src", "app.txt"), "utf8"), "builder-a\n");
});

test("implementation teams can execute a host-authored plan without a Composer planner", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const planText = [
    "# Checkout fix",
    "",
    "Objective: change the app",
    "",
    "- Edit src/app.txt with the smallest compatible change.",
    "- Keep the patch limited to the requested behavior.",
    "- Report checks and residual risk."
  ].join("\n");

  const task = createTeamTask(config, repo, "change the app", {
    builders: 2,
    implementationPlan: planText,
    implementationPlanFile: "plans/checkout.md",
    taskId: "task_host_plan_team"
  });
  assert.deepEqual(
    task.workers.map((worker) => worker.label),
    ["builder-a", "builder-b", "reviewer"]
  );
  assert.equal(task.options.implementationPlanFile, "plans/checkout.md");

  await runTaskWorkflow(config, repo, task.taskId);
  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.planner.worker, "host");
  assert.equal(stored.planner.status, "provided");
  assert.equal(stored.planner.file, "plans/checkout.md");

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 3);
  assert.equal(invocations.some((entry) => entry.workerLabel === "planner"), false);
  const builderPrompt = invocations.find((entry) => entry.workerLabel === "builder-a").args.at(-1);
  assert.match(builderPrompt, /Host-authored implementation plan \(plans\/checkout\.md\):/);
  assert.match(builderPrompt, /Edit src\/app\.txt/);
  assert.match(builderPrompt, /Use the host-authored implementation plan above/);
  assert.equal(invocations.find((entry) => entry.workerLabel === "builder-a").args.includes("--mode=plan"), false);
  assert.equal(invocations.find((entry) => entry.workerLabel === "reviewer").args.includes("--mode=plan"), true);

  const statusText = renderStatus(config, repo, task.taskId);
  assert.match(statusText, /Implementation plan: plans\/checkout\.md/);
  const resultText = renderResult(config, repo, task.taskId);
  assert.match(resultText, /Implementation plan: plans\/checkout\.md/);
  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.implementationPlanFile, "plans/checkout.md");
  assert.equal(json.planner.worker, "host");
  assert.equal(json.planner.status, "provided");
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

test("review workflow supports unborn HEAD repositories with untracked snapshots", async () => {
  const repo = makeUnbornRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "prototype.js"), "export const value = 1;\n", "utf8");

  const task = createReviewTask(config, repo, "repo", {
    taskId: "task_unborn_review",
    includeUntracked: true
  });
  const staleWorktree = path.join(repo, ".composer-swarm", "state", "worktrees", task.taskId, "reviewer");
  fs.mkdirSync(staleWorktree, { recursive: true });
  fs.writeFileSync(path.join(staleWorktree, "stale.txt"), "stale\n", "utf8");
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.baseSha, EMPTY_TREE_SHA);
  assert.equal(stored.baseIsEmptyTree, true);
  assert.equal(stored.options.syntheticBase, true);
  assert.equal(stored.options.snapshotReason, "unborn-head");
  assert.equal(stored.status, "completed");
  assert.equal(
    fs.readFileSync(path.join(stored.workers[0].worktree, "src", "prototype.js"), "utf8"),
    "export const value = 1;\n"
  );
  assert.equal(fs.existsSync(path.join(stored.workers[0].worktree, "stale.txt")), false);
});

test("snapshot current skips symlinks that escape the repository", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-swarm-outside-"));
  const outsideFile = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outsideFile, "outside\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "local.txt"), "inside\n", "utf8");
  fs.symlinkSync("local.txt", path.join(repo, "src", "inside-link.txt"));
  fs.symlinkSync(outsideFile, path.join(repo, "src", "outside-link.txt"));

  const task = createReviewTask(config, repo, "repo", {
    taskId: "task_snapshot_symlink",
    includeUntracked: true
  });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  const reviewerWorktree = stored.workers.find((worker) => worker.label === "reviewer").worktree;
  const insideLink = path.join(reviewerWorktree, "src", "inside-link.txt");
  const outsideLink = path.join(reviewerWorktree, "src", "outside-link.txt");
  assert.equal(fs.lstatSync(insideLink).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(insideLink), "local.txt");
  assert.equal(fs.existsSync(outsideLink), false);
});

test("review result extracts structured findings from worker tool payloads", async () => {
  const repo = makeRepo();
  const fake = makeToolPayloadReviewAgent();
  const config = configWithCursor(fake.scriptPath);

  const task = createReviewTask(config, repo, "repo", { taskId: "task_tool_payload_review" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.reviewer.notes, "Review complete.");

  const findingsText = renderResult(config, repo, task.taskId, { findings: true });
  assert.match(findingsText, /high src\/app\.txt:1 Missing required locator validation/);
  assert.match(findingsText, /tier=source/);
  assert.match(findingsText, /source_read/);

  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.mode, "review");
  assert.equal(json.findings[0].severity, "high");
  assert.equal(json.findings[0].file, "src/app.txt");
  assert.equal(json.findings[0].line, 1);
  assert.equal(json.findings[0].claim, "Missing required locator validation.");
  assert.equal(json.findings[0].verified_by_worker, true);
  assert.equal(json.findings[0].verification_tier, "source");
  assert.equal(json.synthesis.role.mainModelReviewerOfRecord, true);
  assert.deepEqual(json.synthesis.verificationSummary, {
    totalFindings: 1,
    executed: 0,
    source: 1,
    declared: 0,
    unverified: 0,
    signals: { source_read: 1 }
  });
  assert.deepEqual(json.synthesis.workerCoverage[0], {
    worker: "reviewer",
    status: "completed",
    angle: null,
    recovered: false,
    findings: 1,
    executed: 0,
    source: 1,
    declared: 0,
    unverified: 0
  });
  assert.match(json.synthesis.hostFollowUpChecks[0], /No parsed finding reports tests_run/);

  const synthesisText = renderResult(config, repo, task.taskId, { synthesis: true });
  assert.match(synthesisText, /Host synthesis brief/);
  assert.match(synthesisText, /Mode: review/);
  assert.match(synthesisText, /reviewer: completed; findings=1; executed=0; source=1; declared=0; unverified=0/);
  assert.match(synthesisText, /Main model remains reviewer of record/);
  assert.match(synthesisText, /No parsed finding reports tests_run or command_run/);
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

test("research workflow assigns explicit angles for wider host-model coverage", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);

  const task = createResearchTask(config, repo, "find risky behavior", {
    pack: "bugs",
    taskId: "task_research_angles"
  });
  assert.equal(task.options.workers, 4);
  assert.equal(task.options.researchPack, "bugs");
  assert.equal(task.options.researchAngles.length, 4);
  assert.match(task.options.researchAngles[0], /input-validation/);
  assert.equal(defaultResearchWorkerCount({ pack: "bugs" }), 4);
  assert.deepEqual(resolveResearchAngles({ angles: "api,tests", workers: 2 }), ["api", "tests"]);

  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.deepEqual(
    stored.research.map((entry) => entry.angle),
    stored.options.researchAngles
  );

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  const firstPrompt = invocations.find((entry) => entry.workerLabel === "research-a").args.at(-1);
  assert.match(firstPrompt, /Assigned research angle: input-validation/);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /Pack: bugs/);
  assert.match(resultText, /Angle: input-validation/);

  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.mode, "research");
  assert.equal(json.researchPack, "bugs");
  assert.equal(json.research[0].angle, stored.options.researchAngles[0]);
});

test("research workflow can use a host-authored plan as worker decomposition", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const planText = [
    "# Auth flow investigation",
    "",
    "- entry points: find every command and API entry",
    "- data flow: trace token shape and storage",
    "- tests: inspect assertions and missing cases"
  ].join("\n");

  assert.deepEqual(parseResearchPlanAngles(planText), [
    "entry points: find every command and API entry",
    "data flow: trace token shape and storage",
    "tests: inspect assertions and missing cases"
  ]);

  const task = createResearchTask(config, repo, "Auth flow investigation", {
    researchPlan: planText,
    researchPlanFile: "plans/auth.md",
    taskId: "task_research_plan"
  });
  assert.equal(task.options.workers, 3);
  assert.equal(task.options.researchPlanFile, "plans/auth.md");
  assert.equal(task.options.researchAngles[1], "data flow: trace token shape and storage");

  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  assert.deepEqual(
    stored.research.map((entry) => entry.angle),
    stored.options.researchAngles
  );

  const invocations = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line));
  const prompt = invocations.find((entry) => entry.workerLabel === "research-b").args.at(-1);
  assert.match(prompt, /Host-authored research plan:/);
  assert.match(prompt, /Assigned research angle: data flow/);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /Plan: plans\/auth\.md/);
  const statusText = renderStatus(config, repo, task.taskId);
  assert.match(statusText, /Research plan: plans\/auth\.md/);
});

test("research findings are parsed for host-model synthesis", async () => {
  const repo = makeRepo();
  const fake = makeStructuredResearchAgent();
  const config = configWithCursor(fake.scriptPath);

  const task = createResearchTask(config, repo, "map risky behavior", {
    angles: "entry points,data flow",
    taskId: "task_research_findings"
  });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  const parsed = parseResearchFindings(stored.research[0].notes, {
    sourceWorker: stored.research[0].worker,
    angle: stored.research[0].angle
  });
  assert.equal(parsed[0].claim, "research-a found a risky behavior path.");
  assert.equal(parsed[0].evidence, "src/app.txt:1");
  assert.equal(parsed[0].verification, "source_read");
  assert.equal(parsed[0].verified_by_worker, true);
  assert.equal(parsed[0].verification_tier, "source");
  assert.equal(parsed[0].source_worker, "research-a");
  assert.match(parsed[0].angle, /entry points/);
  const genericVerified = parseResearchFindings([
    "- Finding: generic verification should not become source tier.",
    "  Evidence: read src/app.txt manually",
    "  Verification: verified"
  ].join("\n"));
  assert.equal(genericVerified[0].verified_by_worker, true);
  assert.equal(genericVerified[0].verification_tier, "declared");
  const genericRead = parseResearchFindings([
    "- Finding: generic read should stay unverified.",
    "  Evidence: read src/app.txt manually",
    "  Verification: read"
  ].join("\n"));
  assert.equal(genericRead[0].verified_by_worker, false);
  assert.equal(genericRead[0].verification_tier, "unverified");

  const findingsText = renderResult(config, repo, task.taskId, { findings: true });
  assert.match(findingsText, /research \(no file\) research-a found a risky behavior path/);
  assert.match(findingsText, /tier=source/);
  assert.match(findingsText, /Follow-up: confirm whether the path is reachable/);

  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.mode, "research");
  assert.equal(json.findings.length, 2);
  assert.equal(json.findings[0].claim, "research-a found a risky behavior path.");
  assert.equal(json.findings[0].source_worker, "research-a");
  assert.equal(json.findings[0].verified_by_worker, true);
  assert.equal(json.findings[0].verification_tier, "source");
  assert.equal(json.synthesis.role.mainModelReviewerOfRecord, true);
  assert.deepEqual(json.synthesis.verificationSummary, {
    totalFindings: 2,
    executed: 0,
    source: 2,
    declared: 0,
    unverified: 0,
    signals: { source_read: 2 }
  });
  assert.equal(json.synthesis.workerCoverage.length, 2);
  assert.equal(json.synthesis.workerCoverage[0].worker, "research-a");
  assert.equal(json.synthesis.workerCoverage[0].angle, "entry points");
  assert.equal(json.synthesis.workerCoverage[0].findings, 1);
  assert.match(json.synthesis.hostFollowUpChecks[0], /No parsed finding reports tests_run/);

  const synthesisText = renderResult(config, repo, task.taskId, { synthesis: true });
  assert.match(synthesisText, /Host synthesis brief/);
  assert.match(synthesisText, /Mode: research/);
  assert.match(synthesisText, /research-a: completed; angle=entry points; findings=1; executed=0; source=1; declared=0; unverified=0/);
  assert.match(synthesisText, /Source\/docs read only: 2/);
  assert.match(synthesisText, /No parsed finding reports tests_run or command_run/);
});

test("structured finding parsers preserve continuation lines", () => {
  const review = parseReviewFindings([
    "Severity: high",
    "File: src/app.txt:12",
    "Issue: first part of the issue",
    "  continuation of the issue",
    "Evidence: src/app.txt:12",
    "  src/app.txt:13",
    "Why it matters: first impact line",
    "  second impact line",
    "Suggested fix: validate input",
    "  before writing state",
    "Verification: source_read",
    "Open questions:",
    "- this should not attach to verification"
  ].join("\n"));
  assert.equal(review.length, 1);
  assert.equal(review[0].claim, "first part of the issue\ncontinuation of the issue");
  assert.equal(review[0].evidence, "src/app.txt:12\nsrc/app.txt:13");
  assert.equal(review[0].why_it_matters, "first impact line\nsecond impact line");
  assert.equal(review[0].suggested_fix, "validate input\nbefore writing state");
  assert.equal(review[0].verification, "source_read");

  const research = parseResearchFindings([
    "- Finding: first part of the finding",
    "  continuation of the finding",
    "  Evidence: src/app.txt:20",
    "    src/app.txt:21",
    "  Why it matters: first research impact",
    "    second research impact",
    "  Follow-up: inspect the path",
    "    then run the focused test",
    "  Verification: source_read",
    "Open questions:",
    "- this should not attach to verification"
  ].join("\n"));
  assert.equal(research.length, 1);
  assert.equal(research[0].claim, "first part of the finding\ncontinuation of the finding");
  assert.equal(research[0].evidence, "src/app.txt:20\nsrc/app.txt:21");
  assert.equal(research[0].why_it_matters, "first research impact\nsecond research impact");
  assert.equal(research[0].follow_up, "inspect the path\nthen run the focused test");
  assert.equal(research[0].verification, "source_read");
});

test("review finding parser accepts common markdown report labels", () => {
  const bold = parseReviewFindings([
    "**ID:** SA-1",
    "**Severity:** High",
    "**File:** [`src/runtime.mjs`](src/runtime.mjs) L2205–2206",
    "**Issue:** Team status treats any worker failure as total failure.",
    "**Why it matters:** Hosts may skip usable candidates.",
    "**Suggested fix:** Report partial when at least one candidate completed.",
    "**Confidence:** High",
    "**Verification:** `source_read`",
    "**Evidence:** line 2206 sets failed when any worker failed."
  ].join("\n"));
  assert.equal(bold.length, 1);
  assert.equal(bold[0].severity, "high");
  assert.equal(bold[0].file, "src/runtime.mjs");
  assert.equal(bold[0].line, 2205);
  assert.equal(bold[0].claim, "Team status treats any worker failure as total failure.");
  assert.equal(bold[0].verification, "source_read");

  const table = parseReviewFindings([
    "| Field | Detail |",
    "|-------|--------|",
    "| **Severity** | Medium |",
    "| **File** | [`bin/composer-swarm.mjs`](bin/composer-swarm.mjs) L40–63 |",
    "| **Issue** | `usage()` omits `example-config`. |",
    "| **Why it matters** | Operators miss a useful bootstrap command. |",
    "| **Suggested fix** | Add it to usage output. |",
    "| **Confidence** | High |",
    "| **Verification** | `source_read` |",
    "| **Evidence** | Handler exists near the bottom of the CLI. |"
  ].join("\n"));
  assert.equal(table.length, 1);
  assert.equal(table[0].severity, "medium");
  assert.equal(table[0].file, "bin/composer-swarm.mjs");
  assert.equal(table[0].line, 40);
  assert.equal(table[0].claim, "`usage()` omits `example-config`.");
  assert.equal(table[0].verification, "source_read");
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
  assert.equal(stored.status, "partial");
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
  assert.match(statusText, /Status: partial/);
  assert.match(statusText, /research-b: failed/);
  assert.match(statusText, /produced no output/);

  const resultText = renderResult(config, repo, task.taskId, { verbose: true });
  assert.match(resultText, /research pass A:/);
  assert.match(resultText, /research pass B:/);
  assert.match(resultText, /research-a done/);
  assert.match(resultText, /produced no output/);
});

test("worker progress output does not rewrite task state for every stream line", async () => {
  const repo = makeRepo();
  const fake = makeNoisyResearchAgent(40);
  const config = configWithCursor(fake.scriptPath);
  const task = createResearchTask(config, repo, "collect noisy progress", {
    workers: 1,
    taskId: "task_noisy_progress"
  });

  const originalWriteFileSync = fs.writeFileSync;
  let taskStateWriteCount = 0;
  fs.writeFileSync = function patchedWriteFileSync(filePath, ...args) {
    if (new RegExp(`${task.taskId}\\.json\\.\\d+\\.\\d+\\.tmp$`).test(String(filePath))) {
      taskStateWriteCount += 1;
    }
    return originalWriteFileSync.call(this, filePath, ...args);
  };
  try {
    await runTaskWorkflow(config, repo, task.taskId);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  const stored = loadTask(config, repo, task.taskId);
  assert.equal(stored.status, "completed");
  assert.match(stored.research[0].notes, /Noisy research done/);
  const transcript = fs.readFileSync(stored.workers[0].transcript, "utf8");
  assert.equal((transcript.match(/"type":"worker-output"/g) ?? []).length, 41);
  assert.ok(taskStateWriteCount > 0, "expected to count task state temp writes");
  assert.ok(taskStateWriteCount < 12, `expected throttled task writes, got ${taskStateWriteCount}`);
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
  assert.throws(() => applyCandidate(config, repo, task.taskId, "builder-b"), /already applied candidate task_apply-builder-a/);
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

test("applyCandidate does not resolve partial candidate suffixes", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_candidate_match" });
  await runTaskWorkflow(config, repo, task.taskId);

  assert.throws(() => applyCandidate(config, repo, task.taskId, "a"), /Candidate not found/);
  assert.throws(() => applyCandidate(config, repo, task.taskId, "task_candidate_match-a"), /Candidate not found/);
});

test("applyCandidate --recommended rejects ambiguous reviewer recommendations", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_ambiguous_recommended" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  stored.recommendedCandidateId = null;
  stored.reviewer.notes = "I recommend builder-a and builder-b. Both are plausible winners.";
  saveTask(config, repo, stored);

  assert.throws(
    () => applyCandidate(config, repo, task.taskId, null, { recommended: true }),
    /Recommended candidate is ambiguous.*task_ambiguous_recommended-builder-a.*task_ambiguous_recommended-builder-b.*--candidate/
  );
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

test("applyCandidate rejects candidates that did not complete", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_failed_candidate" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  stored.candidates[0].status = "failed";
  saveTask(config, repo, stored);

  assert.throws(() => applyCandidate(config, repo, task.taskId, "builder-a"), /only completed candidates can be applied/);
});

test("applyCandidate rejects a clean checkout when HEAD moved from the task base", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_head_drift" });
  await runTaskWorkflow(config, repo, task.taskId);

  fs.writeFileSync(path.join(repo, "README.md"), "unrelated commit\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "advance head"]);

  assert.throws(() => applyCandidate(config, repo, task.taskId, "builder-a"), /HEAD changed since task task_head_drift was created/);
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
  const stored = loadTask(config, repo, task.taskId);
  stored.baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
  saveTask(config, repo, stored);

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

test("status recovers stale background tasks so cleanup can proceed", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_stale_background" });
  task.status = "running";
  task.backgroundPid = 99999999;
  task.workers[0].status = "running";
  task.workers[0].pid = 99999998;
  saveTask(config, repo, task);

  const statusText = renderStatus(config, repo, task.taskId);
  assert.match(statusText, /Status: failed/);
  assert.match(statusText, /Background process 99999999 is no longer running/);

  const recovered = loadTask(config, repo, task.taskId);
  assert.equal("backgroundPid" in recovered, false);
  assert.equal(recovered.workers[0].status, "failed");
  assert.equal("pid" in recovered.workers[0], false);

  const cleanup = cleanupTask(config, repo, task.taskId);
  assert.match(cleanup.lines.join("\n"), /Cleaned task_stale_background/);
});

test("bulk cleanup recovers stale background tasks before skipping running tasks", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_bulk_stale_background" });
  task.status = "running";
  task.backgroundPid = 99999999;
  task.workers[0].status = "running";
  task.workers[0].pid = 99999998;
  const worktree = path.join(repo, ".composer-swarm", "state", "worktrees", task.taskId, "builder-a");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, "stale.txt"), "stale\n", "utf8");
  task.workers[0].worktree = worktree;
  saveTask(config, repo, task);

  const cleanup = cleanupTasks(config, repo);
  assert.match(cleanup, /Cleaned task_bulk_stale_background/);
  assert.doesNotMatch(cleanup, /still running/);
  assert.equal(fs.existsSync(worktree), false);

  const recovered = loadTask(config, repo, task.taskId);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.workers[0].status, "failed");
  assert.equal("backgroundPid" in recovered, false);
  assert.equal("pid" in recovered.workers[0], false);
});

test("stale background recovery terminates recorded worker process groups", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  const fake = makeChildSpawningAgent();
  const config = configWithCursor(fake.scriptPath);
  const task = createResearchTask(config, repo, "spawn a child process", {
    workers: 1,
    taskId: "task_stale_recovery_process_group"
  });
  const workflow = runTaskWorkflow(config, repo, task.taskId);

  await waitFor(() => fs.existsSync(fake.childPidPath));
  const childPid = Number(fs.readFileSync(fake.childPidPath, "utf8"));
  assert.equal(processIsAlive(childPid), true);

  try {
    const running = loadTask(config, repo, task.taskId);
    assert.ok(running.workers[0].pid, "worker pid should be recorded while the worker is running");
    running.backgroundPid = 99999999;
    saveTask(config, repo, running);

    const statusText = renderStatus(config, repo, task.taskId);
    assert.match(statusText, /Status: failed/);
    assert.match(statusText, /Background process 99999999 is no longer running/);
    await waitFor(() => !processIsAlive(childPid));
    await workflow;

    const stored = loadTask(config, repo, task.taskId);
    assert.equal(stored.status, "failed");
    assert.equal(stored.workers[0].status, "failed");
    assert.equal("pid" in stored.workers[0], false);
  } finally {
    if (processIsAlive(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  }
});

test("cancelTask terminates worker process groups", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  const fake = makeChildSpawningAgent();
  const config = configWithCursor(fake.scriptPath);
  const task = createResearchTask(config, repo, "spawn a child process", { workers: 1, taskId: "task_cancel_process_group" });
  const workflow = runTaskWorkflow(config, repo, task.taskId);

  await waitFor(() => fs.existsSync(fake.childPidPath));
  const childPid = Number(fs.readFileSync(fake.childPidPath, "utf8"));
  assert.equal(processIsAlive(childPid), true);

  try {
    const cancelled = cancelTask(config, repo, task.taskId);
    assert.match(cancelled.lines.join("\n"), /Cancelled task_cancel_process_group/);
    await workflow;
    await waitFor(() => !processIsAlive(childPid));

    const stored = loadTask(config, repo, task.taskId);
    assert.equal(stored.status, "cancelled");
  } finally {
    if (processIsAlive(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  }
});

test("reviewObjective returns preset text and rejects unknown presets", () => {
  assert.match(reviewObjective("repo"), /comprehensive repository review/i);
  assert.match(reviewObjective("security"), /security-focused/i);
  assert.throws(() => reviewObjective("unknown"), /Unknown review preset/);
});

test("createReviewTask can add read-only scout workers", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const quickTask = createReviewTask(config, repo, "tests", { taskId: "task_review_quick", scouts: 0 });
  assert.deepEqual(
    quickTask.workers.map((worker) => worker.label),
    ["reviewer"]
  );

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

test("loadTask reports corrupt task JSON while task lists skip unreadable files", () => {
  const repo = makeRepo();
  const config = defaultConfig();
  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_valid_json" });
  const tasksDir = path.join(repo, ".composer-swarm", "state", "tasks");

  fs.writeFileSync(path.join(tasksDir, "task_bad_json.json"), "{ bad json", "utf8");
  const statusText = renderStatus(config, repo);
  assert.match(statusText, /task_valid_json/);
  assert.doesNotMatch(statusText, /task_bad_json/);
  const statusJson = JSON.parse(renderStatus(config, repo, null, { json: true }));
  assert.equal(statusJson.schema, "composer-swarm.status.v1");
  assert.deepEqual(statusJson.tasks.map((entry) => entry.taskId), ["task_valid_json"]);

  fs.writeFileSync(path.join(tasksDir, `${task.taskId}.json`), "{ bad json", "utf8");
  assert.throws(
    () => loadTask(config, repo, task.taskId),
    (error) => {
      assert.match(error.message, /Invalid composer-swarm task JSON/);
      assert.match(error.message, /task_valid_json\.json/);
      return true;
    }
  );
});

test("task ids are validated before using state paths", () => {
  const repo = makeRepo();
  const config = defaultConfig();

  assert.throws(
    () => createResearchTask(config, repo, "bad id", { taskId: "../evil", workers: 1 }),
    /Invalid task id/
  );
  assert.throws(() => renderStatus(config, repo, "../evil"), /Invalid task id/);

  const task = createResearchTask(config, repo, "valid id", { taskId: "task_safe_id", workers: 1 });
  const taskPath = path.join(repo, ".composer-swarm", "state", "tasks", `${task.taskId}.json`);
  const stored = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  stored.taskId = "../evil";
  fs.writeFileSync(taskPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  assert.throws(() => loadTask(config, repo, task.taskId), /Invalid task id/);
  assert.doesNotMatch(renderStatus(config, repo), /task_safe_id/);
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

test("verifyCandidate recreates stale baseline worktrees", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  config.workers.verifier = { kind: "shell", command: "bash", args: ["-lc", "true"] };

  const task = createTeamTask(config, repo, "change the app", { builders: 1, taskId: "task_verify_fresh_baseline" });
  await runTaskWorkflow(config, repo, task.taskId);

  verifyCandidate(config, repo, task.taskId, "builder-a");
  const baselineWorktree = path.join(repo, ".composer-swarm", "state", "worktrees", task.taskId, "__baseline__");
  const staleFile = path.join(baselineWorktree, "stale.txt");
  fs.writeFileSync(staleFile, "stale\n", "utf8");
  assert.equal(fs.existsSync(staleFile), true);

  verifyCandidate(config, repo, task.taskId, "builder-a");
  assert.equal(fs.existsSync(staleFile), false);
  assert.equal(fs.readFileSync(path.join(baselineWorktree, "src", "app.txt"), "utf8"), "base\n");
});

test("verifyCandidatesResult reports skipped candidates as failed aggregate verification", async () => {
  const repo = makeRepo();
  const fake = makeFakeCursorAgent(repo);
  const config = configWithCursor(fake.scriptPath);
  config.workers.verifier = { kind: "shell", command: "bash", args: ["-lc", "true"] };

  const task = createTeamTask(config, repo, "change the app", { builders: 2, taskId: "task_verify_skipped" });
  await runTaskWorkflow(config, repo, task.taskId);

  const stored = loadTask(config, repo, task.taskId);
  stored.candidates.find((candidate) => candidate.workerLabel === "builder-b").worktree = null;
  saveTask(config, repo, stored);

  const result = verifyCandidatesResult(config, repo, task.taskId);
  assert.equal(result.failed, true);
  assert.deepEqual(result.skipped, [{ candidateId: "task_verify_skipped-builder-b", reason: "no worktree" }]);
  assert.match(result.output, /Verified task_verify_skipped-builder-a/);
  assert.match(result.output, /Skipped task_verify_skipped-builder-b: no worktree/);
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

  const json = JSON.parse(renderResult(config, repo, task.taskId, { json: true }));
  assert.equal(json.reviewer.worker, "reviewer");
  assert.equal(json.reviewer.status, "completed");
  assert.match(json.reviewer.notes, /Recommend builder-a/);
  assert.match(json.reviewer.transcript, /reviewer\.jsonl$/);
  assert.deepEqual(json.candidateSummary, {
    total: 2,
    completed: 2,
    failed: 0,
    withPatch: 2,
    statusCounts: { completed: 2 },
    checks: {
      total: 0,
      passed: 0,
      failed: 0,
      baseline: 0,
      candidateSpecific: 0,
      unclassified: 0,
      uncheckedCandidates: 2
    },
    recommendedCandidateId: "task_compare-builder-a",
    ambiguousRecommendedCandidateIds: []
  });
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

test("extractRecommendedCandidate returns null for ambiguous reviewer notes", () => {
  const task = {
    candidates: [
      { candidateId: "t-builder-a", workerLabel: "builder-a", patchFile: "/a.patch", status: "completed" },
      { candidateId: "t-builder-b", workerLabel: "builder-b", patchFile: "/b.patch", status: "completed" }
    ],
    reviewer: { notes: "I recommend builder-a and builder-b; both are strong choices." }
  };
  assert.equal(extractRecommendedCandidate(task), null);
});
