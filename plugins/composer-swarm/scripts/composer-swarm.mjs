#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { normalizePluginArgv } from "./lib/args.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(scriptDir, "..");
const repoRoot = process.env.COMPOSER_SWARM_REPO
  ? path.resolve(process.env.COMPOSER_SWARM_REPO)
  : path.resolve(pluginRoot, "../..");
const cliPath = path.join(repoRoot, "bin", "composer-swarm.mjs");

function cliCommand() {
  if (fs.existsSync(cliPath)) {
    return {
      command: process.execPath,
      args: [cliPath]
    };
  }
  return {
    command: "composer-swarm",
    args: []
  };
}

const [command, ...rawArgs] = process.argv.slice(2);
const args = normalizePluginArgv(rawArgs);
const cli = cliCommand();
const result = spawnSync(cli.command, [...cli.args, command, ...args], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (result.error) {
  process.stderr.write(
    `composer-swarm plugin could not find the CLI runtime. Install composer-swarm on PATH or set COMPOSER_SWARM_REPO=/path/to/composer-swarm.\n`
  );
  process.exit(1);
}

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.status ?? 1;
