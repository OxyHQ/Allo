#!/usr/bin/env node
// Every exported page must load the app. SDK 58's static render hands the page
// its scripts through `useServerDocumentContext()`, and a root that drops them
// still exports cleanly and passes the size budget, while every page ships with
// no <script> at all (Inbox served exactly that in production). This reads each
// exported .html and fails unless it references at least one script and one
// stylesheet, and every local script and stylesheet it references exists.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DIST = resolve(
  process.argv[2] ?? new URL('../packages/frontend/dist', import.meta.url).pathname,
);
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });

const pages = files(DIST).filter((file) => file.endsWith('.html'));
const failures = [];
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const name = relative(DIST, page);
  if (scripts.length === 0) failures.push(`${name}: references no script`);
  if (styles.length === 0) failures.push(`${name}: references no stylesheet`);
  for (const asset of [...scripts, ...styles]) {
    if (asset.startsWith('/') && !asset.startsWith('//') && !existsSync(join(DIST, asset))) {
      failures.push(`${name}: references ${asset}, which the export does not contain`);
    }
  }
}
if (pages.length === 0) failures.push('the export contains no .html page');
for (const failure of failures) console.error(failure);
if (failures.length > 0) process.exit(1);
console.log(`All ${pages.length} exported pages load their scripts.`);
