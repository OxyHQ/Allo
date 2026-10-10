/**
 * Global test setup for the backend package.
 *
 * The database is deliberately NOT mocked here. A mocked write accepts any
 * statement, including one the server rejects outright, so a suite built on
 * one stays green while the route fails for every caller. Database-backed
 * tests are the `*.realdb.test.ts` suites, each on its own throwaway database
 * (`src/db/testDatabase.ts`); nothing opens a connection merely by importing.
 */
import { vi } from "vitest";

// Suppress log output; assertions that care about logging spy on it explicitly.
vi.mock("../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
