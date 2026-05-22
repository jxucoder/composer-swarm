#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  applyCandidate,
  builderRoles,
  cancelTask,
  cleanupTasks,
  createTeamTask,
  defaultConfig,
  findWorkspaceRoot,
  formatPlan,
  loadConfig,
  planTask,
  recordBackgroundPid,
  renderResult,
  renderStatus,
  runDoctor,
  runTaskWorkflow,
  writeDefaultConfig
} from "../src/runtime.mjs";

function usage() {
  return `composer-swarm

Usage:
  composer-swarm init [--force]
  composer-swarm doctor
  composer-swarm agents
  composer-swarm plan <task text> [--roles a,b,c]
  composer-swarm team <task text> [--builders 2] [--background|--wait] [--model <model>]
  composer-swarm status [task-id]
  composer-swarm result [task-id]
  composer-swarm apply <task-id> --candidate <candidate-id>
  composer-swarm cancel <task-id>
  composer-swarm cleanup [task-id]
  composer-swarm config

Repo-only v1 launches local cursor-agent workers in isolated git worktrees and stores state under .composer-swarm/state/.`;
}

function parseArgs(args, optionNames = []) {
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

function workspaceContext(cwd) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const config = loadConfig(workspaceRoot);
  return { workspaceRoot, config };
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
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const force = args.includes("--force");
    const filePath = writeDefaultConfig(cwd, { force });
    console.log(`Wrote ${filePath}`);
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
    const builders = options.builders ? Number(options.builders) : 2;
    if (!Number.isInteger(builders) || builders < 1 || builders > builderRoles(99).length) {
      console.error("Invalid --builders value. Use an integer from 1 to 4.");
      process.exitCode = 2;
      return;
    }
    if (options.background && options.wait) {
      console.error("Use only one of --background or --wait.");
      process.exitCode = 2;
      return;
    }
    const task = createTeamTask(config, workspaceRoot, taskText, {
      builders,
      model: options.model ?? null,
      background: Boolean(options.background)
    });
    if (options.background) {
      const pid = spawnBackgroundTask(workspaceRoot, task.taskId);
      recordBackgroundPid(config, workspaceRoot, task.taskId, pid);
      console.log(`Started ${task.taskId} in background.`);
      console.log(`Status: composer-swarm status ${task.taskId}`);
      console.log(`Result: composer-swarm result ${task.taskId}`);
      return;
    }
    console.log(`Started ${task.taskId}.`);
    const finished = await runTaskWorkflow(config, workspaceRoot, task.taskId);
    console.log(renderStatus(config, workspaceRoot, finished.taskId));
    console.log("");
    console.log(`Result: composer-swarm result ${finished.taskId}`);
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
    const { workspaceRoot, config } = workspaceContext(cwd);
    console.log(renderStatus(config, workspaceRoot, args[0] ?? null));
    return;
  }

  if (command === "result") {
    const { workspaceRoot, config } = workspaceContext(cwd);
    console.log(renderResult(config, workspaceRoot, args[0] ?? null));
    return;
  }

  if (command === "apply") {
    const { options, positionals } = parseArgs(args, ["candidate"]);
    const taskId = positionals[0];
    const candidate = options.candidate ?? positionals[1];
    if (!taskId || !candidate) {
      console.error("Usage: composer-swarm apply <task-id> --candidate <candidate-id>");
      process.exitCode = 2;
      return;
    }
    const { workspaceRoot, config } = workspaceContext(cwd);
    const result = applyCandidate(config, workspaceRoot, taskId, candidate);
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
    const { workspaceRoot, config } = workspaceContext(cwd);
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
