/**
 * Simulates a runtime WITHOUT WebCrypto `subtle` (the Hermes situation:
 * React Native's JS engine ships no `crypto.subtle`; polyfills usually add
 * `crypto.getRandomValues` only). Shows exactly which ts-mls / @hpke/core
 * code paths need `subtle`, for both the default provider and the
 * `nobleCryptoProvider`.
 *
 * Run: bun run probe-nosubtle.ts
 */
import {
  createGroup, joinGroup, createCommit, createApplicationMessage, processMessage,
  getCiphersuiteImpl, getCiphersuiteFromName, generateKeyPackage, defaultCapabilities,
  defaultLifetime, emptyPskIndex, acceptAll, defaultCryptoProvider, nobleCryptoProvider,
  type CryptoProvider, type Credential, type CiphersuiteImpl,
} from "ts-mls"

const te = new TextEncoder()
const mode = process.argv[2] ?? "nosubtle"

if (mode === "nosubtle") {
  // Shadow the prototype getter with an own property. `crypto.getRandomValues` keeps working.
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true })
  console.log(`crypto.subtle is now: ${String(globalThis.crypto.subtle)}; getRandomValues: ${typeof globalThis.crypto.getRandomValues}`)
} else {
  console.log("control run: WebCrypto intact")
}

function errStr(e: unknown) {
  const err = e as { constructor?: { name?: string }; message?: string; stack?: string }
  const frame = (err?.stack ?? "").split("\n").slice(1).map((l) => l.trim()).find((l) => l.includes("node_modules")) ?? ""
  return `${err?.constructor?.name}: ${err?.message}  @ ${frame.replace(/.*node_modules\//, "")}`
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn()
    console.log(`    ok   ${label}`)
    return r
  } catch (e) {
    console.log(`    FAIL ${label}: ${errStr(e)}`)
    return undefined
  }
}

async function run(providerName: string, provider: CryptoProvider) {
  console.log(`\n== provider: ${providerName}`)
  const suite = getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519")
  const impl = await step("getCiphersuiteImpl", () => getCiphersuiteImpl(suite, provider))
  if (!impl) return
  await step("hash.digest (SHA-256)", () => impl.hash.digest(te.encode("x")))
  await step("hash.mac (HMAC)", () => impl.hash.mac(new Uint8Array(32), te.encode("x")))
  await step("kdf.extract (HKDF via @hpke/core)", () => impl.kdf.extract(new Uint8Array(32), new Uint8Array(32)))
  await step("kdf.expand (HKDF via @hpke/core)", () => impl.kdf.expand(new Uint8Array(32), te.encode("info"), 32))
  await step("signature.keygen (Ed25519)", () => impl.signature.keygen())
  await step("hpke.generateKeyPair (X25519 via @hpke/core)", () => impl.hpke.generateKeyPair())
  await step("hpke.encryptAead (AES-128-GCM)", () => impl.hpke.encryptAead(new Uint8Array(16), new Uint8Array(12), undefined, te.encode("x")))
  await step("rng.randomBytes", async () => impl.rng.randomBytes(16))
  await step("full round trip (create group, add, join, message)", () => roundTrip(impl))
}

async function roundTrip(impl: CiphersuiteImpl) {
  const mk = async (n: string) => {
    const credential: Credential = { credentialType: "basic", identity: te.encode(n) }
    return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl)
  }
  const a = await mk("a")
  const b = await mk("b")
  let ga = await createGroup(te.encode("g"), a.publicPackage, a.privatePackage, [], impl)
  const c = await createCommit({ state: ga, cipherSuite: impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: b.publicPackage } }], ratchetTreeExtension: true })
  ga = c.newState
  let gb = await joinGroup(c.welcome!, b.publicPackage, b.privatePackage, emptyPskIndex, impl)
  const m = await createApplicationMessage(ga, te.encode("hi"), impl)
  const r = await processMessage({ wireformat: "mls_private_message", privateMessage: m.privateMessage }, gb, emptyPskIndex, acceptAll, impl)
  if (r.kind !== "applicationMessage" || new TextDecoder().decode(r.message) !== "hi") throw new Error("round trip mismatch")
}

await run("defaultCryptoProvider", defaultCryptoProvider)
await run("nobleCryptoProvider", nobleCryptoProvider)
