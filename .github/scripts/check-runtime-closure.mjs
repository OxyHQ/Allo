#!/usr/bin/env bun
/**
 * The runtime image's node_modules is EXACTLY the production closure of the
 * workspaces it runs: nothing required is missing, and nothing is installed that
 * no runtime package requires (a dev dependency, a frontend package, a peer the
 * lockfile resolved only for the frontend).
 *
 * Run by CI's image smoke INSIDE the built image (it has bun and nothing else):
 *
 *   docker run --rm -v "$PWD/.github/scripts:/checks:ro" --entrypoint bun <image> \
 *     /checks/check-runtime-closure.mjs /app packages/backend packages/shared-types
 *
 * Reachability starts at the named workspaces and follows `dependencies`,
 * required `peerDependencies`, and `optionalDependencies` that are installed
 * (never an optional peer), resolving each name the way Node does (the nearest
 * `node_modules/<name>` walking up from the requiring package). A required
 * dependency or peer that does not resolve is MISSING; an installed package
 * that nothing reaches is EXTRA. Either fails, except the allowlisted missing
 * peers below, each of which is a reviewed decision.
 *
 * It also fails when a package named in FORBIDDEN is installed at all, so the
 * log says in so many words that the compiler, the test tools and React Native
 * are absent, rather than leaving it implied by "no extras".
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `<requiring package> -> <peer>` pairs that may be absent. Each is a REQUIRED
 * peer by the package's metadata that no runtime code path loads.
 */
const ALLOWED_MISSING = new Map([
  [
    '@oxy.so/protocol -> expo-modules-core',
    'only its React Native build (crypto.native.js) loads it; the Node entry points name it in comments alone',
  ],
]);

/** Must not be installed in the runtime image under any path. */
const FORBIDDEN = [
  'typescript',
  'drizzle-kit',
  'supertest',
  'bun-types',
  '@types/express',
  '@types/supertest',
  '@allo/core',
  '@allo/react',
  '@allo/frontend',
  'expo',
  'react-native',
  'react',
];

const [rootArg, ...workspaceArgs] = process.argv.slice(2);
if (!rootArg || workspaceArgs.length === 0) {
  console.error('usage: check-runtime-closure.mjs <app-root> <workspace-dir>...');
  process.exit(2);
}
const root = realpathSync(resolve(rootArg));

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

/** Every package directory under a node_modules tree, nested trees included. */
function installedUnder(nodeModules, out) {
  if (!existsSync(nodeModules)) return;
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const path = join(nodeModules, entry);
    const dirs = entry.startsWith('@')
      ? readdirSync(path).map((scoped) => join(path, scoped))
      : [path];
    for (const dir of dirs) {
      if (!existsSync(join(dir, 'package.json'))) continue;
      const real = realpathSync(dir);
      if (out.has(real)) continue;
      out.set(real, relative(root, dir));
      // A workspace symlink's own node_modules is walked through its real path.
      installedUnder(join(real, 'node_modules'), out);
    }
  }
}

/** Node's lookup: the nearest node_modules/<name> from `fromDir` upwards. */
function resolvePackage(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const installed = new Map();
installedUnder(join(root, 'node_modules'), installed);

const workspaces = workspaceArgs.map((w) => realpathSync(join(root, w)));
const reachable = new Set();
const missing = [];
const queue = [...workspaces];
while (queue.length > 0) {
  const dir = queue.shift();
  if (reachable.has(dir)) continue;
  reachable.add(dir);
  const manifest = readManifest(dir);
  const peerMeta = manifest.peerDependenciesMeta ?? {};
  const edges = [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => [name, false]),
    // An optional peer is the requirer's guess about its host, not a
    // requirement: it is never followed, so one installed for the frontend
    // shows up as EXTRA rather than as reachable.
    ...Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => !peerMeta[name]?.optional)
      .map((name) => [name, true]),
  ];
  for (const [name, required] of edges) {
    const target = resolvePackage(dir, name);
    if (target) {
      queue.push(target);
    } else if (required) {
      missing.push(`${manifest.name} -> ${name}`);
    }
  }
}

const errors = [];
const allowed = [];
for (const edge of [...new Set(missing)].sort()) {
  if (ALLOWED_MISSING.has(edge)) allowed.push(`${edge} (${ALLOWED_MISSING.get(edge)})`);
  else errors.push(`missing required dependency: ${edge}`);
}
for (const [real, shown] of [...installed].sort((a, b) => a[1].localeCompare(b[1]))) {
  if (!reachable.has(real)) errors.push(`installed but required by nothing at runtime: ${shown}`);
}
for (const name of FORBIDDEN) {
  for (const shown of installed.values()) {
    if (shown === `node_modules/${name}` || shown.endsWith(`/node_modules/${name}`)) {
      errors.push(`forbidden in the runtime image: ${shown}`);
    }
  }
}

const packages = [...installed.keys()].filter((p) => !workspaces.includes(p)).length;
for (const line of allowed) console.log(`allowed missing peer: ${line}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  console.error(`${errors.length} problem(s) in ${packages} installed packages.`);
  process.exit(1);
}
console.log(
  `runtime node_modules: ${packages} packages, every one reachable from ` +
    `${workspaceArgs.join(', ')} and nothing required missing.`,
);
console.log(`absent, as required: ${FORBIDDEN.join(', ')}.`);
