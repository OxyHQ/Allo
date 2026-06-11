// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Monorepo support: watch the entire monorepo so Metro can resolve files
// that live in workspace sibling packages and inside deeply nested
// `node_modules/<pkg>/node_modules/...` trees.
config.projectRoot = projectRoot;
config.watchFolders = [monorepoRoot];

const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/shared-types/src')),
    /\.expo\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
  ],
  extraNodeModules: {
    '@allo/shared-types': path.join(monorepoRoot, 'packages/shared-types'),
  },
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  unstable_enableSymlinks: true,
  assetExts: [
    ...config.resolver.assetExts.filter((ext) => ext !== 'svg' && ext !== 'woff' && ext !== 'woff2'),
    'woff2',
    'woff',
  ],
};

// NativeWind: 1rem === 16px on every platform (browser default).
const REM_PX = 16;

module.exports = withNativeWind(config, {
  input: './styles/global.css',
  inlineRem: REM_PX,
});
