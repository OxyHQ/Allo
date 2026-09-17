/**
 * What an OPTIONAL `ts-mls` peer resolves to when it is not installed.
 *
 * `ts-mls` supports ciphersuites Allo does not use (ChaCha20-Poly1305, ML-KEM,
 * X-Wing, X448, ML-DSA) and reaches each one through a dynamic import of a
 * package that is an optional peer. Allo installs none of them: its suite is
 * the X25519 / AES-GCM / Ed25519 suite, all from `@noble`. Metro resolves the
 * imports anyway, so each name is pointed here — see `metro.config.js`.
 *
 * Not an empty object. If a code path ever did select one of those suites,
 * destructuring `{}` would hand it `undefined` and the failure would surface
 * three calls later as "x is not a constructor". Reading anything off this
 * module throws with the name of what was asked for.
 */
const INTEROP_KEYS = new Set(['__esModule', 'default', 'then']);

module.exports = new Proxy(
  {},
  {
    get(_target, property) {
      if (typeof property === 'symbol' || INTEROP_KEYS.has(property)) return undefined;
      throw new Error(
        `ts-mls asked for "${String(property)}" from an optional peer that Allo does not install. ` +
          'Allo uses the X25519 / AES-GCM / Ed25519 suite only; see metro/ts-mls-optional-peer.js.',
      );
    },
  },
);
