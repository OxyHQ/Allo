/**
 * External-join spike (RFC 9420 §12.4.3.2) for Allo on ts-mls 1.6.4.
 *
 * Question: can a device JOIN an existing conversation by itself, from a
 * server-stored GroupInfo, without an online member committing an Add?
 *
 * `bun run external.ts` — prints PASS/FAIL per check. Every hop between
 * members goes through encodeMlsMessage / decodeMlsMessage so sizes are wire
 * sizes.
 */
import {
  createGroup,
  createCommit,
  createApplicationMessage,
  processMessage,
  joinGroupExternal,
  createGroupInfoWithExternalPub,
  createGroupInfoWithExternalPubAndRatchetTree,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  generateKeyPackage,
  generateKeyPackageWithKey,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  decodeMlsMessage,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultKeyPackageEqualityConfig,
  defaultPaddingConfig,
  defaultAuthenticationService,
  acceptAll,
  type ClientState,
  type ClientConfig,
  type Credential,
  type CiphersuiteImpl,
  type MLSMessage,
  type KeyPackage,
  type PrivateKeyPackage,
  type GroupInfo,
  type IncomingMessageCallback,
  type Proposal,
} from "ts-mls"
import { ratchetTreeEncoder } from "ts-mls/ratchetTree.js"
import { encode } from "ts-mls/codec/tlsEncoder.js"
import { nobleOnlyProvider } from "./nobleOnlyProvider.ts"

// ---------------------------------------------------------------- harness

const te = new TextEncoder()
const td = new TextDecoder()
let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "PASS" : "FAIL"
  if (cond) passed++
  else failed++
  console.log(`[${tag}] ${name}${detail ? ` -- ${detail}` : ""}`)
}
function note(msg: string) {
  console.log(`       ${msg}`)
}
function errStr(e: unknown): string {
  const err = e as { constructor?: { name?: string }; message?: string }
  return `${err?.constructor?.name ?? "Error"}: ${err?.message ?? String(e)}`
}
async function expectThrow(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return errStr(e)
  }
}
function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
const ms = (t: number) => `${t.toFixed(1)} ms`

const clientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService,
}

// ---------------------------------------------------------------- MLS helpers

type Member = {
  name: string
  kp: { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }
  state?: ClientState
}

async function newMember(name: string, impl: CiphersuiteImpl): Promise<Member> {
  const credential: Credential = { credentialType: "basic", identity: te.encode(name) }
  const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
  return { name, kp }
}

function wire(msg: MLSMessage): Uint8Array {
  return encodeMlsMessage(msg)
}
function unwire(bytes: Uint8Array): MLSMessage {
  const r = decodeMlsMessage(bytes, 0)
  if (!r) throw new Error("decodeMlsMessage failed")
  return r[0]
}
function wireGroupInfo(gi: GroupInfo): Uint8Array {
  return wire({ wireformat: "mls_group_info", version: "mls10", groupInfo: gi })
}
function unwireGroupInfo(bytes: Uint8Array): GroupInfo {
  const m = unwire(bytes)
  if (m.wireformat !== "mls_group_info") throw new Error("expected mls_group_info")
  return m.groupInfo
}

/** What a server would do: store the latest GroupInfo bytes per conversation. */
async function publishGroupInfo(m: Member, impl: CiphersuiteImpl, withTree = true): Promise<Uint8Array> {
  const gi = withTree
    ? await createGroupInfoWithExternalPubAndRatchetTree(m.state!, [], impl)
    : await createGroupInfoWithExternalPub(m.state!, [], impl)
  return wireGroupInfo(gi)
}

