import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const CONFIG_DIR = ".composer-swarm";
const CONFIG_FILE = "config.json";
const DEFAULT_STATE_DIR = ".composer-swarm/state";
const TASK_SCHEMA = "composer-swarm.task.v1";
const CANDIDATE_SCHEMA = "composer-swarm.candidate.v1";
const BUILDER_SUFFIXES = ["a", "b", "c", "d"];
const SCOUT_SUFFIXES = ["a", "b", "c", "d"];
const RESEARCH_SUFFIXES = ["a", "b", "c", "d"];
const CURSOR_CONFIG_RACE_RETRY_DELAY_MS = 750;
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_TIMEOUT_KILL_GRACE_MS = 2000;
export const DEFAULT_CURSOR_MODEL = "composer-2.5-fast";

export const REVIEW_PRESETS = {
  repo: [
    "Perform a comprehensive repository review.",
    "Inspect architecture, code quality, test coverage, documentation, and maintainability.",
    "Identify concrete defects, missing tests, security concerns, and technical debt.",
    "Prioritize actionable findings with file references and suggested fixes.",
    "Do not edit files; produce a structured review report."
  ].join(" "),
  security: [
    "Perform a security-focused repository review.",
    "Inspect authentication, authorization, input validation, secrets handling, dependency risks, and unsafe defaults.",
    "Identify concrete vulnerabilities and misconfigurations with file references.",
    "Prioritize by severity. Do not edit files; produce a structured security review report."
  ].join(" "),
  tests: [
    "Perform a test-quality and coverage review of this repository.",
    "Inspect test structure, coverage gaps, flaky patterns, and CI reliability.",
    "Identify missing tests for critical paths and suggest concrete test additions.",
    "Do not edit files; produce a structured test review report."
  ].join(" ")
};

export function defaultConfig() {
  return {
    version: 1,
    swarm: {
      name: "composer-swarm",
      stateDir: DEFAULT_STATE_DIR
    },
    distribution: {
      userPromise: "Add a team of Composer workers to the coding agent you already use.",
      primaryHosts: ["claude-code", "codex"],
      defaultWorkerKind: "cursor-cli",
      defaultWorkerModel: DEFAULT_CURSOR_MODEL
    },
    workers: {
      composer: {
        kind: "cursor-cli",
        command: "cursor-agent"
      },
      verifier: {
        kind: "shell",
        command: "bash",
        args: ["-lc", "npm test"]
      }
    }
  };
}

function configPath(workspaceRoot) {
  return path.join(workspaceRoot, CONFIG_DIR, CONFIG_FILE);
}

export function workspaceConfigFile(workspaceRoot) {
  return configPath(path.resolve(workspaceRoot));
}

