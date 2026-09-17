// Bundle-size measurement with Bun.build. The plugin stubs the bare `crypto`
// specifier that @hpke/common dynamically imports as a Node<=18 fallback, so
// bun's browser target does not inline its node:crypto polyfill.
const optional = /^(@noble\/curves|@noble\/post-quantum|@hpke\/(ml-kem|chacha20poly1305|hybridkem-x-wing|dhkem-x448))(\/|$)/
async function build(name: string, externalOptional: boolean) {
  const r = await Bun.build({
    entrypoints: ["./bundle-entry.ts"],
    target: "browser",
    minify: true,
    outdir: `dist/${name}`,
    plugins: [{
      name: "stub-node-crypto",
      setup(b) {
        b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: "crypto-stub", namespace: "stub" }))
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const webcrypto = globalThis.crypto; export default {webcrypto}", loader: "js" }))
        if (externalOptional) b.onResolve({ filter: optional }, (a) => ({ path: a.path, external: true }))
      },
    }],
  })
  if (!r.success) { console.log(name, "FAILED", r.logs.map(String)); return }
  const out = r.outputs[0]!
  const bytes = new Uint8Array(await out.arrayBuffer())
  const gz = Bun.gzipSync(bytes, { level: 9 })
  console.log(`${name}: raw ${bytes.length} B, gzip ${gz.length} B`)
}
await build("browser-suite1-only", true)   // == what a clean `bun add ts-mls` install bundles (optional peers absent)
await build("browser-all-suites", false)   // every optional peer installed and inlined
