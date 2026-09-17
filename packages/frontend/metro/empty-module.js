/**
 * What `require('crypto')` resolves to in the app bundle.
 *
 * `@hpke/common` (under `ts-mls`, under `@allo/core`) keeps a Node-only
 * fallback, `await import("crypto")`, behind a check for `globalThis.crypto`.
 * The branch never runs in a browser or on Hermes, but Metro resolves every
 * import statically and there is no `crypto` module to resolve to, so the
 * bundle would fail before the check could be reached. See `metro.config.js`.
 */
module.exports = {};
