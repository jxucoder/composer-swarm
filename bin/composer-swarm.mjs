#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { normalizeArgs, splitRawArgumentString } from "../src/args.mjs";
import {
  applyCandidate,
  builderWorkerLabels,
  cancelTask,
  cleanupTasks,
  createResearchTask,
  createTeamTask,
  defaultConfig,
  initializeGitRepository,
  resolveWorkspaceContext,
  formatPlan,
  loadConfig,
  planTask,
  recordBackgroundPid,
  renderInspect,
  renderLogs,
  renderResult,
  renderStatus,
  researchWorkerLabels,
  reviewObjective,
  runDoctor,
  runTaskWorkflow,
  scoutWorkerLabels,
  verifyCandidate,
  verifyCandidatesResult,
  workspaceConfigFile,
  writeDefaultConfig
} from "../src/runtime.mjs";

export { splitRawArgumentString };

function usage() {
  return `composer-swarm

Usage:
  composer-swarm init [--force] [--trust]
  composer-swarm setup [--init] [--trust] [--force] [--json]
  composer-swarm doctor
  composer-swarm plan <task text>
  composer-swarm team <task text> [--builders 2] [--from-plan <file>] [--background|--wait] [--json]
  composer-swarm research <question> [--workers 2] [--focus <area>] [--pack broad|bugs|flow|tests|design|release|security] [--angles <a,b>] [--from-plan <file>] [--include-untracked|--snapshot-current] [--background|--wait] [--json]
  composer-swarm review [--preset repo|security|tests] [--scouts 0..4] [--current|--include-untracked|--snapshot-current] [--background|--wait] [--json]
  composer-swarm ls
  composer-swarm status [task-id] [--json]
  composer-swarm inspect [task-id]
  composer-swarm logs [task-id] [--worker <label>] [--tail 80]
  composer-swarm result [task-id] [--verbose|--findings|--synthesis|--json]
  composer-swarm verify <task-id> [--candidate <id>] [--no-baseline]
  composer-swarm apply <task-id> --candidate <candidate-id>
  composer-swarm apply <task-id> --recommended
  composer-swarm cancel <task-id>
  composer-swarm cleanup [task-id]
  composer-swarm config

Repo-only v1 launches local cursor-agent workers in isolated git worktrees, pins them to composer-2.5-fast, and stores state under .composer-swarm/state/.`;
}

function parseArgs(rawArgs, optionNames = []) {
  const args = normalizeArgs(rawArgs);
  const options = {};
  const positionals = [];
  const takesValue = new Set(optionNames);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (takesValue.has(name)) {
      const value = inlineValue !== undefined ? inlineValue : args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
      }
      options[name] = value;
      if (inlineValue === undefined) {
        i += 1;
      }
    } else {
      options[name] = true;
    }
  }
  return { options, positionals };
}

function readTaskText(positionals) {
  return positionals.join(" ").trim();
}

function readPlanFile(cwd, filePath) {
  const resolved = path.resolve(cwd, filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }
  return {
    path: resolved,
    displayPath: filePath,
    text: fs.readFileSync(resolved, "utf8")
  };
}

