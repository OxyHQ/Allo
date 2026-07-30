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
     * A real MongoDB replica set for the whole run. Booting one costs a few
     * seconds once; not having one cost a bug that broke every report submission
     * while 62 tests passed.
     */
    globalSetup: [path.resolve(backendRoot, "vitest.globalSetup.ts")],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@allo/shared-types": path.resolve(backendRoot, "../shared-types/src"),
    },
  },
});
