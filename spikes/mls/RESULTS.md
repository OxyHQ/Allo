# MLS crypto spike (Phase 1): `ts-mls` on bun/node, for Allo

Date: 2026-09-17. Machine: Linux x86_64 (WSL2), bun 1.4.2, node 24. No Rust
toolchain, so OpenMLS / mls-rs could not be built or compared here (see the last
section).

Everything below was run, not inferred. The scripts are in this directory:

| file | what it does |
| --- | --- |
| `spike.ts` | checks a–j; `bun run spike.ts` (47 checks, all PASS); output in `spike-run3.log` |
| `probe-nosubtle.ts` | removes `crypto.subtle` and shows which ts-mls / @hpke code paths die |
| `nobleOnlyProvider.ts` | a `CryptoProvider` for suite 1 that never touches WebCrypto (the React Native shape) |
| `probe-nobleonly.ts` | proves the provider works without `subtle`, and interoperates with the WebCrypto one |
| `build.ts`, `build-rn.ts`, `bundle-entry*.ts` | browser bundle-size measurements |
| `docs-upstream/` | fetched upstream READMEs / docs used for the API-difference notes |

## 1. Versions

Installed with `bun add ts-mls@1` (stable tag): **ts-mls 1.6.4**. Its only
declared dependency is `@hpke/core 1.9.0` (which brings `@hpke/common 1.10.1`).
bun also resolved `@noble/ciphers 2.1.1` (a non-optional peer).

Optional peers (per ciphersuite) installed later for the suite matrix, at the
exact versions ts-mls 1.6.4 pins in `peerDependencies`: `@noble/curves 2.0.1`,
`@hpke/chacha20poly1305 1.8.0`, `@hpke/ml-kem 0.3.0`, `@hpke/hybridkem-x-wing
0.7.0`, `@hpke/dhkem-x448 1.8.0`, `@noble/post-quantum 0.5.2`. Plus, for the RN
provider, `@hpke/dhkem-x25519 1.8.0`.

**Packaging bug in 1.6.4: a clean install does not import.** `ts-mls/index.js`
eagerly re-exports `nobleCryptoProvider`, whose `makeHashImpl.js` does
`import ... from "@noble/hashes/sha2.js"`, and `@noble/hashes` is only a
devDependency of ts-mls. Both bun and node fail at import time
(`Cannot find package '@noble/hashes'`). Fix: add `@noble/hashes` as a direct
dependency in Allo (`@noble/hashes 2.4.0` was used here). `@noble/curves`
depends on it, so installing that also masks the bug.

`npm view ts-mls@2.0.0-rc.16` (dist-tag `rc`, latest 1.x is `latest`):
`dependencies = { '@hpke/core': '1.9.0' }`; peers `@noble/curves 2.2.0`,
`@noble/ciphers 2.2.0`, `@noble/post-quantum 0.6.1`, `@hpke/ml-kem 0.3.0`,
`@hpke/dhkem-x448 1.8.0`, `@hpke/chacha20poly1305 1.8.0`,
`@hpke/hybridkem-x-wing 0.7.0`.

### 1.x vs 2.0 rc API differences