function planPathForRuntime(workspaceRoot, planPath) {
  if (!planPath) {
    return null;
  }
  const relative = path.relative(workspaceRoot, planPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : planPath;
}

function objectiveFromPlan(planText, planFile) {
  let fallbackHeading = null;
  for (const rawLine of String(planText ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const objective = /^objective:\s*(.+)$/i.exec(line);
    if (objective?.[1]) {
      return objective[1].trim();
    }
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading?.[1] && !fallbackHeading) {
      fallbackHeading = heading[1].trim();
    }
  }
  return fallbackHeading || `Task from ${planFile}`;
}

function launchMode(task) {
  if (task.options?.research) {
    return "research";
  }
  if (task.options?.review) {
    return "review";
  }
  return "team";
}

function repoContextMetadata(task) {
  const context = task.repoContext ?? task.contextCache;
  if (!context) {
    return null;
  }
  const { text, ...metadata } = context;
  return metadata;
}

function launchCommands(task) {
  const commands = {
    status: `composer-swarm status ${task.taskId}`,
    statusJson: `composer-swarm status ${task.taskId} --json`,
    inspect: `composer-swarm inspect ${task.taskId}`,
    logs: `composer-swarm logs ${task.taskId}`,
    result: `composer-swarm result ${task.taskId}`,
    resultJson: `composer-swarm result ${task.taskId} --json`
  };
  const mode = launchMode(task);
  if (mode === "review" || mode === "research") {
    commands.synthesis = `composer-swarm result ${task.taskId} --synthesis`;
    commands.findings = `composer-swarm result ${task.taskId} --findings`;
  }
  if (mode === "team") {
    commands.verify = `composer-swarm verify ${task.taskId}`;
  }
  commands.cleanup = `composer-swarm cleanup ${task.taskId}`;
  return commands;
}

function launchPayload(workspaceRoot, task) {
  const mode = launchMode(task);
  return {
    schema: "composer-swarm.launch.v1",
    taskId: task.taskId,
    status: task.status,
    mode,
    objective: task.objective,
    workspaceRoot,
    background: Boolean(task.options?.background),
    backgroundPid: task.backgroundPid ?? null,
    baseSha: task.baseSha ?? null,
    baseBranch: task.baseBranch ?? null,
    workers: (task.workers ?? []).map((worker) => ({
      label: worker.label,
      status: worker.status,
      canEdit: Boolean(worker.canEdit)
    })),
    repoContext: repoContextMetadata(task),
    research: mode === "research"
      ? {
          workers: task.options?.workers ?? null,
          focus: task.options?.focus ?? null,
          pack: task.options?.researchPack ?? null,
          planFile: task.options?.researchPlanFile ?? null,
          angles: task.options?.researchAngles ?? []
        }
      : null,
    review: mode === "review"
      ? {
          scouts: task.options?.scouts ?? 0,
          snapshotCurrent: Boolean(task.options?.snapshotCurrent)
        }
      : null,
    team: mode === "team"
      ? {
          builders: task.options?.builders ?? 0,
          implementationPlanFile: task.options?.implementationPlanFile ?? null,
          hostProvidedPlan: Boolean(task.options?.implementationPlan)
        }
      : null,
    commands: launchCommands(task)
  };
}

function writeLaunchJson(workspaceRoot, task) {
  process.stdout.write(`${JSON.stringify(launchPayload(workspaceRoot, task), null, 2)}\n`);
}

function cliPath() {
  return fileURLToPath(import.meta.url);
}

function workspaceContext(cwd, options = {}) {
  const ctx = resolveWorkspaceContext(cwd, options);
  return { workspaceRoot: ctx.workspaceRoot, config: ctx.config, gitRoot: ctx.gitRoot, nearbyGitRepos: ctx.nearbyGitRepos };
}

function setupReport(cwd, options = {}) {
  let ctx = resolveWorkspaceContext(cwd, { requireGit: false });
  let targetRoot = ctx.gitRoot ?? ctx.workspaceRoot;
  let initialized = null;
  let initializedGit = null;

  if (options.init && !ctx.gitRoot && !(ctx.nearbyGitRepos ?? []).length) {
    initializedGit = initializeGitRepository(targetRoot);
    ctx = resolveWorkspaceContext(initializedGit, { requireGit: false });
    targetRoot = ctx.gitRoot ?? initializedGit;
  }

  if (options.init) {
    initialized = writeDefaultConfig(targetRoot, {
      force: Boolean(options.force),
      trust: Boolean(options.trust)
    });
    ctx = resolveWorkspaceContext(targetRoot, { requireGit: false });
  }

  const config = loadConfig(targetRoot);
  const configFile = workspaceConfigFile(targetRoot);
  const configExists = Boolean(initialized) || fsExists(configFile);
  const doctor = runDoctor(config);
  const ready = Boolean(ctx.gitRoot) && configExists && doctor.ok;
  const nextSteps = [];

  if (!ctx.gitRoot) {
    nextSteps.push("Initialize this directory: composer-swarm setup --init --trust");
    for (const repo of ctx.nearbyGitRepos ?? []) {
      nextSteps.push(`Try: cd ${repo}`);
    }
  }
  if (!configExists) {
    nextSteps.push("Initialize this repository: composer-swarm setup --init --trust");
  }
  if (!doctor.ok) {
    nextSteps.push("Install or authenticate cursor-agent, then rerun composer-swarm setup.");
  }
  if (ready) {
    nextSteps.push('Start a team: composer-swarm team "fix the failing tests" --background');
    nextSteps.push('Research only: composer-swarm research "map the relevant flow" --background');
    nextSteps.push("Review only: composer-swarm review --preset repo --background");
  }

  return {
    ready,
    workspaceRoot: targetRoot,
    gitRoot: ctx.gitRoot,
    configFile,
    configExists,
    initialized,
    initializedGit,
    doctor,
    nextSteps
  };
}

function fsExists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function renderSetupReport(report) {
  const lines = [
    "# Composer Swarm Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    `Workspace: ${report.workspaceRoot}`,
    `Git: ${report.gitRoot ?? "not found"}`,
    `Config: ${report.configExists ? report.configFile : "missing"}`,
    ""
  ];

  if (report.initialized) {
    lines.push(`Initialized config: ${report.initialized}`, "");
  }
  if (report.initializedGit) {
    lines.push(`Initialized git repository: ${report.initializedGit}`, "");
  }

  lines.push("Checks:");
  for (const line of report.doctor.lines) {
    lines.push(line.startsWith("- ") ? line : `- ${line}`);
  }

  if (report.nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function runTeamCommand(config, workspaceRoot, taskText, options) {
  const isReview = Boolean(options.review);
  const builders = isReview ? 0 : options.builders ? Number(options.builders) : 2;
  const scouts = isReview ? (options.scouts ? Number(options.scouts) : 0) : 0;
  if (!isReview && (!Number.isInteger(builders) || builders < 1 || builders > builderWorkerLabels(99).length)) {
    console.error("Invalid --builders value. Use an integer from 1 to 4.");
    process.exitCode = 2;
    return null;
  }
  if (isReview && (!Number.isInteger(scouts) || scouts < 0 || scouts > scoutWorkerLabels(99).length)) {
    console.error("Invalid --scouts value. Use an integer from 0 to 4.");
    process.exitCode = 2;
    return null;
  }
  if (options.background && options.wait) {
    console.error("Use only one of --background or --wait.");
    process.exitCode = 2;
    return null;
  }
  const task = createTeamTask(config, workspaceRoot, taskText, {
    builders,
    scouts,
    model: options.model ?? null,
    implementationPlan: options.implementationPlan ?? null,
    implementationPlanFile: options.implementationPlanFile ?? null,
    background: Boolean(options.background),
    review: isReview,
    snapshotCurrent: Boolean(options["snapshot-current"] || options["include-untracked"]),
    includeUntracked: Boolean(options["include-untracked"] || options["snapshot-current"])
  });
  if (options.background) {
    const pid = spawnBackgroundTask(workspaceRoot, task.taskId);
    task.backgroundPid = pid;
    recordBackgroundPid(config, workspaceRoot, task.taskId, pid);
    if (options.json) {
      writeLaunchJson(workspaceRoot, task);
      return task;
    }
    console.log(`Started ${task.taskId} as a detached local run.`);
    console.log(`Status: composer-swarm status ${task.taskId}`);
    console.log(`Result: composer-swarm result ${task.taskId}`);
    return task;
  }
  if (!options.json) {
    console.log(`Started ${task.taskId}.`);
  }
  const finished = await runTaskWorkflow(config, workspaceRoot, task.taskId);
  if (options.json) {
    writeLaunchJson(workspaceRoot, finished);
    return finished;
  }
  console.log(renderStatus(config, workspaceRoot, finished.taskId));
  console.log("");
  console.log(`Result: composer-swarm result ${finished.taskId}`);
  return finished;
}

async function runResearchCommand(config, workspaceRoot, question, options) {
  const workers = options.workers ? Number(options.workers) : null;
  if (workers !== null && (!Number.isInteger(workers) || workers < 1 || workers > researchWorkerLabels(99).length)) {
    console.error("Invalid --workers value. Use an integer from 1 to 4.");
    process.exitCode = 2;
    return null;
  }
  if (options.background && options.wait) {
    console.error("Use only one of --background or --wait.");
    process.exitCode = 2;
    return null;
  }
  const task = createResearchTask(config, workspaceRoot, question, {
    workers: workers ?? undefined,
    focus: options.focus ?? null,
    pack: options.pack ?? null,
    angles: options.angles ?? null,
    researchPlan: options.researchPlan ?? null,
    researchPlanFile: options.researchPlanFile ?? null,
    model: options.model ?? null,
    background: Boolean(options.background),
    snapshotCurrent: Boolean(options["snapshot-current"] || options["include-untracked"]),
    includeUntracked: Boolean(options["include-untracked"] || options["snapshot-current"])
  });
  if (options.background) {
    const pid = spawnBackgroundTask(workspaceRoot, task.taskId);
    task.backgroundPid = pid;
    recordBackgroundPid(config, workspaceRoot, task.taskId, pid);
    if (options.json) {
      writeLaunchJson(workspaceRoot, task);
      return task;
    }
    console.log(`Started ${task.taskId} as a detached local run.`);
    console.log(`Status: composer-swarm status ${task.taskId}`);
    console.log(`Result: composer-swarm result ${task.taskId} --verbose`);
    return task;
  }
  if (!options.json) {
    console.log(`Started ${task.taskId}.`);
  }
  const finished = await runTaskWorkflow(config, workspaceRoot, task.taskId);
  if (options.json) {
    writeLaunchJson(workspaceRoot, finished);
    return finished;
  }
  console.log(renderStatus(config, workspaceRoot, finished.taskId));
  console.log("");
  console.log(`Result: composer-swarm result ${finished.taskId} --verbose`);
  return finished;
}

function spawnBackgroundTask(workspaceRoot, taskId) {
  const child = spawn(process.execPath, [cliPath(), "__run-task", taskId], {
    cwd: workspaceRoot,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid;
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = normalizeArgs(rawArgs);
  const cwd = process.cwd();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const { options } = parseArgs(args, []);
    const force = Boolean(options.force);
    const trust = Boolean(options.trust);
    const filePath = writeDefaultConfig(cwd, { force, trust });
    console.log(`Wrote ${filePath}`);
    if (trust) {
      console.log("Composer worker configured with --trust for isolated worktrees.");
    }
    return;
  }

  if (command === "setup") {
    const { options } = parseArgs(args, []);
    const report = setupReport(cwd, options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(renderSetupReport(report));
    }
    process.exitCode = report.ready ? 0 : 1;
    return;
  }

  if (command === "config") {
    const { workspaceRoot, config } = workspaceContext(cwd);
    console.log(JSON.stringify({ workspaceRoot, config }, null, 2));
    return;
  }

  if (command === "doctor") {
    const { config } = workspaceContext(cwd);
    const report = runDoctor(config);
    console.log(report.lines.join("\n"));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "plan") {
    const { options, positionals } = parseArgs(args, []);
    if (options.roles) {
      console.error("composer-swarm plan no longer accepts worker selection flags. Use team --builders or review --scouts.");
      process.exitCode = 2;
      return;
    }
    const taskText = readTaskText(positionals);
    if (!taskText) {
      console.error("Missing task text.");
      process.exitCode = 2;
      return;
    }
    const { config } = workspaceContext(cwd);
    const plan = planTask(config, taskText);
    console.log(formatPlan(plan));
    return;
  }

  if (command === "team") {
    const { options, positionals } = parseArgs(args, ["builders", "model", "from-plan"]);
    const plan = options["from-plan"] ? readPlanFile(cwd, options["from-plan"]) : null;
    const taskText = readTaskText(positionals) || (plan ? objectiveFromPlan(plan.text, plan.displayPath) : "");
    if (!taskText) {
      console.error("Missing task text.");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    await runTeamCommand(config, workspaceRoot, taskText, {
      ...options,
      implementationPlan: plan?.text ?? null,
      implementationPlanFile: plan ? planPathForRuntime(workspaceRoot, plan.path) : null
    });
    return;
  }

  if (command === "research") {
    const { options, positionals } = parseArgs(args, ["workers", "focus", "pack", "angles", "from-plan", "model"]);
    const plan = options["from-plan"] ? readPlanFile(cwd, options["from-plan"]) : null;
    const question = readTaskText(positionals) || (plan ? objectiveFromPlan(plan.text, plan.displayPath) : "");
    if (!question) {
      console.error("Missing research question.");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    await runResearchCommand(config, workspaceRoot, question, {
      ...options,
      researchPlan: plan?.text ?? null,
      researchPlanFile: plan ? planPathForRuntime(workspaceRoot, plan.path) : null
    });
    return;
  }

  if (command === "review") {
    const { options, positionals } = parseArgs(args, ["preset", "model", "scouts"]);
    const preset = options.preset ?? positionals[0] ?? "repo";
    const taskText = reviewObjective(preset);
    let ctx = workspaceContext(cwd, { requireGit: !options.current });
    if (options.current && !ctx.gitRoot && !(ctx.nearbyGitRepos ?? []).length) {
      const gitRoot = initializeGitRepository(ctx.workspaceRoot);
      ctx = workspaceContext(gitRoot);
    }
    if (!ctx.gitRoot) {
      throw new Error(
        `Current directory is not inside a git repository: ${cwd}\nRun composer-swarm setup --init --trust, or cd into a nearby repository.`
      );
    }
    await runTeamCommand(ctx.config, ctx.workspaceRoot, taskText, {
      ...options,
      review: true,
      builders: 0,
      scouts: options.scouts ?? 0,
      "include-untracked": Boolean(options.current || options["include-untracked"]),
      "snapshot-current": Boolean(options.current || options["snapshot-current"])
    });
    return;
  }

  if (command === "__run-task") {
    const taskId = args[0];
    if (!taskId) {
      throw new Error("Missing task id for internal runner.");
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    const task = await runTaskWorkflow(config, workspaceRoot, taskId);
    if (task.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "status" || command === "ls") {
    const { options, positionals } = parseArgs(args, []);
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    const output = renderStatus(config, workspaceRoot, command === "ls" ? null : positionals[0] ?? null, {
      json: Boolean(options.json)
    });
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    return;
  }

  if (command === "inspect") {
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    console.log(renderInspect(config, workspaceRoot, args[0] ?? null));
    return;
  }

  if (command === "logs") {
    const { options, positionals } = parseArgs(args, ["worker", "tail"]);
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    console.log(
      renderLogs(config, workspaceRoot, positionals[0] ?? null, {
        worker: options.worker ?? null,
        tail: options.tail ?? undefined
      })
    );
    return;
  }

  if (command === "result") {
    const { options, positionals } = parseArgs(args, []);
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    const output = renderResult(config, workspaceRoot, positionals[0] ?? null, {
      verbose: Boolean(options.verbose),
      findings: Boolean(options.findings),
      synthesis: Boolean(options.synthesis),
      json: Boolean(options.json)
    });
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    return;
  }

  if (command === "verify") {
    const { options, positionals } = parseArgs(args, ["candidate"]);
    const taskId = positionals[0];
    if (!taskId) {
      console.error("Usage: composer-swarm verify <task-id> [--candidate <candidate-id>]");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    const verifyOptions = { baseline: !options["no-baseline"] };
    if (options.candidate) {
      const result = verifyCandidate(config, workspaceRoot, taskId, options.candidate, verifyOptions);
      console.log(result.lines.join("\n"));
      if (result.check?.status === "failed") {
        process.exitCode = 1;
      }
    } else {
      const result = verifyCandidatesResult(config, workspaceRoot, taskId, verifyOptions);
      console.log(result.output);
      if (result.failed) {
        process.exitCode = 1;
      }
    }
    return;
  }

  if (command === "apply") {
    const { options, positionals } = parseArgs(args, ["candidate"]);
    const taskId = positionals[0];
    if (!taskId) {
      console.error("Usage: composer-swarm apply <task-id> --candidate <candidate-id>");
      console.error("   or: composer-swarm apply <task-id> --recommended");
      process.exitCode = 2;
      return;
    }
    if (!options.candidate && !options.recommended) {
      console.error("Usage: composer-swarm apply <task-id> --candidate <candidate-id>");
      console.error("   or: composer-swarm apply <task-id> --recommended");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    const result = applyCandidate(config, workspaceRoot, taskId, options.candidate ?? null, {
      recommended: Boolean(options.recommended)
    });
    console.log(result.lines.join("\n"));
    return;
  }

  if (command === "cancel") {
    const taskId = args[0];
    if (!taskId) {
      console.error("Usage: composer-swarm cancel <task-id>");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    console.log(cancelTask(config, workspaceRoot, taskId).lines.join("\n"));
    return;
  }

  if (command === "cleanup") {
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    console.log(cleanupTasks(config, workspaceRoot, args[0] ?? null));
    return;
  }

  if (command === "example-config") {
    console.log(JSON.stringify(defaultConfig(), null, 2));
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
