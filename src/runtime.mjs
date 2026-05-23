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
      stateDir: DEFAULT_STATE_DIR,
      defaultRoles: ["planner", "builder-a", "builder-b", "reviewer", "verifier"]
    },
    distribution: {
      userPromise: "Add a team of Composer workers to the coding agent you already use.",
      primaryHosts: ["claude-code", "codex"],
      defaultWorkerKind: "cursor-cli"
    },
    agents: [
      {
        id: "host-operator",
        kind: "host",
        role: "operator",
        canEdit: false,
        notes: "The user's current cockpit: Claude Code, Codex, or another agent."
      },
      {
        id: "composer-planner",
        kind: "cursor-cli",
        role: "planner",
        command: "cursor-agent",
        canEdit: false
      },
      {
        id: "composer-builder-a",
        kind: "cursor-cli",
        role: "builder-a",
        command: "cursor-agent",
        canEdit: true
      },
      {
        id: "composer-builder-b",
        kind: "cursor-cli",
        role: "builder-b",
        command: "cursor-agent",
        canEdit: true
      },
      {
        id: "composer-reviewer",
        kind: "cursor-cli",
        role: "reviewer",
        command: "cursor-agent",
        canEdit: false
      },
      {
        id: "shell-verifier",
        kind: "shell",
        role: "verifier",
        command: "bash",
        args: ["-lc", "npm test"],
        canEdit: false
      }
    ],
    policies: {
      worktreeIsolation: true,
      manualApplyRequired: true,
      maxComposerWorkers: 4,
      leaseTtlSeconds: 600,
      requireReviewBeforeComplete: true,
      defaultNetwork: false
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
    config.agents = config.agents.map((agent) =>
      agent.kind === "cursor-cli" ? { ...agent, args: ["--trust"] } : agent
    );
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
  return {
    ...base,
    ...parsed,
    swarm: {
      ...base.swarm,
      ...(parsed.swarm ?? {})
    },
    policies: {
      ...base.policies,
      ...(parsed.policies ?? {})
    },
    distribution: {
      ...base.distribution,
      ...(parsed.distribution ?? {})
    },
    agents: Array.isArray(parsed.agents) ? parsed.agents : base.agents
  };
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
  lines.push(`Node: ${process.version}`);

  const gitAvailable = commandAvailable("git");
  if (gitAvailable) {
    lines.push("- git: ok");
  } else {
    ok = false;
    lines.push("- git: missing command");
  }

  lines.push(`Agents: ${(config.agents ?? []).length}`);
  for (const agent of config.agents ?? []) {
    const available = commandAvailable(agent.command);
    if (available === null) {
      lines.push(`- ${agent.id}: host-driven (${agent.kind}, role=${agent.role})`);
      continue;
    }
    if (available) {
      const trustNote = agent.kind === "cursor-cli" && (agent.args ?? []).includes("--trust") ? " [trust]" : "";
      lines.push(`- ${agent.id}: ok (${agent.command})${trustNote}`);
    } else {
      ok = false;
      lines.push(`- ${agent.id}: missing command (${agent.command})`);
    }
  }

  return { ok, lines };
}

function agentForRole(config, role) {
  return (config.agents ?? []).find((agent) => agent.role === role) ?? null;
}

function fallbackCursorAgent(role) {
  return {
    id: `composer-${role}`,
    kind: "cursor-cli",
    role,
    command: "cursor-agent",
    canEdit: role.startsWith("builder-")
  };
}

export function planTask(config, taskText, options = {}) {
  const roles = options.roles?.length ? options.roles : config.swarm?.defaultRoles ?? [];
  return {
    schema: "composer-swarm.plan.v1",
    objective: taskText,
    roles: roles.map((role) => {
      const agent = agentForRole(config, role);
      return {
        role,
        agentId: agent?.id ?? null,
        kind: agent?.kind ?? null,
        canEdit: Boolean(agent?.canEdit),
        status: agent ? "mapped" : "unmapped",
        objective: roleObjective(role, taskText)
      };
    })
  };
}

