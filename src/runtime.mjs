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
const WORKER_PROGRESS_SAVE_INTERVAL_MS = 1000;
const REPO_CONTEXT_SCHEMA = "composer-swarm.repo-context.v1";
const REPO_CONTEXT_MAX_FILES = 200;
const REPO_CONTEXT_MAX_BYTES = 12_000;
const TASK_ID_PATTERN = /^task_[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DEFAULT_CURSOR_MODEL = "composer-2.5-fast";

export const RESEARCH_PACKS = Object.freeze({
  broad: [
    "architecture: map modules, entry points, ownership boundaries, and cross-module contracts",
    "behavior: trace runtime flows, state changes, error handling, and data serialization",
    "tests: inspect coverage gaps, fixtures, flaky patterns, and verification commands",
    "risk: look for edge cases, compatibility breaks, security-sensitive paths, and operational hazards"
  ],
  bugs: [
    "input-validation: inspect boundary parsing, user-controlled data, and missing validation",
    "state-and-serialization: inspect persistence, query params, encoding, repeated values, and migrations",
    "error-handling: inspect failures, cleanup, retries, cancellation, and partial writes",
    "test-gaps: inspect missing assertions and untested regressions for risky behavior"
  ],
  flow: [
    "entry-points: find command, API, UI, and background entry points for the requested flow",
    "data-flow: trace data transformations, serialization, persistence, and external calls",
    "failure-flow: inspect errors, retries, cleanup, cancellation, and partial-success paths",
    "verification-flow: identify tests, fixtures, logs, and commands that prove behavior"
  ],
  tests: [
    "coverage-gaps: find important behavior without direct assertions",
    "fixture-quality: inspect mocks, fixtures, and test data for realism and blind spots",
    "flakiness: inspect timing, concurrency, filesystem, and network assumptions",
    "ci-and-commands: map test commands, CI gates, and missing verification steps"
  ],
  design: [
    "architecture: inspect module boundaries, dependencies, and ownership seams",
    "abstractions: identify accidental complexity, leaky APIs, and duplicated concepts",
    "contracts: inspect public interfaces, compatibility promises, and error contracts",
    "maintainability: inspect naming, locality, documentation, and future-change risk"
  ],
  release: [
    "packaging: inspect package metadata, ignored files, generated artifacts, and install paths",
    "compatibility: inspect migration risks, defaults, flags, and backward compatibility",
    "docs: inspect README, command docs, skill docs, and troubleshooting gaps",
    "smoke: identify release smoke checks, live checks, and false-green risks"
  ],
  security: [
    "input-trust: inspect untrusted inputs, parsing, validation, and injection surfaces",
    "auth-secrets: inspect tokens, auth headers, secret storage, and log redaction",
    "filesystem-process: inspect path traversal, symlinks, shell execution, and cleanup hazards",
    "dependency-supply-chain: inspect dependencies, install scripts, and package boundaries"
  ]
});

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
  const parsed = readJsonFile(filePath, "composer-swarm config");
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

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error.message}`, { cause: error });
  }
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

function assertSafeTaskId(taskId) {
  const id = String(taskId ?? "");
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`Invalid task id: ${taskId}. Expected an id like task_<letters-numbers-underscores-dashes>.`);
  }
  return id;
}

function taskFile(config, workspaceRoot, taskId) {
  return statePath(config, workspaceRoot, "tasks", `${assertSafeTaskId(taskId)}.json`);
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

export function initializeGitRepository(cwd) {
  const root = path.resolve(cwd);
  fs.mkdirSync(root, { recursive: true });
  const result = spawnSync("git", ["init"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return findGitRoot(root) ?? root;
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

export function mainCheckoutStatus(gitRoot, options = {}) {
  const ignoredPaths = new Set(
    (options.ignorePaths ?? [])
      .map((entry) => statusPathFromFile(gitRoot, entry))
      .filter(Boolean)
  );
  const result = runGit(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !isRuntimeStateStatusLine(line))
    .filter((line) => !ignoredPaths.has(statusPathFromLine(line)))
    .join("\n")
    .trim();
}

function isRuntimeStateStatusLine(line) {
  const filePath = statusPathFromLine(line);
  return (
    filePath === ".composer-swarm/" ||
    filePath === ".composer-swarm/config.json" ||
    filePath?.startsWith(".composer-swarm/state/")
  );
}

function statusPathFromLine(line) {
  const rawPath = String(line ?? "").slice(3).trim();
  return decodeGitQuotedPath(rawPath.split(" -> ").pop());
}

function decodeGitQuotedPath(filePath) {
  const text = String(filePath ?? "");
  if (!text.startsWith("\"") || !text.endsWith("\"")) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(1, -1);
  }
}

function statusPathFromFile(gitRoot, filePath) {
  if (!filePath) {
    return null;
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(gitRoot, filePath);
  const relative = path.relative(gitRoot, resolved);
  return safeRelativePath(relative) ? relative : null;
}

function statusHasUntracked(statusText) {
  return String(statusText ?? "")
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? "));
}

export function assertCleanMainCheckout(gitRoot, options = {}) {
  const status = mainCheckoutStatus(gitRoot, options);
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

function gitHead(gitRoot, options = {}) {
  const result = runGit(gitRoot, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: Boolean(options.allowUnborn)
  });
  if (result.status !== 0 && options.allowUnborn) {
    return null;
  }
  return result.stdout.trim();
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

export function researchPackNames() {
  return Object.keys(RESEARCH_PACKS);
}

export function parseResearchAngles(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseResearchPlanAngles(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  const bullets = [];
  const fallback = [];
  let fenced = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line === "---") {
      continue;
    }
    const bullet = /^(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/.exec(line);
    if (bullet?.[1]?.trim()) {
      bullets.push(bullet[1].trim());
      continue;
    }
    if (!line.startsWith("#") && !/^objective:\s*/i.test(line)) {
      fallback.push(line);
    }
  }
  return (bullets.length ? bullets : fallback)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, RESEARCH_SUFFIXES.length);
}

function researchPackAngles(packName) {
  const key = String(packName ?? "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  const pack = RESEARCH_PACKS[key];
  if (!pack) {
    throw new Error(`Unknown research pack: ${packName}. Available: ${researchPackNames().join(", ")}`);
  }
  return { key, angles: pack };
}

export function defaultResearchWorkerCount(options = {}) {
  const explicitAngles = parseResearchAngles(options.angles);
  if (explicitAngles.length) {
    return Math.min(RESEARCH_SUFFIXES.length, explicitAngles.length);
  }
  const planAngles = parseResearchPlanAngles(options.researchPlan);
  if (planAngles.length) {
    return Math.min(RESEARCH_SUFFIXES.length, planAngles.length);
  }
  const pack = researchPackAngles(options.pack);
  if (pack) {
    return Math.min(RESEARCH_SUFFIXES.length, pack.angles.length);
  }
  return 2;
}

export function resolveResearchAngles(options = {}) {
  const workerCount = researchWorkerLabels(options.workers ?? defaultResearchWorkerCount(options)).length;
  const explicitAngles = parseResearchAngles(options.angles);
  const planAngles = parseResearchPlanAngles(options.researchPlan);
  const pack = researchPackAngles(options.pack);
  const baseAngles = explicitAngles.length ? explicitAngles : planAngles.length ? planAngles : pack?.angles ?? [];
  if (!baseAngles.length) {
    return [];
  }
  const fallbackAngles = RESEARCH_PACKS.broad;
  return Array.from({ length: workerCount }, (_, index) => baseAngles[index] ?? fallbackAngles[index % fallbackAngles.length]);
}

function executionWorkerLabels(options = {}) {
  if (options.research) {
    return researchWorkerLabels(options.workers ?? defaultResearchWorkerCount(options));
  }
  if (options.review) {
    const scouts = scoutWorkerLabels(options.scouts ?? 0);
    return scouts.length ? ["planner", ...scouts, "reviewer"] : ["reviewer"];
  }
  if (hasHostImplementationPlan(options)) {
    return [...builderWorkerLabels(options.builders ?? 2), "reviewer"];
  }
  return ["planner", ...builderWorkerLabels(options.builders ?? 2), "reviewer"];
}

function hasHostImplementationPlan(options = {}) {
  return Boolean(String(options.implementationPlan ?? "").trim());
}

export function createTeamTask(config, workspaceRoot, objective, options = {}) {
  const gitRoot = requireGitWorkspace(workspaceRoot);
  const isResearch = Boolean(options.research);
  const isReadOnlyTask = isResearch || Boolean(options.review);
  const implementationPlan = !isResearch && !options.review && options.implementationPlan
    ? String(options.implementationPlan).trim()
    : undefined;
  const statusIgnorePaths = implementationPlan && options.implementationPlanFile ? [options.implementationPlanFile] : [];
  const checkoutStatus = mainCheckoutStatus(gitRoot, { ignorePaths: statusIgnorePaths });
  if (!isReadOnlyTask) {
    assertCleanMainCheckout(gitRoot, { ignorePaths: statusIgnorePaths });
  }
  ensureStateDirs(config, workspaceRoot);
  const headSha = gitHead(gitRoot, { allowUnborn: true });
  const usesSyntheticBase = !headSha;

  const taskId = options.taskId ?? createTaskId();
  const createdAt = new Date().toISOString();
  const requestedBuilders = isResearch ? 0 : options.builders ?? 2;
  const builderCount = isResearch ? 0 : builderWorkerLabels(requestedBuilders).length;
  const requestedScouts = options.scouts ?? 0;
  const scoutCount = scoutWorkerLabels(requestedScouts).length;
  const requestedResearchWorkers = options.workers ?? defaultResearchWorkerCount(options);
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
  const researchPack = isResearch && options.pack ? String(options.pack).trim().toLowerCase() : undefined;
  const researchPlan = isResearch && options.researchPlan ? String(options.researchPlan).trim() : undefined;
  const researchAngles = isResearch
    ? resolveResearchAngles({ pack: researchPack, angles: options.angles, researchPlan, workers: researchCount })
    : undefined;
  const snapshotRequested = Boolean(options.snapshotCurrent || options.includeUntracked);
  const snapshotCurrent = (isReadOnlyTask && (snapshotRequested || Boolean(checkoutStatus))) || usesSyntheticBase;
  const task = {
    schema: TASK_SCHEMA,
    taskId,
    id: taskId,
    objective,
    status: options.background ? "queued" : "created",
    workspaceRoot: path.resolve(workspaceRoot),
    gitRoot,
    baseSha: headSha ?? EMPTY_TREE_SHA,
    baseIsEmptyTree: usesSyntheticBase,
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
      researchPack: isResearch ? researchPack ?? null : undefined,
      researchPlan: isResearch ? researchPlan ?? null : undefined,
      researchPlanFile: isResearch ? options.researchPlanFile ?? null : undefined,
      researchAngles: isResearch ? researchAngles : undefined,
      implementationPlan: implementationPlan ?? undefined,
      implementationPlanFile: implementationPlan ? options.implementationPlanFile ?? null : undefined,
      snapshotCurrent,
      snapshotIncludesUntracked: snapshotCurrent,
      snapshotReason: snapshotCurrent ? (usesSyntheticBase ? "unborn-head" : checkoutStatus ? "dirty-worktree" : "requested") : null,
      syntheticBase: usesSyntheticBase,
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
  task.repoContext = createRepoContext(task, checkoutStatus);
  saveTask(config, workspaceRoot, task);
  return task;
}

export function saveTask(config, workspaceRoot, task) {
  assertSafeTaskId(task.taskId);
  task.updatedAt = new Date().toISOString();
  writeJsonAtomic(taskFile(config, workspaceRoot, task.taskId), task);
}

export function loadTask(config, workspaceRoot, taskId) {
  const safeTaskId = assertSafeTaskId(taskId);
  const filePath = taskFile(config, workspaceRoot, taskId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const task = readJsonFile(filePath, "composer-swarm task");
  const storedTaskId = assertSafeTaskId(task.taskId);
  if (storedTaskId !== safeTaskId) {
    throw new Error(`Task state mismatch: requested ${safeTaskId}, file contains ${storedTaskId}.`);
  }
  return task;
}

export function listTasks(config, workspaceRoot) {
  const tasksDir = statePath(config, workspaceRoot, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  return fs
    .readdirSync(tasksDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        const task = readJsonFile(path.join(tasksDir, file), "composer-swarm task");
        assertSafeTaskId(task.taskId);
        return task;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
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
  return statePath(config, workspaceRoot, "transcripts", assertSafeTaskId(taskId), `${workerLabel}.jsonl`);
}

function artifactPath(config, workspaceRoot, taskId, candidateId) {
  return statePath(config, workspaceRoot, "artifacts", assertSafeTaskId(taskId), `${candidateId}.patch`);
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

function safeSnapshotSymlinkTarget(gitRoot, source, linkTarget) {
  if (path.isAbsolute(linkTarget)) {
    return false;
  }
  const resolvedTarget = path.resolve(path.dirname(source), linkTarget);
  return safeRelativePath(path.relative(gitRoot, resolvedTarget));
}

function copyFileIntoSnapshot(gitRoot, worktree, relativeFilePath) {
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
    const linkTarget = fs.readlinkSync(source);
    if (safeSnapshotSymlinkTarget(gitRoot, source, linkTarget)) {
      fs.symlinkSync(linkTarget, destination);
    }
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

function snapshotFileList(gitRoot) {
  const tracked = runGit(gitRoot, ["ls-files", "-z"], {
    maxBuffer: 1024 * 1024 * 20
  }).stdout;
  const untracked = runGit(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"], {
    maxBuffer: 1024 * 1024 * 20
  }).stdout;
  return [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
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
      copyFileIntoSnapshot(gitRoot, worktree, relativeFilePath);
    }
  }
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function repoPackageSummary(gitRoot) {
  const packageJson = readJsonIfPresent(path.join(gitRoot, "package.json"));
  if (!packageJson) {
    return ["- package.json: not found"];
  }
  const lines = [
    `- name: ${packageJson.name ?? "(unnamed)"}`,
    `- type: ${packageJson.type ?? "(default)"}`,
    `- scripts: ${Object.keys(packageJson.scripts ?? {}).join(", ") || "(none)"}`,
    `- dependencies: ${Object.keys(packageJson.dependencies ?? {}).length}`,
    `- devDependencies: ${Object.keys(packageJson.devDependencies ?? {}).length}`
  ];
  if (packageJson.engines?.node) {
    lines.push(`- node: ${packageJson.engines.node}`);
  }
  return lines;
}

function repoContextFileList(gitRoot) {
  return snapshotFileList(gitRoot)
    .filter((entry) => safeRelativePath(entry) && !isRuntimeStatePath(entry))
    .filter((entry) => !entry.startsWith("node_modules/") && !entry.startsWith(".git/"))
    .sort();
}

function truncateContextText(text) {
  if (Buffer.byteLength(text, "utf8") <= REPO_CONTEXT_MAX_BYTES) {
    return text;
  }
  let truncated = text;
  while (Buffer.byteLength(`${truncated}\n...[repo context truncated]\n`, "utf8") > REPO_CONTEXT_MAX_BYTES) {
    truncated = truncated.slice(0, Math.max(0, truncated.length - 500));
  }
  return `${truncated.trimEnd()}\n...[repo context truncated]\n`;
}

function buildRepoContextText(task, checkoutStatus) {
  const fileList = repoContextFileList(task.gitRoot);
  const shownFiles = fileList.slice(0, REPO_CONTEXT_MAX_FILES);
  const lines = [
    "Repository summary",
    `Schema: ${REPO_CONTEXT_SCHEMA}`,
    `Base commit: ${task.baseSha ?? "unknown"}`,
    `Base branch: ${task.baseBranch ?? "(detached)"}`,
    task.options?.snapshotCurrent
      ? `Snapshot: current checkout (${task.options.snapshotReason ?? "requested"})`
      : "Snapshot: committed checkout",
    "",
    "Package metadata:",
    ...repoPackageSummary(task.gitRoot),
    "",
    `File inventory (${fileList.length} file${fileList.length === 1 ? "" : "s"}; showing ${shownFiles.length}):`,
    ...shownFiles.map((entry) => `- ${entry}`)
  ];
  if (fileList.length > shownFiles.length) {
    lines.push(`- ...${fileList.length - shownFiles.length} additional file(s) omitted`);
  }
  if (checkoutStatus) {
    lines.push("", "Current checkout status:", checkoutStatus);
  }
  return truncateContextText(lines.join("\n"));
}

function createRepoContext(task, checkoutStatus) {
  const key = `repo-context-${String(task.baseSha ?? EMPTY_TREE_SHA).slice(0, 12)}`;
  const text = buildRepoContextText(task, checkoutStatus);
  const files = repoContextFileList(task.gitRoot);
  return {
    schema: REPO_CONTEXT_SCHEMA,
    key,
    bytes: Buffer.byteLength(text, "utf8"),
    fileCount: files.length,
    generatedAt: new Date().toISOString(),
    text
  };
}

function createSyntheticSnapshotWorktree(config, workspaceRoot, task, workerLabel) {
  const worktree = statePath(config, workspaceRoot, "worktrees", assertSafeTaskId(task.taskId), workerLabel);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  runGit(worktree, ["init", "-q"]);
  for (const relativeFilePath of snapshotFileList(task.gitRoot)) {
    copyFileIntoSnapshot(task.gitRoot, worktree, relativeFilePath);
  }
  runGit(worktree, ["add", "-A"]);
  runGit(worktree, [
    "-c",
    "user.name=Composer Swarm",
    "-c",
    "user.email=composer-swarm@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "composer-swarm synthetic base"
  ]);
  return worktree;
}

function removeExistingWorktree(task, workspaceRoot, worktree) {
  if (!fs.existsSync(worktree)) {
    return;
  }
  removeWorktree(task.gitRoot ?? workspaceRoot, worktree);
  if (task.gitRoot) {
    runGit(task.gitRoot, ["worktree", "prune"], { allowFailure: true });
  }
}

function appendTranscript(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function createWorktree(config, workspaceRoot, task, workerLabel) {
  const worktree = statePath(config, workspaceRoot, "worktrees", assertSafeTaskId(task.taskId), workerLabel);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  removeExistingWorktree(task, workspaceRoot, worktree);
  if (task.options?.syntheticBase || task.baseIsEmptyTree) {
    return createSyntheticSnapshotWorktree(config, workspaceRoot, task, workerLabel);
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
  const plannerText =
    context.plannerOutput?.trim() ||
    (task.options?.implementationPlan ? "Use the host-authored implementation plan above." : "No planner output is available yet.");
  const candidateText = context.candidateText?.trim() || "No candidates are available yet.";
  const scoutText = context.scoutText?.trim() || "No scout notes are available yet.";
  const isResearch = Boolean(task.options?.research);
  const isReadOnlyWorker =
    workerLabel === "planner" ||
    workerLabel === "reviewer" ||
    workerLabel.startsWith("scout-") ||
    workerLabel.startsWith("research-");
  const readOnlyClaimRule =
    "- Back every important claim with file paths, line numbers, commands, or reproducible evidence. Mark Verification as tests_run, source_read, docs_read, or unverified: <reason>.";
  const base = [
    "You are a Composer worker launched by composer-swarm.",
    repoContextPrompt(task),
    "",
    "Task metadata:",
    `Task id: ${task.taskId}`,
    `Objective: ${task.objective}`,
    `Base commit: ${task.baseSha ?? "unknown"}`,
    task.options?.snapshotCurrent
      ? "Workspace note: this isolated worktree includes a snapshot of the user's current uncommitted checkout, including untracked files where available."
      : null,
    implementationPlanPrompt(task),
    "",
    "Rules:",
    "- Work only in the workspace passed to cursor-agent.",
    isReadOnlyWorker
      ? "- Do not edit files. You are intentionally running in Cursor plan/read-only mode for this worker, regardless of the host agent's mode."
      : "- Keep changes narrowly scoped to the objective.",
    "- Prefer existing project patterns over new abstractions.",
    isReadOnlyWorker ? readOnlyClaimRule : "- Report exact checks you ran and their results.",
    isReadOnlyWorker
      ? "- Treat your output as leads for the host agent to verify, not as final authority."
      : "- End with a concise summary, changed files, risks, and follow-up notes.",
    isReadOnlyWorker
      ? "- Final answer only: do not include planning narration, status updates, internal reasoning, or tool-use commentary."
      : null,
    isReadOnlyWorker
      ? "- Return the report as plain final text. Do not use CreatePlan or another planning container for the final report."
      : null
  ].filter((line) => line !== null);
  const assignment = ["", "Worker assignment:", `Worker label: ${workerLabel}`];

  if (workerLabel.startsWith("research-")) {
    return [
      ...base,
      ...assignment,
      "",
      "Research pass:",
      "Use Cursor's repository search and code-understanding tools aggressively.",
      researchFocus(task.options?.focus),
      researchPlanPrompt(task),
      researchAnglePrompt(task, workerLabel),
      "Avoid duplicating the other research workers; prioritize evidence the host model can reconcile.",
      "The host agent is also doing its own investigation in parallel; return evidence it can reconcile.",
      "Do not attempt shell or test execution if plan mode rejects it; report that as a verification gap.",
      "",
      "Required output format:",
      "Research question: <repeat the question>",
      "Angle: <assigned angle or chosen angle>",
      "Confidence: high|medium|low",
      "",
      "Findings:",
      "- Finding: <specific claim>",
      "  Evidence: <path:line>, <path:line>, or command output",
      "  Why it matters: <short explanation>",
      "  Verification: tests_run|source_read|docs_read|unverified: <reason>",
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
        ...assignment,
        "",
        "Review planning pass:",
        "Define the repository areas the review pass should inspect.",
        "Identify likely risk hotspots, missing verification, and documentation gaps.",
        "Do not edit files."
      ].join("\n");
    }
    return [
      ...base,
      ...assignment,
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
      ...assignment,
      "",
      "Planner output:",
      plannerText,
      "",
      "Implementation pass:",
      "Implement one complete candidate patch in this isolated worktree.",
      "Treat this as an independent candidate attempt. Do not try to match other builders; if the plan leaves room for choices, pick a reasonable local approach and state the tradeoff.",
      "Leave the final diff in the worktree for composer-swarm to collect."
    ].join("\n");
  }

  if (workerLabel === "reviewer") {
    if (task.options?.review) {
      return [
        ...base,
        ...assignment,
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
        "Do not attempt shell or test execution if plan mode rejects it; report that as a verification gap.",
        "Return findings in this exact structure:",
        "Severity: high|medium|low",
        "File: path:line",
        "Issue: <specific problem>",
        "Why it matters: <short rationale>",
        "Suggested fix: <concrete change>",
        "Confidence: high|medium|low",
        "Verification: tests_run|source_read|docs_read|unverified: <reason>",
        "Evidence: <file path, line, command, or observation>",
        "Call out missing tests or verification gaps separately."
      ].join("\n");
    }
    return [
      ...base,
      ...assignment,
      "",
      "Planner output:",
      plannerText,
      "",
      "Candidate patches to review:",
      candidateText,
      "",
      "Patch review pass:",
      "Review the candidates for concrete bugs, regressions, conflicts, and missing tests.",
      "Separate verified defects from preferences or tradeoffs. Any candidate preference is supporting signal for the host, not the final decision.",
      "Do not apply or edit any candidate. Do not choose for the user; report objective findings."
    ].join("\n");
  }

  if (workerLabel.startsWith("scout-")) {
    return [
      ...base,
      ...assignment,
      "",
      "Planner output:",
      plannerText,
      "",
      "Scout pass:",
      "Do not edit files.",
      scoutFocus(),
      "Do not attempt shell or test execution if plan mode rejects it; report that as a verification gap.",
      "Report concrete findings using Severity, File, Issue, Why it matters, Suggested fix, Confidence, Verification, and Evidence.",
      "Prefer useful negative findings over broad summaries."
    ].join("\n");
  }

  return [...base, ...assignment].join("\n");
}

function repoContextPrompt(task) {
  const text = String(task.repoContext?.text ?? task.contextCache?.text ?? "").trim();
  if (!text) {
    return null;
  }
  return ["Shared repo context:", text].join("\n");
}

function implementationPlanPrompt(task) {
  const text = String(task.options?.implementationPlan ?? "").trim();
  if (!text) {
    return null;
  }
  const truncated = text.length > 16000 ? `${text.slice(0, 16000)}\n...[implementation plan truncated]` : text;
  const source = task.options?.implementationPlanFile ? ` (${task.options.implementationPlanFile})` : "";
  return [`Host-authored implementation plan${source}:`, truncated].join("\n");
}

function scoutFocus() {
  return "Independently choose a useful inspection angle that adds coverage beyond the planning pass and other workers.";
}

function researchAngleForWorker(task, workerLabel) {
  const labels = researchWorkerLabels(task.options?.workers ?? defaultResearchWorkerCount(task.options ?? {}));
  const index = labels.indexOf(workerLabel);
  if (index === -1) {
    return null;
  }
  return task.options?.researchAngles?.[index] ?? null;
}

function researchAnglePrompt(task, workerLabel) {
  const angle = researchAngleForWorker(task, workerLabel);
  if (!angle) {
    return "Assigned research angle: choose a distinct angle that adds useful coverage beyond other workers.";
  }
  return `Assigned research angle: ${angle}. Stay mostly within this angle so the host model gets non-duplicative coverage.`;
}

function researchPlanPrompt(task) {
  const text = String(task.options?.researchPlan ?? "").trim();
  if (!text) {
    return null;
  }
  const truncated = text.length > 12000 ? `${text.slice(0, 12000)}\n...[research plan truncated]` : text;
  return ["Host-authored research plan:", truncated].join("\n");
}

function researchFocus(focus) {
  const requested = focus ? `Requested focus: ${focus}.` : "Requested focus: broad repository research.";
  return `${requested} Use this as the shared topic boundary while following your assigned angle.`;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  return parseJsonLine(trimmed) ?? value;
}

function formatStructuredReportObject(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => formatStructuredReportObject(entry, depth + 1))
      .filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  }

  if (Array.isArray(value.findings)) {
    const parts = value.findings
      .map((finding) => formatFindingLikeObject(finding, depth + 1))
      .filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  }

  for (const key of ["report", "review", "findings_markdown", "markdown", "final", "answer", "result", "output"]) {
    if (value[key] !== undefined) {
      const text = formatStructuredReportObject(parseMaybeJson(value[key]), depth + 1);
      if (text) {
        return text;
      }
    }
  }

  for (const key of ["plan", "steps", "items"]) {
    if (Array.isArray(value[key])) {
      const text = formatStructuredReportObject(value[key], depth + 1);
      if (text) {
        return text;
      }
    }
  }

  return formatFindingLikeObject(value, depth + 1);
}

function formatFindingLikeObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) {
    return formatStructuredReportObject(value, depth + 1);
  }
  const fields = [
    ["Severity", ["severity", "priority"]],
    ["File", ["file", "path", "location"]],
    ["Line", ["line", "lineNumber", "line_number"]],
    ["Issue", ["issue", "claim", "finding", "title", "problem", "description", "content", "text"]],
    ["Why it matters", ["why", "why_it_matters", "impact", "risk"]],
    ["Suggested fix", ["suggested_fix", "suggestedFix", "fix", "recommendation"]],
    ["Confidence", ["confidence"]],
    ["Verification", ["verification", "verified", "verified_by", "verifiedBy", "verified_by_worker"]],
    ["Evidence", ["evidence", "source", "sources"]]
  ];
  const lines = [];
  const consumed = new Set();
  for (const [label, keys] of fields) {
    const key = keys.find((candidate) => value[candidate] !== undefined && value[candidate] !== null);
    if (!key) {
      continue;
    }
    consumed.add(key);
    const text = formatStructuredReportObject(value[key], depth + 1);
    if (text) {
      lines.push(`${label}: ${text.split(/\r?\n/).join(" ")}`);
    }
  }
  if (!lines.length) {
    for (const [key, nested] of Object.entries(value)) {
      if (consumed.has(key) || ["id", "type", "name", "status"].includes(key)) {
        continue;
      }
      const text = formatStructuredReportObject(nested, depth + 1);
      if (text) {
        lines.push(`${key}: ${text.split(/\r?\n/).join(" ")}`);
      }
    }
  }
  return lines.length ? lines.join("\n") : null;
}

function toolPayloadText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const type = String(value.type ?? value.event ?? value.kind ?? "").toLowerCase();
  const name = value.name ?? value.toolName ?? value.tool_name ?? value.function?.name ?? value.call?.name;
  const isToolLike = type.includes("tool") || type.includes("function") || Boolean(name);
  if (!isToolLike) {
    return null;
  }
  const payload =
    value.input ?? value.arguments ?? value.args ?? value.parameters ?? value.call?.input ?? value.function?.arguments;
  if (payload === undefined || payload === null) {
    return null;
  }
  return formatStructuredReportObject(parseMaybeJson(payload));
}

function textFromJson(value, depth = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (depth > 6) {
    return null;
  }
  const toolText = toolPayloadText(value);
  if (toolText) {
    return toolText;
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
    const nested = textFromJson(value.message, depth + 1);
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
        if (part && typeof part === "object") {
          return textFromJson(part, depth + 1) ?? "";
        }
        return "";
      })
      .filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  for (const key of ["data", "payload", "event", "item", "response"]) {
    if (value[key] && typeof value[key] === "object") {
      const nested = textFromJson(value[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function isFinalOutputEvent(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = String(value.type ?? value.event ?? value.kind ?? "").toLowerCase();
  return (
    ["final", "result", "completed", "completion"].includes(type) ||
    value.final === true ||
    value.is_final === true
  );
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

function workerSpawnOptions(worktree) {
  return {
    cwd: worktree,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  };
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
    const finalOutputParts = [];
    let child;
    let settled = false;
    let attempts = 0;
    let retryScheduled = false;
    let idleTimer = null;
    let forceKillTimer = null;
    let timeoutDetail = null;
    let lastProgressSaveMs = 0;

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

    function saveWorkerProgress(options = {}) {
      const now = Date.now();
      if (!options.force && lastProgressSaveMs && now - lastProgressSaveMs < WORKER_PROGRESS_SAVE_INTERVAL_MS) {
        return;
      }
      if (safeLoadTask(config, workspaceRoot, task.taskId)?.status === "cancelled") {
        task.status = "cancelled";
        return;
      }
      lastProgressSaveMs = now;
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
        killPid(child.pid, { processGroup: true, signal: "SIGTERM" });
        forceKillTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          killPid(child.pid, { processGroup: true, signal: "SIGKILL" });
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
        if (parsed && isFinalOutputEvent(parsed)) {
          finalOutputParts.push(text);
        }
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
      const finalSource = finalOutputParts.length ? finalOutputParts.join("\n") : outputParts.join("\n");
      const finalOutput = cleanWorkerOutput(finalSource, prompt);
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
        child = spawn(agent.command, args, workerSpawnOptions(worktree));
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

function terminalWorkflowStatus(task) {
  if (!task.workers?.some((worker) => worker.status === "failed")) {
    return "completed";
  }
  if (task.options?.review) {
    return task.reviewer?.status === "completed" || (task.scouts ?? []).some((scout) => scout.status === "completed")
      ? "partial"
      : "failed";
  }
  return (task.candidates ?? []).some((candidate) => candidate.status === "completed") ? "partial" : "failed";
}

function failedWorkerFromRejection(task, workerLabel, reason) {
  const worker = workerForLabel(task, workerLabel);
  Object.assign(worker, {
    status: "failed",
    completedAt: new Date().toISOString(),
    error: reason instanceof Error ? reason.message : String(reason)
  });
  delete worker.pid;
  return worker;
}

function settledWorkers(task, workerLabels, results) {
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failedWorkerFromRejection(task, workerLabels[index], result.reason)
  );
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
      const researchWorkers = settledWorkers(task, researchWorkerList, settledResearchWorkers);
      task.research = researchWorkers.map((worker) => ({
        worker: workerLabelFor(worker),
        angle: researchAngleForWorker(task, workerLabelFor(worker)),
        status: worker.status,
        transcript: worker.transcript,
        notes: worker.finalOutput || "(research worker did not provide notes)",
        error: worker.error ?? null,
        exitCode: worker.exitCode ?? null
      }));
      const completedResearchWorkers = researchWorkers.filter((worker) => worker.status === "completed").length;
      const failedResearchWorkers = researchWorkers.filter((worker) => worker.status === "failed").length;
      task.status = failedResearchWorkers === 0
        ? "completed"
        : completedResearchWorkers > 0
          ? "partial"
          : "failed";
      task.completedAt = new Date().toISOString();
      delete task.backgroundPid;
      saveTask(config, workspaceRoot, task);
      return task;
    }

    const plannerWorker = task.workers.map(workerLabelFor).includes("planner");
    const planner = plannerWorker
      ? await runCursorWorker(config, workspaceRoot, task, "planner")
      : {
          finalOutput: task.options?.implementationPlan
            ? "Use the host-authored implementation plan above."
            : "",
          status: task.options?.implementationPlan ? "provided" : "skipped"
        };
    if (!plannerWorker && task.options?.implementationPlan) {
      task.planner = {
        worker: "host",
        status: "provided",
        source: "implementation_plan",
        file: task.options.implementationPlanFile ?? null,
        notes: task.options.implementationPlan
      };
      saveTask(config, workspaceRoot, task);
    }
    if (isCancelled(config, workspaceRoot, task.taskId)) {
      return markCancelled(config, workspaceRoot, task);
    }

    const scoutWorkerList = task.workers
      .map(workerLabelFor)
      .filter((label) => label?.startsWith("scout-"));
    if (scoutWorkerList.length) {
      const settledScouts = await Promise.allSettled(
        scoutWorkerList.map((label) =>
          runCursorWorker(config, workspaceRoot, task, label, { plannerOutput: planner.finalOutput })
        )
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }
      const scouts = settledWorkers(task, scoutWorkerList, settledScouts);
      task.scouts = scouts.map((scout) => ({
        worker: workerLabelFor(scout),
        status: scout.status,
        transcript: scout.transcript,
        notes: scout.finalOutput || "(scout did not provide notes)",
        error: scout.error ?? null,
        exitCode: scout.exitCode ?? null
      }));
      saveTask(config, workspaceRoot, task);
    }

    const builderWorkerList = task.workers
      .map(workerLabelFor)
      .filter((label) => label?.startsWith("builder-"));
    if (builderWorkerList.length) {
      const settledBuilders = await Promise.allSettled(
        builderWorkerList.map((label) =>
          runCursorWorker(config, workspaceRoot, task, label, { plannerOutput: planner.finalOutput })
        )
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }

      const builders = settledWorkers(task, builderWorkerList, settledBuilders);
      for (const worker of builders) {
        const label = workerLabelFor(worker);
        if (!worker.worktree || !label) {
          continue;
        }
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
      error: reviewer.error ?? null,
      exitCode: reviewer.exitCode ?? null
    };
    if (isCancelled(config, workspaceRoot, task.taskId)) {
      return markCancelled(config, workspaceRoot, task);
    }
    task.recommendedCandidateId = extractRecommendedCandidate(task);
    task.status = terminalWorkflowStatus(task);
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
    workers: options.workers ?? defaultResearchWorkerCount(options),
    focus: options.focus ?? null,
    pack: options.pack ?? null,
    angles: options.angles ?? null,
    researchPlan: options.researchPlan ?? null,
    researchPlanFile: options.researchPlanFile ?? null
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recommendedCandidateDecision(task) {
  if (task.recommendedCandidateId) {
    const existing = (task.candidates ?? []).find((candidate) => candidate.candidateId === task.recommendedCandidateId);
    if (existing) {
      return { candidateId: task.recommendedCandidateId, ambiguousCandidateIds: [] };
    }
  }
  const notes = task.reviewer?.notes ?? "";
  if (!notes.trim() || !task.candidates?.length) {
    return { candidateId: null, ambiguousCandidateIds: [] };
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
    const topScore = recommendations[0].score;
    const topCandidateIds = recommendations
      .filter((recommendation) => recommendation.score === topScore)
      .map((recommendation) => recommendation.candidate.candidateId);
    if (topCandidateIds.length === 1) {
      return { candidateId: topCandidateIds[0], ambiguousCandidateIds: [] };
    }
    return { candidateId: null, ambiguousCandidateIds: topCandidateIds };
  }

  const withPatch = task.candidates.filter((candidate) => candidate.patchFile && candidate.status === "completed");
  if (withPatch.length === 1) {
    return { candidateId: withPatch[0].candidateId, ambiguousCandidateIds: [] };
  }
  return { candidateId: null, ambiguousCandidateIds: [] };
}

export function extractRecommendedCandidate(task) {
  return recommendedCandidateDecision(task).candidateId;
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
  return statePath(config, workspaceRoot, "worktrees", assertSafeTaskId(task.taskId), "__baseline__");
}

function createBaselineWorktree(config, workspaceRoot, task) {
  const baselineDir = baselineWorktreePath(config, workspaceRoot, task);
  fs.mkdirSync(path.dirname(baselineDir), { recursive: true });
  if (fs.existsSync(baselineDir)) {
    removeWorktree(task.gitRoot ?? workspaceRoot, baselineDir);
    if (task.gitRoot) {
      runGit(task.gitRoot, ["worktree", "prune"], { allowFailure: true });
    }
  }
  if (task.options?.syntheticBase || task.baseIsEmptyTree) {
    fs.mkdirSync(baselineDir, { recursive: true });
    runGit(baselineDir, ["init", "-q"]);
    for (const relativeFilePath of snapshotFileList(task.gitRoot)) {
      copyFileIntoSnapshot(task.gitRoot, baselineDir, relativeFilePath);
    }
    runGit(baselineDir, ["add", "-A"]);
    runGit(baselineDir, [
      "-c",
      "user.name=Composer Swarm",
      "-c",
      "user.email=composer-swarm@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "composer-swarm synthetic baseline"
    ]);
    return baselineDir;
  }
  runGit(task.gitRoot, ["worktree", "add", "--detach", baselineDir, task.baseSha]);
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

export function verifyCandidatesResult(config, workspaceRoot, taskId, options = {}) {
  const task = loadTask(config, workspaceRoot, taskId);
  if (!task.candidates?.length) {
    throw new Error(`Task ${taskId} has no candidates to verify.`);
  }
  const outputs = [];
  const results = [];
  const skipped = [];
  for (const candidate of task.candidates) {
    if (candidate.status !== "completed") {
      const reason = `candidate status ${candidate.status ?? "unknown"}`;
      skipped.push({ candidateId: candidate.candidateId, reason });
      outputs.push(`Skipped ${candidate.candidateId}: ${reason}.`);
      continue;
    }
    if (!candidate.worktree) {
      const reason = "no worktree";
      skipped.push({ candidateId: candidate.candidateId, reason });
      outputs.push(`Skipped ${candidate.candidateId}: ${reason}.`);
      continue;
    }
    const result = verifyCandidate(config, workspaceRoot, taskId, candidate.candidateId, options);
    results.push(result);
    outputs.push(result.lines.join("\n"));
  }
  const output = outputs.join("\n\n");
  return {
    task: loadTask(config, workspaceRoot, taskId),
    results,
    skipped,
    output,
    failed: skipped.length > 0 || results.some((result) => result.check?.status === "failed")
  };
}

export function verifyCandidates(config, workspaceRoot, taskId, options = {}) {
  return verifyCandidatesResult(config, workspaceRoot, taskId, options).output;
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

function candidateSummary(task) {
  const candidates = task.candidates ?? [];
  const recommendation = recommendedCandidateDecision(task);
  const statusCounts = {};
  const checkCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    baseline: 0,
    candidateSpecific: 0,
    unclassified: 0,
    uncheckedCandidates: 0
  };
  for (const candidate of candidates) {
    const status = candidate.status ?? "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const checks = candidate.checks ?? [];
    if (!checks.length) {
      checkCounts.uncheckedCandidates += 1;
    }
    for (const check of checks) {
      checkCounts.total += 1;
      if (check.status === "passed") {
        checkCounts.passed += 1;
      } else if (check.status === "failed") {
        checkCounts.failed += 1;
      }
      if (check.classification === "baseline") {
        checkCounts.baseline += 1;
      } else if (check.classification === "candidate-specific") {
        checkCounts.candidateSpecific += 1;
      } else if (check.status !== "passed") {
        checkCounts.unclassified += 1;
      }
    }
  }
  return {
    total: candidates.length,
    completed: statusCounts.completed ?? 0,
    failed: statusCounts.failed ?? 0,
    withPatch: candidates.filter((candidate) => candidate.patchFile).length,
    statusCounts,
    checks: checkCounts,
    recommendedCandidateId: recommendation.candidateId,
    ambiguousRecommendedCandidateIds: recommendation.ambiguousCandidateIds
  };
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
  if (task.options?.research && (task.status === "completed" || task.status === "partial" || task.status === "failed")) {
    lines.push(`Inspect: composer-swarm result ${task.taskId} --verbose`);
    lines.push("Cross-check important research claims before acting.");
    lines.push(`Cleanup: composer-swarm cleanup ${task.taskId}`);
  } else if (task.status === "completed" || task.status === "partial" || task.status === "patches-collected") {
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
    const outputCount = taskOutputCount(task);
    lines.push(
      `${pad(task.taskId, 22)} ${pad(task.status, 17)} ${pad(outputCount, 10)} ${task.objective}`
    );
  }
  return lines.join("\n");
}

function taskOutputCount(task) {
  if (task.options?.research) {
    return task.research?.length ?? 0;
  }
  if (task.options?.review) {
    return (task.scouts?.length ?? 0) + (task.reviewer ? 1 : 0);
  }
  return task.candidates?.length ?? 0;
}

function repoContextMetadata(task) {
  const context = task.repoContext ?? task.contextCache;
  if (!context) {
    return null;
  }
  const { text, ...metadata } = context;
  return metadata;
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
  if (task.options?.researchAngles?.length) {
    lines.push(`Research angles: ${task.options.researchAngles.join(" | ")}`);
  }
  if (task.options?.researchPlan) {
    lines.push(`Research plan: ${task.options.researchPlanFile ?? "inline"}`);
  }
  if (task.options?.implementationPlan) {
    lines.push(`Implementation plan: ${task.options.implementationPlanFile ?? "inline host plan"}`);
  }
  const repoContext = task.repoContext ?? task.contextCache;
  if (repoContext) {
    lines.push(`Repo context: ${repoContext.fileCount ?? 0} files, ${repoContext.bytes ?? 0} bytes`);
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
        const angle = entry.angle ? ` (angle=${entry.angle})` : "";
        lines.push(`- ${entry.worker}: ${entry.status}${angle}`);
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

function workerStatusCounts(workers = []) {
  const counts = {};
  for (const worker of workers) {
    const status = worker.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function taskStatusJson(task) {
  const snapshot = task.options?.snapshotCurrent
    ? {
        reason: task.options.snapshotReason ?? null,
        includes_untracked: Boolean(task.options.snapshotIncludesUntracked),
        synthetic_base: Boolean(task.options.syntheticBase || task.baseIsEmptyTree)
      }
    : null;
  const payload = {
    taskId: task.taskId,
    status: task.status,
    mode: resultMode(task),
    objective: task.objective,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    baseSha: task.baseSha ?? null,
    baseBranch: task.baseBranch ?? null,
    backgroundPid: task.backgroundPid ?? null,
    repoContext: repoContextMetadata(task),
    snapshot,
    outputCount: taskOutputCount(task),
    workerStatusCounts: workerStatusCounts(task.workers),
    workers: (task.workers ?? []).map((worker) => ({
      label: workerLabelFor(worker),
      status: worker.status,
      canEdit: Boolean(worker.canEdit),
      lastOutputAt: worker.lastOutputAt ?? null,
      exitCode: worker.exitCode ?? null,
      error: worker.error ?? null
    })),
    guidance: taskGuidance(task)
  };
  if (task.options?.research) {
    payload.research = (task.research ?? []).map((entry) => ({
      worker: entry.worker,
      angle: entry.angle ?? null,
      status: entry.status,
      error: entry.error ?? null
    }));
  } else if (task.options?.review) {
    payload.reviewer = task.reviewer
      ? {
          status: task.reviewer.status,
          error: task.reviewer.error ?? null
        }
      : null;
    payload.scouts = (task.scouts ?? []).map((scout) => ({
      worker: workerLabelFor(scout),
      status: scout.status,
      error: scout.error ?? null
    }));
  } else {
    payload.candidateSummary = candidateSummary(task);
    payload.recommendedCandidateId = task.recommendedCandidateId ?? extractRecommendedCandidate(task);
  }
  return payload;
}

function formatStatusJson(tasks, workspaceRoot, taskId = null) {
  const payload = {
    schema: "composer-swarm.status.v1",
    workspaceRoot,
    taskId: taskId ?? null,
    tasks: tasks.map(taskStatusJson)
  };
  if (taskId) {
    payload.task = payload.tasks[0] ?? null;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderStatus(config, workspaceRoot, taskId = null, options = {}) {
  if (taskId) {
    const task = recoverStaleBackgroundTask(config, workspaceRoot, loadTask(config, workspaceRoot, taskId));
    if (options.json) {
      return formatStatusJson([task], workspaceRoot, taskId);
    }
    return formatTaskStatus(task);
  }
  const tasks = listTasks(config, workspaceRoot).map((task) => recoverStaleBackgroundTask(config, workspaceRoot, task));
  if (options.json) {
    return formatStatusJson(tasks, workspaceRoot, null);
  }
  return formatTaskList(tasks);
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

function scoreReportCandidate(text, event) {
  const report = String(text ?? "").trim();
  if (!report) {
    return -100;
  }
  let score = 0;
  const structured = /^Severity:\s*/im.test(report) || /\bIssue:\s*/i.test(report) || /\bEvidence:\s*/i.test(report);
  if (isFinalOutputEvent(event)) {
    score += 60;
  }
  const type = String(event?.type ?? event?.event ?? event?.kind ?? "").toLowerCase();
  if (type.includes("tool")) {
    score += 40;
  }
  if (structured) {
    score += 90;
  }
  if (!structured && report.length < 40) {
    score -= 50;
  }
  if (/You are a Composer worker|Rules:\n- Work only in the workspace/.test(report)) {
    score -= 100;
  }
  if (type === "input" || type === "progress") {
    score -= 20;
  }
  return score + Math.min(report.length, 2000) / 2000;
}

function reportTextFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const candidates = [];
  for (const entry of readTranscriptEvents(filePath)) {
    if (entry.type !== "worker-output") {
      continue;
    }
    const event = entry.event ?? null;
    const text = event ? textFromJson(event) : entry.line ?? "";
    if (!text?.trim()) {
      continue;
    }
    candidates.push({ text: text.trim(), score: scoreReportCandidate(text, event) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score > -50 ? candidates[0].text : null;
}

function shouldUseRecoveredReport(current, recovered) {
  if (!recovered?.trim()) {
    return false;
  }
  const existing = String(current ?? "").trim();
  if (!existing || /\((reviewer|scout|research worker) did not provide notes\)/i.test(existing)) {
    return true;
  }
  const recoveredLooksStructured = /^Severity:\s*/im.test(recovered) || /\bIssue:\s*/i.test(recovered);
  const existingLooksStructured = /^Severity:\s*/im.test(existing) || /\bIssue:\s*/i.test(existing);
  return recoveredLooksStructured && !existingLooksStructured;
}

function taskWithRecoveredReports(config, workspaceRoot, task) {
  const copy = JSON.parse(JSON.stringify(task));
  if (copy.reviewer?.transcript) {
    const recovered = reportTextFromTranscript(copy.reviewer.transcript);
    if (shouldUseRecoveredReport(copy.reviewer.notes, recovered)) {
      copy.reviewer.notes = recovered;
    }
  }
  if (copy.scouts?.length) {
    for (const scout of copy.scouts) {
      const recovered = reportTextFromTranscript(scout.transcript);
      if (shouldUseRecoveredReport(scout.notes, recovered)) {
        scout.notes = recovered;
      }
    }
  }
  if (copy.research?.length) {
    for (const research of copy.research) {
      const recovered = reportTextFromTranscript(research.transcript);
      if (shouldUseRecoveredReport(research.notes, recovered)) {
        research.notes = recovered;
      }
    }
  }
  return copy;
}

function parseFileLine(value) {
  let text = String(value ?? "").trim();
  if (!text) {
    return { file: null, line: null };
  }
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const lMatch = /\bL(\d+)(?:\s*[-–]\s*\d+)?\b/i.exec(text);
  if (lMatch) {
    return { file: text.slice(0, lMatch.index).trim(), line: Number(lMatch[1]) };
  }
  const match = /^(.*?):(\d+)(?:[-–]\d+)?(?::\d+)?$/.exec(text);
  if (!match) {
    return { file: text, line: null };
  }
  return { file: match[1], line: Number(match[2]) };
}

function verifiedByWorker(verification, evidence) {
  const text = `${verification ?? ""} ${evidence ?? ""}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (/\bunverified\b|blocked|not run|could not|unable|no test|not executed/.test(text)) {
    return false;
  }
  return /\btests?_run\b|\bsource_read\b|\bdocs?_read\b|\bcommand_run\b|\bexecuted\b|\bverified\b/.test(text);
}

