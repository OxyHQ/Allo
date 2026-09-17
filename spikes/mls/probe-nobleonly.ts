/**
 * Proves the subtle-free provider.
 *   bun run probe-nobleonly.ts nosubtle  -> crypto.subtle removed; full MLS round trip on nobleOnlyProvider
 *   bun run probe-nobleonly.ts interop   -> WebCrypto intact; alice on defaultCryptoProvider, bob on nobleOnlyProvider
 */
import {
  createGroup, joinGroup, createCommit, createApplicationMessage, processMessage,
  getCiphersuiteImpl, getCiphersuiteFromName, generateKeyPackage, defaultCapabilities,
  defaultLifetime, emptyPskIndex, acceptAll, defaultCryptoProvider, encodeGroupState, decodeGroupState,
  encodeMlsMessage, decodeMlsMessage, defaultKeyRetentionConfig, defaultLifetimeConfig,
  defaultKeyPackageEqualityConfig, defaultPaddingConfig, defaultAuthenticationService,
  type Credential, type CiphersuiteImpl, type ClientState, type MLSMessage,
} from "ts-mls"
import { nobleOnlyProvider } from "./nobleOnlyProvider.ts"

const te = new TextEncoder()
const td = new TextDecoder()
const mode = process.argv[2] ?? "nosubtle"
if (mode === "nosubtle") {
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true })
  console.log(`crypto.subtle: ${String(globalThis.crypto.subtle)}`)
}
const errStr = (e: unknown) => `${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`
const suite = getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519")
const clientConfig = { keyRetentionConfig: defaultKeyRetentionConfig, lifetimeConfig: defaultLifetimeConfig, keyPackageEqualityConfig: defaultKeyPackageEqualityConfig, paddingConfig: defaultPaddingConfig, authService: defaultAuthenticationService }
const rt = (m: MLSMessage) => decodeMlsMessage(encodeMlsMessage(m), 0)![0]

async function mk(n: string, impl: CiphersuiteImpl) {
  const credential: Credential = { credentialType: "basic", identity: te.encode(n) }
  return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
}
async function twoParty(implA: CiphersuiteImpl, implB: CiphersuiteImpl, label: string) {
  const t0 = performance.now()
  const a = await mk("a", implA)
  const b = await mk("b", implB)
  let ga = await createGroup(te.encode("g"), a.publicPackage, a.privatePackage, [], implA, clientConfig)
  const kpB = rt({ wireformat: "mls_key_package", version: "mls10", keyPackage: b.publicPackage })
  if (kpB.wireformat !== "mls_key_package") throw new Error("x")
  const c = await createCommit({ state: ga, cipherSuite: implA }, { extraProposals: [{ proposalType: "add", add: { keyPackage: kpB.keyPackage } }], ratchetTreeExtension: true })
  ga = c.newState
  const w = rt({ wireformat: "mls_welcome", version: "mls10", welcome: c.welcome! })
  if (w.wireformat !== "mls_welcome") throw new Error("x")
  let gb = await joinGroup(w.welcome, b.publicPackage, b.privatePackage, emptyPskIndex, implB, undefined, undefined, clientConfig)
  const m1 = await createApplicationMessage(ga, te.encode("a->b"), implA)
  ga = m1.newState
  const r1 = await processMessage(rt({ wireformat: "mls_private_message", version: "mls10", privateMessage: m1.privateMessage }) as never, gb, emptyPskIndex, acceptAll, implB)
  gb = r1.newState
  const m2 = await createApplicationMessage(gb, te.encode("b->a"), implB)
  gb = m2.newState
  const r2 = await processMessage(rt({ wireformat: "mls_private_message", version: "mls10", privateMessage: m2.privateMessage }) as never, ga, emptyPskIndex, acceptAll, implA)
  ga = r2.newState
  // b commits (b's signature + b's HPKE path), a processes
  const c2 = await createCommit({ state: gb, cipherSuite: implB }, { extraProposals: [] })
  gb = c2.newState
  const r3 = await processMessage(rt(c2.commit) as never, ga, emptyPskIndex, acceptAll, implA)
  ga = r3.newState
  const ok = r1.kind === "applicationMessage" && td.decode(r1.message) === "a->b" && r2.kind === "applicationMessage" && td.decode(r2.message) === "b->a" && ga.groupContext.epoch === 2n && gb.groupContext.epoch === 2n && Buffer.from(ga.keySchedule.epochAuthenticator).equals(Buffer.from(gb.keySchedule.epochAuthenticator))
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label} -- ${(performance.now() - t0).toFixed(1)} ms; a.signKey ${a.privatePackage.signaturePrivateKey.length} B, b.signKey ${b.privatePackage.signaturePrivateKey.length} B`)
  return { ga, gb, a, b }
}

if (mode === "nosubtle") {
  try {
    const impl = await getCiphersuiteImpl(suite, nobleOnlyProvider)
    await twoParty(impl, impl, "nobleOnlyProvider full round trip WITHOUT crypto.subtle (create, add, join, msg both ways, commit)")
  } catch (e) {
    console.log(`[FAIL] nobleOnlyProvider without subtle: ${errStr(e)}`)
  }
  try {
    await getCiphersuiteImpl(suite, defaultCryptoProvider).then((impl) => twoParty(impl, impl, "defaultCryptoProvider without subtle (expected to fail)"))
  } catch (e) {
    console.log(`[info] defaultCryptoProvider without subtle fails as expected: ${errStr(e)}`)
  }
} else {
  const implDefault = await getCiphersuiteImpl(suite, defaultCryptoProvider)
  const implNoble = await getCiphersuiteImpl(suite, nobleOnlyProvider)
  await twoParty(implDefault, implDefault, "default <-> default (control)")
  await twoParty(implNoble, implNoble, "nobleOnly <-> nobleOnly (WebCrypto present but unused)")
  const { ga } = await twoParty(implDefault, implNoble, "INTEROP default (web) <-> nobleOnly (RN shape)")
  await twoParty(implNoble, implDefault, "INTEROP nobleOnly creates, default joins")
  // state blob portability across providers: default's Ed25519 signKey is PKCS8 (48 B), noble expects raw 32 B
  const blob = encodeGroupState(ga)
  const restored: ClientState = { ...decodeGroupState(blob, 0)![0], clientConfig }
  try {
    await createCommit({ state: restored, cipherSuite: implNoble }, { extraProposals: [] })
    console.log(`[info] a state written by defaultCryptoProvider (signKey ${restored.signaturePrivateKey.length} B) can COMMIT under nobleOnlyProvider`)
  } catch (e) {
    console.log(`[info] a state written by defaultCryptoProvider (signKey ${restored.signaturePrivateKey.length} B) CANNOT commit under nobleOnlyProvider: ${errStr(e)}`)
  }
  try {
    const r = await createApplicationMessage(restored, te.encode("x"), implNoble)
    console.log(`[info] ...but CAN encrypt an application message under nobleOnlyProvider (${r.privateMessage.ciphertext.length} B) -- app messages use no signature? no: they are signed too; see result`)
  } catch (e) {
    console.log(`[info] ...and cannot encrypt an application message under nobleOnlyProvider either: ${errStr(e)}`)
  }
}