/** Joiner side: external commit from stored GroupInfo bytes. */
async function externalJoin(
  joiner: Member,
  giBytes: Uint8Array,
  impl: CiphersuiteImpl,
  opts: { resync?: boolean; config?: ClientConfig; tree?: ClientState["ratchetTree"] } = {},
): Promise<Uint8Array> {
  const gi = unwireGroupInfo(giBytes)
  const { publicMessage, newState } = await joinGroupExternal(
    gi,
    joiner.kp.publicPackage,
    joiner.kp.privatePackage,
    opts.resync ?? false,
    impl,
    opts.tree,
    opts.config ?? clientConfig,
  )
  joiner.state = newState
  return wire({ wireformat: "mls_public_message", version: "mls10", publicMessage })
}

/** Existing member side: process a commit (public or private) from the wire. */
async function processHandshake(m: Member, bytes: Uint8Array, impl: CiphersuiteImpl, cb: IncomingMessageCallback = acceptAll) {
  const msg = unwire(bytes)
  if (msg.wireformat !== "mls_public_message" && msg.wireformat !== "mls_private_message") throw new Error("not a handshake")
  const r = await processMessage(msg, m.state!, emptyPskIndex, cb, impl)
  if (r.kind !== "newState") throw new Error("expected newState")
  m.state = r.newState
  return r
}

async function send(m: Member, text: string, impl: CiphersuiteImpl): Promise<Uint8Array> {
  const r = await createApplicationMessage(m.state!, te.encode(text), impl)
  m.state = r.newState
  return wire({ wireformat: "mls_private_message", version: "mls10", privateMessage: r.privateMessage })
}
async function recv(m: Member, bytes: Uint8Array, impl: CiphersuiteImpl): Promise<string> {
  const msg = unwire(bytes)
  if (msg.wireformat !== "mls_private_message") throw new Error("not a private message")
  const r = await processMessage(msg, m.state!, emptyPskIndex, acceptAll, impl)
  if (r.kind !== "applicationMessage") throw new Error("expected applicationMessage")
  m.state = r.newState
  return td.decode(r.message)
}
async function makeCommit(m: Member, impl: CiphersuiteImpl, proposals: Proposal[] = []) {
  const r = await createCommit({ state: m.state!, cipherSuite: impl }, { extraProposals: proposals, ratchetTreeExtension: true })
  return { ...r, commitWire: wire(r.commit) }
}

function epoch(m: Member): bigint {
  return m.state!.groupContext.epoch
}
function auth(m: Member): string {
  return hex(m.state!.keySchedule.epochAuthenticator)
}
function members(m: Member): string[] {
  const out: string[] = []
  for (const n of m.state!.ratchetTree) {
    if (n && n.nodeType === "leaf") {
      const c = n.leaf.credential
      out.push(c.credentialType === "basic" ? td.decode(c.identity) : "<x509>")
    }
  }
  return out
}
function leafIndexOf(m: Member, sigKey: Uint8Array): number {
  const t = m.state!.ratchetTree
  for (let i = 0; i < t.length; i += 2) {
    const n = t[i]
    if (n && n.nodeType === "leaf" && bytesEqual(n.leaf.signaturePublicKey, sigKey)) return i / 2
  }
  return -1
}
function agree(ms: Member[]): boolean {
  const e = epoch(ms[0]!)
  const a = auth(ms[0]!)
  return ms.every((m) => epoch(m) === e && auth(m) === a)
}
async function roundTrip(ms: Member[], impl: CiphersuiteImpl): Promise<boolean> {
  for (const s of ms) {
    const bytes = await send(s, `hello from ${s.name}`, impl)
    for (const r of ms) {
      if (r === s) continue
      const got = await recv(r, bytes, impl)
      if (got !== `hello from ${s.name}`) return false
    }
  }
  return true
}

// ---------------------------------------------------------------- run

