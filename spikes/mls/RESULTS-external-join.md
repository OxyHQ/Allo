# MLS external join spike: can a device join an Allo conversation by itself?

Date: 2026-09-18. Machine: Linux x86_64 (WSL2), bun 1.4.2. Scratch copy of
`spikes/mls` (Phase 1); nothing in the Allo repo was touched.

**Answer: yes.** With `ts-mls 1.6.4` a device that was never added can join an
existing group from a server-stored GroupInfo (RFC 9420 §12.4.3.2, external
commit), existing members accept it through the ordinary `processMessage`,
and the joiner can immediately publish the next GroupInfo itself. 38 checks,
all PASS (`external-run4.log`). Two library gaps were found and are listed in
§7; both are worked around above the library, neither blocks the design.

| file | what it does |
| --- | --- |
| `external.ts` | the 38 checks; `bun run external.ts` |
| `external-run1.log` … `external-run4.log` | four runs (run 4 is the final script; 1–3 have fewer checks and give the timing variance) |

## 1. Versions

`ts-mls 1.6.4` (dist-tag `latest`), installed with the exact peers the Phase 1
`package.json` pins: `@noble/curves 2.0.1`, `@noble/hashes ^2.4.0` (the 1.6.4
packaging bug from Phase 1 §1 still needs it), `@hpke/dhkem-x25519 1.8.0`,
`@hpke/chacha20poly1305 1.8.0`, `@hpke/dhkem-x448 1.8.0`,
`@hpke/hybridkem-x-wing 0.7.0`, `@hpke/ml-kem 0.3.0`, `@noble/post-quantum
0.5.2`; `typescript 7.0.2`. Suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
throughout. Primary provider is bun's WebCrypto; check 2g runs the joiner on
`nobleOnlyProvider.ts` (the React Native shape `@allo/core` ships).

**The library ships no docs for this.** `node_modules/ts-mls/` has no `docs/`
directory and its `README.md` does not contain the word "external" at all. The
API below was read off `dist/src/createCommit.d.ts`, `groupInfo.d.ts`,
`message.d.ts`, `processMessages.js`, `clientState.js` and `publicMessage.js`.

## 2. The API (ts-mls 1.6.4)

```ts
// publisher side: any current member, from its ClientState
createGroupInfoWithExternalPub(state, extensions: Extension[], impl): Promise<GroupInfo>               // external_pub only
createGroupInfoWithExternalPubAndRatchetTree(state, extensions, impl): Promise<GroupInfo>             // + ratchet_tree
encodeMlsMessage({ wireformat: "mls_group_info", version: "mls10", groupInfo })                        // what the server stores
//   GroupInfo = { groupContext, extensions, confirmationTag, signer: leafIndex, signature }
//   external_pub = HPKE public key derived from state.keySchedule.externalSecret (cs.hpke.deriveKeyPair)
//   signed with the publisher's own leaf signature key; `signer` is its leaf index

// joiner side: a fresh key package, never added
joinGroupExternal(groupInfo, keyPackage, privatePackage, resync: boolean, impl, tree?: RatchetTree, clientConfig?, authenticatedData?)
  → { publicMessage: PublicMessage, newState: ClientState }
encodeMlsMessage({ wireformat: "mls_public_message", version: "mls10", publicMessage })               // the external commit on the wire
//   publicMessage.content.sender = { senderType: "new_member_commit" }; content.epoch = the GroupInfo's epoch
//   commit.proposals = [external_init]  (resync: [remove <own former leaf>, external_init]); commit.path present

// member side: unchanged
processMessage(decoded, state, emptyPskIndex, callback, impl) → { kind: "newState", newState, ... }
//   callback sees { kind: "commit", senderLeafIndex: undefined, proposals: [external_init] }  — NOT the joiner's leaf
```

What `createCommit` does NOT do: its `groupInfoExtensions` option only decorates
the GroupInfo that is encrypted inside the Welcome, and `CreateCommitResult` is
`{ newState, welcome, commit, consumed }` with no GroupInfo (1a). The standalone
helpers above are the only way to get one for a server. They are cheap (0.2 to
1.1 ms at 50 members) and take only the state, so they can be called right after
`createCommit` on `newState`, or right after `joinGroupExternal` on its
`newState` (3f).

