/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  // gramjs is mocked in every test (no network, no real client), so its heavy
  // transitive deps never load. The manager imports it via `telegram/...`
  // subpaths; the manual mock under src/__tests__/__mocks__ intercepts them.
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2020",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          strict: false,
          skipLibCheck: true,
          isolatedModules: true,
          lib: ["ES2021", "DOM"],
        },
        diagnostics: false,
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testTimeout: 30000,
  forceExit: true,
};
