#!/usr/bin/env node
// Mutation test for check-bun-pin.mjs: a fixture repo that passes, then one
// mutation per way the pins can drift, each of which must fail the gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECK = new URL('./check-bun-pin.mjs', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'allo-bun-pin-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const WORKFLOW = `jobs:
  a:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          # a comment naming bun-version: 9.9.9 is ignored
          bun-version-file: package.json
`;
const DOCKERFILE = `FROM node:22-alpine
ENV BUN_VERSION=1.4.3
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v\${BUN_VERSION}"
RUN bun install --frozen-lockfile
`;

const fixture = (files) => {
  const root = mkdtempSync(join(work, 'repo-'));
  const all = {
    'package.json': JSON.stringify({ packageManager: 'bun@1.4.3' }),
    '.github/workflows/ci.yml': WORKFLOW,
    'packages/backend/Dockerfile': DOCKERFILE,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8' });
};

const clean = fixture({});
if (clean.status !== 0) {
  console.error(`FAIL: consistent pins were rejected\n${clean.stdout}${clean.stderr}`);
  process.exit(1);
}

const mutations = {
  'packageManager missing': { 'package.json': '{}' },
  'packageManager moved, Dockerfile not': {
    'package.json': JSON.stringify({ packageManager: 'bun@1.4.4' }),
  },
  'Dockerfile BUN_VERSION behind': {
    'packages/backend/Dockerfile': DOCKERFILE.replace('1.4.3', '1.4.2'),
  },
  'Dockerfile ARG ahead': {
    'packages/backend/Dockerfile': DOCKERFILE.replace(
      'ENV BUN_VERSION=1.4.3',
      'ARG BUN_VERSION=1.5.0',
    ),
  },
  'oven/bun stage at another version': {
    'packages/backend/Dockerfile': `FROM --platform=linux/arm64 oven/bun:1.4.2-alpine\nRUN bun install\n`,
  },
  'untagged oven/bun stage': {
    'packages/backend/Dockerfile': `FROM oven/bun\nRUN bun install\n`,
  },
  'Dockerfile runs bun with no pin': {
    'packages/backend/Dockerfile': `FROM node:22-alpine\nRUN bun install\n`,
  },
  'literal bun-version in a workflow': {
    '.github/workflows/ci.yml': WORKFLOW.replace(
      'bun-version-file: package.json',
      'bun-version: 1.4.3',
    ),
  },
  'second setup-bun step without the pin': {
    '.github/workflows/deploy.yml': `jobs:\n  b:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n`,
  },
  'no setup-bun step at all': { '.github/workflows/ci.yml': 'jobs: {}\n' },
};

const escaped = [];
for (const [name, files] of Object.entries(mutations)) {
  const result = fixture(files);
  if (result.status !== 1) escaped.push(`${name} (exit ${result.status})\n${result.stdout}`);
}
if (escaped.length > 0) {
  console.error(
    `FAIL: ${escaped.length} drift(s) escaped the bun pin gate:\n${escaped.join('\n')}`,
  );
  process.exit(1);
}
console.log(`Bun pin gate catches all ${Object.keys(mutations).length} drift mutations.`);
