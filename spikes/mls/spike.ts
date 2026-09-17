/**
 * ts-mls spike for Allo's MLS engine evaluation.
 *
 * Runs with `bun run spike.ts`. Prints PASS/FAIL per check and the measured
 * numbers. Every "server" hop goes through the real MLS wire encoding
 * (encodeMlsMessage / decodeMlsMessage) so the sizes are the sizes a
 * delivery service would carry.
 */
import {
  createGroup,
  joinGroup,
  createCommit,
  createApplicationMessage,
  processMessage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  ciphersuites,
  generateKeyPackage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  decodeMlsMessage,
  encodeGroupState,
  decodeGroupState,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultKeyPackageEqualityConfig,
  defaultPaddingConfig,
  defaultAuthenticationService,
  acceptAll,
  type ClientState,
  type ClientConfig,
  type Proposal,
  type Credential,
  type CiphersuiteImpl,
  type CiphersuiteName,
  type MLSMessage,
  type KeyPackage,
  type PrivateKeyPackage,
} from "ts-mls"

// ---------------------------------------------------------------- harness

const te = new TextEncoder()
const td = new TextDecoder()
let passed = 0
let failed = 0
const results: string[] = []

function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "PASS" : "FAIL"
  if (cond) passed++
  else failed++
  const line = `[${tag}] ${name}${detail ? ` -- ${detail}` : ""}`
  results.push(line)
  console.log(line)
}
function note(msg: string) {
  results.push(`       ${msg}`)
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
function wireKeyPackage(kp: KeyPackage): Uint8Array {
  return wire({ wireformat: "mls_key_package", version: "mls10", keyPackage: kp })
}
function addProposalFromWire(bytes: Uint8Array): Proposal {
  const m = unwire(bytes)
  if (m.wireformat !== "mls_key_package") throw new Error("expected key package")
  return { proposalType: "add", add: { keyPackage: m.keyPackage } }
}
function removeProposal(leafIndex: number): Proposal {
  return { proposalType: "remove", remove: { removed: leafIndex } }
}

type CommitOut = { newState: ClientState; commitBytes: Uint8Array; welcomeBytes?: Uint8Array }

/** Create a commit but do NOT apply it to the member (the "pending commit"). */
async function makeCommit(
  m: Member,
  impl: CiphersuiteImpl,
  proposals: Proposal[],
  opts: { ratchetTreeExtension?: boolean } = {},
): Promise<CommitOut> {
  const res = await createCommit(
    { state: m.state!, cipherSuite: impl },
    { extraProposals: proposals, ratchetTreeExtension: opts.ratchetTreeExtension ?? true },
  )
  const out: CommitOut = { newState: res.newState, commitBytes: wire(res.commit) }
  if (res.welcome) out.welcomeBytes = wire({ wireformat: "mls_welcome", version: "mls10", welcome: res.welcome })
  return out
}
/** Create a commit and apply it (the server accepted it). */
async function commitAndApply(m: Member, impl: CiphersuiteImpl, proposals: Proposal[], opts = {}): Promise<CommitOut> {
  const c = await makeCommit(m, impl, proposals, opts)
  m.state = c.newState
  return c
}

async function recv(m: Member, bytes: Uint8Array, impl: CiphersuiteImpl) {
  const msg = unwire(bytes)
  if (msg.wireformat !== "mls_private_message" && msg.wireformat !== "mls_public_message")
    throw new Error(`unexpected wireformat ${msg.wireformat}`)
  const r = await processMessage(msg, m.state!, emptyPskIndex, acceptAll, impl)
  m.state = r.newState
  return r
}
async function recvText(m: Member, bytes: Uint8Array, impl: CiphersuiteImpl): Promise<string> {
  const r = await recv(m, bytes, impl)
  if (r.kind !== "applicationMessage") throw new Error(`expected applicationMessage, got ${r.kind}`)
  return td.decode(r.message)
}
async function send(m: Member, text: string, impl: CiphersuiteImpl): Promise<Uint8Array> {
  const r = await createApplicationMessage(m.state!, te.encode(text), impl)
  m.state = r.newState
  return wire({ wireformat: "mls_private_message", version: "mls10", privateMessage: r.privateMessage })
}
async function join(m: Member, welcomeBytes: Uint8Array, impl: CiphersuiteImpl) {
  const msg = unwire(welcomeBytes)
  if (msg.wireformat !== "mls_welcome") throw new Error("expected welcome")
  m.state = await joinGroup(msg.welcome, m.kp.publicPackage, m.kp.privatePackage, emptyPskIndex, impl, undefined, undefined, clientConfig)
}

const epoch = (m: Member) => m.state!.groupContext.epoch
const auth = (m: Member) => hex(m.state!.keySchedule.epochAuthenticator)
function memberNames(state: ClientState): string[] {
  const out: string[] = []
  state.ratchetTree.forEach((n, i) => {
    if (i % 2 === 0 && n && n.nodeType === "leaf") {
      const c = n.leaf.credential
      out.push(c.credentialType === "basic" ? td.decode(c.identity) : "x509")
    }
  })
  return out
}
function leafIndexOf(state: ClientState, name: string): number {
  for (let i = 0; i < state.ratchetTree.length; i += 2) {
    const n = state.ratchetTree[i]
    if (n && n.nodeType === "leaf" && n.leaf.credential.credentialType === "basic" && td.decode(n.leaf.credential.identity) === name)
      return i / 2
  }
  throw new Error(`no leaf for ${name}`)
}
function agree(members: Member[]): boolean {
  const e = epoch(members[0]!)
  const a = auth(members[0]!)
  return members.every((m) => epoch(m) === e && auth(m) === a)
}
function restoreFromBytes(bytes: Uint8Array): ClientState {
  const r = decodeGroupState(bytes, 0)
  if (!r) throw new Error("decodeGroupState failed")
  return { ...r[0], clientConfig }
}

// ---------------------------------------------------------------- checks

async function main() {
  const suiteName: CiphersuiteName = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
  const impl = await getCiphersuiteImpl(getCiphersuiteFromName(suiteName))
  console.log(`\nts-mls spike, suite ${suiteName} (id ${ciphersuites[suiteName]}), bun ${Bun.version}\n`)

  // ---- a. group creation, two adds in one commit, Welcome join, epoch agreement
  console.log("== a. create / add two in one commit / join from Welcome")
  const alice = await newMember("alice", impl)
  const bob = await newMember("bob", impl)
  const carol = await newMember("carol", impl)
  const groupId = te.encode("allo-spike-group")
  alice.state = await createGroup(groupId, alice.kp.publicPackage, alice.kp.privatePackage, [], impl, clientConfig)
  check("a1 alice created group at epoch 0 with one leaf", epoch(alice) === 0n && memberNames(alice.state).join() === "alice")

  const c1 = await commitAndApply(alice, impl, [
    addProposalFromWire(wireKeyPackage(bob.kp.publicPackage)),
    addProposalFromWire(wireKeyPackage(carol.kp.publicPackage)),
  ])
  check("a2 one commit added bob+carol, alice at epoch 1", epoch(alice) === 1n && memberNames(alice.state).join() === "alice,bob,carol")
  check("a3 commit produced a Welcome", c1.welcomeBytes !== undefined, `welcome ${c1.welcomeBytes?.length} B, commit ${c1.commitBytes.length} B`)
  await join(bob, c1.welcomeBytes!, impl)
  await join(carol, c1.welcomeBytes!, impl)
  check("a4 bob and carol joined from the same Welcome", epoch(bob) === 1n && epoch(carol) === 1n)
  check("a5 all three agree on epoch + epoch_authenticator", agree([alice, bob, carol]), `epoch=${epoch(alice)} auth=${auth(alice).slice(0, 16)}...`)
  check("a6 all three see the same member list", memberNames(bob.state!).join() === "alice,bob,carol" && memberNames(carol.state!).join() === "alice,bob,carol")

  // ---- b. application messages, replay, self-decrypt
  console.log("\n== b. application messages / replay / sender decrypting own ciphertext")
  const trio = [alice, bob, carol]
  let allOk = true
  for (const s of trio) {
    const text = `hi from ${s.name}`
    const ct = await send(s, text, impl)
    for (const r of trio) {
      if (r === s) continue
      const got = await recvText(r, ct, impl)
      if (got !== text) allOk = false
    }
  }
  check("b1 each member sends, every other member decrypts", allOk)

  const ctA = await send(alice, "replay me", impl)
  const first = await recvText(bob, ctA, impl)
  const replayErr = await expectThrow(() => recvText(bob, ctA, impl))
  check("b2 receiver decrypts once", first === "replay me")
  check("b3 receiver REJECTS the same ciphertext a second time (replay)", replayErr !== null, replayErr ?? "no error: replay accepted")

  const selfErr = await expectThrow(() => recvText(alice, ctA, impl))
  check("b4 sender cannot decrypt its own ciphertext (own ratchet already advanced)", selfErr !== null, selfErr ?? "no error: sender decrypted own message")
  // carol still has that generation; make sure she is not affected by bob's replay
  check("b5 unrelated receiver still decrypts that message", (await recvText(carol, ctA, impl)) === "replay me")

  // ---- c. second device for bob as a separate leaf
  console.log("\n== c. bob adds his laptop as a second leaf (same identity)")
  const bobLaptop = await newMember("bob", impl)
  const c2 = await commitAndApply(bob, impl, [addProposalFromWire(wireKeyPackage(bobLaptop.kp.publicPackage))])
  await recv(alice, c2.commitBytes, impl)
  await recv(carol, c2.commitBytes, impl)
  await join(bobLaptop, c2.welcomeBytes!, impl)
  check("c1 a second leaf with the SAME basic identity is accepted", memberNames(alice.state!).join() === "alice,bob,carol,bob", `members=${memberNames(alice.state!).join(",")}`)
  check("c2 four leaves agree on the epoch", agree([alice, bob, carol, bobLaptop]), `epoch=${epoch(alice)}`)
  const ctToBoth = await send(alice, "to both bob devices", impl)
  const onPhone = await recvText(bob, ctToBoth, impl)
  const onLaptop = await recvText(bobLaptop, ctToBoth, impl)
  check("c3 alice's message decrypts on both of bob's devices", onPhone === "to both bob devices" && onLaptop === "to both bob devices")
  check("c4 ...and on carol", (await recvText(carol, ctToBoth, impl)) === "to both bob devices")

  // ---- d. remove carol
  console.log("\n== d. remove carol; forward secrecy on removal")
  const carolLeaf = leafIndexOf(alice.state!, "carol")
  const c3 = await commitAndApply(alice, impl, [removeProposal(carolLeaf)])
  await recv(bob, c3.commitBytes, impl)
  await recv(bobLaptop, c3.commitBytes, impl)
  const carolProcess = await recv(carol, c3.commitBytes, impl) // carol learns she was removed
  check("d1 remaining members agree on the new epoch", agree([alice, bob, bobLaptop]), `epoch=${epoch(alice)} members=${memberNames(alice.state!).join(",")}`)
  check("d2 carol's state after processing the removal is 'removedFromGroup'", carol.state!.groupActiveState.kind === "removedFromGroup", `kind=${carol.state!.groupActiveState.kind}, actionTaken=${carolProcess.kind === "newState" ? carolProcess.actionTaken : "n/a"}, carol epoch=${epoch(carol)}`)
  const ctAfterRemove = await send(alice, "carol must not read this", impl)
  const carolDecErr = await expectThrow(() => recvText(carol, ctAfterRemove, impl))
  check("d3 carol cannot decrypt a post-removal message", carolDecErr !== null, carolDecErr ?? "no error: carol decrypted post-removal message")
  const carolSendErr = await expectThrow(() => send(carol, "am I still here?", impl))
  check("d4 carol cannot send after removal", carolSendErr !== null, carolSendErr ?? "no error")
  check("d5 bob and laptop still decrypt", (await recvText(bob, ctAfterRemove, impl)) === "carol must not read this" && (await recvText(bobLaptop, ctAfterRemove, impl)) === "carol must not read this")

  // ---- e. offline member catches up; out-of-order delivery
  console.log("\n== e. offline member catches up in order; out-of-order commit delivery")
  const carol2 = await newMember("carol2", impl)
  const c4 = await commitAndApply(alice, impl, [addProposalFromWire(wireKeyPackage(carol2.kp.publicPackage))])
  await recv(bob, c4.commitBytes, impl)
  await recv(bobLaptop, c4.commitBytes, impl)
  await join(carol2, c4.welcomeBytes!, impl)
  const epochBefore = epoch(carol2)
  // carol2 goes offline. two commits happen (empty commits = self-update path).
  const c5 = await commitAndApply(alice, impl, [])
  await recv(bob, c5.commitBytes, impl)
  await recv(bobLaptop, c5.commitBytes, impl)
  const c6 = await commitAndApply(bob, impl, [])
  await recv(alice, c6.commitBytes, impl)
  await recv(bobLaptop, c6.commitBytes, impl)
  const ctWhileOffline = await send(alice, "sent while carol2 offline", impl)
  await recvText(bob, ctWhileOffline, impl)
  check("e1 others advanced two epochs while carol2 was offline", epoch(alice) === epochBefore + 2n && epoch(carol2) === epochBefore)
  await recv(carol2, c5.commitBytes, impl)
  await recv(carol2, c6.commitBytes, impl)
  check("e2 carol2 processes the two missed commits in order and catches up", agree([alice, bob, bobLaptop, carol2]), `epoch=${epoch(carol2)}`)
  check("e3 carol2 then decrypts the message sent while she was offline", (await recvText(carol2, ctWhileOffline, impl)) === "sent while carol2 offline")

  // out-of-order: dave misses two commits and gets N+1 before N
  const dave = await newMember("dave", impl)
  const c7 = await commitAndApply(alice, impl, [addProposalFromWire(wireKeyPackage(dave.kp.publicPackage))])
  for (const m of [bob, bobLaptop, carol2]) await recv(m, c7.commitBytes, impl)
  await join(dave, c7.welcomeBytes!, impl)
  const cN = await commitAndApply(alice, impl, [])
  for (const m of [bob, bobLaptop, carol2]) await recv(m, cN.commitBytes, impl)
  const cN1 = await commitAndApply(alice, impl, [])
  for (const m of [bob, bobLaptop, carol2]) await recv(m, cN1.commitBytes, impl)
  const daveEpochBefore = epoch(dave)
  const oooErr = await expectThrow(() => recv(dave, cN1.commitBytes, impl))
  check("e4 processing commit N+1 before N throws", oooErr !== null, oooErr ?? "no error thrown")
  check("e5 the failed call left dave's state untouched (functional API)", epoch(dave) === daveEpochBefore)
  await recv(dave, cN.commitBytes, impl)
  await recv(dave, cN1.commitBytes, impl)
  check("e6 after N then N+1 dave agrees with the group", agree([alice, bob, bobLaptop, carol2, dave]), `epoch=${epoch(dave)}`)

  // app message ordering across an epoch boundary
  const ctOldEpoch = await send(alice, "sent at epoch E", impl)
  const cE1 = await commitAndApply(alice, impl, [])
  for (const m of [bobLaptop, dave]) await recv(m, cE1.commitBytes, impl) // carol2 deliberately NOT yet
  await recv(bob, cE1.commitBytes, impl) // bob gets the commit BEFORE the older app message
  const lateOld = await expectThrow(async () => {
    const t = await recvText(bob, ctOldEpoch, impl)
    if (t !== "sent at epoch E") throw new Error(`wrong plaintext ${t}`)
  })
  check("e7 app message from the PREVIOUS epoch still decrypts after the commit (historicalReceiverData, retainKeysForEpochs=4)", lateOld === null, lateOld ?? "")
  const ctNewEpoch = await send(alice, "sent at epoch E+1", impl)
  // carol2 has NOT processed cE1 yet: message from a future epoch
  const carol2Snapshot = encodeGroupState(carol2.state!)
  const futureErr = await expectThrow(() => recvText(carol2, ctNewEpoch, impl))
  check("e8 app message from a FUTURE epoch (commit not yet processed) throws", futureErr !== null, futureErr ?? "no error: decrypted a future-epoch message")
  carol2.state = restoreFromBytes(carol2Snapshot)
  // (e8's failure path may have partially advanced nothing; restore to be safe) -- then catch up
  const carol2Catch = await expectThrow(async () => {
    const t = await recvText(carol2, ctNewEpoch, impl)
    if (t !== "sent at epoch E+1") throw new Error(`wrong plaintext ${t}`)
  })
  check("e9 ...and works once the commit is processed", (await (async () => {
    // carol2 restored to pre-commit; process commit then message
    try {
      await recv(carol2, cE1.commitBytes, impl)
      return (await recvText(carol2, ctNewEpoch, impl)) === "sent at epoch E+1"
    } catch (e) {
      note(`e9 error: ${errStr(e)}`)
      return false
    }
  })()), carol2Catch === null ? "(note: e8 restore was unnecessary)" : `pre-commit attempt: ${carol2Catch}`)
  await recvText(dave, ctNewEpoch, impl)
  await recvText(bobLaptop, ctNewEpoch, impl)
  await recvText(bob, ctNewEpoch, impl)

  // ---- f. concurrent commits
  console.log("\n== f. concurrent commits at the same epoch; server picks alice's")
  const erin = await newMember("erin", impl)
  const frank = await newMember("frank", impl)
  const e0 = epoch(alice)
  const pendingA = await makeCommit(alice, impl, [addProposalFromWire(wireKeyPackage(erin.kp.publicPackage))])
  const pendingB = await makeCommit(bob, impl, [addProposalFromWire(wireKeyPackage(frank.kp.publicPackage))])
  check("f1 alice and bob each built a commit at the same epoch", pendingA.newState.groupContext.epoch === e0 + 1n && pendingB.newState.groupContext.epoch === e0 + 1n && epoch(alice) === e0 && epoch(bob) === e0)
  // server accepts alice's. alice applies hers.
  alice.state = pendingA.newState
  // bob: discard pendingB (just never assign it), process alice's
  const bobProc = await recv(bob, pendingA.commitBytes, impl)
  for (const m of [bobLaptop, carol2, dave]) await recv(m, pendingA.commitBytes, impl)
  await join(erin, pendingA.welcomeBytes!, impl)
  check("f2 bob discarded his pending commit and processed alice's", bobProc.kind === "newState" && epoch(bob) === e0 + 1n && memberNames(bob.state!).includes("erin") && !memberNames(bob.state!).includes("frank"))
  // what if bob HAD applied his own and then received alice's?
  const wrongBob: Member = { name: "bob-wrong", kp: bob.kp, state: pendingB.newState }
  const wrongErr = await expectThrow(() => recv(wrongBob, pendingA.commitBytes, impl))
  check("f3 (negative) a member that applied its own losing commit cannot process the winner", wrongErr !== null, wrongErr ?? "no error")
  // bob re-proposes frank at the new epoch, reusing frank's still-unused key package
  const retryB = await commitAndApply(bob, impl, [addProposalFromWire(wireKeyPackage(frank.kp.publicPackage))])
  for (const m of [alice, bobLaptop, carol2, dave, erin]) await recv(m, retryB.commitBytes, impl)
  await join(frank, retryB.welcomeBytes!, impl)
  check("f4 bob re-issued the add at the new epoch; frank joined; everyone agrees", agree([alice, bob, bobLaptop, carol2, dave, erin, frank]), `epoch=${epoch(alice)} members=${memberNames(alice.state!).join(",")}`)
  // and the welcome from the discarded commit is dead for frank
  const deadWelcomeErr = await expectThrow(async () => {
    const f2: Member = { name: "frank", kp: frank.kp }
    await join(f2, pendingB.welcomeBytes!, impl)
    // even if join "succeeds" locally, the state is for an epoch nobody else has
    if (f2.state!.keySchedule.epochAuthenticator && auth(f2) !== auth(alice)) throw new Error(`joined a phantom epoch (auth differs from group)`)
  })
  check("f5 the Welcome from the discarded commit does not put frank in the real group", deadWelcomeErr !== null, deadWelcomeErr ?? "")

  // ---- g. persistence
  console.log("\n== g. persistence: encodeGroupState / decodeGroupState")
  const blob = encodeGroupState(alice.state!)
  const sigKeyPos = indexOfBytes(blob, alice.state!.signaturePrivateKey)
  check("g1 group state serialises to bytes", blob.length > 0, `${blob.length} B for a ${memberNames(alice.state!).length}-member group at epoch ${epoch(alice)} (historicalReceiverData entries: ${alice.state!.historicalReceiverData.size})`)
  check("g2 blob CONTAINS the signature private key in the clear", sigKeyPos >= 0, `signaturePrivateKey (${alice.state!.signaturePrivateKey.length} B) found at offset ${sigKeyPos}`)
  const privPathKeys = alice.state!.privatePath.privateKeys
  let privPathFound = 0
  let privPathTotal = 0
  for (const k of Object.values(privPathKeys as Record<string, Uint8Array>)) {
    privPathTotal++
    if (indexOfBytes(blob, k) >= 0) privPathFound++
  }
  check("g3 blob contains the HPKE private path keys", privPathTotal > 0 && privPathFound === privPathTotal, `${privPathFound}/${privPathTotal} private path keys located in blob`)
  const restoredAlice: Member = { name: "alice", kp: alice.kp, state: restoreFromBytes(blob) }
  check("g4 restored state has the same epoch / authenticator", epoch(restoredAlice) === epoch(alice) && auth(restoredAlice) === auth(alice))
  const reblob = encodeGroupState(restoredAlice.state!)
  check("g5 re-encoding the restored state is byte-identical", bytesEqual(blob, reblob))
  const ctToRestored = await send(bob, "after alice restarted", impl)
  check("g6 restored alice decrypts a new message", (await recvText(restoredAlice, ctToRestored, impl)) === "after alice restarted")
  const ctFromRestored = await send(restoredAlice, "restarted alice speaks", impl)
  check("g7 restored alice's message decrypts at bob", (await recvText(bob, ctFromRestored, impl)) === "restarted alice speaks")
  // the ORIGINAL alice object now diverges (her secret tree did not advance): show what happens
  const forkErr = await expectThrow(() => recvText(alice, ctToRestored, impl))
  check("g8 (observation) the stale pre-restore object can still decrypt that message (two forks of one state = replay hazard)", forkErr === null, forkErr ?? "decrypted -- the app must ensure exactly one live copy of a state")
  alice.state = restoredAlice.state // continue with the restored one
  for (const m of [bobLaptop, carol2, dave, erin, frank]) {
    await recvText(m, ctToRestored, impl)
    await recvText(m, ctFromRestored, impl)
  }
  // JSON is NOT usable directly
  const jsonErr = await expectThrow(async () => JSON.stringify(alice.state))
  note(`JSON.stringify(state): ${jsonErr ?? "no error"} (bigint epoch, Map, Uint8Array => use encodeGroupState)`)

  // ---- h. crash recovery
  console.log("\n== h. crash after creating a commit, before the server accepted it")
  const gina = await newMember("gina", impl)
  const hal = await newMember("hal", impl)
  const preCommitSnapshot = encodeGroupState(bob.state!) // persisted BEFORE building the commit
  const bobPending = await makeCommit(bob, impl, [addProposalFromWire(wireKeyPackage(gina.kp.publicPackage))])
  const postCommitSnapshot = encodeGroupState(bobPending.newState) // what a buggy client might persist
  // "crash": bob's process dies; bobPending is lost. meanwhile alice's commit wins.
  const aliceWin = await commitAndApply(alice, impl, [addProposalFromWire(wireKeyPackage(hal.kp.publicPackage))])
  for (const m of [bobLaptop, carol2, dave, erin, frank]) await recv(m, aliceWin.commitBytes, impl)
  await join(hal, aliceWin.welcomeBytes!, impl)
  // restart bob from the pre-commit snapshot
  const bobRestarted: Member = { name: "bob", kp: bob.kp, state: restoreFromBytes(preCommitSnapshot) }
  const bobRecov = await expectThrow(() => recv(bobRestarted, aliceWin.commitBytes, impl))
  check("h1 bob restored from the PRE-commit snapshot processes alice's commit", bobRecov === null && agree([alice, bobRestarted, hal]), bobRecov ?? `epoch=${epoch(bobRestarted)}`)
  const bobWrong: Member = { name: "bob", kp: bob.kp, state: restoreFromBytes(postCommitSnapshot) }
  const bobWrongErr = await expectThrow(() => recv(bobWrong, aliceWin.commitBytes, impl))
  check("h2 (negative) bob restored from the POST-commit snapshot cannot process alice's commit", bobWrongErr !== null, bobWrongErr ?? "no error")
  bob.state = bobRestarted.state
  const ctH = await send(hal, "hal here", impl)
  check("h3 recovered bob decrypts a message from the newly added member", (await recvText(bob, ctH, impl)) === "hal here")
  for (const m of [alice, bobLaptop, carol2, dave, erin, frank]) await recvText(m, ctH, impl)

  // ---- i. measurements
  console.log("\n== i. measurements")
  {
    const N = 50
    const t0 = performance.now()
    const founder = await newMember("m0", impl)
    const others: Member[] = []
    for (let i = 1; i < N; i++) others.push(await newMember(`m${i}`, impl))
    const tKeygen = performance.now() - t0
    founder.state = await createGroup(te.encode("big"), founder.kp.publicPackage, founder.kp.privatePackage, [], impl, clientConfig)
    const kpBytes = others.map((m) => wireKeyPackage(m.kp.publicPackage))
    const proposals = kpBytes.map(addProposalFromWire)
    const t1 = performance.now()
    const bigNoTree = await makeCommit(founder, impl, proposals, { ratchetTreeExtension: false })
    const tCommitNoTree = performance.now() - t1
    const t2 = performance.now()
    const big = await makeCommit(founder, impl, proposals, { ratchetTreeExtension: true })
    const tCommit = performance.now() - t2
    founder.state = big.newState
    const t3 = performance.now()
    await join(others[N - 2]!, big.welcomeBytes!, impl)
    const tJoin = performance.now() - t3
    const t3b = performance.now()
    // join with the tree passed out of band (no ratchet_tree extension)
    {
      const msg = unwire(bigNoTree.welcomeBytes!)
      if (msg.wireformat !== "mls_welcome") throw new Error("x")
      const m = others[0]!
      const st = await joinGroup(msg.welcome, m.kp.publicPackage, m.kp.privatePackage, emptyPskIndex, impl, bigNoTree.newState.ratchetTree, undefined, clientConfig)
      if (st.groupContext.epoch !== 1n) throw new Error("join failed")
    }
    const tJoinOob = performance.now() - t3b
    check(`i1 ${N}-member group: 49 adds in ONE commit`, memberNames(founder.state!).length === N && epoch(others[N - 2]!) === 1n)
    note(`generate ${N} key packages: ${ms(tKeygen)} (${ms(tKeygen / N)} each)`)
    note(`createCommit with ${N - 1} adds + ratchet_tree ext: ${ms(tCommit)}; without ext: ${ms(tCommitNoTree)}`)
    note(`joinGroup from Welcome (tree inside): ${ms(tJoin)}; tree out of band: ${ms(tJoinOob)}`)
    note(`key package on the wire: ${kpBytes[0]!.length} B`)
    note(`Welcome for ${N - 1} joiners: ${big.welcomeBytes!.length} B with ratchet_tree ext, ${bigNoTree.welcomeBytes!.length} B without (${(big.welcomeBytes!.length / (N - 1)).toFixed(0)} / ${(bigNoTree.welcomeBytes!.length / (N - 1)).toFixed(0)} B per joiner)`)
    note(`commit adding ${N - 1}: ${big.commitBytes.length} B with ratchet_tree ext, ${bigNoTree.commitBytes.length} B without`)
    const bigBlob = encodeGroupState(founder.state!)
    note(`encodeGroupState for the ${N}-member founder at epoch 1: ${bigBlob.length} B`)
    // one member's commit in the 50 group: size + time to process for another member
    const t4 = performance.now()
    const upd = await commitAndApply(others[N - 2]!, impl, [])
    const tUpdCommit = performance.now() - t4
    const t5 = performance.now()
    await recv(founder, upd.commitBytes, impl)
    const tUpdProc = performance.now() - t5
    note(`empty (self-update) commit in the ${N}-member group: ${upd.commitBytes.length} B; create ${ms(tUpdCommit)}, process ${ms(tUpdProc)}`)
    const t6 = performance.now()
    const removeC = await commitAndApply(founder, impl, [removeProposal(leafIndexOf(founder.state!, "m10"))])
    const tRemove = performance.now() - t6
    note(`remove-one commit in the ${N}-member group: ${removeC.commitBytes.length} B; create ${ms(tRemove)}`)
    const t7 = performance.now()
    const bigMsg = await send(founder, "hello fifty", impl)
    const tBigMsgSend = performance.now() - t7
    await recv(others[N - 2]!, upd.commitBytes, impl).catch(() => {})
    note(`application message in the ${N}-member group: ${bigMsg.length} B, encrypt ${ms(tBigMsgSend)}`)
  }
  {
    // 3-member group sizes
    const smallCommit = await commitAndApply(alice, impl, [])
    for (const m of [bob, bobLaptop, carol2, dave, erin, frank, hal]) await recv(m, smallCommit.commitBytes, impl)
    note(`empty commit in the current ${memberNames(alice.state!).length}-member group: ${smallCommit.commitBytes.length} B`)
  }
  {
    // 1000 messages, 2-member group
    const p = await newMember("p", impl)
    const q = await newMember("q", impl)
    p.state = await createGroup(te.encode("perf"), p.kp.publicPackage, p.kp.privatePackage, [], impl, clientConfig)
    const c = await commitAndApply(p, impl, [addProposalFromWire(wireKeyPackage(q.kp.publicPackage))])
    await join(q, c.welcomeBytes!, impl)
    const M = 1000
    const payload = "x".repeat(100)
    let tEnc = 0
    let tDec = 0
    let ok = 0
    for (let i = 0; i < M; i++) {
      const a = performance.now()
      const ct = await send(p, payload, impl)
      const b = performance.now()
      const pt = await recvText(q, ct, impl)
      const d = performance.now()
      tEnc += b - a
      tDec += d - b
      if (pt === payload) ok++
    }
    check(`i2 ${M} application messages encrypt+decrypt`, ok === M, `encrypt ${ms(tEnc)} (${(tEnc / M).toFixed(3)} ms/msg), decrypt ${ms(tDec)} (${(tDec / M).toFixed(3)} ms/msg), total ${ms(tEnc + tDec)}`)
    // overhead vs plaintext, default padding and no padding
    const sizes: string[] = []
    for (const len of [1, 12, 100, 255, 256, 1000, 10000]) {
      const pt = "y".repeat(len)
      const ct = await send(p, pt, impl)
      await recvText(q, ct, impl)
      sizes.push(`${len}->${ct.length} (+${ct.length - len})`)
    }
    note(`app message size plaintext->wire with DEFAULT padding (padUntilLength 256): ${sizes.join(", ")}`)
    const noPad: ClientConfig = { ...clientConfig, paddingConfig: { kind: "alwaysPad", paddingLength: 0 } }
    p.state = { ...p.state!, clientConfig: noPad }
    const sizes2: string[] = []
    for (const len of [1, 12, 100, 1000]) {
      const pt = "y".repeat(len)
      const ct = await send(p, pt, impl)
      await recvText(q, ct, impl)
      sizes2.push(`${len}->${ct.length} (+${ct.length - len})`)
    }
    note(`app message size with NO padding: ${sizes2.join(", ")}`)
    // the fixed overhead breakdown: MLSMessage header + PrivateMessage(group_id, epoch, content_type, auth_data, enc_sender_data, ciphertext(tag 16 + content_type 1 + sig ~64 + padding))
    const st2 = encodeGroupState(p.state!)
    note(`encodeGroupState for the 2-member group after ${M + 11} messages: ${st2.length} B`)
  }

  // ---- j. ciphersuites
  console.log("\n== j. ciphersuites available under bun's WebCrypto")
  for (const name of Object.keys(ciphersuites) as CiphersuiteName[]) {
    const id = ciphersuites[name]
    const t0 = performance.now()
    let outcome: string
    let ok = false
    try {
      const cs = await getCiphersuiteImpl(getCiphersuiteFromName(name))
      const a = await newMember("a", cs)
      const b = await newMember("b", cs)
      a.state = await createGroup(te.encode("cs"), a.kp.publicPackage, a.kp.privatePackage, [], cs, clientConfig)
      const c = await commitAndApply(a, cs, [addProposalFromWire(wireKeyPackage(b.kp.publicPackage))])
      await join(b, c.welcomeBytes!, cs)
      const ct = await send(a, "suite ok", cs)
      const pt = await recvText(b, ct, cs)
      ok = pt === "suite ok" && agree([a, b])
      outcome = ok ? `round trip ok in ${ms(performance.now() - t0)}; key package ${wireKeyPackage(a.kp.publicPackage).length} B, welcome ${c.welcomeBytes!.length} B, commit ${c.commitBytes.length} B, msg ${ct.length} B` : "round trip mismatch"
    } catch (e) {
      outcome = errStr(e)
    }
    console.log(`  [${ok ? "OK " : "NO "}] ${String(id).padStart(2)} ${name}: ${outcome}`)
    results.push(`  [${ok ? "OK " : "NO "}] ${String(id).padStart(2)} ${name}: ${outcome}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  return { passed, failed, results }
}

const out = await main()
await Bun.write(new URL("./spike-output.txt", import.meta.url), out.results.join("\n") + `\n\n${out.passed} passed, ${out.failed} failed\n`)
if (out.failed > 0) process.exitCode = 1