function withVerificationMetadata(finding) {
  const normalized = {
    ...finding,
    verified_by_worker: verifiedByWorker(finding.verification, finding.evidence)
  };
  normalized.verification_tier = verificationTier(normalized);
  return normalized;
}

function appendParsedField(target, field, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return;
  }
  target[field] = target[field] ? `${target[field]}\n${text}` : text;
}

function continuationValue(rawLine, trimmedLine) {
  if (!trimmedLine) {
    return null;
  }
  if (/^\s+/.test(rawLine) || /^(?:[-*]\s+|\d+[.)]\s+)/.test(trimmedLine)) {
    return trimmedLine;
  }
  return null;
}

function normalizeFieldKey(key) {
  return String(key ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

function stripMarkdownFieldMarkup(value) {
  return String(value ?? "")
    .trim()
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^`(.+)`$/, "$1")
    .trim();
}

function parseStructuredFieldLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line) {
    return null;
  }
  if (line.startsWith("|")) {
    const cells = line.split("|").slice(1, line.endsWith("|") ? -1 : undefined).map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      return null;
    }
    const keyText = stripMarkdownFieldMarkup(cells[0]);
    const value = stripMarkdownFieldMarkup(cells.slice(1).join(" | "));
    if (!keyText || /^:?-{3,}:?$/.test(keyText) || normalizeFieldKey(keyText) === "field") {
      return null;
    }
    return { key: normalizeFieldKey(keyText), value };
  }
  const plain = stripMarkdownFieldMarkup(line.replace(/^\s*[-*]\s+/, ""));
  const match = /^([A-Za-z][A-Za-z _-]*):\s*(.*)$/.exec(plain);
  if (!match) {
    return null;
  }
  return { key: normalizeFieldKey(match[1]), value: stripMarkdownFieldMarkup(match[2]) };
}

