import path from "path";
import { defineConfig } from "vitest/config";

const backendRoot = import.meta.dirname;

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(backendRoot, "src/__tests__/setup.ts")],
    include: [path.resolve(backendRoot, "src/__tests__/**/*.test.ts")],
    /**
     * No `globalSetup`. It booted a MongoDB replica set for the whole run, and
     * nothing needs one now — the `*.realdb.test.ts` suites each create their
     * own throwaway, fully-migrated Postgres database instead
     * (`src/db/testDatabase.ts`), so the server they need is the one
     * `TEST_DATABASE_URL` points at rather than one this process starts.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@allo/shared-types": path.resolve(backendRoot, "../shared-types/src"),
    },
  },
});