const impl = await getCiphersuiteImpl(getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"))
console.log(`ts-mls ${(await import("ts-mls/package.json", { with: { type: "json" } })).default.version}, bun ${Bun.version}, suite ${impl.name}`)

// ================================================================ 1. GroupInfo with external_pub
console.log("\n--- 1. Alice publishes a GroupInfo with external_pub")

const alice = await newMember("alice", impl)
alice.state = await createGroup(te.encode("allo-conv-1"), alice.kp.publicPackage, alice.kp.privatePackage, [], impl, clientConfig)

// createCommit's groupInfoExtensions only feed the GroupInfo INSIDE the Welcome
// (encrypted to the added members). It never returns a GroupInfo, so it cannot
// produce what the server needs. The standalone helpers do.
{
  const r = await createCommit({ state: alice.state, cipherSuite: impl }, { ratchetTreeExtension: true, groupInfoExtensions: [] })
  check("1a createCommit returns no GroupInfo (only newState/commit/welcome)", !("groupInfo" in r) && r.welcome === undefined, Object.keys(r).join(","))
  // keep Alice at epoch 0: do NOT adopt r.newState
}

const gi0Bytes = await publishGroupInfo(alice, impl, true)
const gi0 = unwireGroupInfo(gi0Bytes)
const gi0Ext = gi0.extensions.map((e) => String(e.extensionType))
check("1b createGroupInfoWithExternalPubAndRatchetTree at epoch 0", gi0Ext.includes("external_pub") && gi0Ext.includes("ratchet_tree"), `extensions=${gi0Ext.join(",")} signer=leaf ${gi0.signer}`)
check("1c GroupInfo round-trips through encodeMlsMessage(mls_group_info)", bytesEqual(wireGroupInfo(gi0), gi0Bytes) && gi0.groupContext.epoch === 0n, `${gi0Bytes.length} B`)

const giNoTreeBytes = await publishGroupInfo(alice, impl, false)
check("1d GroupInfo without ratchet_tree", !unwireGroupInfo(giNoTreeBytes).extensions.some((e) => e.extensionType === "ratchet_tree"), `${giNoTreeBytes.length} B`)

// What is in it, and what is not.
{
  const ctx = gi0.groupContext
  note(`groupContext: groupId="${td.decode(ctx.groupId)}" epoch=${ctx.epoch} treeHash=${hex(ctx.treeHash).slice(0, 16)}… confirmedTranscriptHash=${hex(ctx.confirmedTranscriptHash).slice(0, 16)}… extensions=${ctx.extensions.length}`)
  const sk = alice.state.signaturePrivateKey
  const leaks: string[] = []
  if (indexOfBytes(gi0Bytes, sk) >= 0) leaks.push("signaturePrivateKey")
  for (const v of Object.values(alice.state.privatePath.privateKeys)) if (indexOfBytes(gi0Bytes, v) >= 0) leaks.push("hpke private key")
  const ks = alice.state.keySchedule
  for (const [k, v] of Object.entries(ks)) if (v instanceof Uint8Array && v.length >= 16 && indexOfBytes(gi0Bytes, v) >= 0) leaks.push(`keySchedule.${k}`)
  check("1e GroupInfo carries no private material (sig key, path keys, key schedule secrets)", leaks.length === 0, leaks.length ? `LEAKED: ${leaks.join(",")}` : "epochAuthenticator, externalSecret, initSecret etc. absent")
}

// ================================================================ 2. Bob joins externally
console.log("\n--- 2. Bob (never added) joins from the stored GroupInfo")

const bob = await newMember("bob", impl)
let seen: { senderLeafIndex: number | undefined; proposals: string[] } | undefined
const recordCb: IncomingMessageCallback = (inc) => {
  if (inc.kind === "commit") seen = { senderLeafIndex: inc.senderLeafIndex, proposals: inc.proposals.map((p) => p.proposal.proposalType) }
  return "accept"
}

const bobJoinWire = await externalJoin(bob, gi0Bytes, impl)
{
  const m = unwire(bobJoinWire)
  check("2a joinGroupExternal yields an mls_public_message commit from new_member_commit", m.wireformat === "mls_public_message" && m.publicMessage.content.contentType === "commit" && m.publicMessage.content.sender.senderType === "new_member_commit", `${bobJoinWire.length} B, epoch field=${m.wireformat === "mls_public_message" ? m.publicMessage.content.epoch : "?"}`)
  check("2b Bob's state is at epoch 1 with two members before anyone else saw it", epoch(bob) === 1n && members(bob).join(",") === "alice,bob", members(bob).join(","))
}
await processHandshake(alice, bobJoinWire, impl, recordCb)
check("2c Alice processes the external commit: epoch and authenticator agree", agree([alice, bob]), `epoch=${epoch(alice)} auth=${auth(alice).slice(0, 16)}…`)
check("2d callback saw senderLeafIndex=undefined and an external_init proposal", seen?.senderLeafIndex === undefined && (seen?.proposals ?? []).includes("external_init"), JSON.stringify(seen))
check("2e Alice's members list", members(alice).join(",") === "alice,bob", members(alice).join(","))
check("2f Bob decrypts Alice's next message and Alice decrypts Bob's", await roundTrip([alice, bob], impl))
{
  // Traffic from BEFORE the join: Alice sent this at epoch 0, from a state Bob never held.
  const preJoinAlice: Member = { ...alice, state: (await createGroup(te.encode("allo-conv-pre"), alice.kp.publicPackage, alice.kp.privatePackage, [], impl, clientConfig)) }
  const gi = await publishGroupInfo(preJoinAlice, impl)
  const early = await send(preJoinAlice, "before you joined", impl)
  const late = await newMember("latecomer", impl)
  await processHandshake(preJoinAlice, await externalJoin(late, gi, impl), impl)
  const err = await expectThrow(() => recv(late, early, impl))
  check("2h an external joiner cannot decrypt a message sent before it joined (fresh init_secret, no history)", err !== null, err ?? "")
}

// Mixed providers: Alice on WebCrypto, Bob's external join on the RN provider.
{
  const nobleImpl = await getCiphersuiteImpl(getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"), nobleOnlyProvider)
  const a2 = await newMember("a2", impl)
  a2.state = await createGroup(te.encode("g-mixed"), a2.kp.publicPackage, a2.kp.privatePackage, [], impl, clientConfig)
  const b2 = await newMember("b2", nobleImpl)
  const w = await externalJoin(b2, await publishGroupInfo(a2, impl), nobleImpl)
  await processHandshake(a2, w, impl)
  const msgA = await send(a2, "x", impl)
  const msgB = await send(b2, "y", nobleImpl)
  check("2g external join interoperates: publisher on WebCrypto, joiner on nobleOnlyProvider", agree([a2, b2]) && (await recv(b2, msgA, nobleImpl)) === "x" && (await recv(a2, msgB, impl)) === "y")
}

// ================================================================ 3. Concurrency + who publishes GroupInfo
console.log("\n--- 3. Concurrency at one epoch, and GroupInfo after the join")

// Alice builds a normal commit at epoch 1 (adding Erin) but the server accepts
// Dave's external commit first.
const erin = await newMember("erin", impl)
const alicePending = await makeCommit(alice, impl, [{ proposalType: "add", add: { keyPackage: erin.kp.publicPackage } }])
const gi1Bytes = await publishGroupInfo(alice, impl) // Alice's GroupInfo for epoch 1, before her commit
const dave = await newMember("dave", impl)
const daveJoinWire = await externalJoin(dave, gi1Bytes, impl)

{
  // Had Alice applied her own commit first (epoch 2), Dave's external commit at epoch 1 is refused.
  const wrong: Member = { ...alice, state: alicePending.newState }
  const err = await expectThrow(() => processHandshake(wrong, daveJoinWire, impl))
  check("3a Alice who applied her losing commit cannot process the external commit", err !== null, err ?? "")
}
// The right flow: discard the pending commit (never adopt newState), process Dave's from the pre-commit state.
await processHandshake(alice, daveJoinWire, impl)
await processHandshake(bob, daveJoinWire, impl)
check("3b Alice discards her pending commit and processes Dave's external commit; all agree at epoch 2", agree([alice, bob, dave]) && epoch(alice) === 2n, members(alice).join(","))

// Alice re-issues Erin's add at epoch 2 with the same key package (it was never applied).
{
  const retry = await makeCommit(alice, impl, [{ proposalType: "add", add: { keyPackage: erin.kp.publicPackage } }])
  alice.state = retry.newState
  await processHandshake(bob, retry.commitWire, impl)
  await processHandshake(dave, retry.commitWire, impl)
  const { joinGroup } = await import("ts-mls")
  erin.state = await joinGroup(retry.welcome!, erin.kp.publicPackage, erin.kp.privatePackage, emptyPskIndex, impl, undefined, undefined, clientConfig)
  check("3c Alice re-issues the lost Add at the new epoch; Erin joins from its Welcome; 4 agree at epoch 3", agree([alice, bob, dave, erin]) && epoch(alice) === 3n, members(alice).join(","))
}

// A stale GroupInfo (epoch 1) still on the server: a join built from it is refused by everyone.
{
  const late = await newMember("late", impl)
  const staleJoin = await externalJoin(late, gi1Bytes, impl) // late believes it is at epoch 2
  const err = await expectThrow(() => processHandshake({ ...alice }, staleJoin, impl))
  check("3d an external commit built from a STALE GroupInfo is refused by members", err !== null, err ?? "")
  note("the joiner's own newState is a phantom epoch; the server must answer epoch_conflict and the joiner must refetch GroupInfo and rebuild")
}

// Who publishes: can the external joiner itself publish a GroupInfo for the epoch it created?
{
  const giByDave = await publishGroupInfo(dave, impl) // dave's state is at epoch 3 now (processed Erin add)
  const giD = unwireGroupInfo(giByDave)
  const frank = await newMember("frank", impl)
  const w = await externalJoin(frank, giByDave, impl)
  for (const m of [alice, bob, dave, erin]) await processHandshake(m, w, impl)
  check("3e an external joiner (Dave) can publish a GroupInfo; Frank joins from it; 5 agree", agree([alice, bob, dave, erin, frank]) && epoch(alice) === 4n, `signer=leaf ${giD.signer} (${members(dave)[giD.signer]}) epoch=${giD.groupContext.epoch}`)
}
// And immediately after the join, before any other message?
{
  const g = await newMember("g", impl)
  g.state = await createGroup(te.encode("g-imm"), g.kp.publicPackage, g.kp.privatePackage, [], impl, clientConfig)
  const h = await newMember("h", impl)
  const hw = await externalJoin(h, await publishGroupInfo(g, impl), impl)
  const giByH = await publishGroupInfo(h, impl) // h publishes right after joinGroupExternal, before g even processed
  await processHandshake(g, hw, impl)
  const i = await newMember("i", impl)
  const iw = await externalJoin(i, giByH, impl)
  await processHandshake(g, iw, impl)
  await processHandshake(h, iw, impl)
  check("3f GroupInfo produced by the joiner straight out of joinGroupExternal is valid for the next joiner", agree([g, h, i]) && epoch(g) === 2n, members(g).join(","))
}

// ================================================================ 4. Second device, 4-party, removal
console.log("\n--- 4. Carol = Bob's second device (same identity), joins externally")

// fresh group of alice/bob/dave (+erin, frank from above = 5). Use a clean group for clarity.
const A = await newMember("alice", impl)
A.state = await createGroup(te.encode("allo-conv-2"), A.kp.publicPackage, A.kp.privatePackage, [], impl, clientConfig)
const B = await newMember("bob", impl)
await processHandshake(A, await externalJoin(B, await publishGroupInfo(A, impl), impl), impl)
const D = await newMember("dave", impl)
{
  const w = await externalJoin(D, await publishGroupInfo(B, impl), impl)
  await processHandshake(A, w, impl)
  await processHandshake(B, w, impl)
}
const C = await newMember("bob", impl) // Carol: Bob's laptop, SAME identity string
{
  const w = await externalJoin(C, await publishGroupInfo(A, impl), impl)
  for (const m of [A, B, D]) await processHandshake(m, w, impl)
  check("4a second device with the same identity joins externally as its own leaf", agree([A, B, D, C]) && members(A).join(",") === "alice,bob,dave,bob", members(A).join(","))
}
check("4b 4-party message round trip (every member to every other)", await roundTrip([A, B, D, C], impl))
{
  const idx = leafIndexOf(A, C.kp.publicPackage.leafNode.signaturePublicKey)
  const rm = await makeCommit(A, impl, [{ proposalType: "remove", remove: { removed: idx } }])
  A.state = rm.newState
  await processHandshake(B, rm.commitWire, impl)
  await processHandshake(D, rm.commitWire, impl)
  await processHandshake(C, rm.commitWire, impl)
  check("4c Alice removes Carol by leaf index; remaining agree; Carol is removedFromGroup", agree([A, B, D]) && C.state!.groupActiveState.kind === "removedFromGroup" && members(A).join(",") === "alice,bob,dave", `carol leaf=${idx}`)
  const after = await send(A, "post-removal", impl)
  const err = await expectThrow(() => recv(C, after, impl))
  check("4d Carol cannot read after removal; Bob still can", err !== null && (await recv(B, after, impl)) === "post-removal", err ?? "")
}

// resync: Bob's phone lost its group state but kept its signing key.
{
  const bobResync: Member = {
    name: "bob",
    kp: await generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode("bob") },
      defaultCapabilities(),
      defaultLifetime,
      [],
      { signKey: B.state!.signaturePrivateKey, publicKey: B.kp.publicPackage.leafNode.signaturePublicKey },
      impl,
    ),
  }
  const before = members(A).length
  const w = await externalJoin(bobResync, await publishGroupInfo(D, impl), impl, { resync: true })
  const m = unwire(w)
  const props = m.wireformat === "mls_public_message" && m.publicMessage.content.contentType === "commit" ? m.publicMessage.content.commit.proposals.map((p) => (p.proposalOrRefType === "proposal" ? p.proposal.proposalType : "ref")) : []
  await processHandshake(A, w, impl)
  await processHandshake(D, w, impl)
  const oldBobErr = await expectThrow(() => processHandshake(B, w, impl))
  check("4e resync=true: same signing key re-joins, old leaf removed + external_init in one commit, member count unchanged", agree([A, D, bobResync]) && members(A).length === before && props.join(",") === "remove,external_init", `proposals=${props.join(",")} members=${members(A).join(",")}`)
  check("4f the old Bob state (the one that was resynced away) cannot follow", oldBobErr !== null || B.state!.groupActiveState.kind === "removedFromGroup", oldBobErr ?? B.state!.groupActiveState.kind)
  check("4g resynced Bob decrypts and sends", await roundTrip([A, D, bobResync], impl))

  // The same device again, state lost again, but resync=false this time: the
  // signing key is already in the tree, so members must refuse the duplicate.
  const bobAgain: Member = {
    name: "bob",
    kp: await generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode("bob") },
      defaultCapabilities(),
      defaultLifetime,
      [],
      { signKey: bobResync.state!.signaturePrivateKey, publicKey: bobResync.kp.publicPackage.leafNode.signaturePublicKey },
      impl,
    ),
  }
  const w2 = await externalJoin(bobAgain, await publishGroupInfo(A, impl), impl, { resync: false })
  const A2: Member = { ...A }
  const errDup = await expectThrow(() => processHandshake(A2, w2, impl))
  const sigs = A2.state!.ratchetTree.flatMap((n) => (n && n.nodeType === "leaf" ? [hex(n.leaf.signaturePublicKey)] : []))
  const dupInTree = new Set(sigs).size !== sigs.length
  // ts-mls 1.6.4 gap: validateLeafNodeCredentialAndKeyUniqueness excuses the
  // committer's own leaf index, so the joiner's duplicate signature key is
  // ACCEPTED. RFC 9420 s7.3 requires signature_key unique among members.
  check("4h LIBRARY GAP: same signing key rejoining with resync=false is ACCEPTED by members (duplicate leaf in tree)", errDup === null && dupInTree, `members=${members(A2).join(",")} duplicateSigKey=${dupInTree}`)
  // The guard Allo's engine must add: the joiner's leaf is readable off the
  // wire (PublicMessage, sender new_member_commit) BEFORE processing.
  const m2 = unwire(w2)
  let guarded = false
  if (m2.wireformat === "mls_public_message" && m2.publicMessage.content.contentType === "commit" && m2.publicMessage.content.sender.senderType === "new_member_commit") {
    const leaf = m2.publicMessage.content.commit.path!.leafNode
    const removes = m2.publicMessage.content.commit.proposals.flatMap((p) => (p.proposalOrRefType === "proposal" && p.proposal.proposalType === "remove" ? [p.proposal.remove.removed] : []))
    const existing = leafIndexOf(A, leaf.signaturePublicKey)
    guarded = existing >= 0 && !removes.includes(existing)
  }
  check("4i wrapper guard: read path.leafNode off the wire, refuse if its signature key already holds a leaf not removed by this commit", guarded)
}