export function parseReviewFindings(text, options = {}) {
  const sourceWorker = options.sourceWorker ?? "reviewer";
  const findings = [];
  let current = null;
  let activeField = null;

  function finishCurrent() {
    if (!current) {
      return;
    }
    const fileLine = parseFileLine(current.file);
    findings.push(withVerificationMetadata({
      severity: current.severity ?? "unknown",
      file: fileLine.file,
      line: current.line ?? fileLine.line,
      claim: current.claim ?? current.issue ?? "",
      evidence: current.evidence ?? "",
      confidence: current.confidence ?? "unknown",
      verification: current.verification ?? "unverified: not_declared",
      source_worker: sourceWorker,
      suggested_fix: current.suggestedFix ?? "",
      why_it_matters: current.whyItMatters ?? ""
    }));
    current = null;
    activeField = null;
  }

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const field = parseStructuredFieldLine(rawLine);
    if (!field) {
      const continuation = current && activeField ? continuationValue(rawLine, line) : null;
      if (continuation) {
        appendParsedField(current, activeField, continuation);
      } else {
        activeField = null;
      }
      continue;
    }
    const { key, value } = field;
    if (key === "severity") {
      finishCurrent();
      current = { severity: value.toLowerCase() };
      activeField = null;
      continue;
    }
    if (!current && [
      "file",
      "path",
      "location",
      "line",
      "line_number",
      "issue",
      "claim",
      "finding",
      "problem",
      "evidence",
      "source"
    ].includes(key)) {
      current = {};
    }
    if (!current) {
      activeField = null;
      continue;
    }
    if (key === "file" || key === "path" || key === "location") {
      current.file = value;
      activeField = null;
    } else if (key === "line" || key === "line_number") {
      const lineNumber = Number(value);
      current.line = Number.isFinite(lineNumber) ? lineNumber : null;
      activeField = null;
    } else if (key === "issue" || key === "claim" || key === "finding" || key === "problem") {
      appendParsedField(current, "claim", value);
      activeField = "claim";
    } else if (key === "evidence" || key === "source") {
      appendParsedField(current, "evidence", value);
      activeField = "evidence";
    } else if (key === "confidence") {
      current.confidence = value.toLowerCase();
      activeField = null;
    } else if (key === "verification" || key === "verified") {
      appendParsedField(current, "verification", value);
      activeField = "verification";
    } else if (key === "suggested_fix" || key === "fix" || key === "recommendation") {
      appendParsedField(current, "suggestedFix", value);
      activeField = "suggestedFix";
    } else if (key === "why_it_matters" || key === "impact" || key === "risk") {
      appendParsedField(current, "whyItMatters", value);
      activeField = "whyItMatters";
    } else {
      activeField = null;
    }
  }
  finishCurrent();
  return findings.filter((finding) => finding.claim || finding.evidence || finding.file);
}

