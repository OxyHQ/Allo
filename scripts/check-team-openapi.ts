import { readFileSync, writeFileSync } from 'node:fs';
import { generateTeamOpenApi } from '../packages/contracts/src/openapi';
const path = new URL('../docs/platform/team-openapi.json', import.meta.url);
const expected = `${JSON.stringify(generateTeamOpenApi(), null, 2)}\n`;
if (process.argv.includes('--write')) {
  const formatted = Bun.spawnSync(
    ['bunx', 'biome', 'format', '--stdin-file-path=team-openapi.json'],
    { stdin: Buffer.from(expected) },
  );
  if (formatted.exitCode !== 0) throw new Error('Could not format Team OpenAPI');
  writeFileSync(path, formatted.stdout);
} else if (
  JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(JSON.parse(expected))
)
  throw new Error('Team OpenAPI is stale; run bun scripts/check-team-openapi.ts --write');
