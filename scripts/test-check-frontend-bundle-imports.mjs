#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECK = new URL('./check-frontend-bundle-imports.mjs', import.meta.url).pathname;
const fixture = mkdtempSync(join(tmpdir(), 'allo-bundle-imports-'));
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }));
const run = () => spawnSync(process.execPath, [CHECK, fixture], { encoding: 'utf8' });

mkdirSync(join(fixture, 'components'));
writeFileSync(
  join(fixture, 'components', 'Good.tsx'),
  "import Ionicons from '@expo/vector-icons/Ionicons';\n",
);
const clean = run();
if (clean.status !== 0) {
  console.error(`FAIL: direct family import was rejected\n${clean.stdout}${clean.stderr}`);
  process.exit(1);
}

writeFileSync(
  join(fixture, 'components', 'Bad.tsx'),
  "import { Ionicons } from '@expo/vector-icons';\n",
);
const broken = run();
if (broken.status !== 1 || !broken.stderr.includes('components/Bad.tsx:1')) {
  console.error(`FAIL: root-barrel import escaped the gate\n${broken.stdout}${broken.stderr}`);
  process.exit(1);
}
rmSync(join(fixture, 'components', 'Bad.tsx'));
writeFileSync(
  join(fixture, 'components', 'Glyphs.tsx'),
  "import type { BloomIconComponent } from '@oxy.so/bloom/icons';\n" +
    "import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';\n",
);
const glyphs = run();
if (glyphs.status !== 0) {
  console.error(
    `FAIL: a type-only or per-glyph Bloom import was rejected\n${glyphs.stdout}${glyphs.stderr}`,
  );
  process.exit(1);
}

writeFileSync(
  join(fixture, 'components', 'Barrel.tsx'),
  "import type { ChatComposerIcon } from '@oxy.so/bloom/chat-composer';\n" +
    "import {\n  RiImageLine,\n  RiMic2Line,\n} from '@oxy.so/bloom/icons';\n",
);
const barrel = run();
if (barrel.status !== 1 || !barrel.stderr.includes('components/Barrel.tsx:2')) {
  console.error(
    `FAIL: a Bloom icon-barrel import escaped the gate\n${barrel.stdout}${barrel.stderr}`,
  );
  process.exit(1);
}
console.log('Bundle-import gate mutations detected.');
