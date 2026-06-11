// packages/frontend/babel.config.js
module.exports = function (api) {
    api.cache(true);

    // Minimal config for Jest unit tests. Avoids babel-preset-expo (which injects
    // Expo's "winter" runtime and breaks Jest 30) — tests only need TS + ESM transforms.
    if (process.env.NODE_ENV === 'test') {
      return {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
        plugins: [
          ['module-resolver', {
            root: ['.'],
            alias: { '@': './' },
            extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
          }],
        ],
      };
    }

    return {
      // 👇 Treat NativeWind as a PRESET for your version
      presets: [
        [
          'babel-preset-expo',
          {
            jsxImportSource: "nativewind",
            unstable_transformImportMeta: true,
          },
        ],
        'nativewind/babel',
      ],
      plugins: [
        // resolver must come first for proper module resolution
        ['module-resolver', {
          root: ['.'],
          alias: { '@': './' },
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.svg'],
        }],
        '@babel/plugin-syntax-dynamic-import',
        '@babel/plugin-transform-export-namespace-from',
        // must be LAST
        'react-native-worklets/plugin',
      ],
    };
  };