What `joinGroupExternal` verifies before it builds anything (read from
`createCommit.js`): `external_pub` present, every GroupContext extension
supported by the joiner's capabilities, a ratchet tree from the extension or the
`tree` argument, `validateRatchetTree` against `groupContext.treeHash`
(lifetimes, parent hashes, leaf signatures), the signer leaf's credential via
`clientConfig.authService.validateCredential`, and the GroupInfo signature with
the signer's leaf key. Only then does it KEM to `external_pub`, add its leaf,
build an UpdatePath and derive the new epoch with `initSecret` = the KEM
shared secret.

What `processCommit` verifies on the member side (`processMessages.js`,
`publicMessage.js`): the message epoch equals the member's epoch; the commit
signature with `commit.path.leafNode.signaturePublicKey` (for
`new_member_commit` the key comes from the path's leaf, since the sender has no
leaf index); the path leaf's own signature over `(groupId, leafIndex)`; the
joiner's credential via `authService.validateCredential`; required
capabilities; then the confirmation tag of the new epoch. The new epoch's
`init_secret` is recovered by decrypting the `external_init` KEM output with
the member's `external_priv`.

## 3. Checks (38, all PASS)

### 1. GroupInfo with `external_pub` — PASS (1a–1e)

Alice creates a group (epoch 0) and, with no commit at all, produces a
GroupInfo with `external_pub` + `ratchet_tree` (1b: extensions
`external_pub,ratchet_tree`, signer = leaf 0). It round-trips through
`encodeMlsMessage`/`decodeMlsMessage` as `mls_group_info` (1c: 434 B with the
tree, 1d: 202 B without). The serialized bytes contain none of Alice's private
material: her `signaturePrivateKey`, every HPKE private key in `privatePath`,
and every `keySchedule` secret of 16 bytes or more (`epochAuthenticator`,
`externalSecret`, `initSecret`, …) were searched for verbatim and none is
present (1e).

### 2. Bob joins externally — PASS (2a–2h)

Bob, never added by anybody, calls `joinGroupExternal` with Alice's epoch-0
GroupInfo and his own fresh key package. The result is a 523 B
`mls_public_message` whose sender is `new_member_commit` and whose epoch field
is 0 (2a); his own `newState` is already at epoch 1 with members `alice,bob`
before anyone has seen it (2b). Alice `processMessage`s it: same epoch, same
`epochAuthenticator` (2c), same member list (2e), and both directions of
application traffic decrypt (2f). The `IncomingMessageCallback` on Alice's side
saw `{ senderLeafIndex: undefined, proposals: ["external_init"] }` and nothing
else (2d) — see §7 for why that matters.

2g: Alice on WebCrypto, Bob's join on `nobleOnlyProvider` (the RN provider):
agree and exchange messages. The external join path uses only
`hpke.deriveKeyPair`, `hpke.exportPublicKey` and the ordinary seal/open, which
the RN provider already implements.

2h: a message Alice sent BEFORE the join is refused by the joiner with
`ValidationError: Cannot process message, epoch too old`. An external joiner
starts with an empty `historicalReceiverData` and an `init_secret` that comes
from its own KEM, so it derives nothing about previous epochs.

### 3. Concurrency, and who publishes — PASS (3a–3f)

