#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECK = new URL('./check-web-export-html.mjs', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'allo-web-html-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const run = (dist) => spawnSync(process.execPath, [CHECK, dist], { encoding: 'utf8' });
const CSS = '<link rel="stylesheet" href="/_expo/global.css"/>';
const page = (script, css = CSS) =>
  `<!DOCTYPE html><html><head>${css}</head><body><div id="root"></div>${script}</body></html>`;
const fixture = (name, html) => {
  const dist = join(work, name);
  mkdirSync(join(dist, '_expo'), { recursive: true });
  writeFileSync(join(dist, '_expo', 'entry.js'), 'export {};\n');
  writeFileSync(join(dist, '_expo', 'global.css'), 'body{}\n');
  writeFileSync(join(dist, 'index.html'), html);
  return dist;
};
const expect = (name, html, status, why) => {
  const result = run(fixture(name, html));
  if (result.status !== status) {
    console.error(`FAIL: ${why}\n${result.stdout}${result.stderr}`);
    process.exit(1);
  }
};
expect(
  'ok',
  page('<script defer="" src="/_expo/entry.js"></script>'),
  0,
  'a loading page was rejected',
);
expect('none', page('<script>globalThis.x=1;</script>'), 1, 'a page with no script passed');
expect('gone', page('<script src="/_expo/missing.js"></script>'), 1, 'a missing bundle passed');
const loads = '<script defer="" src="/_expo/entry.js"></script>';
expect('unstyled', page(loads, ''), 1, 'a page with no stylesheet passed');
expect(
  'nocss',
  page(loads, '<link rel="stylesheet" href="/_expo/missing.css"/>'),
  1,
  'a missing stylesheet passed',
);
console.log('Web-export HTML mutations detected.');
