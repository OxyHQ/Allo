#!/usr/bin/env node
/** Refuse Metro-hostile package-barrel imports in frontend source. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = resolve(process.argv[2] ?? new URL('../packages/frontend', import.meta.url).pathname);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['.expo', 'dist', 'node_modules']);
const ROOT_VECTOR_ICON_IMPORT = /from\s+['"]@expo\/vector-icons['"]/;
// A value import from Bloom's root or its icon barrel puts every component or
// every glyph (the whole Remix set, ~450 KB) in the web entry. Type-only
// imports are erased and stay allowed.
const BLOOM_BARREL_IMPORT = /import\s+(type\s+)?[^;]*?\bfrom\s+['"]@oxy\.so\/bloom(\/icons)?['"]/g;

function extension(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extension(path))) files.push(path);
  }
  return files;
}

const violations = [];
const bloomViolations = [];
for (const file of sourceFiles(ROOT)) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    if (ROOT_VECTOR_ICON_IMPORT.test(line)) {
      violations.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
    }
  });
  for (const match of source.matchAll(BLOOM_BARREL_IMPORT)) {
    if (match[1]) continue;
    const line = source.slice(0, match.index).split('\n').length;
    bloomViolations.push(`${relative(ROOT, file)}:${line}: ${match[0].replace(/\s+/g, ' ')}`);
  }
}

if (violations.length > 0) {
  console.error(
    'Import icon families through @expo/vector-icons/<Family>; the root barrel bundles every font.\n' +
      violations.join('\n'),
  );
}
if (bloomViolations.length > 0) {
  console.error(
    'Import Bloom by subpath (@oxy.so/bloom/<component>, @oxy.so/bloom/icons/<Glyph>); a barrel bundles all of it.\n' +
      bloomViolations.join('\n'),
  );
}
if (violations.length > 0 || bloomViolations.length > 0) process.exit(1);

console.log(
  `Bundle imports: ${relative(process.cwd(), ROOT)} has no vector-icon or Bloom barrel imports.`,
);