function reviewFindingsForTask(task) {
  const entries = [];
  if (task.reviewer?.notes) {
    entries.push(...parseReviewFindings(task.reviewer.notes, { sourceWorker: "reviewer" }));
  }
  for (const scout of task.scouts ?? []) {
    entries.push(...parseReviewFindings(scout.notes, { sourceWorker: workerLabelFor(scout) ?? "scout" }));
  }
  return entries;
}

export function parseResearchFindings(text, options = {}) {
  const sourceWorker = options.sourceWorker ?? "research";
  const sourceAngle = options.angle ?? null;
  const findings = [];
  let current = null;
  let defaultConfidence = null;
  let declaredAngle = null;
  let activeField = null;

  function finishCurrent() {
    if (!current) {
      return;
    }
    findings.push(withVerificationMetadata({
      claim: current.claim ?? "",
      evidence: current.evidence ?? "",
      why_it_matters: current.whyItMatters ?? "",
      follow_up: current.followUp ?? "",
      confidence: current.confidence ?? defaultConfidence ?? "unknown",
      verification: current.verification ?? "unverified: not_declared",
      source_worker: sourceWorker,
      angle: current.angle ?? declaredAngle ?? sourceAngle
    }));
    current = null;
    activeField = null;
  }

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const findingMatch = /^-?\s*Finding:\s*(.*)$/i.exec(line);
    if (findingMatch) {
      finishCurrent();
      current = { claim: findingMatch[1].trim() };
      activeField = "claim";
      continue;
    }
    const field = parseStructuredFieldLine(rawLine);
    if (!field) {
      const continuation = current && activeField ? continuationValue(rawLine, line) : null;
      if (continuation) {
        appendParsedField(current, activeField, continuation);
      } else {
        activeField = null;
      }
      continue;
    }
    const { key, value } = field;
    if (key === "confidence" && !current) {
      defaultConfidence = value.toLowerCase();
      activeField = null;
      continue;
    }
    if (key === "angle" && !current) {
      declaredAngle = value;
      activeField = null;
      continue;
    }
    if (!current) {
      activeField = null;
      continue;
    }
    if (key === "claim" || key === "issue" || key === "problem") {
      appendParsedField(current, "claim", value);
      activeField = "claim";
    } else if (key === "evidence" || key === "source") {
      appendParsedField(current, "evidence", value);
      activeField = "evidence";
    } else if (key === "why_it_matters" || key === "impact" || key === "risk") {
      appendParsedField(current, "whyItMatters", value);
      activeField = "whyItMatters";
    } else if (key === "follow_up" || key === "followup" || key === "next_step") {
      appendParsedField(current, "followUp", value);
      activeField = "followUp";
    } else if (key === "confidence") {
      current.confidence = value.toLowerCase();
      activeField = null;
    } else if (key === "verification" || key === "verified") {
      appendParsedField(current, "verification", value);
      activeField = "verification";
    } else if (key === "angle") {
      current.angle = value;
      activeField = null;
    } else {
      activeField = null;
    }
  }
  finishCurrent();
  return findings.filter((finding) => finding.claim || finding.evidence);
}