The published 1.6.4 README and the `npm view ts-mls@2.0.0-rc.16 readme` are
byte-identical (the rc's published README is stale). The GitHub `main` README
and `docs/migration-guide.md` describe 2.0. Diff of consequence:

- every entry point takes a single params object with a `context: MlsContext`
  (`{ cipherSuite, authService }`) instead of positional args;
  `authService` becomes a required explicit dependency (`ClientConfig` no
  longer carries it); a `unsafeTestingAuthenticationService` is exported for
  tests.
- `processPrivateMessage` / `processPublicMessage` / `processMessage` all
  take `{ context, state, message }`.
- `generateKeyPackage({ credential, cipherSuite, capabilities?, lifetime?,
  extensions? })`; `defaultLifetime` becomes a function.
- `getCiphersuiteImpl("NAME")` takes the name directly (1.x:
  `getCiphersuiteImpl(getCiphersuiteFromName("NAME"))`).
- string-literal enums become numeric constants (`wireformats.mls_welcome`,
  `protocolVersions.mls10`, `defaultCredentialTypes.basic`, ...).
- `encodeMlsMessage` / `decodeMlsMessage` become `encode(mlsMessageEncoder, x)`
  / `decode(mlsMessageDecoder, bytes)`; `encodeGroupState` becomes
  `encode(clientStateEncoder, state)`.
- `createCommit` returns `welcome` already wrapped as an `MlsWelcomeMessage`;
  `processKeyPackage({ context, state, keyPackage })` validates a key package
  and returns the add proposal.
- PQ ciphersuite IDs move from 77–88 to `0xf007`–`0xf012` (private-use
  range); X-Wing now depends on `@hpke/ml-kem` + `@noble/curves` rather than
  `@hpke/hybridkem-x-wing`.

The concepts (functional state, `consumed` key material, `historicalReceiverData`,
`ClientConfig`, `CryptoProvider`) are the same, so a wrapper written for 1.x
ports with mechanical renames. The migration guide includes a find/replace
cookbook.

## 2. Checks (suite 1, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`)

All 47 checks PASS on the final run (`spike-run3.log`). Every hop between
members goes through `encodeMlsMessage` / `decodeMlsMessage`, so the sizes are
wire sizes.

### a. create / two adds in one commit / join from Welcome — PASS

Alice creates the group (epoch 0, one leaf); one `createCommit` with two add
proposals moves her to epoch 1; the commit yields one Welcome (1136 B; the
commit is 834 B) that Bob and Carol both join from; all three have the same
`groupContext.epoch` and `keySchedule.epochAuthenticator` and the same member
list. The commits use `ratchetTreeExtension: true` so `joinGroup` needs no
out-of-band tree.

### b. application messages / replay / self-decrypt — PASS

- Each of the three sends; each other member decrypts (b1).
- Replay: the same ciphertext processed twice by the same receiver throws
  `ValidationError: Desired gen in the past` (b3). The default
  `keyRetentionConfig` (`retainKeysForGenerations: 10`) retains keys for
  *out-of-order* delivery but a consumed generation is deleted, so a straight
  replay is rejected.
- The sender cannot decrypt its own ciphertext: same error (b4). ts-mls
  advances the sender's own ratchet on send, so "decrypt my own message on
  the same device" is not a thing; the app keeps its own plaintext.
- A different receiver is unaffected by another's replay (b5).

### c. second device as a separate leaf — PASS

`bobLaptop` is a new key package with the SAME basic credential identity
`"bob"`; Bob commits the add; Alice/Carol process it; laptop joins from the
Welcome. Members are `alice,bob,carol,bob`. Uniqueness is enforced on signature
keys / HPKE keys (`defaultKeyPackageEqualityConfig` compares
`leafNode.signaturePublicKey`), not on the identity, so multi-device with one
identity per user works as separate leaves. Alice's message decrypts on both
Bob devices and on Carol.

### d. removal / forward secrecy — PASS

Alice commits `{ proposalType: "remove", remove: { removed: <carol leaf index> } }`.
Remaining members agree on epoch 3. Carol, processing the commit that removes
her, ends with `groupActiveState.kind === "removedFromGroup"` and her epoch
stays at 2 (she cannot derive epoch 3: no path secret reaches her). A message
Alice sends afterwards fails at Carol with
`CryptoError: OperationError: The operation failed for an operation-specific reason`
(an AEAD failure on sender-data decryption, i.e. the epoch keys are simply
wrong for her). Carol's own send is refused with
`UsageError: Cannot send messages after being removed from group`.

### e. offline catch-up and out-of-order delivery — PASS

- `carol2` misses two commits (an empty self-update commit from Alice and one
  from Bob). Processing them in order brings her to the group's epoch and
  authenticator, and she then decrypts a message sent while she was offline.
- **Commit N+1 before N**: `dave` (missing two commits) processes N+1 first.
  Error thrown, exactly:
  `CryptoError: OperationError: The operation failed for an operation-specific reason`.
  It is NOT a clean "wrong epoch" error: `processPrivateMessage` only has a
  fast path for `pm.epoch < state.epoch`; for a future epoch it goes straight
  to `unprotectPrivateMessage` with the current epoch's `senderDataSecret`, and
  the AEAD fails. The exception leaves the state untouched (functional API;
  e5), and N then N+1 succeeds (e6). A wrapper must compare
  `privateMessage.epoch` (a public field of the decoded message) with
  `state.groupContext.epoch` *before* calling and queue anything from the
  future; the library will not do it for you and the error it gives is
  indistinguishable from corruption.
- **Application message from the previous epoch arriving after the commit**
  decrypts fine (e7): `historicalReceiverData` keeps the last
  `retainKeysForEpochs: 4` epochs' secret trees.
- **Application message from a future epoch** (its commit not yet processed)
  throws the same `CryptoError: OperationError` (e8) and decrypts once the
  commit is processed (e9).

### f. concurrent commits — PASS

Alice and Bob each `createCommit` at epoch E (adding Erin and Frank
respectively). Both produce `newState` at E+1 without touching the caller's
state (f1). The "server" picks Alice's. Bob discards his pending commit by
never assigning `newState` — there is no explicit "pending commit" object to
clear, the API is purely functional — and processes Alice's commit from his
old state (f2). He then re-issues the Frank add at E+1, re-using Frank's
still-unused key package; Frank joins from the new Welcome; all seven agree
(f4).

Negative cases, error text exact:

- had Bob applied his own losing commit and then received Alice's:
  `ValidationError: Cannot process commit or proposal from former epoch` (f3).
  (The commit's epoch E is now "former" for him, so it is found in
  `historicalReceiverData`, decrypts, and is then refused as a handshake
  message from the past.)
- the Welcome from the discarded commit still *decodes and joins* locally
  (`joinGroup` does not throw) but produces a phantom epoch whose
  authenticator matches nobody; the app must never hand out a Welcome before
  the server has acknowledged the commit it came from (f5).

### g. persistence — PASS

`encodeGroupState(state): Uint8Array` / `decodeGroupState(bytes, 0) →
[GroupState, number] | undefined`. The blob is TLS-presentation-language, not
JSON; `JSON.stringify(state)` throws (`BigInt` epoch, `Map`, `Uint8Array`).
`ClientState = GroupState & { clientConfig }`; `clientConfig` holds functions
(`authService`, equality config) and is NOT serialised, the caller re-attaches
it after decoding.

- 7-member group at epoch 12 with 4 historical epochs retained: **14 223 B**.
- 50-member group, epoch 1: **21 551 B**. 2-member group after 1011
  messages: **1 560 B**.
- The blob **contains all private material in the clear**: the
  `signaturePrivateKey` (48 B here, PKCS#8 from WebCrypto) was found verbatim
  at offset 3423; all 4 HPKE private path keys were found verbatim (g2, g3).
  It must be stored encrypted at rest (Keychain/Keystore-wrapped key).
- Round trip is byte-identical (g5); the restored state decrypts and sends
  (g6, g7).
- Observation (g8): the pre-restore *object* is still usable and can decrypt
  the same message again — two live copies of one state are a replay/fork
  hazard. Exactly one live copy per group per device, persisted after every
  state-changing call, is the rule.

### h. crash recovery — PASS

Bob persists a snapshot, builds a commit (Gina), "crashes" before the server
accepts it. Alice's competing commit (Hal) wins. Bob restored from the
pre-commit snapshot processes Alice's commit and agrees with the group (h1),
then decrypts a message from Hal (h3). Restored from a post-commit snapshot
instead: `ValidationError: Cannot process commit or proposal from former epoch`
(h2). Rule for the wrapper: persist the pre-commit state, hold the commit's
`newState` in memory only, and swap it in only on server ack.

### i. measurements (bun 1.4.2, WebCrypto provider, x86_64 WSL2)

| what | value |
| --- | --- |
| generate 50 key packages | 25.9 ms (0.5 ms each) |
| `createCommit` with 49 adds (one commit) | 53.1 ms with ratchet_tree ext, 50.0 ms without |
| `joinGroup` from that Welcome | 54.2 ms (tree inside Welcome), 36.1 ms (tree out of band) |
| key package on the wire | **324 B** |
| Welcome for 49 joiners | **16 983 B** with ratchet_tree ext, **5 995 B** without (347 / 122 B per joiner) |
| commit adding 49 | **16 018 B** (the ext does not change the commit, only the Welcome/GroupInfo) |
| empty (self-update) commit, 50-member group | 4 523 B; create 67 ms, process 63 ms |
| remove-one commit, 50-member group | 3 168 B; create 68 ms |
| empty commit, 8-member group | 1 096 B |
| application message, 50-member group | 321 B, encrypt 1.3 ms |
| 1000 app messages (100 B payload, 2 members) | encrypt 560 ms (**0.56 ms/msg**), decrypt 575 ms (**0.57 ms/msg**) |
| app message overhead, default padding (`padUntilLength: 256`) | 1 B → 322 B, 100 B → 322 B, 255 B → 389 B, 1000 B → 1134 B, 10 kB → 10 134 B |
| app message overhead, no padding (`{ kind: "alwaysPad", paddingLength: 0 }`) | **+133/134 B** fixed (1 → 134, 12 → 145, 100 → 234, 1000 → 1134) |

The fixed 134 B is: MLSMessage header + PrivateMessage(group_id 16, epoch 8,
content_type, auth_data, encrypted_sender_data 44 (28 + tag 16), AEAD tag 16,
content_type byte, Ed25519 signature 64, length prefixes). Default padding
rounds every message up to a 256 B ciphertext body, which is what a chat app
wants (it hides message length); it is a `ClientConfig.paddingConfig` knob.

Run-to-run variance was ~2× on the millisecond figures (first run: 0.94/0.99
ms per message; final: 0.56/0.57). Sizes were stable to within a few bytes
(Ed25519 signatures and varints).

**Browser bundle** (`Bun.build`, `target: "browser"`, `minify: true`, gzip
level 9; entry = the wrapper surface listed in section 3):

| build | raw | gzip |
| --- | --- | --- |
| naive `bun build --target=browser --minify` | 665 802 B | 193 883 B |
| same with `crypto` stubbed (`build.ts`, optional peers external) | **135 653 B** | **36 748 B** |
| every optional peer installed and inlined (all 19 suites) | 285 146 B | 82 905 B |
| RN shape: ts-mls + `nobleOnlyProvider` (+@noble/curves, @noble/hashes, @hpke/dhkem-x25519) | 214 861 B | 66 847 B |

The naive number is wrong for a real browser: 54 % of it is bun's `node:crypto`
polyfill (plus `node:stream`, `node:buffer`), pulled in because `@hpke/common`
has `await import("crypto")` as a Node ≤ 18 fallback. `--external crypto` on
the CLI did not remove it; a `Bun.build` plugin that resolves `crypto` to a
stub does (`build.ts`). Expo web (Metro) will need the equivalent
(`resolver.extraNodeModules` / `resolveRequest` alias of `crypto` to a stub),
and Metro also fails the build on unresolvable *dynamic* imports, so the six
optional peers must either be installed or aliased to stubs — ts-mls's
`try { await import("@noble/curves/...") } catch` does not help under Metro.
Non-minified composition with the stub: ts-mls 200 KB (71 %), @hpke/common
31 KB, @hpke/core 28 KB, @noble/ciphers 23 KB.

### j. ciphersuites — all 19 pass a two-party round trip under bun's WebCrypto once their peers are installed

| id | suite | with base install | with peers | round trip | key pkg / welcome / commit / msg (B) |
| --- | --- | --- | --- | --- | --- |
| 1 | X25519 / AES-128-GCM / SHA-256 / Ed25519 | OK | OK | 10 ms | 327 / 774 / 486 / 320 |
| 2 | P-256 / AES-128-GCM / SHA-256 / P-256 | needs `@noble/curves` | OK | 49 ms | 411 / 897 / 572 / 320 |
| 3 | X25519 / ChaCha20-Poly1305 / SHA-256 / Ed25519 | needs `@hpke/chacha20poly1305` | OK | 18 ms | 323 / 764 / 480 / 320 |
| 4 | X448 / AES-256-GCM / SHA-512 / Ed448 | needs `@noble/curves`, `@hpke/dhkem-x448` | OK | 79 ms | 494 / 1214 / 750 / 320 |
| 5 | P-521 / AES-256-GCM / SHA-512 / P-521 | needs `@noble/curves` | OK | 108 ms | 714 / 1538 / 981 / 320 |
| 6 | X448 / ChaCha20 / SHA-512 / Ed448 | needs both | OK | 33 ms | 494 / 1204 / 740 / 320 |
| 7 | P-384 / AES-256-GCM / SHA-384 / P-384 | needs `@noble/curves` | OK | 66 ms | 544 / 1190 / 763 / 320 |
| 77–82 | ML-KEM-512/768/1024 (+AES or ChaCha), Ed25519 | needs `@hpke/ml-kem` | OK | 12–44 ms | 1855–3403 / 3073–5559 / 2024–3599 / 320 |
| 83–84 | X-Wing, Ed25519 | needs `@hpke/hybridkem-x-wing` | OK | 13–17 ms | 2689–2697 / 4397 / 2887–2895 / 320 |
| 85–88 | ML-KEM-1024 or X-Wing, **ML-DSA-87** | needs `@noble/post-quantum` | OK | 106–135 ms | 14 372–15 080 / 23 208–24 362 / 19 139–19 845 / **4702** |

Notes: P-256/P-384/P-521 *signatures* use `@noble/curves` even though the
DHKEM uses WebCrypto (ts-mls has no WebCrypto ECDSA path). Ed25519 uses
WebCrypto when `crypto.subtle` exists and `@noble/curves` otherwise. The
ML-DSA suites cost 4.7 KB per application message (signature size) and
~15 KB per key package — not for a mobile chat app today. **Suite 1 is the
right default for Allo**: no optional peers, smallest wire sizes, fastest, and
it is the one every other MLS stack (OpenMLS, mls-rs, Wire, RFC test vectors)
treats as mandatory-to-implement.

## 3. API surface to wrap behind an Allo `CryptoEngine`

The whole library is functional: every call takes a `ClientState` and returns
a new one; nothing mutates. Every result that touched secrets carries
`consumed: Uint8Array[]` which the caller should `zeroOutUint8Array` after
persisting.

```ts
// setup
const impl: CiphersuiteImpl = await getCiphersuiteImpl(getCiphersuiteFromName(name), provider?)
const clientConfig: ClientConfig = { keyRetentionConfig, lifetimeConfig, keyPackageEqualityConfig, paddingConfig, authService }
//   defaults exported individually: defaultKeyRetentionConfig {retainKeysForGenerations: 10, retainKeysForEpochs: 4, maximumForwardRatchetSteps: 200},
//   defaultLifetimeConfig, defaultKeyPackageEqualityConfig, defaultPaddingConfig {kind:"padUntilLength", padUntilLength: 256}, defaultAuthenticationService (accepts everything)

// identity + key packages
const credential: Credential = { credentialType: "basic", identity: Uint8Array }   // or { credentialType: "x509", certificates }
generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, extensions: [], impl)
  → { publicPackage: KeyPackage, privatePackage: { initPrivateKey, hpkePrivateKey, signaturePrivateKey } }
generateKeyPackageWithKey(..., { signKey, publicKey }, impl)   // reuse a long-lived signature key across key packages

// wire
encodeMlsMessage({ wireformat: "mls_key_package" | "mls_welcome" | "mls_private_message" | "mls_public_message" | "mls_group_info", version: "mls10", ... }): Uint8Array
decodeMlsMessage(bytes, 0) → [MLSMessage, bytesRead] | undefined       // discriminate on .wireformat

// group lifecycle
createGroup(groupId, keyPackage, privateKeyPackage, extensions, impl, clientConfig?) → ClientState
createCommit({ state, cipherSuite: impl, pskIndex? }, { extraProposals?: Proposal[], ratchetTreeExtension?, wireAsPublicMessage?, groupInfoExtensions?, authenticatedData? })
  → { newState, commit: MLSMessage, welcome: Welcome | undefined, consumed }
joinGroup(welcome, keyPackage, privatePackage, emptyPskIndex, impl, ratchetTree?, resumingFromState?, clientConfig?) → ClientState
joinGroupExternal(groupInfo, keyPackage, privateKeys, resync, impl, tree?, clientConfig?)   // external join, not exercised
createProposal(state, asPublicMessage, proposal, impl, authenticatedData?) → { newState, message, consumed }  // standalone proposals, not exercised

// proposals (plain objects)
{ proposalType: "add",    add: { keyPackage } }
{ proposalType: "remove", remove: { removed: leafIndex } }
{ proposalType: "update", update: { leafNode } }      // a commit with no proposals already does a self-update path
{ proposalType: "psk" | "reinit" | "external_init" | "group_context_extensions" | <custom number> }

// receiving (one entry point suffices)
processMessage(msg: MlsPrivateMessage | MlsPublicMessage, state, emptyPskIndex, acceptAll, impl)
  → { kind: "applicationMessage", message: Uint8Array, newState, consumed }
  | { kind: "newState", newState, actionTaken: "accept" | "reject", consumed }
//   the IncomingMessageCallback sees { kind: "commit", senderLeafIndex, proposals } or { kind: "proposal", proposal } and can return "reject"
//   note: the parameter type is MlsPrivateMessage (no `version`), while decodeMlsMessage returns MLSMessage (with it); pass the decoded object, not a fresh literal with `version`

// sending
createApplicationMessage(state, bytes, impl, authenticatedData?) → { newState, privateMessage, consumed }

// state inspection
state.groupContext.epoch: bigint;  state.groupContext.groupId;  state.keySchedule.epochAuthenticator
state.ratchetTree: (Node | undefined)[]   // leaf i is node 2i: n.nodeType === "leaf" && n.leaf.credential / .signaturePublicKey
state.groupActiveState.kind: "active" | "removedFromGroup" | "suspendedPendingReinit"
state.historicalReceiverData: Map<bigint, EpochReceiverData>
mlsExporter(state.keySchedule.exporterSecret, label, context, length, impl)   // MLS exporter for app-level keys (e.g. media)

// persistence
encodeGroupState(state) → Uint8Array;  decodeGroupState(bytes, 0) → [GroupState, n] | undefined;  then { ...groupState, clientConfig }

// crypto plug-in
interface CryptoProvider { getCiphersuiteImpl(cs: Ciphersuite): Promise<CiphersuiteImpl> }
interface CiphersuiteImpl { hash: Hash; hpke: Hpke; signature: Signature; kdf: Kdf; rng: Rng; name }
//   Hash {digest, mac, verifyMac}; Kdf {extract, expand, size}; Signature {sign, verify, keygen}; Rng {randomBytes}
//   Hpke {seal, open, importPrivateKey, importPublicKey, exportPublicKey, exportPrivateKey, encryptAead, decryptAead, exportSecret, importSecret, deriveKeyPair, generateKeyPair, keyLength, nonceLength}
//   HPKE keys are opaque to ts-mls (typed as CryptoKey but never inspected outside the provider) — verified by grep.
//   Exported providers: defaultCryptoProvider (WebCrypto), nobleCryptoProvider (partly noble; still needs subtle, see section 5).

// errors: all extend MlsError — ValidationError, CodecError, UsageError, DependencyError, CryptoVerificationError, CryptoError, InternalError
```

A `CryptoEngine` for Allo would therefore hold, per group: `ClientState`,
the `CiphersuiteImpl`, and a `ClientConfig`; expose `createGroup`,
`addMembers(keyPackages)`, `removeMembers(leafIndices)`, `join(welcome)`,
`encrypt(bytes)`, `decrypt(bytes)`, `processHandshake(bytes)`, `export()`;
and own the two invariants the library does not enforce: (1) epoch gating
(queue future-epoch messages, order commits), (2) pending-commit handling
(keep the pre-commit state persisted; apply `newState` on server ack;
drop it and re-propose on rejection).

## 4. Concurrency and ordering semantics observed

- Commits must be processed in exact epoch order. A future-epoch commit or
  application message fails with `CryptoError: OperationError` (AEAD failure),
  not with an epoch error; the state is untouched. The epoch is readable from
  the decoded `privateMessage.epoch` / `publicMessage.content.epoch` field
  before processing.
- A commit from a *past* epoch is `ValidationError: Cannot process commit or
  proposal from former epoch`; an application message from a past epoch (up to
  `retainKeysForEpochs`, default 4) still decrypts. Older than that:
  `ValidationError: Cannot process message, epoch too old`.
- Within an epoch, per-sender generations are ratcheted; out-of-order delivery
  within `retainKeysForGenerations` (10) / `maximumForwardRatchetSteps` (200)
  works, replay is `ValidationError: Desired gen in the past`.
- Two commits at the same epoch: the library has no notion of a "pending
  commit"; the caller holds two states and picks one. Discarding is free; the
  loser processes the winner from its pre-commit state and re-proposes. A key
  package used in a lost commit is reusable in the retry (it was never applied
  to the tree).
- Processing the commit that removes you yields
  `groupActiveState: removedFromGroup` at the *old* epoch; sending is then a
  `UsageError`, decrypting a `CryptoError`.
- A Welcome from an unacknowledged commit joins a phantom epoch without error.
  Welcomes must only be delivered after the commit is accepted.

## 5. React Native / Hermes: what the crypto needs

Hermes has no WebCrypto at all: no `crypto.subtle`, and no
`crypto.getRandomValues` without a polyfill. Measured here by shadowing
`crypto.subtle` with `undefined` (`probe-nosubtle.ts`), which is the closest
this machine gets to Hermes:

- `defaultCryptoProvider`: dies in `makeHashImpl` (`sc.digest`),
  `@hpke/common` HKDF (`this._api.importKey`), `@hpke/core` X25519
  (`this._api.generateKey`), and AES-GCM (`crypto.subtle.importKey`). Ed25519
  falls back to `@noble/curves` (and throws `DependencyError` if that is not
  installed — so `@noble/curves` is mandatory on RN).
- `nobleCryptoProvider` (ts-mls's own "noble" provider): hash/HMAC and AES-GCM
  are pure JS, **but the HKDF and the X25519 KEM still come from `@hpke/core`
  and still need `subtle`** (`hkdf.js:91 this._api.importKey`,
  `x25519.js:121 this._api.generateKey`). It is not a Hermes-ready provider
  despite its name.
- `@hpke/dhkem-x25519 1.8.0` is the noble-based X25519 KEM from the hpke-js
  monorepo, but its bundled `HkdfSha256` still calls `subtle` on the main
  path (it only uses noble HMAC when the salt length is not the hash size).

So the answer is a **custom `CryptoProvider`**, which ts-mls explicitly
supports (`getCiphersuiteImpl(cs, provider)`; docs `17-custom-crypto-provider.md`),
and `@hpke/core` supports at the HPKE level by accepting any `KemInterface` /
`KdfInterface` / `AeadInterface` in `new CipherSuite({ kem, kdf, aead })`.
`nobleOnlyProvider.ts` in this directory is that provider for suite 1:
`@noble/hashes` (SHA-256, HMAC, HKDF), an `HkdfSha256Native` subclass whose
`extract` / `expand` / `extractAndExpand` are noble, `@hpke/common`'s `Dhkem`
over `@hpke/dhkem-x25519`'s `X25519` primitive wired to that KDF, an
`AeadInterface` over `@noble/ciphers` AES-GCM, `@noble/curves` Ed25519, and
`crypto.getRandomValues` for the RNG. `probe-nobleonly.ts` shows:

- with `crypto.subtle` removed: full round trip (create, add, join, messages
  both ways, a commit from the joiner) **PASS**, 68 ms.
- with WebCrypto intact: **interop PASS in both directions** between a member
  on `defaultCryptoProvider` (what web would run) and one on
  `nobleOnlyProvider` (what RN would run), including a commit authored by the
  noble side.
- caveat found: the WebCrypto provider stores the Ed25519 signing key as a
  48 B PKCS#8 blob, the noble one as 32 B raw. A persisted state written by
  one provider cannot sign under the other
  (`"secretKey" expected Uint8Array of length 32, got length=48`). States are
  per device so this does not arise in Allo, but a wrapper should normalise
  the key to raw 32 B (`rawEd25519ToPKCS8` is the only conversion the library
  has, and it goes the other way) if state ever moves between providers.

Only `crypto.getRandomValues` is required from the platform. Options, from
npm on 2026-09-17:

| package | version | what it gives | fit |
| --- | --- | --- | --- |
| `react-native-get-random-values` | 2.0.0 | `crypto.getRandomValues` only (RN ≥ 0.81) | enough for `nobleOnlyProvider` |
| `expo-crypto` + `expo-standard-web-crypto` | 57.0.3 | `getRandomValues` (expo-standard-web-crypto's README: "Namely, `Crypto#getRandomValues()` is implemented"), plus `expo-crypto.digest` | enough; Allo is Expo, so this is the natural choice |
| `react-native-quick-crypto` | 1.1.7 | a C++/JSI Node-`crypto` implementation with a `subtle` (its `subtle.ts` has `X25519`, `Ed25519`, `HKDF`, `HMAC`, `AES-GCM`, `ChaCha20-Poly1305`, `ML-KEM`, `ML-DSA`, raw + pkcs8 import/export); peers `react-native-nitro-modules ≥ 0.31.2`, `react-native-quick-base64`, `expo ≥ 48` | could make `defaultCryptoProvider` run unmodified on RN, and would be faster than noble JS; but it is a native module + Nitro + new architecture, and its `subtle` must match WebCrypto's exact `importKey` semantics for `@hpke/core` (`pkcs8` X25519 keys, JWK export in `derivePublicKey`) — untested here |
| `@peculiar/webcrypto` | 1.7.1 | "A WebCrypto Polyfill for NodeJS": built on Node's `crypto`, not usable on Hermes | no |
| `react-native-webcrypto` | 1.0.0-alpha.3 (2022) | AES-GCM/HKDF/PBKDF2, Android only, no X25519/Ed25519 | no |
| `isomorphic-webcrypto` / `@sphereon/isomorphic-webcrypto` | 2.3.8 (2022) / 2.5.0-rn-crypto.2 (2024) | msrcrypto-based RN shim; no X25519/Ed25519 | no |

Recommendation: ship `nobleOnlyProvider` (pure JS, one platform dependency,
proven interoperable) and consider `react-native-quick-crypto` later as a
performance provider once measured on a device. ts-mls's docs say "Node.js
20+ is required" and the hpke docs list browsers, Node, Deno, Bun, Cloudflare
Workers; React Native is not a claimed target of either, so the RN provider is
Allo-owned code.

## 6. What this spike could NOT prove on this machine

- **iOS and Android/Hermes.** No device, no Hermes. The "no subtle" runs are
  bun with `crypto.subtle` shadowed, which proves the provider avoids
  WebCrypto but not that Hermes runs it. ts-mls uses `bigint` for epochs and
  lifetimes; Hermes has shipped BigInt since RN 0.70, but that is asserted
  from release notes, not run. Metro's handling of ts-mls's
  optional dynamic imports, `import.meta`-free ESM, and the `@hpke/common`
  `import("crypto")` fallback needs a real `expo export` / device build.
  Performance on a phone is unknown; noble JS X25519/Ed25519 is typically
  5–20× slower than native, which matters for the ~50 HPKE operations in a
  50-member commit (68 ms here on x86_64 WebCrypto).
- **Real browsers.** The bundle numbers come from `Bun.build`, not Metro/Expo
  web; the `crypto` stub and optional-peer aliasing must be reproduced in
  `metro.config.js`. Safari/Firefox WebCrypto X25519 and Ed25519 support was
  not exercised (Chrome ≥ 113 / Firefox ≥ 130 / Safari ≥ 17 have both; older
  Safari needs the noble provider or the `derivePublicKey` JWK fallback in
  `@hpke/core`).
- **WASM.** ts-mls has no WASM; nothing was measured for a WASM engine.
- **Security.** ts-mls's README: "This library has not undergone a formal
  security audit." Nothing here changes that. The spike checked protocol
  behaviour, not constant-time-ness or side channels of the JS primitives.
- **Interop with another MLS implementation.** Only ts-mls ↔ ts-mls (across
  two crypto providers) was tested. RFC 9420 test vectors were not run
  (ts-mls's own CI does, per its repo, but that was not verified here).
- **OpenMLS / mls-rs comparison.** Neither has an npm package; both are Rust
  crates. Adopting one means:
  - a Rust toolchain in CI and on every dev machine (none here);
  - **web**: `wasm-pack` / `wasm-bindgen` build of the crate plus a JS
    binding layer (mls-rs has no official WASM/JS package; OpenMLS has none
    either — the Wire `core-crypto` project is the closest thing: an OpenMLS
    wrapper with `wasm-bindgen` for web and `uniffi` for iOS/Android, but it
    is Wire's product, opinionated, and licensed GPL-3.0). A WASM crypto
    provider also needs `getrandom`'s `js` feature and a WASM-side RNG story;
  - **native**: `uniffi` (or hand-written JSI) bindings, an Expo config plugin
    for the Xcode/Gradle integration, prebuilt `.xcframework`/`.aar`
    artefacts per ABI (compare the `armeabi-v7a,arm64-v8a` pinning already
    needed for the Matrix SDK spike in this repo), and code-signing /
    EAS build implications;
  - a second copy of the persistence format (Rust-side `GroupStorageProvider`
    trait implementation over SQLite/Keychain) and an FFI-crossing cost per
    message.
  Rough estimate: 4–8 engineer-weeks to a first working binding on all three
  platforms, ongoing maintenance of the toolchain, versus ~1 week to wrap
  ts-mls behind `CryptoEngine` with the provider from this spike. The
  trade-off is that OpenMLS/mls-rs are audited, faster, and used in
  production (Wire, AWS Wickr); ts-mls is a single-maintainer, unaudited,
  pure-TS implementation whose 2.0 rc is still churning its API.

## 7. Summary

ts-mls 1.6.4 does everything Phase 1 asked for: multi-add commits, Welcome
joins, multi-device leaves, removal with forward secrecy, in-order catch-up,
functional state that makes concurrent-commit rollback and crash recovery
trivial, binary state serialisation, 19 ciphersuites, and a pluggable
`CryptoProvider` that lets a subtle-free noble provider interoperate with the
WebCrypto one. It needs Allo to own epoch gating, pending-commit handling,
Welcome gating, one-live-copy-of-state discipline, encrypted storage of the
state blob, and the RN crypto provider. Costs: an unaudited library, a
packaging bug (`@noble/hashes` missing from `dependencies`), a
`node:crypto`-polyfill trap in bundlers, and error messages that do not
distinguish "wrong epoch" from "corrupt".
