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
  },
  resolve: {
    alias: {
      "@allo/shared-types": path.resolve(backendRoot, "../shared-types/src"),
    },
  },
});