function researchFindingsForTask(task) {
  const entries = [];
  for (const research of task.research ?? []) {
    entries.push(
      ...parseResearchFindings(research.notes, {
        sourceWorker: research.worker,
        angle: research.angle ?? null
      })
    );
  }
  return entries;
}

function resultMode(task) {
  if (task.options?.research) {
    return "research";
  }
  if (task.options?.review) {
    return "review";
  }
  return "team";
}

function findingsForTask(task) {
  if (task.options?.research) {
    return researchFindingsForTask(task);
  }
  if (task.options?.review) {
    return reviewFindingsForTask(task);
  }
  return [];
}

function verificationText(finding) {
  const text = String(finding.verification ?? "").trim();
  return text || "unverified: not_declared";
}

function verificationTier(finding) {
  const text = verificationText(finding).toLowerCase();
  if (!finding.verified_by_worker) {
    return "unverified";
  }
  if (/\btests?_run\b|\bcommand_run\b|\bexecuted\b/.test(text)) {
    return "executed";
  }
  if (/\bsource_read\b|\bdocs?_read\b/.test(text)) {
    return "source";
  }
  return "declared";
}

function verificationSignal(finding) {
  const text = verificationText(finding).toLowerCase();
  return text.split(/[;,]/)[0]?.trim() || "unverified: not_declared";
}

