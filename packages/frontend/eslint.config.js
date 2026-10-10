// Biome (`biome.jsonc` at the repo root) formats and lints this package. This
// config keeps ONLY what Biome has no rule for, and `expo lint` runs it:
//
// - `expo/no-env-var-destructuring` and `expo/no-dynamic-env-var`: Metro inlines
//   `process.env.EXPO_PUBLIC_*` only when it is read as a literal member
//   expression; a destructured or computed read is silently `undefined` in the
//   bundle, and nothing else catches it.
// - `expo/use-dom-exports`: a `'use dom'` file may only export a single default
//   React component, a non-async function, or Expo cannot mount it.
//
// Everything else that eslint-config-expo enforced either has a Biome
// equivalent (configured in `biome.jsonc`, including the `expo-video`
// `VideoView` import restriction) or is covered by `tsc`.
// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');

module.exports = defineConfig([
  {
    ignores: ['dist/**', '.expo/**', '.wrangler/**'],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      'expo/use-dom-exports': 'error',
    },
  },
]);
