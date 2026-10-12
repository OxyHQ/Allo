/**
 * Global test setup for the backend package, loaded with `bun test --preload`.
 * Under `--parallel` (which implies `--isolate`) every test file gets a fresh
 * module registry and this preload runs again for each one, so the mock below
 * is in place before any file imports the module it replaces.
 *
 * The database is deliberately NOT mocked here. A mocked write accepts any
 * statement, including one the server rejects outright, so a suite built on
 * one stays green while the route fails for every caller. Database-backed
 * tests are the `*.realdb.test.ts` suites, each on its own throwaway database
 * (`src/db/testDatabase.ts`); nothing opens a connection merely by importing.
 */
import { mock } from 'bun:test';
import * as realLogger from '../utils/logger';

// Suppress log output; assertions that care about logging spy on it explicitly.
// Only `logger` is replaced: the module's other exports (the sanitiser that
// `platform/logger.test.ts` exercises) stay the real ones.
mock.module('../utils/logger', () => ({
  ...realLogger,
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));
