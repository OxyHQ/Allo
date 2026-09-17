const unusedOptional = /^(@noble\/post-quantum|@hpke\/(ml-kem|chacha20poly1305|hybridkem-x-wing|dhkem-x448))(\/|$)/
const r = await Bun.build({
  entrypoints: ["./bundle-entry-rn.ts"], target: "browser", minify: true, outdir: "dist/rn-shape",
  plugins: [{ name: "stub", setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: "crypto-stub", namespace: "stub" }))
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const webcrypto = globalThis.crypto; export default {webcrypto}", loader: "js" }))
    b.onResolve({ filter: unusedOptional }, (a) => ({ path: a.path, external: true }))
  } }],
})
if (!r.success) { console.log("FAILED", r.logs.map(String)); process.exit(1) }
const bytes = new Uint8Array(await r.outputs[0]!.arrayBuffer())
console.log(`rn-shape (ts-mls + nobleOnlyProvider, @noble/curves+hashes+ciphers, @hpke/core+common+dhkem-x25519): raw ${bytes.length} B, gzip ${Bun.gzipSync(bytes, { level: 9 }).length} B`)