- 3a/3b: Alice builds a normal commit at epoch 1 (adding Erin) and keeps it
  pending; Dave's external commit at epoch 1 is accepted first. Had Alice
  applied her own commit, Dave's fails with `ValidationError: Cannot process
  message, epoch too old`; discarding it (never adopting `newState`) and
  processing Dave's from the pre-commit state works and everybody agrees at
  epoch 2. This is Phase 1's check (f) with an external commit as the winner:
  the same 409 flow, no new rule.
- 3c: Alice re-issues Erin's Add at epoch 2 with the same key package; Erin
  joins from the new Welcome; four agree at epoch 3.
- 3d: a join built from a STALE GroupInfo (epoch 1, after the group moved on)
  is refused by every member with the same `epoch too old` error. The joiner's
  own `newState` is a phantom epoch. So the server must answer such a commit
  with `epoch_conflict` exactly as for a member's stale commit, and the joiner
  refetches the GroupInfo and rebuilds; nothing on the joiner needs undoing
  because it never adopted the state.
- 3e: **an external joiner can publish the GroupInfo for the epoch it
  created.** Dave (joined externally) later produces a GroupInfo signed by his
  own leaf (signer = leaf 2); Frank joins from it; five agree.
- 3f: the GroupInfo produced by the joiner straight out of
  `joinGroupExternal`, before any member has processed its commit, is valid for
  the next joiner. So "the committer of every commit uploads the GroupInfo for
  the epoch it creates" holds for external commits too, and it can be uploaded
  in the same request as the commit.

### 4. Second device, four parties, removal, resync — PASS (4a–4i)

- 4a: Carol is a second device with the SAME basic-credential identity `bob`
  and a different signing key; she joins externally as her own leaf, members
  `alice,bob,dave,bob`.
- 4b: four-party round trip, every member to every other.
- 4c/4d: Alice removes Carol by leaf index with a normal commit; the three
  remaining agree; Carol's state is `removedFromGroup` and she cannot read
  what follows (`CryptoError: OperationError`) while Bob's other leaf can.
- 4e: **resync.** Bob's phone "loses its group state" but keeps its signing
  key (`generateKeyPackageWithKey` with the old key, which is how `@allo/core`
  makes every key package). `joinGroupExternal(..., resync = true)` finds the
  former leaf by `keyPackageEqualityConfig.compareKeyPackageToLeafNode`
  (default: same signature key), and emits ONE commit with proposals
  `remove,external_init`. Members process it; the member count is unchanged;
  the resynced Bob sends and receives (4g).
- 4f: the OLD Bob state, if it still existed somewhere, cannot follow that
  commit — but it dies with `InternalError: ... No overlap between provided
  private keys and update path`, not with `removedFromGroup` (§7, gap 1).
- 4h/4i: see §7, gap 2.

### 5. Negatives — PASS (5a–5h)

| check | result |
| --- | --- |
| 5a GroupInfo without `external_pub` | `UsageError: Could not find external_pub extension` |
| 5b no `ratchet_tree` and no tree passed | `UsageError: No RatchetTree passed and no ratchet_tree extension` |
| 5c same GroupInfo, tree passed out of band | joins |
| 5d GroupInfo with one signature byte flipped | `CryptoVerificationError: Could not verify groupInfo Signature` (joiner refuses before building anything) |
| 5e external commit, byte flipped in the confirmation tag | `CryptoVerificationError: Could not verify confirmation tag` |
| 5e2 external commit, byte flipped in the Ed25519 signature | `CryptoVerificationError: Signature invalid` |
| 5f members whose `authService.validateCredential` refuses the joiner's identity | `ValidationError: Could not validate credential` — commit rejected, state untouched |
| 5g joiner the policy accepts | admitted |
| 5h a party holding only GroupInfo + tree | reads groupId, epoch, member identities, every leaf's signature and HPKE public keys, tree hash, transcript hash, `external_pub`; holds no key schedule and cannot read traffic |

## 4. Sizes and timings

Final run (`external-run4.log`); runs 1–3 in brackets where they differ.

| what | 2 members | 50 members |
| --- | --- | --- |
| GroupInfo with `ratchet_tree` | **672 B** (674, 678, 670) | **11 213 B** (11 243, 11 245, 11 171) |
| GroupInfo without `ratchet_tree` | **226 B** | **227 B** |
| ratchet tree alone (`ratchetTreeEncoder`) | 441 B | 10 981 B |
| `createGroupInfoWithExternalPubAndRatchetTree` | 0.3 ms | 0.8 ms (0.7–1.1) |
| external commit on the wire | 594 B (590, 588, 600) | 4 605 B (4 597–4 603) |
| `joinGroupExternal` (joiner) | 8.1 ms (5.4, 6.8, 7.2) | **58.4 ms** (56.9, 59.1, 54.6) |
| member `processMessage` of it | 4.6 ms (4.1, 4.3, 3.9) | **26.7 ms** (28.5, 26.0, 26.8) |

For comparison, Phase 1 measured `joinGroup` from a Welcome at 50 members at
54 ms and an empty commit at 50 members at 67 ms create / 63 ms process. An
external join costs the same as a Welcome join for the joiner and less than
half an ordinary commit for each member. The 224 B a GroupInfo costs without
the tree is the fixed part (GroupContext with two 32 B hashes, confirmation
tag, `external_pub` 32 B, signature 64 B); the tree is ~220 B per member and
is exactly what a Welcome with `ratchetTreeExtension: true` already carries
today (Phase 1: 347 B per joiner with the tree vs 122 B without).

## 5. Security notes

From RFC 9420 §12.4.3.2 and what the library was observed to do:

- **What the external commit may contain.** The RFC restricts an external
  commit to exactly one `ExternalInit`, at most one `Remove` (the joiner's own
  former leaf — "resync"), optional `PreSharedKey`, nothing else, and it MUST
  carry a `path`. `joinGroupExternal` builds exactly that (4e:
  `remove,external_init`; 2a: `external_init` only) and cannot be asked to add
  or remove anybody else. An external commit therefore cannot change
  membership beyond adding its own sender; every other change still needs a
  member.
- **What the server learns from a stored GroupInfo.** With the tree: the
  group id, the epoch, the confirmed transcript hash and tree hash, and for
  every leaf its credential (in Allo, `accountId:instanceId`), signature
  public key, HPKE public key, capabilities and lifetime (5h, 1e). Without the
  tree: everything but the leaves. No secret: `external_pub` is a public key
  derived from `external_secret`, and the confirmation tag is a MAC the server
  cannot verify without `confirmation_key`. **For the Allo server this is no
  new information**: it already holds every leaf's `(accountId, instanceId)` in
  the leaves table and every signature key from the key packages it serves.
  For anybody else it IS membership disclosure, so the GET must be gated the
  way `appendClientEvent` gates writes (a member row for the caller's account,
  or a 404).
- **Can the server, or a non-member with the GroupInfo, forge a join? No.**
  Anybody with the GroupInfo can *build* an external commit (that is the
  point), but the commit is signed by the joiner's own leaf signature key and
  carries the joiner's credential in `path.leafNode`, and every existing member
  verifies (a) that signature, (b) the leaf's own signature, (c) the credential
  through `authService.validateCredential` (5f: a refused credential rejects
  the commit), (d) the confirmation tag (5e). A forged joiner is a joiner with
  a credential the members do not accept; it changes nothing on their side.
  In Allo the credential identity is `accountId:instanceId`, the server admits
  an `mls_commit` only from an active instance of a member account, and the
  client-side chain verification (the elector's `approve`/instance chain) runs
  on the identity the leaf declares. `validateCredential` receives exactly
  `(credential, signaturePublicKey)`, which is the pair the chain binds, so
  "does this account's chain contain an instance with this id and this signing
  key" is the check to plug in there.
- **Can the server substitute a tree?** No: the tree hash is inside the signed
  GroupInfo and `validateRatchetTree` checks the tree against it, whether the
  tree came in-band or out of band (5c, 5d).
- **Can the server replay an old GroupInfo to fork the group?** It can serve a
  stale one, and the join built from it is rejected by every member (3d). The
  joiner adopts nothing until the server acknowledges the commit, so a stale
  GroupInfo costs one round trip, not a fork.
- **Forward secrecy / what the joiner learns.** The joiner learns the public
  membership before joining (the same thing a Welcome tells it). The new
  epoch's `init_secret` is the KEM shared secret the joiner generated, so
  members derive the new epoch from something the joiner chose plus the
  commit's path secret; the joiner learns nothing about previous epochs (2h),
  and, as after any commit, the previous epoch's keys are gone for the future.
  The RFC's caution here is the reverse direction: publishing `external_pub`
  means *anybody the members' credential policy accepts* can join without
  being invited, so admission control moves entirely to the credential
  validation and to the server's access check. That is where Allo already
  puts it (instance chain + member row).
- **`resync`** (RFC: "a member re-joining the group after losing state")
  means: find my former leaf (same signature key), remove it and add my new
  leaf in one commit. It is the recovery path for a device that lost its
  encrypted-at-rest group state but kept its identity key. It relies on
  `keyPackageEqualityConfig`, which `@allo/core` inherits as the default
  (signature key equality); since Allo derives every key package from one
  long-lived signing key per instance, "same signing key" is "same instance".
  Without resync the same device rejoining is a second leaf for the same
  instance (see gap 2).
- **Two live copies.** As in Phase 1 (g8), a resynced-away state that still
  exists somewhere is a hazard: it cannot follow (4f) but the library gives it
  an `InternalError`, not a clean removed state.

## 6. Design implications for Allo

1. **The server stores the latest GroupInfo per conversation.** One row:
   `(conversationId, epoch, signerInstanceId, bytes)`, overwritten when a
   commit for a higher epoch lands. 0.7–11 KB. The committer of every commit
   uploads it **in the same `POST /v1/conversations/:id/events` request** as
   the commit (`commit.groupInfo`), because both a member committer
   (`createCommit().newState`) and an external joiner
   (`joinGroupExternal().newState`, 3f) hold the new state at that moment;
   that makes "commit accepted but no GroupInfo for the new epoch" impossible
   instead of a crash window. Any member may also re-upload for the current
   epoch (3e), which covers conversations created before the field exists.
   `GET` is gated by a member row for the caller's account, like every read.
2. **A joiner posts an external commit as an ordinary `mls_commit` event**:
   `epoch` = the GroupInfo's epoch, `commit.newEpoch = epoch + 1`,
   `commit.addedLeaves = [{ accountId, instanceId: self }]`,
   `commit.removedLeaves = []`, no `welcome`, plus the new GroupInfo. Server
   rules that change in `eventRepository.appendClientEvent`:
   - the sender need not hold a leaf yet — it needs a member row for its
     account, which the `findMember` check already expresses (an invited
     account waiting for its first device has one);
   - an added leaf that IS the sender is `active` at `newEpoch` immediately,
     not `pending_welcome` (there is no Welcome to wait for);
   - **resync**: `addedLeaves` and `removedLeaves` naming the same instance is
     a replace, not the current `"an added instance already holds an active
     leaf"` refusal;
   - the DM rule ("a dm cannot gain a third account") is unchanged; the
     joiner's account is already `joined`.
   The `epoch_conflict` answer and the client's discard-and-retry are the same
   as today (3a/3b/3d): a joiner that loses the race refetches the GroupInfo.
