<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Dependency gotchas

**Keep the provider and its linked clients on one Oxy core major.** Pin each
application's core directly and satisfy its services peer; inspect the installed
resolution, not only the manifest. SDK-only releases may test core7 beside an
application still on core6. Global core/contracts/protocol overrides must not
force one major into the other. `packages/sdk/README.md` and `bun.lock` record
the independent release boundary; the application changes majors separately.

**`@react-native-community/netinfo`.** Root `overrides` plus `resolutions` pin it
to an **exact version, not a range**; the frontend declares it as a direct
dependency. Keep it exact.

**Metro and the MLS engine.** `metro.config.js` is the shared
`createOxyMetroConfig` from `@oxy.so/app-preset/metro` (watch folders, block
list, `.wasm`/`.woff2` assets, minifier, NativeWind and its complete
`react-native` shim) with Allo's resolver wrapped over the preset's: it handles
its own names first and hands everything else, `react-native` included, down
unchanged. It aliases `crypto` (a Node-only
fallback inside `@hpke/common`) to `metro/empty-module.js`, the optional `ts-mls`
peers Allo does not install (`@hpke/ml-kem` and friends) to
`metro/ts-mls-optional-peer.js`, and every `@hpke/*` package root to its ESM
build. The last one is not cosmetic: the CJS build is a UMD wrapper whose
factory takes a parameter named `require`, Metro's collector only rewrites the
global one, and the static-render bundle `expo export` runs in Node picks the
`require` condition and dies with "Requiring unknown module @hpke/common".
Measured: the client bundle compiled and the SSR pass failed until the ESM
mapping landed. Jest needs `ts-mls|@hpke` in `transformIgnorePatterns` for the
same ESM reason.

**Android release signing is `@oxy.so/services/plugins/withOxySharedPermissions`'.**
Since services 13.4.0 that plugin (which declares the Oxy signature permissions)
also applies `withOxyReleaseSigning`: the `release` buildType is ALWAYS signed
from the `OXY_UPLOAD_*` Gradle properties (`gradle.properties` in the Gradle user home, or
`-P`, never the repo), and `oxyVerifyReleaseSigning` fails any release whose
certificate is not the Oxy ecosystem one. There is no debug-key fallback; a
debug build keeps Expo's debug key (no Oxy permissions) unless
`OXY_UPLOAD_SIGN_DEBUG=true`. `@oxy.so/app-preset/plugin/withOxyAndroidRelease`
was removed in app-preset 5 and throws if listed; `__tests__/appConfig.test.ts`
keeps it out.

**Babel stays the bare preset.** `packages/frontend/babel.config.js` is only
`@oxy.so/app-preset/babel`: in development that is exactly `babel-preset-expo`;
production adds the preset's build-id inliner. `@/` resolves from
`tsconfig.json` `paths` (Jest maps it in `moduleNameMapper`), and
`babel-preset-expo` adds the worklets plugin and the `import.meta` transform
itself. Noxcturnal, Expo's oxc transformer
(`experiments.noxcturnalTransformWorker`), stays off: noxcturnal 0.1.11 to
0.1.13 miscompile `@tanstack/query-core`'s `QueriesObserver` on web (the
temporary holding the lowered constructor's return value reuses `_result`, the
name of the `#result` private key), so every `useQueries` throws "attempted to
use private field on non-instance" in development. Development and production
both bundle with Babel; turn it back on only with a release that compiles that
class correctly.

**`bun.lock` regeneration.** Always run `bun install` from the **monorepo root**,
never inside a package: a sub-package install can drop workspace resolution lines
from `bun.lock` and break CI. The root `packageManager` is the one bun pin:
every workflow's setup-bun reads it (`bun-version-file`, never a literal) and
`bun run check:bun-pin` fails when `packages/backend/Dockerfile`'s
`FROM oven/bun:<version>` tag disagrees. Regenerate the lockfile with that bun; a bump moves both pins.
