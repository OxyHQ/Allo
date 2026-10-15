import { readFileSync, writeFileSync } from 'node:fs';
import { generateTeamOpenApi } from '../packages/contracts/src/openapi';
const path = new URL('../docs/platform/team-openapi.json', import.meta.url);
const expected = `${JSON.stringify(generateTeamOpenApi(), null, 2)}\n`;
if (process.argv.includes('--write')) writeFileSync(path, expected);
else if (readFileSync(path, 'utf8') !== expected)
  throw new Error('Team OpenAPI is stale; run bun scripts/check-team-openapi.ts --write');
