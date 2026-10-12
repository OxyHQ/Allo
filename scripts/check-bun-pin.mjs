#!/usr/bin/env node
/**
 * One bun pin: root `package.json` `packageManager: "bun@x.y.z"`.
 *
 * bun.lock is only reproducible under the bun that wrote it, so CI, the
 * backend image and the developer who regenerates the lockfile must all run the
 * same one. Before this gate the version was a literal in five workflow steps
 * and in the Dockerfile, and nothing compared them. This holds every place that
 * installs bun to the one pin:
 *
 * - every `oven-sh/setup-bun` step reads it (`bun-version-file: package.json`)
 *   and no workflow names a literal `bun-version:`;
 * - every Dockerfile's `ENV`/`ARG BUN_VERSION=` and `FROM oven/bun:<tag>` equal
 *   it, and a Dockerfile that runs bun without declaring which one fails.
 *
 * Usage: check-bun-pin.mjs [repo-root]  (the root argument exists for the
 * mutation test, scripts/test-check-bun-pin.mjs).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname);
const errors = [];

const pin = /^bun@(\d+\.\d+\.\d+)$/.exec(
  String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager ?? ''),
)?.[1];
if (!pin) {
  console.error('::error::root package.json must pin `packageManager` as bun@<x.y.z>.');
  process.exit(1);
}

/** Lines with comments dropped, so a commented-out pin neither passes nor fails. */
const codeLines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

const walk = (dir, keep) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.worktrees') {
      return [];
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, keep);
    return keep(entry.name) ? [path] : [];
  });

let setupSteps = 0;
const workflowDir = join(ROOT, '.github', 'workflows');
for (const file of walk(workflowDir, (name) => /\.ya?ml$/.test(name))) {
  const lines = codeLines(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file);
  const steps = lines.filter((line) => /uses:\s*oven-sh\/setup-bun@/.test(line)).length;
  const fromPin = lines.filter((line) =>
    /^bun-version-file:\s*['"]?package\.json['"]?$/.test(line),
  );
  setupSteps += steps;
  for (const line of lines.filter((l) => /^bun-version:/.test(l))) {
    errors.push(`${rel}: \`${line}\` is a literal; use \`bun-version-file: package.json\`.`);
  }
  if (fromPin.length !== steps) {
    errors.push(
      `${rel}: ${steps} setup-bun step(s) but ${fromPin.length} read \`bun-version-file: package.json\`.`,
    );
  }
}
if (setupSteps === 0) {
  errors.push(
    `found no oven-sh/setup-bun step under ${relative(ROOT, workflowDir)}; the check measured nothing.`,
  );
}

const dockerfiles = walk(ROOT, (name) => /^Dockerfile(\..+)?$/.test(name));
let dockerPins = 0;
for (const file of dockerfiles) {
  const lines = codeLines(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file);
  const declared = [];
  for (const line of lines) {
    const env = /^(?:ENV|ARG)\s+BUN_VERSION[=\s]+['"]?([^'"\s]+)/i.exec(line);
    if (env) declared.push(['BUN_VERSION', env[1]]);
    const from = /^FROM\s+(?:--\S+\s+)*oven\/bun(?::(\S+))?/i.exec(line);
    if (from) declared.push(['oven/bun', from[1] ?? 'latest']);
  }
  const runsBun = lines.some((line) => /\bbun\s+(install|run|x)\b|\bbunx\b/.test(line));
  if (runsBun && declared.length === 0) {
    errors.push(`${rel} runs bun but declares no BUN_VERSION and no oven/bun stage.`);
  }
  for (const [where, value] of declared) {
    dockerPins += 1;
    // `${BUN_VERSION}`-style tags are checked through the BUN_VERSION they expand.
    if (value.startsWith('${')) continue;
    const version = value.replace(/^bun-v/, '').split('-')[0];
    if (version !== pin) {
      errors.push(`${rel}: ${where} is ${value}, but package.json pins bun@${pin}.`);
    }
  }
}

for (const error of errors) console.error(`::error::${error}`);
if (errors.length > 0) process.exit(1);
console.log(
  `bun@${pin} is the one pin: ${setupSteps} setup-bun step(s) read it, ` +
    `${dockerPins} Dockerfile pin(s) across ${dockerfiles.length} Dockerfile(s) equal it.`,
);
