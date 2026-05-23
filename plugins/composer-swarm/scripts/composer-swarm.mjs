#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(scriptDir, "..");
const repoRoot = process.env.COMPOSER_SWARM_REPO
  ? path.resolve(process.env.COMPOSER_SWARM_REPO)
  : path.resolve(pluginRoot, "../..");
const cliPath = path.join(repoRoot, "bin", "composer-swarm.mjs");
const argsPath = path.join(repoRoot, "src", "args.mjs");

if (!fs.existsSync(cliPath) || !fs.existsSync(argsPath)) {
  process.stderr.write(
    `composer-swarm plugin could not find the repo runtime at ${repoRoot}.\n` +
      "If the plugin was copied outside the checkout, set COMPOSER_SWARM_REPO=/path/to/composer-swarm.\n"
  );
  process.exit(1);
}

const { normalizePluginArgv } = await import(pathToFileURL(argsPath).href);

const [command, ...rawArgs] = process.argv.slice(2);
const args = normalizePluginArgv(rawArgs);
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