// ================================================================ 5. Security negatives
console.log("\n--- 5. Negatives")
{
  const S = await newMember("s", impl)
  S.state = await createGroup(te.encode("g-neg"), S.kp.publicPackage, S.kp.privatePackage, [], impl, clientConfig)
  const giOk = await publishGroupInfo(S, impl)

  // no external_pub → cannot even try
  const { createGroupInfo } = await import("ts-mls/createCommit.js")
  const giPlain = await createGroupInfo(S.state.groupContext, S.state.confirmationTag, S.state, [], impl)
  const j1 = await newMember("j1", impl)
  const e1 = await expectThrow(() => joinGroupExternal(giPlain, j1.kp.publicPackage, j1.kp.privatePackage, false, impl, S.state!.ratchetTree, clientConfig))
  check("5a GroupInfo without external_pub: join refused", e1 !== null, e1 ?? "")

  // no tree anywhere
  const giNoTree = unwireGroupInfo(await publishGroupInfo(S, impl, false))
  const e2 = await expectThrow(() => joinGroupExternal(giNoTree, j1.kp.publicPackage, j1.kp.privatePackage, false, impl, undefined, clientConfig))
  check("5b GroupInfo without ratchet_tree and no tree passed: join refused", e2 !== null, e2 ?? "")
  const okNoTree = await joinGroupExternal(giNoTree, j1.kp.publicPackage, j1.kp.privatePackage, false, impl, S.state!.ratchetTree, clientConfig)
  check("5c same GroupInfo with the tree passed out of band: join works", okNoTree.newState.groupContext.epoch === 1n)

  // tampered GroupInfo signature
  const tampered = new Uint8Array(giOk)
  tampered[tampered.length - 1] ^= 0x01 // last byte of the signature
  const j2 = await newMember("j2", impl)
  const e3 = await expectThrow(() => externalJoin(j2, tampered, impl))
  check("5d GroupInfo with a flipped signature byte: join refused", e3 !== null, e3 ?? "")

  // tampered external commit
  const j3 = await newMember("j3", impl)
  const w = await externalJoin(j3, giOk, impl)
  const wt = new Uint8Array(w)
  wt[wt.length - 1] ^= 0x01 // inside the signature/confirmation tag region
  const e4 = await expectThrow(() => processHandshake({ ...S }, wt, impl))
  check("5e external commit with a flipped byte (confirmation tag): member refuses", e4 !== null, e4 ?? "")
  const ws2 = new Uint8Array(w)
  ws2[ws2.length - 1 - 32 - 1 - 20] ^= 0x01 // 20 bytes into the 64-byte Ed25519 signature that precedes the 32-byte confirmation tag
  const e4b = await expectThrow(() => processHandshake({ ...S }, ws2, impl))
  check("5e2 external commit with a flipped byte in the signature: member refuses", e4b !== null, e4b ?? "")

  // credential policy: members validate the joiner's credential via authService
  const strictConfig: ClientConfig = {
    ...clientConfig,
    authService: {
      async validateCredential(c) {
        return c.credentialType === "basic" && td.decode(c.identity).startsWith("acct:")
      },
    },
  }
  const S2 = await newMember("acct:s2", impl)
  S2.state = await createGroup(te.encode("g-neg2"), S2.kp.publicPackage, S2.kp.privatePackage, [], impl, strictConfig)
  const gi2 = await publishGroupInfo(S2, impl)
  const stranger = await newMember("stranger", impl) // identity the policy refuses
  const ws = await externalJoin(stranger, gi2, impl)
  const e5 = await expectThrow(() => processHandshake({ ...S2 }, ws, impl))
  check("5f joiner whose credential the member's authService refuses: commit rejected by members", e5 !== null, e5 ?? "")
  const legit = await newMember("acct:legit", impl)
  await processHandshake(S2, await externalJoin(legit, gi2, impl), impl)
  check("5g joiner the policy accepts: admitted", agree([S2, legit]))

  // the server holds GroupInfo + tree: what does it know, and can it decrypt?
  const serverView = unwireGroupInfo(giOk)
  const treeExt = serverView.extensions.find((e) => e.extensionType === "ratchet_tree")!
  const ids: string[] = []
  const { decodeRatchetTree } = await import("ts-mls/ratchetTree.js")
  const t = decodeRatchetTree(treeExt.extensionData, 0)![0]
  for (const n of t) if (n && n.nodeType === "leaf" && n.leaf.credential.credentialType === "basic") ids.push(td.decode(n.leaf.credential.identity))
  note(`server learns from GroupInfo+tree: groupId, epoch, member identities [${ids.join(",")}], every leaf's signature + HPKE public key, tree hash, transcript hash, external_pub`)
  const secret = await send(S, "secret", impl)
  check("5h the server holding GroupInfo cannot read application traffic (no state derivable without joining)", secret.length > 0 && !("keySchedule" in serverView))
}