3. **The engine validates the joiner before `processMessage`**, because the
   `IncomingMessageCallback` sees only `external_init` and no leaf (2d), and
   because of gap 2 below. The joiner's leaf is public on the wire:
   `publicMessage.content.commit.path.leafNode` when
   `sender.senderType === "new_member_commit"`. Rules: credential parses as
   `accountId:instanceId`; that instance is in the account's verified chain
   with that signing key (this is also the right body for
   `clientConfig.authService.validateCredential`, which today only parses);
   no active leaf already carries that signing key, or that instance id,
   unless a `remove` proposal in the same commit removes it (4i). A commit that
   fails is dropped; the state is untouched.
4. **The elector rule becomes the fallback.** A device that finds itself a
   member with no active leaf (a new account's first device, a new device of a
   member account) fetches the GroupInfo and joins itself; "This device is
   being added…" is shown only when no GroupInfo exists for the current epoch
   (a conversation whose last committer predates the field) and then the
   elector adds it as now. Held messages for a not-yet-installed account still
   need the account to have a member row first, which the inviter's commit
   already creates.
5. **Lost state recovery** becomes `joinGroupExternal(..., resync = true)`
   with a key package from the device's existing signing key: one commit, no
   other device involved, membership unchanged (4e). The server-side "replace"
   rule in point 2 is what makes it admissible.
