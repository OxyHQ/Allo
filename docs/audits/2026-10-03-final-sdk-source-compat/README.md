# Allo candidate SDK compatibility

Source `7115bbed417f6d1d6ef3941d2e2d3739b8d47d4d` adapts the product at `795ba4e0` to reviewed Oxy candidate `dca175d22` and published Bloom 6.2.1. Local candidate manifests/lock are stored separately; production registry locks remain pending.

One backend OxyServer replaces the removed SDK singleton. Existing service credential configuration and canonical auth helpers are preserved. The socket calls middleware.socket; directory lookups use users.byUsername/get/getMany/search and the public avatar URL builder. Moderation still reads only the public profile with cache:false, with its import-closure guard retained.

One frontend OxyServices instance is handed to the registered OxyProvider and the existing linked HTTP clients. The Allo session adapter reads session.accessToken/userId/onChange, without copying credentials or decoding a second token. The pre-provider getCurrentUser restore is removed; appearance settings load after the provider resolves the signed-in account. Splash animation remains independent of identity/network resolution. Allo's account lifecycle, MLS engine, encryption, stores, secrets and DB code are unchanged.

Bloom's published import-aware migration updates Button appearances/tones, Switch checked/onCheckedChange, Card appearances and size names. The native chat FAB now takes explicit bottom-right layout from its parent (16-point inset), retaining the new-conversation handler and accessible name. These checks establish typed/render-test compatibility, not pixel-identical device acceptance.

Allo's old telemetry override 1.1.1 caused ESM import failure with the candidate core. Registry telemetry 1.2.0 resolves it. The failed import log is retained. After building the workspace shared-types/core/react packages, typechecks pass for backend/core/react/frontend. Backend focal tests: 52 passed in 3 suites. Existing frontend tests: 214 passed in 23 suites. One additional test uses the real SDK session namespace to check account/token coherence on refresh, switch and clear; final focus passes 9 tests in 3 suites. Backend build and Expo web export pass.

Scoped ESLint with --max-warnings=0 exits 1 for two existing utils/api.ts warnings (Array syntax and require); exact baseline stdin lint has the same diagnostics. No errors or new warnings remain. React test renderer deprecation/FontLoader act warnings remain in the test log. No warning is recategorized as a passing strict lint check.

Commands: root bun run typecheck; bun run --cwd packages/backend test [three named suites]; bun run --cwd packages/frontend test --runInBand; bun run --cwd packages/backend build; EXPO_NO_DOTENV=1 bun run --cwd packages/frontend build with an owned TMPDIR Metro cache. Source, candidate inputs and executed records are hashed in proof.json. Socket SQL suites, live OAuth, native device behavior and final registry/deployment acceptance remain pending.
