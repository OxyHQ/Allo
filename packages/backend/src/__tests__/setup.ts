/**
 * Global test setup for the backend package.
 *
 * Mongoose is deliberately NOT mocked. An earlier version of this file replaced
 * `connect`/`disconnect` with stubs to keep unit tests off the network, and the
 * cost of that convenience was a bug that made `POST /reports` fail for EVERY
 * report ever submitted while the whole suite stayed green — a mocked
 * `updateOne` accepts any update document, including one Mongo rejects outright.
 *
 * Nothing opens a connection merely by importing: `utils/database.ts` exports a
 * function nobody calls at module scope. The moderation tests either mock the
 * MODEL (unit) or connect to the replica set from `vitest.globalSetup.ts`
 * explicitly (integration).
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