6. **Nothing changes for the crypto provider.** The RN provider already
   covers the external join path (2g).

## 7. Library gaps found (ts-mls 1.6.4), both to report upstream

1. **`selfRemoved` is hard-coded `false` for external commits**
   (`clientState.js:495`; the member-commit branch computes it at line 459).
   A member whose leaf is removed by somebody's resync commit therefore does
   not get `groupActiveState: removedFromGroup`; it throws
   `InternalError: ... No overlap between provided private keys and update
   path` (4f). In Allo the affected state is, by definition, one the device
   lost, so this only bites when two live copies exist; the wrapper should
   treat that `InternalError` after a `remove` of its own leaf index as
   "removed".
2. **Signature-key uniqueness is not enforced for the committer's leaf.**
   `validateLeafNodeCredentialAndKeyUniqueness(tree, leafNode,
   existingLeafIndex)` walks the tree for internal duplicates and never
   compares the `leafNode` argument against it; for an external commit the new
   leaf is already in the tree but a duplicate found at `existingLeafIndex`
   (its own index) is excused. Measured: the same signing key rejoining with
   `resync = false` is **accepted** and the tree ends with two leaves sharing
   one signature key (4h, `alice,bob,dave,bob`, `duplicateSigKey=true`). RFC
   9420 §7.3 requires `signature_key` to be unique among members. The
   wrapper-level guard in §6 point 3 catches it before the library runs (4i).

## 8. What this spike did not do

- No server: "the server" is a variable holding bytes. The `eventRepository`
  changes in §6 are read off the code, not implemented.
- No chain verification: `authService` in the negative check is a string
  prefix policy, standing in for the instance chain.
- No PSK, no `external_senders`, no `required_capabilities` in the group
  context, no ML-KEM suite. Allo's groups carry no GroupContext extensions
  today, so `joinGroupExternal`'s "client does not support every extension in
  the GroupContext" check was not exercised.
- Timings are bun on x86_64 with WebCrypto; the RN provider was only checked
  for correctness (2g), not timed. Phase 1 §5 has its cost profile.