function verificationCounts(findings) {
  const counts = {
    executed: 0,
    source: 0,
    declared: 0,
    unverified: 0
  };
  const signals = new Map();
  for (const finding of findings) {
    counts[verificationTier(finding)] += 1;
    const signal = verificationSignal(finding);
    signals.set(signal, (signals.get(signal) ?? 0) + 1);
  }
  return { counts, signals };
}

function sourceLabelForFinding(finding) {
  return [finding.source_worker, finding.angle].filter(Boolean).join("; ") || "unknown";
}

function findingLocation(finding) {
  const location = [finding.file, finding.line].filter((part) => part !== null && part !== undefined).join(":");
  return location || "(no file)";
}

function normalizedFindingKey(finding) {
  const claim = String(finding.claim ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [finding.file ?? "", finding.line ?? "", claim || String(finding.evidence ?? "").toLowerCase()].join("|");
}

function groupedFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = normalizedFindingKey(finding);
    const source = sourceLabelForFinding(finding);
    if (!groups.has(key)) {
      groups.set(key, {
        finding,
        findings: [],
        sources: new Set()
      });
    }
    const group = groups.get(key);
    group.findings.push(finding);
    group.sources.add(source);
  }
  return [...groups.values()];
}

function formatSignalCounts(signals) {
  if (!signals.size) {
    return "none";
  }
  return [...signals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([signal, count]) => `${signal}=${count}`)
    .join(", ");
}

