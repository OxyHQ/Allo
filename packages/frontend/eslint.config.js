// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    settings: {
      // Metro picks a platform variant before the plain file — `foo.native.ts`
      // on iOS and Android, `foo.web.ts` on web — and `tsconfig.json` tells
      // TypeScript the same thing through `moduleSuffixes`. The import resolver
      // knows about neither, so an import of a module that exists *only* as
      // platform variants, as `lib/matrix/client` does, would be reported as
      // unresolved by a rule that is otherwise worth keeping on.
      'import/resolver': {
        typescript: {
          extensions: [
            '.native.ts',
            '.native.tsx',
            '.ts',
            '.tsx',
            '.d.ts',
            '.js',
            '.jsx',
            '.json',
          ],
        },
      },
    },
  },
  {
    // Build scripts run in Node before Metro ever sees the project, so they get
    // Node's module globals. The Expo config does not grant them, because
    // everything else here is bundled.
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
]);
