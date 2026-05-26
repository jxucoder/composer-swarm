#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAIRS = [
  {
    src: ".agents",
    dst: "plugins/composer-swarm/agents",
    match: (name) => /^composer-.*\.md$/.test(name)
  }
];

let copied = 0;
let removed = 0;

for (const { src, dst, match } of PAIRS) {
  const srcDir = path.join(ROOT, src);
  const dstDir = path.join(ROOT, dst);
  fs.mkdirSync(dstDir, { recursive: true });

  const wanted = new Set();
  for (const name of fs.readdirSync(srcDir)) {
    if (!match(name)) continue;
    const srcFile = path.join(srcDir, name);
    if (!fs.statSync(srcFile).isFile()) continue;
    wanted.add(name);
    fs.copyFileSync(srcFile, path.join(dstDir, name));
    copied += 1;
  }

  for (const name of fs.readdirSync(dstDir)) {
    if (!match(name)) continue;
    const dstFile = path.join(dstDir, name);
    if (!fs.statSync(dstFile).isFile()) continue;
    if (!wanted.has(name)) {
      fs.unlinkSync(dstFile);
      removed += 1;
      console.log(`removed ${dst}/${name} (no longer in ${src}/)`);
    }
  }
}

console.log(`sync complete: ${copied} copied, ${removed} removed`);
