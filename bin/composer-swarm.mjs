#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { normalizeArgs, splitRawArgumentString } from "../src/args.mjs";
import {
  applyCandidate,
  builderRoles,
  cancelTask,
  cleanupTasks,
  createTeamTask,
  defaultConfig,
  resolveWorkspaceContext,
  formatPlan,
  loadConfig,
  planTask,
  recordBackgroundPid,
  renderResult,
  renderStatus,
  reviewObjective,
  runDoctor,
  runTaskWorkflow,
  verifyCandidate,
  verifyCandidates,
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
  composer-swarm agents
  composer-swarm plan <task text> [--roles a,b,c]
  composer-swarm team <task text> [--builders 2] [--background|--wait]
  composer-swarm review [--preset repo|security|tests] [--background|--wait]
  composer-swarm status [task-id]
  composer-swarm result [task-id] [--verbose]
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

function readRoles(options) {
  if (!options.roles) {
    return null;
  }
  return String(options.roles)
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
}

function readTaskText(positionals) {
  return positionals.join(" ").trim();
}

function cliPath() {
  return fileURLToPath(import.meta.url);
}

function workspaceContext(cwd, options = {}) {
  const ctx = resolveWorkspaceContext(cwd, options);
  return { workspaceRoot: ctx.workspaceRoot, config: ctx.config, gitRoot: ctx.gitRoot };
}

function setupReport(cwd, options = {}) {
  const ctx = resolveWorkspaceContext(cwd, { requireGit: false });
  const targetRoot = ctx.gitRoot ?? ctx.workspaceRoot;
  let initialized = null;

  if (options.init) {
    initialized = writeDefaultConfig(targetRoot, {
      force: Boolean(options.force),
      trust: Boolean(options.trust)
    });
  }

  const config = loadConfig(targetRoot);
  const configFile = workspaceConfigFile(targetRoot);
  const configExists = Boolean(initialized) || fsExists(configFile);
  const doctor = runDoctor(config);
  const ready = Boolean(ctx.gitRoot) && configExists && doctor.ok;
  const nextSteps = [];

  if (!ctx.gitRoot) {
    nextSteps.push("Run composer-swarm from a git repository root.");
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
    nextSteps.push("Review only: composer-swarm review --preset repo --background");
  }

  return {
    ready,
    workspaceRoot: targetRoot,
    gitRoot: ctx.gitRoot,
    configFile,
    configExists,
    initialized,
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
  if (!isReview && (!Number.isInteger(builders) || builders < 1 || builders > builderRoles(99).length)) {
    console.error("Invalid --builders value. Use an integer from 1 to 4.");
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
    model: options.model ?? null,
    background: Boolean(options.background),
    review: isReview
  });
  if (options.background) {
    const pid = spawnBackgroundTask(workspaceRoot, task.taskId);
    recordBackgroundPid(config, workspaceRoot, task.taskId, pid);
    console.log(`Started ${task.taskId} in background.`);
    console.log(`Status: composer-swarm status ${task.taskId}`);
    console.log(`Result: composer-swarm result ${task.taskId}`);
    return task;
  }
  console.log(`Started ${task.taskId}.`);
  const finished = await runTaskWorkflow(config, workspaceRoot, task.taskId);
  console.log(renderStatus(config, workspaceRoot, finished.taskId));
  console.log("");
  console.log(`Result: composer-swarm result ${finished.taskId}`);
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
      console.log("Cursor CLI agents configured with --trust for isolated worktrees.");
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

  if (command === "agents") {
    const { config } = workspaceContext(cwd);
    for (const agent of config.agents ?? []) {
      const commandText = [agent.command, ...(agent.args ?? [])].filter(Boolean).join(" ");
      console.log(`${agent.id}\t${agent.kind}\t${agent.role}\t${commandText || "(host-driven)"}`);
    }
    return;
  }

  if (command === "plan") {
    const { options, positionals } = parseArgs(args, ["roles"]);
    const taskText = readTaskText(positionals);
    if (!taskText) {
      console.error("Missing task text.");
      process.exitCode = 2;
      return;
    }
    const { config } = workspaceContext(cwd);
    const plan = planTask(config, taskText, { roles: readRoles(options) });
    console.log(formatPlan(plan));
    return;
  }

  if (command === "team") {
    const { options, positionals } = parseArgs(args, ["builders", "model"]);
    const taskText = readTaskText(positionals);
    if (!taskText) {
      console.error("Missing task text.");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    await runTeamCommand(config, workspaceRoot, taskText, options);
    return;
  }

  if (command === "review") {
    const { options, positionals } = parseArgs(args, ["preset", "model"]);
    const preset = options.preset ?? positionals[0] ?? "repo";
    const taskText = reviewObjective(preset);
    const { workspaceRoot, config } = workspaceContext(cwd);
    await runTeamCommand(config, workspaceRoot, taskText, {
      ...options,
      review: true,
      builders: 0
    });
    return;
  }

  if (command === "__run-task") {
    const taskId = args[0];
    if (!taskId) {
      throw new Error("Missing task id for internal runner.");
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    await runTaskWorkflow(config, workspaceRoot, taskId);
    return;
  }

  if (command === "status") {
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    console.log(renderStatus(config, workspaceRoot, args[0] ?? null));
    return;
  }

  if (command === "result") {
    const { options, positionals } = parseArgs(args, []);
    const { workspaceRoot, config } = workspaceContext(cwd, { requireGit: false });
    console.log(renderResult(config, workspaceRoot, positionals[0] ?? null, { verbose: Boolean(options.verbose) }));
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
    } else {
      console.log(verifyCandidates(config, workspaceRoot, taskId, verifyOptions));
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