function signalCountsObject(signals) {
  return Object.fromEntries([...signals.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function sourceFindings(findings, sourceWorker) {
  return findings.filter((finding) => finding.source_worker === sourceWorker);
}

function coverageCounts(findings) {
  const { counts } = verificationCounts(findings);
  return {
    findings: findings.length,
    executed: counts.executed,
    source: counts.source,
    declared: counts.declared,
    unverified: counts.unverified
  };
}

function synthesisCoverageEntries(task, findings) {
  const entries = [];
  const seen = new Set();
  if (task.options?.research) {
    for (const entry of task.research ?? []) {
      const worker = entry.worker ?? "research";
      seen.add(worker);
      entries.push({
        worker,
        status: entry.status ?? "unknown",
        angle: entry.angle ?? null,
        recovered: false,
        ...coverageCounts(sourceFindings(findings, worker))
      });
    }
  } else if (task.options?.review) {
    if (task.reviewer) {
      seen.add("reviewer");
      entries.push({
        worker: "reviewer",
        status: task.reviewer.status ?? "unknown",
        angle: null,
        recovered: false,
        ...coverageCounts(sourceFindings(findings, "reviewer"))
      });
    }
    for (const scout of task.scouts ?? []) {
      const worker = workerLabelFor(scout) ?? "scout";
      seen.add(worker);
      entries.push({
        worker,
        status: scout.status ?? "unknown",
        angle: null,
        recovered: false,
        ...coverageCounts(sourceFindings(findings, worker))
      });
    }
  }
  for (const finding of findings) {
    const worker = finding.source_worker ?? "unknown";
    if (!seen.has(worker)) {
      seen.add(worker);
      entries.push({
        worker,
        status: "recovered",
        angle: null,
        recovered: true,
        ...coverageCounts(sourceFindings(findings, worker))
      });
    }
  }
  return entries;
}

function synthesisCoverageLines(task, findings) {
  const entries = synthesisCoverageEntries(task, findings);
  if (!entries.length) {
    return ["- no worker outputs recorded yet"];
  }
  const lines = [];
  for (const entry of entries) {
    if (entry.recovered) {
      lines.push(`- ${entry.worker}: recovered; findings=${entry.findings}; executed=${entry.executed}; source=${entry.source}; declared=${entry.declared}; unverified=${entry.unverified}`);
      continue;
    }
    const angle = entry.angle ? `; angle=${entry.angle}` : "";
    lines.push(
      `- ${entry.worker}: ${entry.status}${angle}; findings=${entry.findings}; executed=${entry.executed}; source=${entry.source}; declared=${entry.declared}; unverified=${entry.unverified}`
    );
  }
  if (!lines.length) {
    lines.push("- no worker outputs recorded yet");
  }
  return lines;
}

function formatSynthesisFindings(findings) {
  const groups = groupedFindings(findings);
  if (!groups.length) {
    return ["- none parsed"];
  }
  const severityRank = new Map([
    ["critical", 0],
    ["high", 1],
    ["medium", 2],
    ["low", 3],
    ["info", 4],
    ["unknown", 5]
  ]);
  groups.sort((a, b) => {
    const aSeverity = severityRank.get(a.finding.severity ?? "unknown") ?? 5;
    const bSeverity = severityRank.get(b.finding.severity ?? "unknown") ?? 5;
    if (aSeverity !== bSeverity) {
      return aSeverity - bSeverity;
    }
    return String(a.finding.claim ?? "").localeCompare(String(b.finding.claim ?? ""));
  });
  const lines = [];
  for (const group of groups.slice(0, 20)) {
    const finding = group.finding;
    const tierCounts = verificationCounts(group.findings).counts;
    const tiers = [
      tierCounts.executed ? `executed=${tierCounts.executed}` : null,
      tierCounts.source ? `source=${tierCounts.source}` : null,
      tierCounts.declared ? `declared=${tierCounts.declared}` : null,
      tierCounts.unverified ? `unverified=${tierCounts.unverified}` : null
    ]
      .filter(Boolean)
      .join(", ");
    const severity = finding.severity ? `${finding.severity} ` : "";
    const sources = [...group.sources].slice(0, 4).join(" | ");
    const sourceSuffix = group.sources.size > 4 ? `${sources} | +${group.sources.size - 4} more` : sources;
    lines.push(
      `- ${severity}${findingLocation(finding)} ${finding.claim || "(no claim)"} [${finding.confidence ?? "unknown"}; ${tiers || "no verification"}; ${sourceSuffix}]`
    );
    if (finding.evidence) {
      lines.push(`  Evidence: ${finding.evidence}`);
    }
    if (finding.follow_up) {
      lines.push(`  Follow-up: ${finding.follow_up}`);
    }
  }
  if (groups.length > 20) {
    lines.push(`- ${groups.length - 20} additional parsed finding group(s) omitted from synthesis`);
  }
  return lines;
}

function synthesisFollowUpLines(mode, findings) {
  const lines = [];
  const unverified = findings.filter((finding) => verificationTier(finding) === "unverified");
  const executed = findings.filter((finding) => verificationTier(finding) === "executed");
  if (!findings.length) {
    lines.push("- No parsed findings; inspect `result --verbose` before concluding workers found nothing.");
  }
  if (!executed.length) {
    lines.push("- No parsed finding reports tests_run or command_run; run local checks for behavioral claims.");
  }
  if (unverified.length) {
    const examples = unverified
      .slice(0, 3)
      .map((finding) => finding.claim || finding.evidence || "(no claim)")
      .join("; ");
    lines.push(`- Recheck ${unverified.length} unverified finding(s) before using them: ${examples}`);
  }
  if (mode === "review") {
    const sourceOnlyReleaseRisks = findings.filter((finding) => {
      const severity = String(finding.severity ?? "").toLowerCase();
      return (severity === "critical" || severity === "high" || severity === "medium") && verificationTier(finding) !== "executed";
    });
    if (sourceOnlyReleaseRisks.length) {
      lines.push(
        `- Validate ${sourceOnlyReleaseRisks.length} high/medium review finding(s) with local reproduction or tests before treating them as release blockers.`
      );
    }
  }
  if (!lines.length) {
    lines.push("- Cross-check cited files and commands in the main checkout before acting.");
  }
  return lines;
}

function synthesisMetadata(task, findings) {
  const mode = resultMode(task);
  const { counts, signals } = verificationCounts(findings);
  return {
    role: {
      composerOutput: "scout",
      mainModelReviewerOfRecord: true
    },
    workerCoverage: synthesisCoverageEntries(task, findings),
    verificationSummary: {
      totalFindings: findings.length,
      executed: counts.executed,
      source: counts.source,
      declared: counts.declared,
      unverified: counts.unverified,
      signals: signalCountsObject(signals)
    },
    hostFollowUpChecks: synthesisFollowUpLines(mode, findings).map((line) => line.replace(/^- /, ""))
  };
}

function formatSynthesisBrief(task) {
  const mode = resultMode(task);
  if (mode !== "review" && mode !== "research") {
    return formatResult(task, { synthesis: false });
  }
  const findings = findingsForTask(task);
  const { counts, signals } = verificationCounts(findings);
  const lines = [
    "Host synthesis brief",
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Mode: ${mode}`,
    `${mode === "research" ? "Research question" : "Review objective"}: ${task.objective}`,
    "",
    "Role:",
    "- Composer output is scout work for the host model.",
    "- Main model remains reviewer of record; verify important claims before acting."
  ];
  if (task.options?.snapshotCurrent) {
    lines.push(`- Snapshot: current checkout (${task.options.snapshotReason ?? "requested"})`);
  }
  if (task.options?.researchPack) {
    lines.push(`- Research pack: ${task.options.researchPack}`);
  }
  if (task.options?.researchPlan) {
    lines.push(`- Research plan: ${task.options.researchPlanFile ?? "inline"}`);
  }
  if (task.options?.researchAngles?.length) {
    lines.push(`- Expected angles: ${task.options.researchAngles.join(" | ")}`);
  }
  const repoContext = task.repoContext ?? task.contextCache;
  if (repoContext) {
    lines.push(`- Repo context: ${repoContext.fileCount ?? 0} files, ${repoContext.bytes ?? 0} bytes`);
  }
  lines.push("");
  lines.push("Coverage:");
  lines.push(...synthesisCoverageLines(task, findings));
  lines.push("");
  lines.push("Verification summary:");
  lines.push(`- Total parsed findings: ${findings.length}`);
  lines.push(`- Executed tests/commands: ${counts.executed}`);
  lines.push(`- Source/docs read only: ${counts.source}`);
  lines.push(`- Worker-declared verification: ${counts.declared}`);
  lines.push(`- Unverified or blocked: ${counts.unverified}`);
  lines.push(`- Signals: ${formatSignalCounts(signals)}`);
  lines.push("");
  lines.push("Finding groups:");
  lines.push(...formatSynthesisFindings(findings));
  lines.push("");
  lines.push("Host follow-up checks:");
  lines.push(...synthesisFollowUpLines(mode, findings));
  return lines.join("\n");
}

function formatFindingsOnly(task) {
  const findings = task.options?.research ? researchFindingsForTask(task) : reviewFindingsForTask(task);
  const lines = [`Task: ${task.taskId}`, `Status: ${task.status}`, "", "Findings:"];
  if (!findings.length) {
    lines.push("- none parsed");
  } else {
    for (const finding of findings) {
      const location = [finding.file, finding.line].filter((part) => part !== null && part !== undefined).join(":");
      const source = [finding.source_worker, finding.angle].filter(Boolean).join("; ");
      const tier = finding.verification_tier ?? verificationTier(finding);
      lines.push(
        `- ${finding.severity ?? "research"} ${location || "(no file)"} ${finding.claim || "(no claim)"} [confidence=${finding.confidence}; tier=${tier}; verification=${finding.verification}${source ? `; ${source}` : ""}]`
      );
      if (finding.evidence) {
        lines.push(`  Evidence: ${finding.evidence}`);
      }
      if (finding.follow_up) {
        lines.push(`  Follow-up: ${finding.follow_up}`);
      }
    }
  }
  return lines.join("\n");
}

function formatResultJson(task, options = {}) {
  const mode = resultMode(task);
  const payload = {
    schema: "composer-swarm.result.v1",
    taskId: task.taskId,
    status: task.status,
    mode,
    objective: task.objective,
    baseSha: task.baseSha ?? null,
    baseBranch: task.baseBranch ?? null,
    repoContext: repoContextMetadata(task),
    snapshot: task.options?.snapshotCurrent
      ? {
          reason: task.options.snapshotReason ?? null,
          includes_untracked: Boolean(task.options.snapshotIncludesUntracked),
          synthetic_base: Boolean(task.options.syntheticBase || task.baseIsEmptyTree)
        }
      : null
  };
  if (mode === "review") {
    const findings = reviewFindingsForTask(task);
    payload.findings = findings;
    payload.synthesis = synthesisMetadata(task, findings);
    payload.reviewer = task.reviewer
      ? {
          status: task.reviewer.status,
          transcript: task.reviewer.transcript ?? null,
          error: task.reviewer.error ?? null
        }
      : null;
    payload.scouts = (task.scouts ?? []).map((scout) => ({
      worker: workerLabelFor(scout),
      status: scout.status,
      transcript: scout.transcript ?? null,
      error: scout.error ?? null
    }));
  } else if (mode === "research") {
    payload.focus = task.options?.focus ?? null;
    payload.researchPack = task.options?.researchPack ?? null;
    payload.researchPlanFile = task.options?.researchPlanFile ?? null;
    payload.researchPlan = task.options?.researchPlan ?? null;
    payload.researchAngles = task.options?.researchAngles ?? [];
    const findings = researchFindingsForTask(task);
    payload.findings = findings;
    payload.synthesis = synthesisMetadata(task, findings);
    payload.research = (task.research ?? []).map((entry) => ({
      worker: entry.worker,
      angle: entry.angle ?? null,
      status: entry.status,
      confidence: /confidence:\s*(high|medium|low)/i.exec(entry.notes ?? "")?.[1]?.toLowerCase() ?? null,
      transcript: entry.transcript ?? null,
      notes: options.verbose ? entry.notes ?? "" : reviewerNotesExcerpt(entry.notes, 500),
      error: entry.error ?? null
    }));
  } else {
    payload.implementationPlanFile = task.options?.implementationPlanFile ?? null;
    payload.implementationPlan = task.options?.implementationPlan ?? null;
    payload.planner = task.planner
      ? {
          worker: task.planner.worker ?? null,
          status: task.planner.status ?? null,
          source: task.planner.source ?? null,
          file: task.planner.file ?? null
        }
      : null;
    payload.candidates = (task.candidates ?? []).map((candidate) => ({
      candidateId: candidate.candidateId,
      workerLabel: candidateWorkerLabel(candidate),
      status: candidate.status,
      changedFiles: candidate.changedFiles ?? [],
      patchBytes: candidate.patchBytes ?? 0,
      patchFile: candidate.patchFile ?? null,
      checks: candidate.checks ?? []
    }));
    payload.reviewer = task.reviewer
      ? {
          worker: task.reviewer.worker ?? "reviewer",
          status: task.reviewer.status ?? null,
          transcript: task.reviewer.transcript ?? null,
          error: task.reviewer.error ?? null,
          notes: options.verbose ? task.reviewer.notes ?? "" : reviewerNotesExcerpt(task.reviewer.notes, 500)
        }
      : null;
    payload.recommendedCandidateId = task.recommendedCandidateId ?? extractRecommendedCandidate(task);
    payload.candidateSummary = candidateSummary(task);
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function formatResult(task, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? task.workspaceRoot ?? process.cwd();
  const verbose = Boolean(options.verbose);
  if (options.json) {
    return formatResultJson(task, { workspaceRoot, verbose });
  }
  if (options.findings) {
    return task.options?.review || task.options?.research
      ? formatFindingsOnly(task)
      : formatResult(task, { ...options, findings: false });
  }
  if (options.synthesis) {
    return task.options?.review || task.options?.research
      ? formatSynthesisBrief(task)
      : formatResult(task, { ...options, synthesis: false });
  }
  if (task.options?.research) {
    return formatResearchResult(task, { workspaceRoot, verbose });
  }
  if (task.options?.review) {
    return formatReviewResult(task, { workspaceRoot, verbose });
  }
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Objective: ${task.objective}`,
    ""
  ];
  if (task.options?.implementationPlan) {
    lines.splice(3, 0, `Implementation plan: ${task.options.implementationPlanFile ?? "inline host plan"}`);
  }
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

function formatReviewResult(task, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? task.workspaceRoot ?? process.cwd();
  const verbose = Boolean(options.verbose);
  const lines = [
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Review objective: ${task.objective}`,
    "",
    "Review report:"
  ];
  if (task.reviewer?.error) {
    lines.push(`Reviewer error: ${task.reviewer.error}`);
  }
  lines.push(task.reviewer?.notes ?? "No reviewer notes recorded yet.");
  if (verbose) {
    lines.push("", "Scout notes:");
    if (!task.scouts?.length) {
      lines.push("- none");
    } else {
      for (const scout of task.scouts) {
        lines.push("");
        lines.push(`Scout: ${workerLabelFor(scout) ?? "unknown"}`);
        lines.push(`Status: ${scout.status}`);
        if (scout.transcript) {
          lines.push(`Transcript: ${relativePath(workspaceRoot, scout.transcript)}`);
        }
        lines.push(scout.notes ?? "No scout notes recorded.");
      }
    }
  } else if (task.scouts?.length) {
    lines.push("", `(use --verbose for ${task.scouts.length} scout note${task.scouts.length === 1 ? "" : "s"})`);
  }
  lines.push("");
  lines.push("Main agent guidance:");
  lines.push("- Treat this as scout output, not a reviewer of record.");
  lines.push("- Verify high and medium severity claims against source before acting.");
  lines.push("- Run local repo checks yourself when behavior matters; read-only workers may not execute tests.");
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
  if (task.options?.researchPack) {
    lines.push(`Pack: ${task.options.researchPack}`);
  }
  if (task.options?.researchPlan) {
    lines.push(`Plan: ${task.options.researchPlanFile ?? "inline"}`);
  }
  if (task.options?.researchAngles?.length) {
    lines.push(`Angles: ${task.options.researchAngles.join(" | ")}`);
  }
  lines.push("", "Research outputs:");
  if (!task.research?.length) {
    lines.push("- none recorded yet");
  } else {
    for (const entry of task.research) {
      lines.push("", `${workerDisplayName(entry.worker)}:`);
      lines.push(`Status: ${entry.status}`);
      if (entry.angle) {
        lines.push(`Angle: ${entry.angle}`);
      }
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
  lines.push("- Treat Composer findings as scout output, not authority or a reviewer of record.");
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
  return formatResult(taskWithRecoveredReports(config, workspaceRoot, task), { workspaceRoot, ...options });
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
  return candidate.candidateId === requested || label === requested;
}

function findCandidate(task, requested) {
  return (task.candidates ?? []).find((candidate) => candidateMatches(candidate, requested)) ?? null;
}

function assertTaskBaseStillCurrent(task, workspaceRoot) {
  const gitRoot = task.gitRoot ?? workspaceRoot;
  const expected = task.baseSha ?? null;
  if (!expected) {
    return;
  }
  const current = gitHead(gitRoot, { allowUnborn: true });
  const expectedEmptyTree = expected === EMPTY_TREE_SHA || task.baseIsEmptyTree || task.options?.syntheticBase;
  if (expectedEmptyTree) {
    if (current) {
      throw new Error(
        `Main checkout HEAD changed since task ${task.taskId} was created. Expected an unborn HEAD/empty-tree base, found ${current}. Re-run the task before applying a candidate.`
      );
    }
    return;
  }
  if (current !== expected) {
    throw new Error(
      `Main checkout HEAD changed since task ${task.taskId} was created. Expected ${expected}, found ${current ?? "unborn HEAD"}. Re-run the task before applying a candidate.`
    );
  }
}

export function applyCandidate(config, workspaceRoot, taskId, requestedCandidateId, options = {}) {
  const task = loadTask(config, workspaceRoot, taskId);
  if (task.status === "applied") {
    throw new Error(
      `Task ${taskId} already applied candidate ${task.selectedCandidateId ?? "(unknown)"}. Re-run the task before applying another candidate.`
    );
  }
  let candidateId = requestedCandidateId;
  if (options.recommended || candidateId === "--recommended") {
    const recommendation = recommendedCandidateDecision(task);
    candidateId = recommendation.candidateId;
    if (!candidateId) {
      if (recommendation.ambiguousCandidateIds.length) {
        throw new Error(
          `Recommended candidate is ambiguous for task ${taskId}: ${recommendation.ambiguousCandidateIds.join(", ")}. Use --candidate <candidate-id>.`
        );
      }
      throw new Error(
        `No recommended candidate for task ${taskId}. Inspect reviewer notes with: composer-swarm result ${taskId} --verbose`
      );
    }
  }
  const candidate = findCandidate(task, candidateId);
  if (!candidate) {
    throw new Error(`Candidate not found for task ${taskId}: ${candidateId ?? requestedCandidateId}`);
  }
  if (candidate.status && candidate.status !== "completed") {
    throw new Error(`Candidate ${candidate.candidateId} is ${candidate.status}; only completed candidates can be applied.`);
  }
  if (!candidate.patchFile) {
    throw new Error(`Candidate ${candidate.candidateId} has no patch to apply.`);
  }
  if (!fs.existsSync(candidate.patchFile)) {
    throw new Error(`Patch file is missing: ${candidate.patchFile}`);
  }

  assertCleanMainCheckout(task.gitRoot ?? workspaceRoot);
  assertTaskBaseStillCurrent(task, workspaceRoot);
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
  const signal = options.signal ?? "SIGTERM";
  if (options.processGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      killed = true;
    } catch {
      // Fall back to signalling the single PID below.
    }
  }
  try {
    process.kill(pid, signal);
    killed = true;
  } catch {
    // The process may already have exited, or the PID may be stale.
  }
  return killed;
}

function pidIsAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recoverStaleBackgroundTask(config, workspaceRoot, task) {
  if (task.status !== "running" || !task.backgroundPid || pidIsAlive(task.backgroundPid)) {
    return task;
  }
  const message = `Background process ${task.backgroundPid} is no longer running. Marked task failed so it can be inspected or cleaned up.`;
  task.status = "failed";
  task.error = task.error ?? message;
  task.completedAt = task.completedAt ?? new Date().toISOString();
  for (const worker of task.workers ?? []) {
    if (worker.status === "running" || worker.status === "pending") {
      killPid(worker.pid, { processGroup: true });
      worker.status = "failed";
      worker.error = worker.error ?? message;
      delete worker.pid;
    }
  }
  delete task.backgroundPid;
  saveTask(config, workspaceRoot, task);
  return task;
}

export function cancelTask(config, workspaceRoot, taskId) {
  const task = loadTask(config, workspaceRoot, taskId);
  const killed = [];
  if (killPid(task.backgroundPid, { processGroup: true })) {
    killed.push(task.backgroundPid);
  }
  delete task.backgroundPid;
  for (const worker of task.workers ?? []) {
    if (killPid(worker.pid, { processGroup: true })) {
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
  const task = recoverStaleBackgroundTask(config, workspaceRoot, loadTask(config, workspaceRoot, taskId));
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
    lines: [
      `Cleaned ${taskId}.`,
      removed.length ? `Removed worktrees:\n${removed.map((entry) => `- ${entry}`).join("\n")}` : "No worktrees needed removal.",
      `Retained task metadata and transcripts under ${relativePath(workspaceRoot, stateRoot(config, workspaceRoot))}.`
    ]
  };
}

export function cleanupTasks(config, workspaceRoot, taskId = null) {
  if (taskId) {
    return cleanupTask(config, workspaceRoot, taskId).lines.join("\n");
  }
  const outputs = [];
  for (const listedTask of listTasks(config, workspaceRoot)) {
    const task = recoverStaleBackgroundTask(config, workspaceRoot, listedTask);
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
