// Jest on Expo's preset, with the Bloom language compiler in front of the
// preset's own Babel transform: a test fails on the same chain the build would.
const preset = require('jest-expo/jest-preset');

const SOURCE = '\\.[jt]sx?$';

module.exports = {
  ...preset,
  transform: {
    ...preset.transform,
    [SOURCE]: [
      require.resolve('@oxy.so/bloom-language-compiler/jest'),
      { upstream: preset.transform[SOURCE] },
    ],
  },
  resolver: 'react-native-reanimated/jest/resolver.js',
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|@noble|ts-mls|@hpke|@oxy\\.so|@scure|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@oxy\\.so/bloom/surfaces$': '<rootDir>/__mocks__/bloom-surfaces.js',
    '^@oxy\\.so/bloom/screen$': '<rootDir>/__mocks__/bloom-screen.js',
  },
};