function parentDir(dir) {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

export function findWorkspaceRoot(cwd) {
  let dir = path.resolve(cwd);
  while (dir) {
    if (fs.existsSync(configPath(dir))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = parentDir(dir);
  }
  return path.resolve(cwd);
}

export function writeDefaultConfig(cwd, options = {}) {
  const workspaceRoot = path.resolve(cwd);
  const dir = path.join(workspaceRoot, CONFIG_DIR);
  const filePath = configPath(workspaceRoot);
  if (fs.existsSync(filePath) && !options.force) {
    throw new Error(`${filePath} already exists. Use --force to overwrite it.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const config = defaultConfig();
  if (options.trust) {
    config.workers.composer = {
      ...config.workers.composer,
      args: [...new Set([...(config.workers.composer.args ?? []), "--trust"])]
    };
  }
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function loadConfig(cwd) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const filePath = configPath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return defaultConfig();
  }
  const base = defaultConfig();
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const { policies: _unusedPolicies, ...parsedConfig } = parsed;
  const config = {
    ...base,
    ...parsedConfig,
    swarm: {
      ...base.swarm,
      ...(parsed.swarm ?? {})
    },
    distribution: {
      ...base.distribution,
      ...(parsed.distribution ?? {})
    },
    workers: {
      ...base.workers,
      ...(parsed.workers ?? {})
    }
  };
  if (Array.isArray(parsed.agents)) {
    config.agents = parsed.agents;
  } else {
    delete config.agents;
  }
  delete config.swarm.defaultRoles;
  return config;
}

function commandAvailable(command) {
  if (!command) {
    return null;
  }
  if (command.includes(path.sep)) {
    return executable(command);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (executable(path.join(dir, command))) {
      return true;
    }
  }
  return false;
}

function executable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runDoctor(config) {
  const lines = [];
  let ok = true;
  lines.push(`Swarm: ${config.swarm?.name ?? "composer-swarm"}`);
  if (config.distribution?.userPromise) {
    lines.push(`Promise: ${config.distribution.userPromise}`);
  }
  const configuredModel = config.distribution?.defaultWorkerModel ?? DEFAULT_CURSOR_MODEL;
  if (configuredModel === DEFAULT_CURSOR_MODEL) {
    lines.push(`Cursor model: ${DEFAULT_CURSOR_MODEL}`);
  } else {
    ok = false;
    lines.push(`Cursor model: unsupported ${configuredModel}; expected ${DEFAULT_CURSOR_MODEL}`);
  }
  lines.push(`Node: ${process.version}`);

  const gitAvailable = commandAvailable("git");
  if (gitAvailable) {
    lines.push("- git: ok");
  } else {
    ok = false;
    lines.push("- git: missing command");
  }

  lines.push("Workers:");
  const composer = agentForWorker(config, "builder-a");
  const composerAvailable = commandAvailable(composer.command);
  if (composerAvailable) {
    const trustNote = (composer.args ?? []).includes("--trust") ? " [trust]" : "";
    lines.push(`- composer: ok (${composer.command})${trustNote}`);
  } else {
    ok = false;
    lines.push(`- composer: missing command (${composer.command})`);
  }

  const verifier = verifierAgent(config);
  if (!verifier) {
    lines.push("- verifier: not configured");
  } else {
    const verifierAvailable = commandAvailable(verifier.command);
    if (verifierAvailable) {
      lines.push(`- verifier: ok (${[verifier.command, ...(verifier.args ?? [])].join(" ")})`);
    } else {
      ok = false;
      lines.push(`- verifier: missing command (${verifier.command})`);
    }
  }

  return { ok, lines };
}

function agentForWorker(config, workerLabel) {
  const legacyExact = (config.agents ?? []).find((agent) => agent.role === workerLabel && agent.kind === "cursor-cli");
  if (legacyExact) {
    const { role: _legacyRole, ...agent } = legacyExact;
    return {
      ...agent,
      label: workerLabel,
      canEdit: workerLabel.startsWith("builder-")
    };
  }
  const worker = config.workers?.composer;
  if (worker?.command) {
    return {
      id: `${worker.id ?? "composer"}-${workerLabel}`,
      kind: worker.kind ?? "cursor-cli",
      label: workerLabel,
      command: worker.command,
      args: worker.args ?? [],
      canEdit: workerLabel.startsWith("builder-")
    };
  }
  const legacyAny = (config.agents ?? []).find((agent) => agent.kind === "cursor-cli" && agent.command);
  if (legacyAny) {
    const { role: _legacyRole, ...agent } = legacyAny;
    return {
      ...agent,
      id: `${legacyAny.id ?? "composer"}-${workerLabel}`,
      label: workerLabel,
      canEdit: workerLabel.startsWith("builder-")
    };
  }
  return fallbackCursorAgent(workerLabel);
}

function fallbackCursorAgent(workerLabel) {
  return {
    id: `composer-${workerLabel}`,
    kind: "cursor-cli",
    label: workerLabel,
    command: "cursor-agent",
    canEdit: workerLabel.startsWith("builder-")
  };
}

export function resolveCursorModel(config, requestedModel = null) {
  const configuredModel = config.distribution?.defaultWorkerModel ?? DEFAULT_CURSOR_MODEL;
  if (configuredModel !== DEFAULT_CURSOR_MODEL) {
    throw new Error(`Composer Swarm only supports Cursor model ${DEFAULT_CURSOR_MODEL}. Config requested ${configuredModel}.`);
  }
  if (requestedModel && requestedModel !== DEFAULT_CURSOR_MODEL) {
    throw new Error(`Composer Swarm only supports --model ${DEFAULT_CURSOR_MODEL}. Received --model ${requestedModel}.`);
  }
  return DEFAULT_CURSOR_MODEL;
}

export function planTask(config, taskText, options = {}) {
  const workerLabels = executionWorkerLabels(options);
  const workers = workerLabels.map((label) => ({
    label,
    canEdit: label.startsWith("builder-")
  }));
  return {
    schema: "composer-swarm.plan.v1",
    objective: taskText,
    workers
  };
}

export function formatPlan(plan) {
  const lines = [`Objective: ${plan.objective}`, "", "Worker passes:"];
  for (const entry of plan.workers ?? []) {
    const label = workerDisplayName(workerLabelFor(entry));
    const access = entry.canEdit ? "can edit" : "read-only";
    lines.push(`- ${label} (${access})`);
  }
  return lines.join("\n");
}

function workerDisplayName(label) {
  if (label === "planner") {
    return "planning pass";
  }
  if (label === "reviewer") {
    return "review pass";
  }
  if (label?.startsWith("builder-")) {
    return `implementation pass ${label.slice("builder-".length).toUpperCase()}`;
  }
  if (label?.startsWith("scout-")) {
    return `scout pass ${label.slice("scout-".length).toUpperCase()}`;
  }
  if (label?.startsWith("research-")) {
    return `research pass ${label.slice("research-".length).toUpperCase()}`;
  }
  return label ?? "worker";
}

export function stateRoot(config, workspaceRoot) {
  const configured = config.swarm?.stateDir ?? DEFAULT_STATE_DIR;
  return path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured);
}

function statePath(config, workspaceRoot, ...segments) {
  return path.join(stateRoot(config, workspaceRoot), ...segments);
}

function ensureStateDirs(config, workspaceRoot) {
  for (const dir of [
    stateRoot(config, workspaceRoot),
    statePath(config, workspaceRoot, "tasks"),
    statePath(config, workspaceRoot, "transcripts"),
    statePath(config, workspaceRoot, "artifacts"),
    statePath(config, workspaceRoot, "worktrees")
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function taskFile(config, workspaceRoot, taskId) {
  return statePath(config, workspaceRoot, "tasks", `${taskId}.json`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

export function createTaskId() {
  return `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function findGitRoot(cwd) {
  const result = spawnSync("git", ["-C", path.resolve(cwd), "rev-parse", "--show-toplevel"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export function findNestedGitRepos(cwd, options = {}) {
  const maxDepth = options.maxDepth ?? 3;
  const maxResults = options.maxResults ?? 10;
  const root = path.resolve(cwd);
  const found = [];

  function walk(dir, depth) {
    if (found.length >= maxResults || depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxResults) {
        return;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      const name = entry.name;
      if (name === ".git" || name === "node_modules" || name.startsWith(".")) {
        continue;
      }
      const child = path.join(dir, name);
      const gitRoot = findGitRoot(child);
      if (gitRoot) {
        found.push(gitRoot);
        continue;
      }
      walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return [...new Set(found)].sort();
}

export function resolveWorkspaceContext(cwd, options = {}) {
  const resolved = path.resolve(cwd);
  const workspaceRoot = findWorkspaceRoot(resolved);
  const gitRoot = findGitRoot(resolved);
  const config = loadConfig(workspaceRoot);

  if (gitRoot) {
    return { workspaceRoot, gitRoot, config, resolved, nearbyGitRepos: [] };
  }

  const nearbyGitRepos = findNestedGitRepos(resolved);
  if (options.requireGit === false) {
    return { workspaceRoot, gitRoot: null, config, resolved, nearbyGitRepos };
  }

  if (nearbyGitRepos.length) {
    const lines = [
      `Current directory is not inside a git repository: ${resolved}`,
      "",
      "Nearby git repositories:"
    ];
    for (const repo of nearbyGitRepos) {
      lines.push(`  cd ${repo}`);
    }
    lines.push("");
    lines.push("Run composer-swarm from a git repository root or use one of the paths above.");
    throw new Error(lines.join("\n"));
  }

  throw new Error(
    `Current directory is not inside a git repository: ${resolved}\nRun composer-swarm from a git repository root.`
  );
}

export function reviewObjective(preset = "repo") {
  const key = String(preset).toLowerCase();
  if (!REVIEW_PRESETS[key]) {
    const available = Object.keys(REVIEW_PRESETS).join(", ");
    throw new Error(`Unknown review preset: ${preset}. Available: ${available}`);
  }
  return REVIEW_PRESETS[key];
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 20
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function requireGitWorkspace(cwd) {
  try {
    const { gitRoot } = resolveWorkspaceContext(cwd);
    return gitRoot;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function trackedStatus(gitRoot) {
  const result = runGit(gitRoot, ["status", "--porcelain", "--untracked-files=no"]);
  return result.stdout.trim();
}

export function mainCheckoutStatus(gitRoot) {
  const result = runGit(gitRoot, ["status", "--porcelain"]);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !isRuntimeStateStatusLine(line))
    .join("\n")
    .trim();
}

function isRuntimeStateStatusLine(line) {
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.split(" -> ").pop();
  return filePath === ".composer-swarm/" || filePath?.startsWith(".composer-swarm/state/");
}

function statusHasUntracked(statusText) {
  return String(statusText ?? "")
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? "));
}

export function assertCleanMainCheckout(gitRoot) {
  const status = mainCheckoutStatus(gitRoot);
  if (status) {
    const untracked = statusHasUntracked(status);
    const lines = [
      `Main checkout has changes. Commit, stash, or remove them before continuing.`,
      untracked ? "Untracked files are present." : "Only tracked changes are present.",
      "",
      "Changed files:",
      status,
      "",
      "Read-only workflows can review the current dirty checkout safely:",
      "  composer-swarm review --preset repo --include-untracked",
      '  composer-swarm research "review current rewrite" --snapshot-current',
      "",
      "Implementation and apply workflows require a clean tracked checkout."
    ];
    throw new Error(lines.join("\n"));
  }
}

function gitHead(gitRoot) {
  return runGit(gitRoot, ["rev-parse", "HEAD"]).stdout.trim();
}

function gitBranch(gitRoot) {
  const result = runGit(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function builderWorkerLabels(count = 2) {
  const numeric = Number.isFinite(Number(count)) ? Number(count) : 2;
  if (numeric <= 0) {
    return [];
  }
  const bounded = Math.max(1, Math.min(BUILDER_SUFFIXES.length, Math.trunc(numeric)));
  return BUILDER_SUFFIXES.slice(0, bounded).map((suffix) => `builder-${suffix}`);
}

export function scoutWorkerLabels(count = 0) {
  const numeric = Number.isFinite(Number(count)) ? Number(count) : 0;
  if (numeric <= 0) {
    return [];
  }
  const bounded = Math.max(0, Math.min(SCOUT_SUFFIXES.length, Math.trunc(numeric)));
  return SCOUT_SUFFIXES.slice(0, bounded).map((suffix) => `scout-${suffix}`);
}

export function researchWorkerLabels(count = 2) {
  const numeric = Number.isFinite(Number(count)) ? Number(count) : 2;
  if (numeric <= 0) {
    return [];
  }
  const bounded = Math.max(1, Math.min(RESEARCH_SUFFIXES.length, Math.trunc(numeric)));
  return RESEARCH_SUFFIXES.slice(0, bounded).map((suffix) => `research-${suffix}`);
}

function executionWorkerLabels(options = {}) {
  if (options.research) {
    return researchWorkerLabels(options.workers ?? 2);
  }
  if (options.review) {
    return ["planner", ...scoutWorkerLabels(options.scouts ?? 0), "reviewer"];
  }
  return ["planner", ...builderWorkerLabels(options.builders ?? 2), "reviewer"];
}

export function createTeamTask(config, workspaceRoot, objective, options = {}) {
  const gitRoot = requireGitWorkspace(workspaceRoot);
  const isResearch = Boolean(options.research);
  const isReadOnlyTask = isResearch || Boolean(options.review);
  const checkoutStatus = mainCheckoutStatus(gitRoot);
  if (!isReadOnlyTask) {
    assertCleanMainCheckout(gitRoot);
  }
  ensureStateDirs(config, workspaceRoot);

  const taskId = options.taskId ?? createTaskId();
  const createdAt = new Date().toISOString();
  const requestedBuilders = isResearch ? 0 : options.builders ?? 2;
  const builderCount = isResearch ? 0 : builderWorkerLabels(requestedBuilders).length;
  const requestedScouts = options.scouts ?? 0;
  const scoutCount = scoutWorkerLabels(requestedScouts).length;
  const requestedResearchWorkers = options.workers ?? 2;
  const researchCount = isResearch ? researchWorkerLabels(requestedResearchWorkers).length : 0;
  if (isResearch && Number(requestedResearchWorkers) !== researchCount) {
    throw new Error("composer-swarm research requires 1 to 4 workers.");
  }
  if (!isResearch && !options.review && builderCount < 1) {
    throw new Error("composer-swarm team requires 1 to 4 builders.");
  }
  if (!isResearch && options.review && Number(requestedScouts) !== scoutCount) {
    throw new Error("composer-swarm review requires 0 to 4 scouts.");
  }
  const model = resolveCursorModel(config, options.model ?? null);
  const workerLabels = executionWorkerLabels(options);
  const snapshotRequested = Boolean(options.snapshotCurrent || options.includeUntracked);
  const snapshotCurrent = isReadOnlyTask && (snapshotRequested || Boolean(checkoutStatus));
  const task = {
    schema: TASK_SCHEMA,
    taskId,
    id: taskId,
    objective,
    status: options.background ? "queued" : "created",
    workspaceRoot: path.resolve(workspaceRoot),
    gitRoot,
    baseSha: gitHead(gitRoot),
    baseBranch: gitBranch(gitRoot),
    createdAt,
    updatedAt: createdAt,
    options: {
      builders: options.review || isResearch ? 0 : builderCount,
      scouts: options.review && !isResearch ? scoutCount : 0,
      workers: isResearch ? researchCount : undefined,
      model,
      background: Boolean(options.background),
      review: Boolean(options.review),
      research: isResearch,
      focus: isResearch ? options.focus ?? null : undefined,
      snapshotCurrent,
      snapshotIncludesUntracked: snapshotCurrent,
      snapshotReason: snapshotCurrent ? (checkoutStatus ? "dirty-worktree" : "requested") : null,
      snapshotStatus: snapshotCurrent && checkoutStatus ? checkoutStatus : undefined
    },
    workers: workerLabels.map((label) => {
      const agent = agentForWorker(config, label) ?? fallbackCursorAgent(label);
      return {
        label,
        agentId: agent.id,
        kind: agent.kind,
        command: agent.command,
        status: "pending",
        canEdit: Boolean(agent.canEdit)
      };
    }),
    candidates: [],
    reviewer: null
  };
  saveTask(config, workspaceRoot, task);
  return task;
}

export function saveTask(config, workspaceRoot, task) {
  task.updatedAt = new Date().toISOString();
  writeJsonAtomic(taskFile(config, workspaceRoot, task.taskId), task);
}

export function loadTask(config, workspaceRoot, taskId) {
  const filePath = taskFile(config, workspaceRoot, taskId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listTasks(config, workspaceRoot) {
  const tasksDir = statePath(config, workspaceRoot, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  return fs
    .readdirSync(tasksDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8")))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function latestTask(config, workspaceRoot) {
  return listTasks(config, workspaceRoot)[0] ?? null;
}

function workerLabelFor(entry) {
  return entry?.label ?? entry?.workerLabel ?? entry?.worker ?? entry?.role ?? null;
}

function candidateWorkerLabel(candidate) {
  return candidate?.workerLabel ?? candidate?.label ?? candidate?.worker ?? candidate?.role ?? null;
}

function workerForLabel(task, workerLabel) {
  const worker = task.workers.find((entry) => workerLabelFor(entry) === workerLabel);
  if (!worker) {
    throw new Error(`Task ${task.taskId} has no worker labeled ${workerLabel}`);
  }
  return worker;
}

function candidateIdFor(task, workerLabel) {
  return `${task.taskId}-${workerLabel}`;
}

function relativePath(workspaceRoot, filePath) {
  return path.relative(workspaceRoot, filePath) || ".";
}

function transcriptPath(config, workspaceRoot, taskId, workerLabel) {
  return statePath(config, workspaceRoot, "transcripts", taskId, `${workerLabel}.jsonl`);
}

function artifactPath(config, workspaceRoot, taskId, candidateId) {
  return statePath(config, workspaceRoot, "artifacts", taskId, `${candidateId}.patch`);
}

function safeRelativePath(relativeFilePath) {
  const normalized = path.normalize(relativeFilePath);
  return Boolean(
    normalized &&
    !path.isAbsolute(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${path.sep}`)
  );
}

function isRuntimeStatePath(relativeFilePath) {
  return relativeFilePath === ".composer-swarm/state" || relativeFilePath.startsWith(".composer-swarm/state/");
}

function copyUntrackedFileIntoSnapshot(gitRoot, worktree, relativeFilePath) {
  if (!safeRelativePath(relativeFilePath) || isRuntimeStatePath(relativeFilePath)) {
    return;
  }
  const source = path.join(gitRoot, relativeFilePath);
  const destination = path.join(worktree, relativeFilePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, dereference: false });
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination);
  }
}

function applyCurrentSnapshot(task, worktree) {
  const gitRoot = task.gitRoot;
  const diff = runGit(gitRoot, ["diff", "--binary", "HEAD"], {
    maxBuffer: 1024 * 1024 * 50
  }).stdout;
  if (diff.trim()) {
    runGit(worktree, ["apply", "--whitespace=nowarn", "--binary"], {
      input: diff,
      maxBuffer: 1024 * 1024 * 50
    });
  }

  if (task.options?.snapshotIncludesUntracked) {
    const untracked = runGit(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"], {
      maxBuffer: 1024 * 1024 * 20
    }).stdout;
    for (const relativeFilePath of untracked.split("\0").filter(Boolean)) {
      copyUntrackedFileIntoSnapshot(gitRoot, worktree, relativeFilePath);
    }
  }
}

function appendTranscript(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function createWorktree(config, workspaceRoot, task, workerLabel) {
  const worktree = statePath(config, workspaceRoot, "worktrees", task.taskId, workerLabel);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (fs.existsSync(worktree)) {
    return worktree;
  }
  runGit(task.gitRoot, ["worktree", "add", "--detach", worktree, task.baseSha]);
  if (task.options?.snapshotCurrent) {
    applyCurrentSnapshot(task, worktree);
  }
  return worktree;
}

export function buildCursorAgentArgs({ workerLabel, worktree, prompt, model }) {
  const args = ["--print", "--output-format", "stream-json", "--workspace", worktree];
  if (model) {
    args.push("--model", model);
  }
  if (
    workerLabel === "planner" ||
    workerLabel === "reviewer" ||
    workerLabel.startsWith("scout-") ||
    workerLabel.startsWith("research-")
  ) {
    args.push("--mode=plan");
  }
  args.push(prompt);
  return args;
}

export function buildWorkerPrompt(workerLabel, task, context = {}) {
  const plannerText = context.plannerOutput?.trim() || "No planner output is available yet.";
  const candidateText = context.candidateText?.trim() || "No candidates are available yet.";
  const scoutText = context.scoutText?.trim() || "No scout notes are available yet.";
  const isResearch = Boolean(task.options?.research);
  const base = [
    "You are a Composer worker launched by composer-swarm.",
    `Task id: ${task.taskId}`,
    `Worker label: ${workerLabel}`,
    `Objective: ${task.objective}`,
    `Base commit: ${task.baseSha ?? "unknown"}`,
    task.options?.snapshotCurrent
      ? "Workspace note: this isolated worktree includes a snapshot of the user's current uncommitted checkout, including untracked files where available."
      : null,
    "",
    "Rules:",
    "- Work only in the workspace passed to cursor-agent.",
    isResearch ? "- Do not edit files. Use plan/read-only mode for research only." : "- Keep changes narrowly scoped to the objective.",
    "- Prefer existing project patterns over new abstractions.",
    isResearch ? "- Back every important claim with file paths, line numbers, commands, or reproducible evidence." : "- Report exact checks you ran and their results.",
    isResearch ? "- Treat your output as leads for the host agent to verify, not as final authority." : "- End with a concise summary, changed files, risks, and follow-up notes."
  ].filter((line) => line !== null);

  if (workerLabel.startsWith("research-")) {
    return [
      ...base,
      "",
      "Research pass:",
      "Use Cursor's repository search and code-understanding tools aggressively.",
      researchFocus(task.options?.focus),
      "Independently choose a useful search angle and avoid broad summaries.",
      "The host agent is also doing its own investigation in parallel; return evidence it can reconcile.",
      "",
      "Required output format:",
      "Research question: <repeat the question>",
      "Confidence: high|medium|low",
      "",
      "Findings:",
      "- Finding: <specific claim>",
      "  Evidence: <path:line>, <path:line>, or command output",
      "  Why it matters: <short explanation>",
      "  Follow-up: <what the host should inspect or verify>",
      "",
      "Open questions:",
      "- <unknown or ambiguity, with where to inspect next>",
      "",
      "Suggested next actions:",
      "- <concrete inspection, command, or implementation next step>"
    ].join("\n");
  }

  if (workerLabel === "planner") {
    if (task.options?.review) {
      return [
        ...base,
        "",
        "Review planning pass:",
        "Define the repository areas the review pass should inspect.",
        "Identify likely risk hotspots, missing verification, and documentation gaps.",
        "Do not edit files."
      ].join("\n");
    }
    return [
      ...base,
      "",
      "Planning pass:",
      "Produce a scoped implementation plan for the implementation workers.",
      "Identify likely files, acceptance criteria, risks, and suggested checks.",
      "Do not edit files."
    ].join("\n");
  }

  if (workerLabel.startsWith("builder-")) {
    return [
      ...base,
      "",
      "Planner output:",
      plannerText,
      "",
      "Implementation pass:",
      "Implement one complete candidate patch in this isolated worktree.",
      "Leave the final diff in the worktree for composer-swarm to collect."
    ].join("\n");
  }

  if (workerLabel === "reviewer") {
    if (task.options?.review) {
      return [
        ...base,
        "",
        "Planner output:",
        plannerText,
        "",
        "Scout notes:",
        scoutText,
        "",
        "Repository review pass:",
        "Use the objective, planner context, and scout notes to review the repository.",
        "Do not edit files and do not expect candidate patches.",
        "Return findings in this exact structure:",
        "Severity: high|medium|low",
        "File: path:line",
        "Issue: <specific problem>",
        "Why it matters: <short rationale>",
        "Suggested fix: <concrete change>",
        "Evidence: <file path, line, command, or observation>",
        "Call out missing tests or verification gaps separately."
      ].join("\n");
    }
    return [
      ...base,
      "",
      "Planner output:",
      plannerText,
      "",
      "Candidate patches to review:",
      candidateText,
      "",
      "Patch review pass:",
      "Review the candidates for concrete bugs, regressions, conflicts, and missing tests.",
      "Do not apply or edit any candidate. Do not choose for the user; report objective findings."
    ].join("\n");
  }

  if (workerLabel.startsWith("scout-")) {
    return [
      ...base,
      "",
      "Planner output:",
      plannerText,
      "",
      "Scout pass:",
      "Do not edit files.",
      scoutFocus(),
      "Report concrete findings using Severity, File, Issue, Why it matters, Suggested fix, and Evidence.",
      "Prefer useful negative findings over broad summaries."
    ].join("\n");
  }

  return base.join("\n");
}

function scoutFocus() {
  return "Independently choose a useful inspection angle that adds coverage beyond the planning pass and other workers.";
}

function researchFocus(focus) {
  const requested = focus ? `Requested focus: ${focus}.` : "Requested focus: broad repository research.";
  return `${requested} Pick a distinct angle that adds useful coverage for the host agent.`;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textFromJson(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of ["text", "message", "summary", "content", "result", "output"]) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) {
      return found;
    }
  }
  if (value.delta && typeof value.delta === "string") {
    return value.delta;
  }
  if (value.message && typeof value.message === "object") {
    const nested = textFromJson(value.message);
    if (nested) {
      return nested;
    }
  }
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  return null;
}

function trimForSummary(text) {
  const compact = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}

function splitLines(bufferState, chunk) {
  bufferState.buffer += chunk;
  const lines = bufferState.buffer.split(/\r?\n/);
  bufferState.buffer = lines.pop() ?? "";
  return lines;
}

function finalizeBufferedLine(bufferState) {
  if (!bufferState.buffer) {
    return null;
  }
  const line = bufferState.buffer;
  bufferState.buffer = "";
  return line;
}

function cleanWorkerOutput(output, prompt) {
  const text = String(output ?? "").trim();
  const promptText = String(prompt ?? "").trim();
  if (promptText && text.startsWith(promptText)) {
    return text.slice(promptText.length).trim();
  }
  return text;
}

function configuredDurationMs(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function workerIdleTimeoutMs(config) {
  return configuredDurationMs(config.swarm?.workerIdleTimeoutMs, DEFAULT_WORKER_IDLE_TIMEOUT_MS);
}

function workerTimeoutKillGraceMs(config) {
  return configuredDurationMs(config.swarm?.workerTimeoutKillGraceMs, DEFAULT_WORKER_TIMEOUT_KILL_GRACE_MS);
}

function formatDuration(ms) {
  if (ms % 60000 === 0) {
    return `${ms / 60000}m`;
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

async function runCursorWorker(config, workspaceRoot, task, workerLabel, context = {}) {
  const worker = workerForLabel(task, workerLabel);
  const agent = agentForWorker(config, workerLabel) ?? fallbackCursorAgent(workerLabel);
  const worktree = createWorktree(config, workspaceRoot, task, workerLabel);
  const transcript = transcriptPath(config, workspaceRoot, task.taskId, workerLabel);
  const prompt = buildWorkerPrompt(workerLabel, task, context);
  const cursorArgs = buildCursorAgentArgs({
    workerLabel,
    worktree,
    prompt,
    model: task.options?.model ?? null
  });
  const args = [...(agent.args ?? []), ...cursorArgs];
  const idleTimeoutMs = workerIdleTimeoutMs(config);
  const timeoutKillGraceMs = workerTimeoutKillGraceMs(config);
  const startedAt = new Date().toISOString();

  Object.assign(worker, {
    status: "running",
    startedAt,
    worktree,
    transcript,
    command: agent.command,
    args: redactPromptArg(args)
  });
  saveTask(config, workspaceRoot, task);
  appendTranscript(transcript, {
    type: "started",
    taskId: task.taskId,
    worker: workerLabel,
    agentId: agent.id,
    command: agent.command,
    args: redactPromptArg(args)
  });

  return new Promise((resolve) => {
    const stdoutState = { buffer: "" };
    const stderrState = { buffer: "" };
    const outputParts = [];
    let child;
    let settled = false;
    let attempts = 0;
    let retryScheduled = false;
    let idleTimer = null;
    let forceKillTimer = null;
    let timeoutDetail = null;

    function clearTimer(timer) {
      if (timer) {
        clearTimeout(timer);
      }
    }

    function clearWorkerTimers() {
      clearTimer(idleTimer);
      clearTimer(forceKillTimer);
      idleTimer = null;
      forceKillTimer = null;
    }

    function scheduleIdleTimer() {
      clearTimer(idleTimer);
      if (!idleTimeoutMs || settled || retryScheduled) {
        idleTimer = null;
        return;
      }
      idleTimer = setTimeout(() => {
        handleIdleTimeout();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    }

    function workerTimeoutError() {
      const lastOutput = worker.lastOutputAt ?? "none";
      const started = worker.startedAt ?? "unknown";
      return `Worker ${workerLabel} produced no output for ${formatDuration(idleTimeoutMs)}. Last output: ${lastOutput}. Started: ${started}.`;
    }

    function saveWorkerProgress() {
      if (safeLoadTask(config, workspaceRoot, task.taskId)?.status === "cancelled") {
        task.status = "cancelled";
        return;
      }
      saveTask(config, workspaceRoot, task);
    }

    function handleIdleTimeout() {
      if (settled || retryScheduled) {
        return;
      }
      if (safeLoadTask(config, workspaceRoot, task.taskId)?.status === "cancelled") {
        task.status = "cancelled";
        return;
      }
      timeoutDetail = {
        error: workerTimeoutError(),
        timedOut: true
      };
      appendTranscript(transcript, {
        type: "timeout",
        taskId: task.taskId,
        worker: workerLabel,
        idleTimeoutMs,
        lastOutputAt: worker.lastOutputAt ?? null,
        error: timeoutDetail.error
      });
      Object.assign(worker, {
        status: "failed",
        error: timeoutDetail.error
      });
      saveTask(config, workspaceRoot, task);
      if (child?.pid) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have already exited.
        }
        forceKillTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have already exited.
          }
          finish("failed", { ...timeoutDetail, signal: "SIGKILL" });
        }, timeoutKillGraceMs);
        forceKillTimer.unref?.();
      } else {
        finish("failed", timeoutDetail);
      }
    }

    function recordLine(stream, line) {
      if (!line) {
        return;
      }
      worker.lastOutputAt = new Date().toISOString();
      const parsed = parseJsonLine(line);
      const text = parsed ? textFromJson(parsed) : line;
      if (text) {
        outputParts.push(text);
      }
      appendTranscript(transcript, {
        type: "worker-output",
        taskId: task.taskId,
        worker: workerLabel,
        stream,
        event: parsed,
        line: parsed ? undefined : line
      });
      saveWorkerProgress();
      scheduleIdleTimer();
    }

    function canRetryStartup(status) {
      if (status !== "failed" || attempts > 1) {
        return false;
      }
      return /ENOENT:.*cli-config\.json\.tmp.*cli-config\.json/.test(outputParts.join("\n"));
    }

    function flushBufferedLines() {
      for (const [stream, state] of [
        ["stdout", stdoutState],
        ["stderr", stderrState]
      ]) {
        const line = finalizeBufferedLine(state);
        if (line) {
          recordLine(stream, line);
        }
      }
    }

    function finish(status, detail = {}) {
      if (settled) {
        return;
      }
      flushBufferedLines();
      if (retryScheduled) {
        return;
      }
      if (!detail.timedOut && canRetryStartup(status)) {
        retryScheduled = true;
        clearWorkerTimers();
        outputParts.length = 0;
        delete worker.pid;
        delete worker.lastOutputAt;
        appendTranscript(transcript, {
          type: "retry",
          taskId: task.taskId,
          worker: workerLabel,
          reason: "cursor-cli-config-race",
          nextAttempt: attempts + 1
        });
        saveTask(config, workspaceRoot, task);
        setTimeout(() => {
          retryScheduled = false;
          startAttempt();
        }, CURSOR_CONFIG_RACE_RETRY_DELAY_MS);
        return;
      }
      settled = true;
      clearWorkerTimers();
      const finalOutput = cleanWorkerOutput(outputParts.join("\n"), prompt);
      const current = safeLoadTask(config, workspaceRoot, task.taskId);
      const cancelled = current?.status === "cancelled";
      if (cancelled) {
        task.status = "cancelled";
      }
      Object.assign(worker, {
        status: cancelled ? "cancelled" : status,
        completedAt: new Date().toISOString(),
        exitCode: detail.exitCode ?? null,
        signal: detail.signal ?? null,
        error: detail.error ?? null,
        finalOutput
      });
      delete worker.pid;
      appendTranscript(transcript, {
        type: worker.status,
        taskId: task.taskId,
        worker: workerLabel,
        exitCode: worker.exitCode,
        signal: worker.signal,
        error: worker.error
      });
      saveTask(config, workspaceRoot, task);
      resolve(worker);
    }

    function startAttempt() {
      attempts += 1;
      try {
        child = spawn(agent.command, args, {
          cwd: worktree,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        finish("failed", { error: error instanceof Error ? error.message : String(error) });
        return;
      }

      worker.pid = child.pid;
      saveTask(config, workspaceRoot, task);

      child.stdout.on("data", (chunk) => {
        for (const line of splitLines(stdoutState, chunk.toString("utf8"))) {
          recordLine("stdout", line);
        }
      });
      child.stderr.on("data", (chunk) => {
        for (const line of splitLines(stderrState, chunk.toString("utf8"))) {
          recordLine("stderr", line);
        }
      });
      child.on("error", (error) => {
        finish("failed", { error: error instanceof Error ? error.message : String(error) });
      });
      child.on("close", (exitCode, signal) => {
        if (timeoutDetail) {
          finish("failed", { ...timeoutDetail, exitCode, signal });
        } else {
          finish(exitCode === 0 ? "completed" : "failed", { exitCode, signal });
        }
      });
      scheduleIdleTimer();
    }

    startAttempt();
  });
}

function redactPromptArg(args) {
  if (!args.length) {
    return [];
  }
  return args.map((arg, index) => (index === args.length - 1 ? "<prompt>" : arg));
}

function safeLoadTask(config, workspaceRoot, taskId) {
  try {
    return loadTask(config, workspaceRoot, taskId);
  } catch {
    return null;
  }
}

function includeUntrackedInDiff(worktree) {
  runGit(worktree, ["add", "-N", "."], { allowFailure: true });
}

export function collectCandidatePatch(config, workspaceRoot, task, workerLabel) {
  const worker = workerForLabel(task, workerLabel);
  const worktree = worker.worktree;
  if (!worktree) {
    throw new Error(`Worker ${workerLabel} has no worktree.`);
  }

  includeUntrackedInDiff(worktree);
  const diff = runGit(worktree, ["diff", "--binary", "HEAD"], { maxBuffer: 1024 * 1024 * 50 }).stdout;
  const status = runGit(worktree, ["status", "--porcelain"]).stdout;
  const changedFiles = parseStatusFiles(status);
  const candidateId = candidateIdFor(task, workerLabel);
  let patchFile = null;
  if (diff.trim()) {
    patchFile = artifactPath(config, workspaceRoot, task.taskId, candidateId);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, diff, "utf8");
  }

  const candidate = {
    schema: CANDIDATE_SCHEMA,
    candidateId,
    workerLabel,
    status: worker.status,
    summary: trimForSummary(worker.finalOutput) || "(worker did not provide a summary)",
    risk: "unknown",
    patchFile,
    patchBytes: diff.length,
    changedFiles,
    worktree,
    transcript: worker.transcript,
    checks: [],
    exitCode: worker.exitCode ?? null,
    completedAt: new Date().toISOString()
  };
  const existingIndex = task.candidates.findIndex((entry) => entry.candidateId === candidateId);
  if (existingIndex === -1) {
    task.candidates.push(candidate);
  } else {
    task.candidates[existingIndex] = candidate;
  }
  saveTask(config, workspaceRoot, task);
  return candidate;
}

function parseStatusFiles(statusText) {
  const files = [];
  for (const line of statusText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const raw = line.slice(3).trim();
    const renameParts = raw.split(" -> ");
    files.push(renameParts[renameParts.length - 1]);
  }
  return [...new Set(files)].sort();
}

function candidateReviewText(config, workspaceRoot, task) {
  if (!task.candidates.length) {
    return "";
  }
  return task.candidates
    .map((candidate) => {
      const patch = candidate.patchFile && fs.existsSync(candidate.patchFile)
        ? fs.readFileSync(candidate.patchFile, "utf8")
        : "";
      const truncatedPatch = patch.length > 12000 ? `${patch.slice(0, 12000)}\n...[patch truncated]` : patch;
      return [
        `Candidate: ${candidate.candidateId}`,
        `Worker label: ${candidateWorkerLabel(candidate) ?? "unknown"}`,
        `Status: ${candidate.status}`,
        `Changed files: ${candidate.changedFiles.join(", ") || "(none)"}`,
        `Summary: ${candidate.summary}`,
        "Patch:",
        truncatedPatch || "(no patch)"
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function scoutReviewText(task) {
  const scouts = task.scouts ?? [];
  if (!scouts.length) {
    return "";
  }
  return scouts
    .map((scout) =>
      [
        `Scout: ${workerLabelFor(scout) ?? "unknown"}`,
        `Status: ${scout.status}`,
        `Notes: ${scout.notes || "(no notes)"}`
      ].join("\n")
    )
    .join("\n\n---\n\n");
}

export async function runTaskWorkflow(config, workspaceRoot, taskId) {
  let task = loadTask(config, workspaceRoot, taskId);
  if (task.status === "cancelled") {
    return task;
  }

  task.status = "running";
  task.startedAt = task.startedAt ?? new Date().toISOString();
  saveTask(config, workspaceRoot, task);

  try {
    if (task.options?.research) {
      const researchWorkerList = task.workers
        .map(workerLabelFor)
        .filter((label) => label?.startsWith("research-"));
      const settledResearchWorkers = await Promise.allSettled(
        researchWorkerList.map((label) => runCursorWorker(config, workspaceRoot, task, label))
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }
      const researchWorkers = settledResearchWorkers.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        const label = researchWorkerList[index];
        const worker = workerForLabel(task, label);
        Object.assign(worker, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
        return worker;
      });
      task.research = researchWorkers.map((worker) => ({
        worker: workerLabelFor(worker),
        status: worker.status,
        transcript: worker.transcript,
        notes: worker.finalOutput || "(research worker did not provide notes)",
        error: worker.error ?? null,
        exitCode: worker.exitCode ?? null
      }));
      task.status = researchWorkers.some((worker) => worker.status === "failed") ? "failed" : "completed";
      task.completedAt = new Date().toISOString();
      delete task.backgroundPid;
      saveTask(config, workspaceRoot, task);
      return task;
    }

    const planner = await runCursorWorker(config, workspaceRoot, task, "planner");
    if (isCancelled(config, workspaceRoot, task.taskId)) {
      return markCancelled(config, workspaceRoot, task);
    }

    const scoutWorkerList = task.workers
      .map(workerLabelFor)
      .filter((label) => label?.startsWith("scout-"));
    if (scoutWorkerList.length) {
      const scouts = await Promise.all(
        scoutWorkerList.map((label) =>
          runCursorWorker(config, workspaceRoot, task, label, { plannerOutput: planner.finalOutput })
        )
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }
      task.scouts = scouts.map((scout) => ({
        worker: workerLabelFor(scout),
        status: scout.status,
        transcript: scout.transcript,
        notes: scout.finalOutput || "(scout did not provide notes)",
        exitCode: scout.exitCode ?? null
      }));
      saveTask(config, workspaceRoot, task);
    }

    const builderWorkerList = task.workers
      .map(workerLabelFor)
      .filter((label) => label?.startsWith("builder-"));
    if (builderWorkerList.length) {
      await Promise.all(
        builderWorkerList.map((label) =>
          runCursorWorker(config, workspaceRoot, task, label, { plannerOutput: planner.finalOutput })
        )
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }

      for (const label of builderWorkerList) {
        collectCandidatePatch(config, workspaceRoot, task, label);
      }
      task.status = "patches-collected";
      saveTask(config, workspaceRoot, task);
    }

    const reviewer = await runCursorWorker(config, workspaceRoot, task, "reviewer", {
      plannerOutput: planner.finalOutput,
      candidateText: candidateReviewText(config, workspaceRoot, task),
      scoutText: scoutReviewText(task)
    });
    task.reviewer = {
      worker: "reviewer",
      status: reviewer.status,
      transcript: reviewer.transcript,
      notes: reviewer.finalOutput || "(reviewer did not provide notes)",
      exitCode: reviewer.exitCode ?? null
    };
    if (isCancelled(config, workspaceRoot, task.taskId)) {
      return markCancelled(config, workspaceRoot, task);
    }
    task.recommendedCandidateId = extractRecommendedCandidate(task);
    task.status = task.workers.some((worker) => worker.status === "failed") ? "failed" : "completed";
    task.completedAt = new Date().toISOString();
    delete task.backgroundPid;
    saveTask(config, workspaceRoot, task);
    return task;
  } catch (error) {
    task.status = isCancelled(config, workspaceRoot, task.taskId) ? "cancelled" : "failed";
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = new Date().toISOString();
    delete task.backgroundPid;
    saveTask(config, workspaceRoot, task);
    return task;
  }
}

function isCancelled(config, workspaceRoot, taskId) {
  return safeLoadTask(config, workspaceRoot, taskId)?.status === "cancelled";
}

function markCancelled(config, workspaceRoot, task) {
  task.status = "cancelled";
  task.completedAt = new Date().toISOString();
  delete task.backgroundPid;
  saveTask(config, workspaceRoot, task);
  return task;
}

export async function runTeam(config, workspaceRoot, objective, options = {}) {
  const task = createTeamTask(config, workspaceRoot, objective, options);
  if (options.background) {
    return task;
  }
  return runTaskWorkflow(config, workspaceRoot, task.taskId);
}

export function createReviewTask(config, workspaceRoot, preset = "repo", options = {}) {
  return createTeamTask(config, workspaceRoot, reviewObjective(preset), {
    ...options,
    review: true,
    builders: 0,
    scouts: options.scouts ?? 0
  });
}

export function createResearchTask(config, workspaceRoot, question, options = {}) {
  return createTeamTask(config, workspaceRoot, question, {
    ...options,
    research: true,
    review: false,
    builders: 0,
    scouts: 0,
    workers: options.workers ?? 2,
    focus: options.focus ?? null
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractRecommendedCandidate(task) {
  if (task.recommendedCandidateId) {
    const existing = (task.candidates ?? []).find((candidate) => candidate.candidateId === task.recommendedCandidateId);
    if (existing) {
      return task.recommendedCandidateId;
    }
  }
  const notes = task.reviewer?.notes ?? "";
  if (!notes.trim() || !task.candidates?.length) {
    return null;
  }

  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const recommendations = [];
  for (const candidate of task.candidates) {
    const labels = [candidate.candidateId, candidateWorkerLabel(candidate)].filter(Boolean);
    const labelPattern = new RegExp(`\\b(?:${labels.map(escapeRegExp).join("|")})\\b`, "i");
    const recommendationPattern = /\b(recommend(?:ed|ation)?|prefer(?:s|red)?|best|winner|choose|selected)\b/i;
    for (const line of lines) {
      if (labelPattern.test(line) && recommendationPattern.test(line)) {
        recommendations.push({ candidate, score: 10 });
        break;
      }
    }
  }

  if (recommendations.length) {
    recommendations.sort((a, b) => b.score - a.score);
    const [first, second] = recommendations;
    if (!second || first.score > second.score) {
      return first.candidate.candidateId;
    }
  }

  const withPatch = task.candidates.filter((candidate) => candidate.patchFile && candidate.status === "completed");
  if (withPatch.length === 1) {
    return withPatch[0].candidateId;
  }
  return null;
}

function verifierAgent(config) {
  const legacyExact = (config.agents ?? []).find((agent) => agent.role === "verifier" && agent.kind === "shell");
  if (legacyExact) {
    return legacyExact;
  }
  const worker = config.workers?.verifier;
  if (worker?.command) {
    return {
      id: worker.id ?? "verifier",
      kind: worker.kind ?? "shell",
      command: worker.command,
      args: worker.args ?? []
    };
  }
  return null;
}

function runShellCheck(agent, cwd) {
  const command = agent.command;
  const args = agent.args ?? [];
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    env: process.env
  });
  const commandText = [command, ...args].join(" ");
  return {
    command: commandText,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function normalizeCheckOutput(check) {
  return `${check.stdout ?? ""}\n${check.stderr ?? ""}`.trim();
}

function classifyCheckFailure(candidateCheck, baselineCheck) {
  if (candidateCheck.status === "passed") {
    return { ...candidateCheck, baseline: baselineCheck?.status ?? null, classification: "passed" };
  }
  if (!baselineCheck || baselineCheck.status === "passed") {
    return { ...candidateCheck, baseline: baselineCheck?.status ?? null, classification: "candidate-specific" };
  }
  const candidateOut = normalizeCheckOutput(candidateCheck);
  const baselineOut = normalizeCheckOutput(baselineCheck);
  if (candidateOut === baselineOut || (baselineOut && candidateOut.includes(baselineOut))) {
    return { ...candidateCheck, baseline: "failed", classification: "baseline" };
  }
  return { ...candidateCheck, baseline: "failed", classification: "candidate-specific" };
}

function baselineWorktreePath(config, workspaceRoot, task) {
  return statePath(config, workspaceRoot, "worktrees", task.taskId, "__baseline__");
}

function createBaselineWorktree(config, workspaceRoot, task) {
  const baselineDir = baselineWorktreePath(config, workspaceRoot, task);
  fs.mkdirSync(path.dirname(baselineDir), { recursive: true });
  if (!fs.existsSync(baselineDir)) {
    runGit(task.gitRoot, ["worktree", "add", "--detach", baselineDir, task.baseSha]);
  }
  return baselineDir;
}

export function verifyCandidate(config, workspaceRoot, taskId, requestedCandidateId, options = {}) {
  const task = loadTask(config, workspaceRoot, taskId);
  const candidate = findCandidate(task, requestedCandidateId);
  if (!candidate) {
    throw new Error(`Candidate not found for task ${taskId}: ${requestedCandidateId}`);
  }
  if (!candidate.worktree || !fs.existsSync(candidate.worktree)) {
    throw new Error(`Candidate ${candidate.candidateId} worktree is missing. Re-run the task or inspect the patch directly.`);
  }

  const agent = verifierAgent(config);
  if (!agent) {
    throw new Error("No shell verifier configured. Add workers.verifier to .composer-swarm/config.json.");
  }

  const baselineAware = options.baseline !== false;
  let baselineCheck = null;
  if (baselineAware && task.baseSha && task.gitRoot) {
    const baselineWorktree = createBaselineWorktree(config, workspaceRoot, task);
    baselineCheck = runShellCheck(agent, baselineWorktree);
  }

  const candidateCheck = runShellCheck(agent, candidate.worktree);
  const classified = classifyCheckFailure(candidateCheck, baselineCheck);

  const checks = candidate.checks ?? [];
  const existingIndex = checks.findIndex((check) => check.command === classified.command);
  const entry = {
    ...classified,
    verifiedAt: new Date().toISOString()
  };
  if (existingIndex === -1) {
    checks.push(entry);
  } else {
    checks[existingIndex] = entry;
  }
  candidate.checks = checks;
  const candidateIndex = task.candidates.findIndex((entry) => entry.candidateId === candidate.candidateId);
  if (candidateIndex !== -1) {
    task.candidates[candidateIndex] = candidate;
  }
  saveTask(config, workspaceRoot, task);

  const lines = [
    `Verified ${candidate.candidateId} (${candidateWorkerLabel(candidate) ?? "unknown"})`,
    `Command: ${classified.command}`,
    `Result: ${classified.status}`,
    `Classification: ${classified.classification}`
  ];
  if (baselineCheck) {
    lines.push(`Baseline: ${baselineCheck.status}`);
  }
  if (classified.status === "failed") {
    const output = normalizeCheckOutput(classified);
    if (output) {
      lines.push("", "Output:", output.length > 2000 ? `${output.slice(0, 1997)}...` : output);
    }
  }
  return { task, candidate, check: classified, lines };
}

export function verifyCandidates(config, workspaceRoot, taskId, options = {}) {
  const task = loadTask(config, workspaceRoot, taskId);
  if (!task.candidates?.length) {
    throw new Error(`Task ${taskId} has no candidates to verify.`);
  }
  const outputs = [];
  for (const candidate of task.candidates) {
    if (!candidate.worktree) {
      outputs.push(`Skipped ${candidate.candidateId}: no worktree.`);
      continue;
    }
    const result = verifyCandidate(config, workspaceRoot, taskId, candidate.candidateId, options);
    outputs.push(result.lines.join("\n"));
  }
  return outputs.join("\n\n");
}

function formatCheckSummary(checks) {
  if (!checks?.length) {
    return "none";
  }
  return checks
    .map((check) => {
      const tag = check.classification ? ` [${check.classification}]` : "";
      return `${check.status}${tag}`;
    })
    .join(", ");
}

export function formatCandidateComparison(task) {
  if (!task.candidates?.length) {
    return "";
  }
  const lines = [
    "",
    "Comparison:",
    `${pad("CANDIDATE", 28)} ${pad("FILES", 6)} ${pad("PATCH", 8)} ${pad("CHECKS", 18)} RECOMMENDED`,
    `${"-".repeat(28)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(18)} ${"-".repeat(12)}`
  ];
  const recommended = task.recommendedCandidateId ?? extractRecommendedCandidate(task);
  for (const candidate of task.candidates) {
    const patchKb = candidate.patchBytes ? `${Math.round(candidate.patchBytes / 1024)}k` : "-";
    const checks = formatCheckSummary(candidate.checks);
    const isRecommended = recommended === candidate.candidateId ? "yes" : "";
    lines.push(
      `${pad(candidate.candidateId, 28)} ${pad(candidate.changedFiles?.length ?? 0, 6)} ${pad(patchKb, 8)} ${pad(checks, 18)} ${isRecommended}`
    );
  }
  if (recommended) {
    lines.push("");
    lines.push(`Recommended: ${recommended}`);
    lines.push(`Apply: composer-swarm apply ${task.taskId} --recommended`);
    lines.push(`Or:    composer-swarm apply ${task.taskId} --candidate ${recommended}`);
  }
  return lines.join("\n");
}

function reviewerNotesExcerpt(notes, maxLen = 400) {
  const compact = String(notes ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!compact) {
    return "(no reviewer notes)";
  }
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

function taskGuidance(task) {
  const lines = [];
  if (task.options?.research && (task.status === "completed" || task.status === "failed")) {
    lines.push(`Inspect: composer-swarm result ${task.taskId} --verbose`);
    lines.push("Cross-check important research claims before acting.");
    lines.push(`Cleanup: composer-swarm cleanup ${task.taskId}`);
  } else if (task.status === "completed" || task.status === "patches-collected") {
    lines.push(`Inspect: composer-swarm result ${task.taskId}`);
    if (task.recommendedCandidateId) {
      lines.push(`Apply recommended: composer-swarm apply ${task.taskId} --recommended`);
    }
    if (!task.options?.review) {
      lines.push(`Verify: composer-swarm verify ${task.taskId}`);
    }
    lines.push(`Cleanup: composer-swarm cleanup ${task.taskId}`);
  } else if (task.status === "running" || task.status === "queued") {
    lines.push(`Poll: composer-swarm status ${task.taskId}`);
    lines.push(`Cancel: composer-swarm cancel ${task.taskId}`);
  } else if (task.status === "applied") {
    lines.push(`Cleanup worktrees: composer-swarm cleanup ${task.taskId}`);
  } else if (task.status === "cancelled" || task.status === "failed") {
    lines.push(`Cleanup: composer-swarm cleanup ${task.taskId}`);
  }
  const stateDir = ".composer-swarm/state/";
  lines.push(`Runtime state: ${stateDir} (safe to delete after cleanup)`);
  return lines;
}

function formatAge(iso) {
  if (!iso) {
    return "";
  }
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

export function formatTaskList(tasks) {
  if (!tasks.length) {
    return "No composer-swarm tasks found.";
  }
  const lines = [`${pad("TASK", 22)} ${pad("STATUS", 17)} ${pad("OUTPUTS", 10)} OBJECTIVE`];
  for (const task of tasks) {
    const outputCount = task.options?.research ? task.research?.length ?? 0 : task.candidates?.length ?? 0;
    lines.push(
      `${pad(task.taskId, 22)} ${pad(task.status, 17)} ${pad(outputCount, 10)} ${task.objective}`
    );
  }
  return lines.join("\n");
}

export function formatTaskStatus(task) {
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Objective: ${task.objective}`,
    `Created: ${formatAge(task.createdAt)}`,
    `Updated: ${formatAge(task.updatedAt)}`,
    `Base: ${task.baseBranch ? `${task.baseBranch} ` : ""}${task.baseSha ?? "unknown"}`
  ];
  if (task.options?.snapshotCurrent) {
    lines.push(`Snapshot: current checkout (${task.options.snapshotReason ?? "requested"})`);
  }
  if (task.error) {
    lines.push(`Error: ${task.error}`);
  }
  lines.push("", "Workers:");
  for (const worker of task.workers ?? []) {
    const label = workerLabelFor(worker) ?? "unknown";
    const detail = [
      worker.exitCode !== undefined && worker.exitCode !== null ? `exit=${worker.exitCode}` : null,
      worker.lastOutputAt ? `last-output=${formatAge(worker.lastOutputAt)}` : null,
      worker.error ? `error=${trimForSummary(worker.error)}` : null,
      worker.worktree ? `worktree=${worker.worktree}` : null
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`- ${label}: ${worker.status}${detail ? ` (${detail})` : ""}`);
  }
  if (task.options?.research) {
    lines.push("", "Research:");
    if (!task.research?.length) {
      lines.push("- pending");
    } else {
      for (const entry of task.research) {
        lines.push(`- ${entry.worker}: ${entry.status}`);
      }
    }
    lines.push("", "Next steps:");
    for (const hint of taskGuidance(task)) {
      lines.push(`- ${hint}`);
    }
    return lines.join("\n");
  }
  lines.push("", "Candidates:");
  if (!task.candidates?.length) {
    lines.push("- none");
  } else {
    for (const candidate of task.candidates) {
      const patchSize = candidate.patchBytes ? `${candidate.patchBytes}b` : "none";
      lines.push(
        `- ${candidate.candidateId}: ${candidate.status}, files=${candidate.changedFiles.length}, patch=${patchSize}`
      );
    }
    if (task.recommendedCandidateId) {
      lines.push(`Recommended: ${task.recommendedCandidateId}`);
    }
  }
  lines.push("", "Next steps:");
  for (const hint of taskGuidance(task)) {
    lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}

export function renderStatus(config, workspaceRoot, taskId = null) {
  if (taskId) {
    return formatTaskStatus(loadTask(config, workspaceRoot, taskId));
  }
  return formatTaskList(listTasks(config, workspaceRoot));
}

function formatChecks(checks, verbose = false) {
  if (!checks?.length) {
    return "Checks: none recorded";
  }
  const lines = ["Checks:"];
  for (const check of checks) {
    const tag = check.classification ? ` (${check.classification})` : "";
    lines.push(`- ${check.command}: ${check.status}${tag}`);
    if (verbose && check.status === "failed") {
      const output = normalizeCheckOutput(check);
      if (output) {
        lines.push(`  ${output.split(/\r?\n/).join("\n  ")}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatResult(task, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? task.workspaceRoot ?? process.cwd();
  const verbose = Boolean(options.verbose);
  if (task.options?.research) {
    return formatResearchResult(task, { workspaceRoot, verbose });
  }
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Objective: ${task.objective}`,
    ""
  ];
  if (!task.candidates?.length) {
    lines.push("No candidates have been collected yet.");
  } else {
    lines.push(formatCandidateComparison(task));
    lines.push("");
    lines.push("Candidates:");
    for (const candidate of task.candidates) {
      lines.push("");
      lines.push(`Candidate: ${candidate.candidateId} (${candidateWorkerLabel(candidate) ?? "unknown"})`);
      lines.push(`Status: ${candidate.status}`);
      lines.push(`Patch: ${candidate.patchBytes ?? 0} bytes`);
      if (verbose) {
        lines.push(`Patch file: ${candidate.patchFile ? relativePath(workspaceRoot, candidate.patchFile) : "none"}`);
        lines.push(`Worktree: ${candidate.worktree ? relativePath(workspaceRoot, candidate.worktree) : "none"}`);
      }
      lines.push(`Changed files: ${candidate.changedFiles.join(", ") || "(none)"}`);
      lines.push(`Summary: ${candidate.summary}`);
      lines.push(formatChecks(candidate.checks, verbose));
      if (candidate.patchFile) {
        lines.push(`Apply: composer-swarm apply ${task.taskId} --candidate ${candidate.candidateId}`);
      }
    }
  }
  lines.push("");
  if (verbose && task.scouts?.length) {
    lines.push("Scout notes:");
    for (const scout of task.scouts) {
      lines.push("");
      lines.push(`Scout: ${workerLabelFor(scout) ?? "unknown"}`);
      lines.push(`Status: ${scout.status}`);
      lines.push(scout.notes ?? "No scout notes recorded.");
    }
    lines.push("");
  }
  lines.push("Reviewer notes:");
  if (verbose) {
    lines.push(task.reviewer?.notes ?? "No reviewer notes recorded yet.");
  } else {
    lines.push(reviewerNotesExcerpt(task.reviewer?.notes));
    lines.push("(use --verbose for full reviewer notes)");
  }
  lines.push("");
  lines.push("Next steps:");
  for (const hint of taskGuidance(task)) {
    lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}

function formatResearchResult(task, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? task.workspaceRoot ?? process.cwd();
  const verbose = Boolean(options.verbose);
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Research question: ${task.objective}`
  ];
  if (task.options?.focus) {
    lines.push(`Focus: ${task.options.focus}`);
  }
  lines.push("", "Research outputs:");
  if (!task.research?.length) {
    lines.push("- none recorded yet");
  } else {
    for (const entry of task.research) {
      lines.push("", `${workerDisplayName(entry.worker)}:`);
      lines.push(`Status: ${entry.status}`);
      if (entry.error) {
        lines.push(`Error: ${entry.error}`);
      }
      if (verbose && entry.transcript) {
        lines.push(`Transcript: ${relativePath(workspaceRoot, entry.transcript)}`);
      }
      lines.push(entry.notes ?? "(no notes)");
    }
  }
  lines.push("");
  lines.push("Main agent guidance:");
  lines.push("- Continue or complete your own repo investigation.");
  lines.push("- Treat Composer findings as evidence-backed leads, not authority.");
  lines.push("- Cross-check important claims against the cited files or commands before acting.");
  lines.push("");
  lines.push("Next steps:");
  for (const hint of taskGuidance(task)) {
    lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}

export function renderResult(config, workspaceRoot, taskId = null, options = {}) {
  const task = taskId ? loadTask(config, workspaceRoot, taskId) : latestTask(config, workspaceRoot);
  if (!task) {
    return "No composer-swarm tasks found.";
  }
  return formatResult(task, { workspaceRoot, ...options });
}

function transcriptEntriesForTask(config, workspaceRoot, task) {
  const entries = new Map();
  for (const worker of task.workers ?? []) {
    const label = workerLabelFor(worker);
    if (!label) {
      continue;
    }
    const transcript = worker.transcript ?? transcriptPath(config, workspaceRoot, task.taskId, label);
    entries.set(label, { label, transcript, worker });
  }
  return [...entries.values()];
}

function findTranscriptEntry(config, workspaceRoot, task, requestedWorker) {
  const requested = String(requestedWorker ?? "").trim();
  if (!requested) {
    return null;
  }
  const entries = transcriptEntriesForTask(config, workspaceRoot, task);
  return (
    entries.find((entry) => entry.label === requested) ??
    entries.find((entry) => `${task.taskId}-${entry.label}` === requested) ??
    entries.find((entry) => workerDisplayName(entry.label) === requested) ??
    null
  );
}

export function renderInspect(config, workspaceRoot, taskId = null) {
  const task = taskId ? loadTask(config, workspaceRoot, taskId) : latestTask(config, workspaceRoot);
  if (!task) {
    return "No composer-swarm tasks found.";
  }
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Objective: ${task.objective}`,
    `State file: ${relativePath(workspaceRoot, taskFile(config, workspaceRoot, task.taskId))}`,
    `State root: ${relativePath(workspaceRoot, stateRoot(config, workspaceRoot))}`,
    ""
  ];
  if (task.options?.snapshotCurrent) {
    lines.splice(3, 0, `Snapshot: current checkout (${task.options.snapshotReason ?? "requested"})`);
  }

  const transcripts = transcriptEntriesForTask(config, workspaceRoot, task);
  lines.push("Workers:");
  if (!transcripts.length) {
    lines.push("- none recorded");
  } else {
    for (const entry of transcripts) {
      const worker = entry.worker ?? {};
      const transcriptStatus = fs.existsSync(entry.transcript) ? relativePath(workspaceRoot, entry.transcript) : "not started";
      const worktree = worker.worktree ? relativePath(workspaceRoot, worker.worktree) : "not created";
      lines.push(`- ${entry.label}: ${worker.status ?? "unknown"}`);
      lines.push(`  Transcript: ${transcriptStatus}`);
      lines.push(`  Worktree: ${worktree}`);
    }
  }

  if (task.options?.research) {
    lines.push("", "Research outputs:");
    if (!task.research?.length) {
      lines.push("- none recorded");
    } else {
      for (const entry of task.research) {
        lines.push(`- ${entry.worker}: ${entry.status}`);
      }
    }
  } else {
    lines.push("", "Candidate artifacts:");
    if (!task.candidates?.length) {
      lines.push("- none recorded");
    } else {
      for (const candidate of task.candidates) {
        lines.push(`- ${candidate.candidateId}: ${candidate.status}`);
        lines.push(`  Patch: ${candidate.patchFile ? relativePath(workspaceRoot, candidate.patchFile) : "none"}`);
        lines.push(`  Worktree: ${candidate.worktree ? relativePath(workspaceRoot, candidate.worktree) : "none"}`);
      }
    }
  }

  lines.push("", "Useful commands:");
  lines.push(`- composer-swarm status ${task.taskId}`);
  lines.push(`- composer-swarm result ${task.taskId} --verbose`);
  lines.push(`- composer-swarm logs ${task.taskId}`);
  if (transcripts.length) {
    lines.push(`- composer-swarm logs ${task.taskId} --worker ${transcripts[0].label}`);
  }
  if (!task.options?.research && task.candidates?.length) {
    lines.push(`- composer-swarm verify ${task.taskId}`);
  }
  lines.push(`- composer-swarm cleanup ${task.taskId}`);
  return lines.join("\n");
}

function readTranscriptEvents(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseJsonLine(line) ?? { type: "raw", line });
}

function formatTranscriptEvent(event) {
  const prefix = [event.timestamp, event.type, event.stream].filter(Boolean).join(" ");
  if (event.type === "worker-output") {
    const text = textFromJson(event.event) ?? event.line ?? "";
    const eventType = event.event?.type ? `${prefix} ${event.event.type}` : prefix;
    return text ? `${eventType}\n  ${String(text).split(/\r?\n/).join("\n  ")}` : eventType;
  }
  if (event.type === "started") {
    return `${prefix}\n  command=${event.command} args=${(event.args ?? []).join(" ")}`;
  }
  if (event.error) {
    return `${prefix}\n  error=${event.error}`;
  }
  if (event.reason) {
    return `${prefix}\n  reason=${event.reason}`;
  }
  if (event.exitCode !== undefined || event.signal !== undefined) {
    return `${prefix}\n  exit=${event.exitCode ?? "null"} signal=${event.signal ?? "null"}`;
  }
  return prefix || JSON.stringify(event);
}

export function renderLogs(config, workspaceRoot, taskId = null, options = {}) {
  const task = taskId ? loadTask(config, workspaceRoot, taskId) : latestTask(config, workspaceRoot);
  if (!task) {
    return "No composer-swarm tasks found.";
  }
  const entries = transcriptEntriesForTask(config, workspaceRoot, task);
  const requestedWorker = options.worker ?? null;
  if (!requestedWorker) {
    const lines = [`Task: ${task.taskId}`, "", "Available transcripts:"];
    if (!entries.length) {
      lines.push("- none recorded");
    } else {
      for (const entry of entries) {
        const detail = fs.existsSync(entry.transcript)
          ? `${relativePath(workspaceRoot, entry.transcript)} (${fs.statSync(entry.transcript).size} bytes)`
          : "not started";
        lines.push(`- ${entry.label}: ${detail}`);
      }
    }
    lines.push("", `Use: composer-swarm logs ${task.taskId} --worker <worker-label> [--tail 80]`);
    return lines.join("\n");
  }

  const entry = findTranscriptEntry(config, workspaceRoot, task, requestedWorker);
  if (!entry) {
    throw new Error(`Task ${task.taskId} has no transcript worker labeled ${requestedWorker}`);
  }
  if (!fs.existsSync(entry.transcript)) {
    return [
      `Task: ${task.taskId}`,
      `Worker: ${entry.label}`,
      `Transcript: ${relativePath(workspaceRoot, entry.transcript)}`,
      "No transcript file has been written yet."
    ].join("\n");
  }

  const events = readTranscriptEvents(entry.transcript);
  const tail = options.tail === undefined || options.tail === null ? 80 : Number(options.tail);
  if (!Number.isInteger(tail) || tail < 0) {
    throw new Error("--tail must be a non-negative integer.");
  }
  const shown = tail === 0 ? events : events.slice(-tail);
  const lines = [
    `Task: ${task.taskId}`,
    `Worker: ${entry.label}`,
    `Transcript: ${relativePath(workspaceRoot, entry.transcript)}`,
    tail === 0 ? `Events: ${events.length}` : `Events: showing ${shown.length} of ${events.length}`,
    ""
  ];
  for (const event of shown) {
    lines.push(formatTranscriptEvent(event), "");
  }
  return lines.join("\n").trimEnd();
}

function candidateMatches(candidate, requested) {
  const label = candidateWorkerLabel(candidate);
  return candidate.candidateId === requested || label === requested || candidate.candidateId.endsWith(`-${requested}`);
}

function findCandidate(task, requested) {
  return (task.candidates ?? []).find((candidate) => candidateMatches(candidate, requested)) ?? null;
}

export function applyCandidate(config, workspaceRoot, taskId, requestedCandidateId, options = {}) {
  const task = loadTask(config, workspaceRoot, taskId);
  let candidateId = requestedCandidateId;
  if (options.recommended || candidateId === "--recommended") {
    candidateId = task.recommendedCandidateId ?? extractRecommendedCandidate(task);
    if (!candidateId) {
      throw new Error(
        `No recommended candidate for task ${taskId}. Inspect reviewer notes with: composer-swarm result ${taskId} --verbose`
      );
    }
  }
  const candidate = findCandidate(task, candidateId);
  if (!candidate) {
    throw new Error(`Candidate not found for task ${taskId}: ${requestedCandidateId}`);
  }
  if (!candidate.patchFile) {
    throw new Error(`Candidate ${candidate.candidateId} has no patch to apply.`);
  }
  if (!fs.existsSync(candidate.patchFile)) {
    throw new Error(`Patch file is missing: ${candidate.patchFile}`);
  }

  assertCleanMainCheckout(task.gitRoot ?? workspaceRoot);
  const check = runGit(task.gitRoot ?? workspaceRoot, ["apply", "--check", candidate.patchFile], {
    allowFailure: true,
    maxBuffer: 1024 * 1024 * 20
  });
  if (check.status !== 0) {
    throw new Error(`Patch does not apply cleanly.\n${(check.stderr || check.stdout).trim()}`);
  }
  runGit(task.gitRoot ?? workspaceRoot, ["apply", candidate.patchFile], { maxBuffer: 1024 * 1024 * 20 });

  task.status = "applied";
  task.selectedCandidateId = candidate.candidateId;
  task.appliedAt = new Date().toISOString();
  saveTask(config, workspaceRoot, task);
  return {
    task,
    candidate,
    lines: [
      `Applied ${candidate.candidateId} to ${task.gitRoot ?? workspaceRoot}.`,
      `Changed files: ${candidate.changedFiles.join(", ") || "(none)"}`
    ]
  };
}

function killPid(pid, options = {}) {
  if (!pid) {
    return false;
  }
  let killed = false;
  if (options.processGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      killed = true;
    } catch {
      // Fall back to signalling the single PID below.
    }
  }
  try {
    process.kill(pid, "SIGTERM");
    killed = true;
  } catch {
    // The process may already have exited, or the PID may be stale.
  }
  return killed;
}

export function cancelTask(config, workspaceRoot, taskId) {
  const task = loadTask(config, workspaceRoot, taskId);
  const killed = [];
  if (killPid(task.backgroundPid, { processGroup: true })) {
    killed.push(task.backgroundPid);
  }
  delete task.backgroundPid;
  for (const worker of task.workers ?? []) {
    if (killPid(worker.pid)) {
      killed.push(worker.pid);
    }
    delete worker.pid;
    if (worker.status === "running" || worker.status === "pending") {
      worker.status = "cancelled";
    }
  }
  task.status = "cancelled";
  task.cancelledAt = new Date().toISOString();
  saveTask(config, workspaceRoot, task);
  return {
    task,
    lines: [`Cancelled ${taskId}.`, killed.length ? `Signalled processes: ${killed.join(", ")}` : "No running processes were recorded."]
  };
}

function removeWorktree(gitRoot, worktree) {
  if (!worktree) {
    return false;
  }
  if (fs.existsSync(worktree)) {
    const result = runGit(gitRoot, ["worktree", "remove", "--force", worktree], { allowFailure: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    return result.status === 0 || !fs.existsSync(worktree);
  }
  return false;
}

export function cleanupTask(config, workspaceRoot, taskId) {
  const task = loadTask(config, workspaceRoot, taskId);
  if (task.status === "running") {
    throw new Error(`Task ${taskId} is still running. Cancel it before cleanup.`);
  }
  const removed = [];
  for (const worker of task.workers ?? []) {
    if (removeWorktree(task.gitRoot ?? workspaceRoot, worker.worktree)) {
      removed.push(worker.worktree);
    }
    delete worker.pid;
  }
  const baselineWorktree = baselineWorktreePath(config, workspaceRoot, task);
  if (removeWorktree(task.gitRoot ?? workspaceRoot, baselineWorktree)) {
    removed.push(baselineWorktree);
  }
  if (task.gitRoot) {
    runGit(task.gitRoot, ["worktree", "prune"], { allowFailure: true });
  }
  task.cleanedAt = new Date().toISOString();
  saveTask(config, workspaceRoot, task);
  return {
    task,
    lines: [`Cleaned ${taskId}.`, removed.length ? `Removed worktrees:\n${removed.map((entry) => `- ${entry}`).join("\n")}` : "No worktrees needed removal."]
  };
}

export function cleanupTasks(config, workspaceRoot, taskId = null) {
  if (taskId) {
    return cleanupTask(config, workspaceRoot, taskId).lines.join("\n");
  }
  const outputs = [];
  for (const task of listTasks(config, workspaceRoot)) {
    if (task.status === "running") {
      outputs.push(`Skipped ${task.taskId}: still running.`);
      continue;
    }
    outputs.push(cleanupTask(config, workspaceRoot, task.taskId).lines.join("\n"));
  }
  return outputs.length ? outputs.join("\n\n") : "No composer-swarm tasks found.";
}

export function recordBackgroundPid(config, workspaceRoot, taskId, pid) {
  const task = loadTask(config, workspaceRoot, taskId);
  task.backgroundPid = pid;
  if (task.status === "created") {
    task.status = "queued";
  }
  task.options = {
    ...(task.options ?? {}),
    background: true
  };
  saveTask(config, workspaceRoot, task);
  return task;
}