// ================================================================ 6. Size / perf
console.log("\n--- 6. Sizes and timings")
{
  const sizes = async (n: number) => {
    const founder = await newMember("m0", impl)
    founder.state = await createGroup(te.encode(`g-${n}`), founder.kp.publicPackage, founder.kp.privatePackage, [], impl, clientConfig)
    const adds: Proposal[] = []
    for (let i = 1; i < n; i++) adds.push({ proposalType: "add", add: { keyPackage: (await newMember(`m${i}`, impl)).kp.publicPackage } })
    if (adds.length) founder.state = (await makeCommit(founder, impl, adds)).newState
    const t0 = performance.now()
    const withTree = await publishGroupInfo(founder, impl, true)
    const t1 = performance.now()
    const noTree = await publishGroupInfo(founder, impl, false)
    const treeBytes = encode(ratchetTreeEncoder)(founder.state.ratchetTree)
    const joiner = await newMember("joiner", impl)
    const t2 = performance.now()
    const w = await externalJoin(joiner, withTree, impl)
    const t3 = performance.now()
    await processHandshake(founder, w, impl)
    const t4 = performance.now()
    console.log(`       ${String(n).padStart(2)} members: GroupInfo ${withTree.length} B with ratchet_tree, ${noTree.length} B without (tree alone ${treeBytes.length} B); createGroupInfo ${ms(t1 - t0)}; external commit ${w.length} B; joinGroupExternal ${ms(t3 - t2)}; member processes it ${ms(t4 - t3)}`)
    return { withTree: withTree.length, noTree: noTree.length, join: t3 - t2, proc: t4 - t3, commit: w.length }
  }
  const s2 = await sizes(2)
  const s50 = await sizes(50)
  check("6a sizes measured for 2 and 50 members", s2.withTree > 0 && s50.withTree > s2.withTree, `50-member external join ${ms(s50.join)}, processed in ${ms(s50.proc)}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
