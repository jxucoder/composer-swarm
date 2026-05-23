#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(scriptDir, "..");
const repoRoot = process.env.COMPOSER_SWARM_REPO
  ? path.resolve(process.env.COMPOSER_SWARM_REPO)
  : path.resolve(pluginRoot, "../..");
const cliPath = path.join(repoRoot, "bin", "composer-swarm.mjs");

const [command, ...args] = process.argv.slice(2);
const result = spawnSync(process.execPath, [cliPath, command, ...args], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.status ?? 1;
