// Mirrors packages/frontend/babel.config.js in the parts that matter for this
// spike: `unstable_transformImportMeta` is what lets Metro/Babel handle the
// `import.meta.url` that @matrix-org/matrix-sdk-crypto-wasm uses to locate its
// .wasm asset. The frontend already enables it, so the spike must too — testing
// with a different Babel config would not answer the question that was asked.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
        },
      ],
    ],
  };
};
