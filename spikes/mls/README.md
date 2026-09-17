# MLS crypto spike (Phase 1 of #139)

Runs `ts-mls` (a TypeScript implementation of RFC 9420) through the scenarios
the platform needs: multi-add commits, Welcome joins, a second device as its
own leaf, removal with forward secrecy, offline catch-up, out-of-order
delivery, concurrent commits, persistence, crash recovery, and a
WebCrypto-free crypto provider for React Native (Hermes has no `crypto.subtle`).

`RESULTS.md` records what was measured, on which versions, and what this
machine could not prove (no device, no Rust toolchain for OpenMLS / mls-rs).

This directory is outside the workspaces on purpose: a root `bun install` does
not touch it and it does not affect the main `bun.lock`.

```bash
cd spikes/mls
bun install
bun run spike.ts              # 47 checks, prints PASS/FAIL per check
bun run probe-nosubtle.ts     # which ts-mls code paths need crypto.subtle
bun run probe-nobleonly.ts    # the subtle-free provider, alone and interoperating
bun run build.ts              # browser bundle size with the node:crypto stub
```

`nobleOnlyProvider.ts` is the origin of the provider `@allo/core` ships.