function roleObjective(role, taskText) {
  switch (role) {
    case "operator":
      return `Stay in the user's current host, supervise the Composer team, and choose the final patch: ${taskText}`;
    case "planner":
      return `Decompose the task, identify file scopes, and define acceptance criteria for Composer builders: ${taskText}`;
    case "builder-a":
      return `Attempt the smallest direct implementation in an isolated worktree: ${taskText}`;
    case "builder-b":
      return `Attempt an alternate implementation or parallel subtask in an isolated worktree: ${taskText}`;
    case "reviewer":
      return `Review candidate Composer patches for concrete defects, regressions, and missing tests: ${taskText}`;
    case "adversary":
      return `Challenge assumptions, edge cases, and whether the approach is too complex: ${taskText}`;
    case "verifier":
      return `Run or define reproducible checks against the selected candidate and report exact results: ${taskText}`;
    default:
      if (role.startsWith("builder-")) {
        return `Attempt an implementation in an isolated worktree: ${taskText}`;
      }
      return taskText;
  }
}

export function formatPlan(plan) {
  const lines = [`Objective: ${plan.objective}`, "", "Composer team:"];
  for (const entry of plan.roles) {
    const agent = entry.agentId ? `${entry.agentId} (${entry.kind})` : "unmapped";
    lines.push(`- ${entry.role}: ${agent}`);
    lines.push(`  ${entry.objective}`);
  }
  return lines.join("\n");
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

export function assertCleanMainCheckout(gitRoot) {
  const status = mainCheckoutStatus(gitRoot);
  if (status) {
    throw new Error(`Main checkout has changes. Commit, stash, or remove them before continuing.\n${status}`);
  }
}

function gitHead(gitRoot) {
  return runGit(gitRoot, ["rev-parse", "HEAD"]).stdout.trim();
}

function gitBranch(gitRoot) {
  const result = runGit(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function builderRoles(count = 2) {
  const numeric = Number.isFinite(Number(count)) ? Number(count) : 2;
  if (numeric <= 0) {
    return [];
  }
  const bounded = Math.max(1, Math.min(BUILDER_SUFFIXES.length, Math.trunc(numeric)));
  return BUILDER_SUFFIXES.slice(0, bounded).map((suffix) => `builder-${suffix}`);
}

function executionRoles(options = {}) {
  if (options.review) {
    return ["planner", "reviewer"];
  }
  return ["planner", ...builderRoles(options.builders ?? 2), "reviewer"];
}

export function createTeamTask(config, workspaceRoot, objective, options = {}) {
  const gitRoot = requireGitWorkspace(workspaceRoot);
  assertCleanMainCheckout(gitRoot);
  ensureStateDirs(config, workspaceRoot);

  const taskId = options.taskId ?? createTaskId();
  const createdAt = new Date().toISOString();
  const requestedBuilders = options.builders ?? 2;
  const builderCount = builderRoles(requestedBuilders).length;
  if (!options.review && builderCount < 1) {
    throw new Error("composer-swarm team requires 1 to 4 builders.");
  }
  const roles = executionRoles(options);
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
      builders: options.review ? 0 : builderCount,
      model: options.model ?? null,
      background: Boolean(options.background),
      review: Boolean(options.review)
    },
    workers: roles.map((role) => {
      const agent = agentForRole(config, role) ?? fallbackCursorAgent(role);
      return {
        role,
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

function workerForRole(task, role) {
  const worker = task.workers.find((entry) => entry.role === role);
  if (!worker) {
    throw new Error(`Task ${task.taskId} has no worker for role ${role}`);
  }
  return worker;
}

function candidateIdFor(task, role) {
  return `${task.taskId}-${role}`;
}

function relativePath(workspaceRoot, filePath) {
  return path.relative(workspaceRoot, filePath) || ".";
}

function transcriptPath(config, workspaceRoot, taskId, role) {
  return statePath(config, workspaceRoot, "transcripts", taskId, `${role}.jsonl`);
}

function artifactPath(config, workspaceRoot, taskId, candidateId) {
  return statePath(config, workspaceRoot, "artifacts", taskId, `${candidateId}.patch`);
}

function appendTranscript(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function createWorktree(config, workspaceRoot, task, role) {
  const worktree = statePath(config, workspaceRoot, "worktrees", task.taskId, role);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (fs.existsSync(worktree)) {
    return worktree;
  }
  runGit(task.gitRoot, ["worktree", "add", "--detach", worktree, task.baseSha]);
  return worktree;
}

export function buildCursorAgentArgs({ role, worktree, prompt, model }) {
  const args = ["--print", "--output-format", "stream-json", "--workspace", worktree];
  if (model) {
    args.push("--model", model);
  }
  if (role === "planner" || role === "reviewer") {
    args.push("--mode=plan");
  }
  args.push(prompt);
  return args;
}

export function buildRolePrompt(role, task, context = {}) {
  const plannerText = context.plannerOutput?.trim() || "No planner output is available yet.";
  const candidateText = context.candidateText?.trim() || "No candidates are available yet.";
  const base = [
    "You are a Composer worker launched by composer-swarm.",
    `Task id: ${task.taskId}`,
    `Role: ${role}`,
    `Objective: ${task.objective}`,
    `Base commit: ${task.baseSha ?? "unknown"}`,
    "",
    "Rules:",
    "- Work only in the workspace passed to cursor-agent.",
    "- Keep changes narrowly scoped to the objective.",
    "- Prefer existing project patterns over new abstractions.",
    "- Report exact checks you ran and their results.",
    "- End with a concise summary, changed files, risks, and follow-up notes."
  ];

  if (role === "planner") {
    if (task.options?.review) {
      return [
        ...base,
        "",
        "Review planning task:",
        "Define the repository areas the reviewer should inspect.",
        "Identify likely risk hotspots, missing verification, and documentation gaps.",
        "Do not edit files."
      ].join("\n");
    }
    return [
      ...base,
      "",
      "Planner task:",
      "Produce a scoped implementation plan for the builders.",
      "Identify likely files, acceptance criteria, risks, and suggested checks.",
      "Do not edit files."
    ].join("\n");
  }

  if (role.startsWith("builder-")) {
    return [
      ...base,
      "",
      "Planner output:",
      plannerText,
      "",
      "Builder task:",
      "Implement one complete candidate patch in this isolated worktree.",
      "Leave the final diff in the worktree for composer-swarm to collect."
    ].join("\n");
  }

  if (role === "reviewer") {
    if (task.options?.review) {
      return [
        ...base,
        "",
        "Planner output:",
        plannerText,
        "",
        "Repository review task:",
        "Use the objective and planner context to review the repository.",
        "Do not edit files and do not expect candidate patches.",
        "Prioritize concrete findings with file references, severity, rationale, and suggested fixes.",
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
      "Reviewer task:",
      "Review the candidates for concrete bugs, regressions, conflicts, and missing tests.",
      "Do not apply or edit any candidate. Do not choose for the user; report objective findings."
    ].join("\n");
  }

  return base.join("\n");
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

async function runCursorWorker(config, workspaceRoot, task, role, context = {}) {
  const worker = workerForRole(task, role);
  const agent = agentForRole(config, role) ?? fallbackCursorAgent(role);
  const worktree = createWorktree(config, workspaceRoot, task, role);
  const transcript = transcriptPath(config, workspaceRoot, task.taskId, role);
  const prompt = buildRolePrompt(role, task, context);
  const cursorArgs = buildCursorAgentArgs({
    role,
    worktree,
    prompt,
    model: task.options?.model ?? null
  });
  const args = [...(agent.args ?? []), ...cursorArgs];

  Object.assign(worker, {
    status: "running",
    startedAt: new Date().toISOString(),
    worktree,
    transcript,
    command: agent.command,
    args: redactPromptArg(args)
  });
  saveTask(config, workspaceRoot, task);
  appendTranscript(transcript, {
    type: "started",
    taskId: task.taskId,
    role,
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

    function recordLine(stream, line) {
      if (!line) {
        return;
      }
      const parsed = parseJsonLine(line);
      const text = parsed ? textFromJson(parsed) : line;
      if (text) {
        outputParts.push(text);
      }
      appendTranscript(transcript, {
        type: "worker-output",
        taskId: task.taskId,
        role,
        stream,
        event: parsed,
        line: parsed ? undefined : line
      });
    }

    function finish(status, detail = {}) {
      if (settled) {
        return;
      }
      settled = true;
      for (const [stream, state] of [
        ["stdout", stdoutState],
        ["stderr", stderrState]
      ]) {
        const line = finalizeBufferedLine(state);
        if (line) {
          recordLine(stream, line);
        }
      }
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
        role,
        exitCode: worker.exitCode,
        signal: worker.signal,
        error: worker.error
      });
      saveTask(config, workspaceRoot, task);
      resolve(worker);
    }

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
      finish(exitCode === 0 ? "completed" : "failed", { exitCode, signal });
    });
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

export function collectCandidatePatch(config, workspaceRoot, task, role) {
  const worker = workerForRole(task, role);
  const worktree = worker.worktree;
  if (!worktree) {
    throw new Error(`Worker ${role} has no worktree.`);
  }

  includeUntrackedInDiff(worktree);
  const diff = runGit(worktree, ["diff", "--binary", "HEAD"], { maxBuffer: 1024 * 1024 * 50 }).stdout;
  const status = runGit(worktree, ["status", "--porcelain"]).stdout;
  const changedFiles = parseStatusFiles(status);
  const candidateId = candidateIdFor(task, role);
  let patchFile = null;
  if (diff.trim()) {
    patchFile = artifactPath(config, workspaceRoot, task.taskId, candidateId);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, diff, "utf8");
  }

  const candidate = {
    schema: CANDIDATE_SCHEMA,
    candidateId,
    role,
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
        `Role: ${candidate.role}`,
        `Status: ${candidate.status}`,
        `Changed files: ${candidate.changedFiles.join(", ") || "(none)"}`,
        `Summary: ${candidate.summary}`,
        "Patch:",
        truncatedPatch || "(no patch)"
      ].join("\n");
    })
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
    const planner = await runCursorWorker(config, workspaceRoot, task, "planner");
    if (isCancelled(config, workspaceRoot, task.taskId)) {
      return markCancelled(config, workspaceRoot, task);
    }

    const builderRoleList = task.workers
      .map((worker) => worker.role)
      .filter((role) => role.startsWith("builder-"));
    if (builderRoleList.length) {
      await Promise.all(
        builderRoleList.map((role) =>
          runCursorWorker(config, workspaceRoot, task, role, { plannerOutput: planner.finalOutput })
        )
      );
      if (isCancelled(config, workspaceRoot, task.taskId)) {
        return markCancelled(config, workspaceRoot, task);
      }

      for (const role of builderRoleList) {
        collectCandidatePatch(config, workspaceRoot, task, role);
      }
      task.status = "patches-collected";
      saveTask(config, workspaceRoot, task);
    }

    const reviewer = await runCursorWorker(config, workspaceRoot, task, "reviewer", {
      plannerOutput: planner.finalOutput,
      candidateText: candidateReviewText(config, workspaceRoot, task)
    });
    task.reviewer = {
      role: "reviewer",
      status: reviewer.status,
      transcript: reviewer.transcript,
      notes: reviewer.finalOutput || "(reviewer did not provide notes)",
      exitCode: reviewer.exitCode ?? null
    };
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
    builders: 0
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
    const labels = [candidate.candidateId, candidate.role].filter(Boolean);
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
  return (config.agents ?? []).find((agent) => agent.role === "verifier" && agent.kind === "shell") ?? null;
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
    throw new Error("No shell verifier agent configured. Add a verifier agent to .composer-swarm/config.json.");
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
    `Verified ${candidate.candidateId} (${candidate.role})`,
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
  if (task.status === "completed" || task.status === "patches-collected") {
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
  const lines = [`${pad("TASK", 22)} ${pad("STATUS", 17)} ${pad("CANDIDATES", 10)} OBJECTIVE`];
  for (const task of tasks) {
    lines.push(
      `${pad(task.taskId, 22)} ${pad(task.status, 17)} ${pad(task.candidates?.length ?? 0, 10)} ${task.objective}`
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
  if (task.error) {
    lines.push(`Error: ${task.error}`);
  }
  lines.push("", "Workers:");
  for (const worker of task.workers ?? []) {
    const detail = [
      worker.exitCode !== undefined && worker.exitCode !== null ? `exit=${worker.exitCode}` : null,
      worker.worktree ? `worktree=${worker.worktree}` : null
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`- ${worker.role}: ${worker.status}${detail ? ` (${detail})` : ""}`);
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
      lines.push(`Candidate: ${candidate.candidateId} (${candidate.role})`);
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

export function renderResult(config, workspaceRoot, taskId = null, options = {}) {
  const task = taskId ? loadTask(config, workspaceRoot, taskId) : latestTask(config, workspaceRoot);
  if (!task) {
    return "No composer-swarm tasks found.";
  }
  return formatResult(task, { workspaceRoot, ...options });
}

function candidateMatches(candidate, requested) {
  return candidate.candidateId === requested || candidate.role === requested || candidate.candidateId.endsWith(`-${requested}`);
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

function killPid(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function cancelTask(config, workspaceRoot, taskId) {
  const task = loadTask(config, workspaceRoot, taskId);
  const killed = [];
  if (killPid(task.backgroundPid)) {
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
