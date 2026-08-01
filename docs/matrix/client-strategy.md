# La estrategia de cliente: web y clave de recuperación

Resuelve las dos incógnitas que bloquean la Fase 2: qué SDK corre en web, y si la
clave de recuperación de Matrix (4S/SSSS) puede derivarse de la identidad de Oxy.

No es un plan de implementación. Es la decisión de qué se construye una vez y qué
se construye dos veces, y cuál es el esquema de claves que sostiene las dos.

---

## 0. Cómo leer este documento

Cada afirmación va marcada. La diferencia entre "lo leí en el código" y "me parece"
es la única razón por la que este documento vale algo.

| Marca | Significa |
|-------|-----------|
| **[R]** | Verificado leyendo el código de `matrix-rust-sdk` en el commit exacto que compila el binding. Lleva `ruta:línea`. |
| **[B]** | Verificado en las tipificaciones generadas del binding instalado. Lleva `FFI:línea`. |
| **[J]** | Verificado en el paquete publicado `matrix-js-sdk@42.0.0`. Lleva `JS:ruta:línea`. |
| **[V]** | Verificado leyendo el repositorio de Allo. Lleva `ruta:línea`. |
| **[W]** | Verificado en una fuente pública. Lleva enlace. |
| **[T]** | Verificado ejecutando código que escribí para comprobarlo. Dice qué ejecuté. |
| **[C]** | Criterio mío. Es una opinión defendida, no un hecho. |
| **[?]** | No lo pude confirmar. Dice por qué. |

Abreviaturas de rutas:

- `FFI` = `spikes/matrix-rn/node_modules/@unomed/react-native-matrix-sdk/lib/typescript/module/src/generated/matrix_sdk_ffi.d.ts`
- `RUST` = [`matrix-org/matrix-rust-sdk`](https://github.com/matrix-org/matrix-rust-sdk)
  en el commit `742a0db07bde3afd049077e7962948111473e1e1` (`matrix-sdk-base-0.16.0`).
  Ese commit no lo elegí yo: es el que fija `ubrn.yaml` en el tag `0.9.1` del binding
  **[W]** ([`ubrn.yaml:4`](https://raw.githubusercontent.com/unomed-dev/react-native-matrix-sdk/0.9.1/ubrn.yaml)).
  Todas las líneas `RUST` son de ese commit, no de `main`.
- `JS` = contenido del tarball publicado de `matrix-js-sdk@42.0.0`. Donde cito
  `src/` en vez de `lib/` es porque leí la rama `develop`, y lo digo.

Los números de línea son de las copias de hoy. Una actualización los mueve; los
nombres de los métodos, no.

---

## 1. Las dos respuestas, primero

**Incógnita 1.** Son dos implementaciones. No hay una vía razonable a una sola hoy:
no existe un binding JS del SDK de Rust completo, sólo del subsistema de cripto
(§2.2). Pero la parte cara —el modelo de datos y la UI— **sí se comparte**, porque
`packages/frontend` ya es un único código que exporta a nativo y a web **[V]**
(`packages/frontend/package.json`, script `build`). La frontera correcta no es "una
capa que abstrae Matrix", es un puerto estrecho con dos implementaciones resueltas
por extensión de fichero (§2.3).

**Incógnita 2.** Sí, y mejor de lo que la pregunta asume. El binding **sí** deja
alimentar la clave de 4S desde fuera, vía el `passphrase` de `enableRecovery`, y lo
que hace con él está completamente especificado: PBKDF2-HMAC-SHA512, 500 000
iteraciones, salt aleatorio publicado en `account data` **[R]**. Es reproducible
desde cualquier dispositivo con sesión iniciada, y `matrix-js-sdk` implementa
exactamente los mismos parámetros **[J]**, así que el esquema es simétrico entre las
dos implementaciones sin escribir criptografía propia.

Y la consecuencia que enlaza las dos incógnitas: **resolver la 2 resuelve la parte
difícil de la 1.** Recuperar desde 4S firma el propio dispositivo con la clave de
self-signing, es decir, lo verifica sin ningún paso interactivo **[R]**
(`RUST:crates/matrix-sdk/src/encryption/secret_storage/secret_store.rs:426-443`).
El "usuario con móvil y web tiene dos dispositivos que hay que verificar entre sí"
deja de ser un flujo de UI y pasa a ser un efecto secundario del login.

---

## 2. Incógnita 1 — la historia de web

### 2.1 ¿Es viable `matrix-js-sdk` + `matrix-sdk-crypto-wasm` hoy?

Sí, y no es una apuesta: es la pila que usa Element Web.

**Estado y madurez.** `matrix-js-sdk` publicó `42.0.0` el 2026-07-28 y
`@matrix-org/matrix-sdk-crypto-wasm` publicó `18.4.0` el 2026-07-23 **[W]** (registro
npm). `matrix-js-sdk@42.0.0` declara `"@matrix-org/matrix-sdk-crypto-wasm": "^18.3.1"`
como dependencia directa **[J]** (`package.json`). No es una integración opcional: la
cripto de JS heredada (libolm) ya no existe en la superficie pública — en `42.0.0`
sólo hay `initRustCrypto()` **[J]** (`JS:lib/client.d.ts:1159`), no hay
`initLegacyCrypto`. Es decir, **el backend de cifrado de web es el mismo Rust
`matrix-sdk-crypto` que corre en el móvil**, compilado a WASM en vez de a
aarch64. Eso importa más de lo que parece: el subsistema donde la divergencia sería
más cara —el cifrado— no diverge.

**Cross-signing, key backup y 4S.** Todo presente en `CryptoApi` **[J]**
(`JS:lib/crypto-api/index.d.ts`):

| Necesidad | Método | Línea |
|---|---|---|
| Cross-signing | `bootstrapCrossSigning(opts)` | 316 |
| 4S / secret storage | `bootstrapSecretStorage(opts)` | 353 |
| Clave 4S desde passphrase | `createRecoveryKeyFromPassphrase(password?)` | 375 |
| Key backup (crear) | `resetKeyBackup()` | 548 |
| Key backup (restaurar) | `restoreKeyBackup(opts?)` | 580 |
| Inyectar clave 4S propia | `CreateSecretStorageOpts.createSecretStorageKey` | 1038 |

**Sliding sync.** Existe, pero con matices que conviene no descubrir tarde.
`matrix-js-sdk` implementa Simplified Sliding Sync (MSC4186): pega contra
`/_matrix/client/unstable/org.matrix.simplified_msc3575/sync` **[J]**
(`develop:src/client.ts:8701-8702`) y se activa pasando `slidingSync` a
`createClient`, lo que cambia el motor de sync a `SlidingSyncSdk` **[J]**
(`develop:src/client.ts:1500-1502`). Pero la opción está marcada `@experimental` en
los tipos publicados **[J]** (`JS:lib/client.d.ts:303-305`).

**[C]** En web no lo uses. El motor por defecto de `matrix-js-sdk` es el `/sync` v2
de siempre, que soporta cualquier homeserver y no está marcado experimental. Sliding
sync resuelve el arranque en frío con miles de salas; una web app de mensajería con
paginación normal no lo necesita para existir. Y hay un coste asimétrico escondido
que sí conviene registrar: **el binding nativo no tiene alternativa**. Su enum es
`SlidingSyncVersion { None, Native }` **[B]** (`FFI:20243-20246`), y no poder
determinar la versión es un error de construcción del cliente, `ClientBuildError.SlidingSyncVersion`
**[B]** (`FFI:3866-3890`). O sea: **el homeserver que se despliegue tiene que servir
sliding sync nativo o la app móvil no arranca**. Web no impone ese requisito; móvil
sí. Es un requisito de despliegue, no de cliente, y pertenece a la lista de
prerrequisitos de la Fase 2.

**Los tres riesgos reales de web,** que no son de madurez sino de empaquetado:

1. **El WASM pesa.** `matrix_sdk_crypto_wasm_bg.wasm` son 7 820 736 bytes sin
   comprimir y 2 093 185 comprimido con gzip -9 **[T]** (medido sobre el tarball de
   `18.4.0` descargado del registro). Cloudflare Pages sirve Brotli, así que el coste
   real de red estará por debajo de esa cifra, pero el coste de compilación en el
   cliente no desaparece. Se carga una vez, en diferido, con `initAsync()`.
2. **Metro no es Vite.** El cargador por defecto hace
   `new URL("./pkg/matrix_sdk_crypto_wasm_bg.wasm", import.meta.url)` y
   `WebAssembly.instantiateStreaming(fetch(url))` **[J]**
   (`@matrix-org/matrix-sdk-crypto-wasm@18.4.0/index.mjs`). Resolver un asset por
   `import.meta.url` es precisamente lo que Metro no hace igual que un bundler web.
   **La salida ya está prevista por el paquete**: `initAsync(url?)` acepta una URL
   explícita **[J]** (mismo fichero). **[C]** Copiar el `.wasm` a
   `packages/frontend/public/` — que ya existe y se copia al `dist/` del export web
   **[V]** (`packages/frontend/public/`) — y llamar `initAsync("/matrix_sdk_crypto_wasm_bg.wasm")`.
   Es una línea, no una batalla con el bundler. **[?]** No he ejecutado el export web
   con el paquete instalado; que el import de JS resuelva limpio bajo Metro es lo
   único de esta sección que no está probado, y es lo primero que debería probar el
   spike de web.
3. **Multi-pestaña.** La documentación es explícita: *"the cryptography stack is not
   thread-safe. Having multiple `MatrixClient` instances connected to the same Indexed
   DB will cause data corruption and decryption failures"* **[J]**
   (`JS:lib/client.d.ts:1142-1144`). Dos pestañas de Allo abiertas corrompen el store
   de cripto. Element Web resuelve esto y hay que resolverlo aquí: un lock entre
   pestañas (`navigator.locks`) o un `SharedWorker`. **[C]** Es trabajo real y hay que
   presupuestarlo; no es un detalle.

### 2.2 ¿`matrix-rust-sdk` compilado a WASM? Verificado: los crates sí, el binding no

Esta era la vía que habría hecho innecesario todo lo anterior, así que la comprobé a
fondo. La respuesta es no, y la razón es concreta.

**Los crates de Rust sí compilan a `wasm32-unknown-unknown`.** No es especulación:
el CI de `matrix-rust-sdk` tiene un job `test-wasm` que instala el target
`wasm32-unknown-unknown` y `wasm-pack`, y construye `matrix-sdk-qrcode`,
`matrix-sdk-base`, `matrix-sdk-common`, `matrix-sdk` (sin features por defecto),
`matrix-sdk-ui` (sólo `check`) y los stores de IndexedDB **[W]**
([`.github/workflows/ci.yml:226-258`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/.github/workflows/ci.yml)).
Y el propio código del SDK está lleno de `#[cfg(target_family = "wasm")]` **[R]**
(`RUST:crates/matrix-sdk/src/encryption/secret_storage/futures.rs:44-47`).

**Pero no existe binding JS del SDK completo.** El directorio `bindings/` del
repositorio contiene exactamente cuatro entradas: `apple`, `matrix-sdk-crypto-ffi`,
`matrix-sdk-ffi-macros` y `matrix-sdk-ffi` **[W]** (API de contenidos de GitHub sobre
`main`). Ninguna es un binding WASM/JS. El único binding JS publicado es
`matrix-sdk-crypto-wasm`, que vive en otro repositorio y expone **sólo la máquina de
cripto** (`OlmMachine`), no el cliente, ni el room list, ni el timeline.

**[C]** Escribir ese binding es un proyecto, no una tarea: habría que envolver a mano
con `wasm-bindgen` toda la superficie de `matrix-sdk` + `matrix-sdk-ui`, incluyendo
callbacks de listeners, streams asíncronos y los bounds `Send` que en WASM no se
cumplen igual — que es precisamente por lo que el SDK ya tiene ramas `cfg(target_family
= "wasm")` distintas para sus futuros. Descartado.

**Un apunte sobre la premisa inversa: Hermes y WASM.** La premisa del encargo —Hermes
no ejecuta WASM— la comprobé porque hay ruido reciente que sugiere lo contrario.
Sostiene: el issue de soporte de WebAssembly en Hermes ([facebook/hermes#429]) sigue
**abierto**, con última actividad el 2025-02-11 **[W]** (consultado vía la API de
GitHub), y el anuncio oficial de React Native 0.84 —el que hace Hermes V1 el motor
por defecto— **no menciona WebAssembly en ningún punto** **[W]**
([reactnative.dev/blog/2026/02/11/react-native-0.84](https://reactnative.dev/blog/2026/02/11/react-native-0.84)).
Lo que sí existe es [`callstackincubator/polygen`], un compilador AOT que traduce
módulos `.wasm` a C con `wasm2c` en tiempo de compilación; está marcado experimental
por sus autores, su último push es de 2025-06-04 **[W]** (API de GitHub) y su
documentación no menciona soporte de módulos generados con `wasm-bindgen` **[W]**.
`matrix-sdk-crypto-wasm` es exactamente un módulo `wasm-bindgen` cargado con
`instantiateStreaming`. **[C]** No es una vía. La premisa del encargo se sostiene.

### 2.3 ¿Se puede compartir la capa de datos? Sí, pero no donde uno querría

**La respuesta corta:** compartir el modelo y la UI, no el timeline.

**Por qué el timeline no.** Los dos SDK no tienen modelos parecidos, tienen modelos
opuestos. El binding entrega un objeto `Timeline` por sala con un stream de diffs de
items —`addListener`, `paginateBackwards`, `paginateForwards`, `send`, `sendReply`,
`toggleReaction`, `redactEvent`, `markAsRead`— y su propio tipo de item,
`EventTimelineItem` **[B]** (`FFI:29202` para `paginateBackwards`, `FFI:531` para
`EventTimelineItem`), más un `RoomListService` con `allRooms`/`subscribeToRooms` y
un enum de diffs `RoomListEntriesUpdate` **[B]** (`FFI:17957-18373`).
`matrix-js-sdk` entrega `Room` / `MatrixEvent` / `EventTimeline` y paginación por
`client.paginateEventTimeline`. Uno es "un stream de diffs sobre una lista
mantenida por Rust"; el otro es "un grafo de objetos mutables con eventos". Unificar
los dos significa reimplementar uno encima del otro. **[C]** Eso es donde se van los
meses y donde aparecen los bugs de decrypción fantasma.

**Dónde sí se comparte, y es la mayor parte del trabajo.** Nada de esto toca un SDK:

- La derivación de claves desde Oxy (§3). Es HKDF con `@noble/hashes`, TypeScript
  puro, idéntico en las tres plataformas — el propio `kdf.ts` de Oxy lo dice
  explícitamente **[V]** (`node_modules/@oxyhq/core/src/crypto/kdf.ts:1-11`).
- El mapeo identidad Oxy → identidad Matrix.
- Los esquemas de los eventos propios de Allo (`so.oxy.allo.*`) definidos en
  `data-model.md`, y su validación.
- El cliente del registry de moderación, i18n, y **toda la UI**, porque
  `packages/frontend` ya construye web con `expo export --platform web` **[V]**
  (`packages/frontend/package.json`) y se despliega a Cloudflare Pages con ese `dist`
  **[V]** (`.github/workflows/deploy-frontends.yml`).

**La forma del puerto.** **[C]** Un módulo con dos implementaciones resueltas por
Metro vía extensión (`matrixClient.native.ts` / `matrixClient.web.ts`), exportando
un tipo único. Concretamente, y a propósito corto:

```ts
// Ciclo de vida
start(): Promise<void>
stop(): Promise<void>

// Lista de salas: una vista ya ordenada, no el modelo del SDK
observeRoomList(onChange: (rooms: AlloRoomSummary[]) => void): Unsubscribe

// Timeline: se entrega el array completo ya reconciliado.
// Nativo aplica los diffs de RoomListEntriesUpdate por dentro;
// web reconstruye desde Room.getLiveTimeline(). El consumidor no lo sabe.
observeTimeline(
  roomId: string,
  onChange: (items: AlloTimelineItem[]) => void,
): { paginateBack(count: number): Promise<boolean>; dispose(): void }

// Envío y edición
sendText(roomId: string, body: string, replyToEventId?: string): Promise<void>
sendMedia(roomId: string, media: AlloOutgoingMedia): Promise<void>
redact(roomId: string, eventId: string): Promise<void>
toggleReaction(roomId: string, eventId: string, key: string): Promise<void>
markRead(roomId: string, eventId: string): Promise<void>

// Salas
createDirectRoom(userId: string): Promise<string>
leaveRoom(roomId: string): Promise<void>

// Estado propio de Allo (§4 de data-model.md)
setRoomState(roomId: string, type: AlloStateEventType, content: unknown): Promise<void>

// Cifrado — la parte que decide la §3
recoveryState(): AlloRecoveryState          // Unknown | Enabled | Disabled | Incomplete
enableRecovery(passphrase: string): Promise<void>
recover(passphrase: string): Promise<void>
verificationState(): AlloVerificationState  // Unknown | Verified | Unverified
```

Lo que se abstrae es **el modelo de vista**, no Matrix: `AlloRoomSummary`,
`AlloTimelineItem` y `AlloOutgoingMedia` son tipos de Allo, definidos por lo que la
UI dibuja, no por lo que el SDK devuelve. Cada implementación traduce hacia ese
modelo. Si en algún momento el puerto crece un método que sólo existe en un SDK, esa
es la señal de que la abstracción se está rompiendo y hay que resolverlo en la UI,
no añadiendo el método.

**Y la condición que hace que esto valga la pena:** el puerto sólo se justifica
porque la UI es compartida. Si en algún momento se decide que web tiene su propia
UI, el puerto deja de tener sentido y hay que borrarlo, no mantenerlo por inercia.

### 2.4 ¿Cuánto diverge el comportamiento? Menos de lo que la pregunta teme

Un usuario con la app móvil y la web tiene, efectivamente, **dos dispositivos Matrix
distintos**: dos `device_id`, dos pares de claves Olm, dos stores. Eso es Matrix
estándar y no es negociable.

Lo que la pregunta asume —que eso implica un flujo de verificación cruzada entre
ellos— **deja de ser cierto en cuanto 4S está resuelto**. La verificación cruzada
interactiva (SAS, QR) es sólo *una* de las dos formas de que un dispositivo nuevo
entre en la identidad del usuario. La otra es recuperar las claves de cross-signing
desde 4S, y en el SDK de Rust ese camino termina firmando el propio dispositivo:

> `if status.has_self_signing { ... own_device.verify().await?; ... "Successfully signed our own device, the device is now verified" }`
> **[R]** (`RUST:crates/matrix-sdk/src/encryption/secret_storage/secret_store.rs:426-443`)

Y a continuación habilita el backup de claves **[R]** (mismo fichero, `:447`, llamando
a `maybe_enable_backups` de `:312`). Es decir: **entrar con Oxy en la web produce un
dispositivo verificado con historial descifrable, sin pedirle al usuario que escanee
nada.** Ese es el objetivo del encargo, y sale de la §3 sin trabajo adicional.

Lo que **sí** diverge, y hay que registrarlo:

1. **Requisito de homeserver asimétrico.** Móvil exige sliding sync nativo, web no
   (§2.1). Un homeserver mal configurado rompe móvil y deja web funcionando, que es
   un modo de fallo confuso de diagnosticar si no está escrito.
2. **La cola de envío offline es del SDK de Rust.** El binding expone
   `enableSendQueue`, `isSendQueueEnabled`, `subscribeToSendQueueUpdates`,
   `saveComposerDraft` **[B]** (superficie de `RoomLike`). `matrix-js-sdk` no tiene
   equivalente. **[C]** En web no hace falta reproducirla: un navegador con la pestaña
   cerrada no reintenta nada de todos modos. Pero significa que el comportamiento
   offline de Allo en web será peor que en móvil, y eso es una decisión de producto
   que alguien tiene que aceptar por escrito, no un detalle de implementación.
3. **Los chats secretos.** `data-model.md` §5.2(c) ya establece que el key backup es
   por cuenta y no por sala, y que un segundo cliente sube al backup las claves que
   tenga **[V]** (`docs/matrix/data-model.md:452-490`). El cliente web de Allo es
   exactamente ese segundo cliente. **[C]** No empeora el análisis de ese documento
   —que ya contempla "otro cliente Matrix con la misma cuenta rompe la propiedad"—
   pero lo hace inmediato en vez de hipotético: si se elige la opción **B** de
   `data-model.md` §5.2(c), la web hay que incluirla en esa promesa desde el día uno.

### Recomendación — Incógnita 1

**Dos implementaciones, un modelo, una UI.**

1. Nativo: `@unomed/react-native-matrix-sdk` (ya validado en dispositivo).
2. Web: `matrix-js-sdk@42` + `@matrix-org/matrix-sdk-crypto-wasm@18`, con `/sync` v2
   (no sliding sync), el `.wasm` servido desde `public/` e `initAsync(url)` explícito.
3. Un puerto `AlloChatClient` como el de §2.3, resuelto por `.native.ts` / `.web.ts`.
   No abstraer el timeline del SDK; abstraer el modelo de vista de Allo.
4. Cerrar antes de escribir el puerto, con un spike de web de un día: que
   `matrix-js-sdk` + el `.wasm` sobrevivan a `expo export --platform web`. Es el único
   riesgo de esta sección que no está verificado, y es barato de cerrar.
5. Añadir a los prerrequisitos de despliegue: **homeserver con sliding sync nativo**
   (lo exige móvil, no web).

---

## 3. Incógnita 2 — derivar la clave de recuperación desde Oxy

### 3.1 Qué hace exactamente `enableRecovery` con el `passphrase`

La firma del binding es
`enableRecovery(waitForBackupsToUpload: boolean, passphrase: string | undefined, progressListener: EnableRecoveryProgressListener): Promise<string>`
**[B]** (`FFI:25056`, y en la clase `FFI:25171`).

El camino completo, leído de arriba abajo:

1. El FFI pasa el passphrase al builder: `enable.with_passphrase(passphrase)` **[R]**
   (`RUST:bindings/matrix-sdk-ffi/src/encryption.rs:336-371`, la rama en `:350-354`).
2. El builder llama a `secret_storage.create_secret_store().with_passphrase(passphrase)`
   **[R]** (`RUST:crates/matrix-sdk/src/encryption/recovery/futures.rs:104-108`).
3. Y ahí está la bifurcación decisiva **[R]**
   (`RUST:crates/matrix-sdk/src/encryption/secret_storage/futures.rs:60-64`):

   ```rust
   let new_key = if let Some(passphrase) = passphrase {
       SecretStorageKey::new_from_passphrase(passphrase)
   } else {
       SecretStorageKey::new()
   };
   ```

4. `new_from_passphrase` **[R]** (`RUST:crates/matrix-sdk-crypto/src/secret_storage.rs:325-348`):

   ```rust
   let salt = Alphanumeric.sample_string(&mut rng, Self::DEFAULT_KEY_ID_LEN);   // 32 chars
   pbkdf2::<Hmac<Sha512>>(
       passphrase.as_bytes(),
       salt.as_bytes(),
       Self::DEFAULT_PBKDF_ITERATIONS,                                          // 500_000
       key.as_mut_slice(),                                                      // 32 bytes
   )
   ...
   key.storage_key_info.passphrase = Some(PassPhrase::new(salt, ...));
   ```

**La respuesta a la pregunta, sin ambigüedad: el passphrase NO es "otra cosa". La
clave de 4S se deriva del passphrase.** Parámetros exactos:

| Parámetro | Valor | Fuente |
|---|---|---|
| KDF | PBKDF2-HMAC-**SHA512** | `RUST:.../secret_storage.rs:330` |
| Iteraciones | **500 000** | `RUST:.../secret_storage.rs:223` |
| Salt | 32 chars alfanuméricos, **aleatorios** | `RUST:.../secret_storage.rs:221,328` |
| Salida | 32 bytes | `RUST:.../secret_storage.rs:326` |

(El `#[cfg(test)] const DEFAULT_PBKDF_ITERATIONS: u32 = 10` de la línea 225 es sólo
para los tests del crate **[R]**; en release son 500 000.)

El salt y el número de iteraciones se publican en el evento de account data
`m.secret_storage.key.<key_id>` **[R]** (`RUST:.../secret_storage.rs:344-345`, y el
evento se sube en
`RUST:crates/matrix-sdk/src/encryption/secret_storage/futures.rs:66-68`).

**Lo que devuelve `enableRecovery` NO es el passphrase**: es la clave de 4S en base58
—`store.secret_storage_key()` **[R]**
(`RUST:crates/matrix-sdk/src/encryption/recovery/futures.rs:146-151`)— y también llega
por el listener como `EnableRecoveryProgress.Done { recoveryKey }` **[B]**
(`FFI:5125-5135`). Es decir, con el passphrase route el usuario acaba teniendo **dos**
credenciales equivalentes: el passphrase derivado y la clave base58. Ambas abren el
store.

**Cuánto cuesta.** Medí PBKDF2-HMAC-SHA512 con 500 000 iteraciones y salida de 32
bytes: **143 ms** **[T]** (Node v22.17 sobre OpenSSL, en esta máquina de desarrollo —
no es un teléfono). **[C]** El orden de magnitud es cientos de milisegundos, no
segundos; sucede una vez al habilitar y una vez al recuperar. No es un problema de UX.
**[?]** No lo he medido en un dispositivo Android real; si resultara ser un orden de
magnitud peor, sigue siendo aceptable para una operación que ocurre una vez por
dispositivo.

### 3.2 ¿Se puede importar una clave existente en vez de generarla?

Hay que separar dos operaciones que la pregunta junta: **abrir** un store existente y
**crear** uno con material propio.

**Abrir: sí, y por dos caminos.** `recover(recoveryKey: string)` **[B]** (`FFI:25072`)
llama a `open_secret_store` **[R]**
(`RUST:crates/matrix-sdk/src/encryption/secret_storage/mod.rs:253-274`), que baja el
account data y llama a `SecretStorageKey::from_account_data(input, content)`. Y esa
función **acepta las dos formas** **[R]** (`RUST:.../secret_storage.rs:365-384`):

```rust
let key = if let Some(passphrase_info) = &content.passphrase {
    // Si el content define un passphrase, prueba primero como passphrase.
    match Self::from_passphrase(input, &content, passphrase_info) {
        Ok(key) => key,
        Err(e) => Self::from_base58(input, &content).map_err(|_| e)?,   // y si no, base58
    }
} else {
    Self::from_base58(input, &content)?
};
```

Nota que el parámetro se llama `recoveryKey` pero acepta el passphrase. La
documentación del SDK lo confirma: *"The `secret_storage_key` can be a passphrase or
a Base58 encoded secret storage key"* **[R]**
(`RUST:crates/matrix-sdk/src/encryption/secret_storage/mod.rs:227-228`).

**Crear con material propio: en el binding, no.** Comprobé los tres métodos que
sugería el encargo:

| Método | Qué hace realmente |
|---|---|
| `recover(key)` **[B]** `FFI:25072` | Sólo abre. No crea. **[R]** `encryption.rs:401-407` |
| `recoverAndReset(oldKey)` **[B]** `FFI:25075` | Abre con la vieja y **crea una nueva sin passphrase** → clave aleatoria. El FFI construye `RecoverAndReset` con `passphrase: None` y nunca llama a `.with_passphrase()` **[R]** (`encryption.rs:381-387`; `recovery/futures.rs:217-218, 238-247`) |
| `resetRecoveryKey()` **[B]** `FFI:25087` | Igual: `Reset` con `passphrase: None` → `SecretStorageKey::new()` → **32 bytes aleatorios** **[R]** (`encryption.rs:377-379`; `recovery/futures.rs:166-168, 191-195`) |

Es decir: **`enableRecovery` es la única puerta del binding por la que entra material
externo.** Y lo que entra es un passphrase, no una clave de 32 bytes.

**Esto tiene una consecuencia operativa que hay que escribir en el código, no en un
comentario:** si algún día se llama a `resetRecoveryKey()` o `recoverAndReset()` desde
la app, **el vínculo con Oxy se rompe en silencio** — la clave nueva es aleatoria, el
account data pierde el bloque `passphrase`, y `recover(passphraseDerivado)` empieza a
fallar. Ninguno de los dos métodos debería ser accesible desde la UI de Allo; el
"cambiar mi clave de recuperación" correcto es `enableRecovery` con un passphrase
derivado nuevo.

**Escotilla que existe pero no sirve.** El binding expone
`setAccountData(eventType: string, content: string)` **[B]** (`FFI:24008`), así que
técnicamente se podría escribir a mano el evento `m.secret_storage.key.<id>` con una
clave elegida. No es una vía: además del evento habría que cifrar y subir los tres
secretos de cross-signing y la clave de backup con el formato
`m.secret_storage.v1.aes-hmac-sha2` — que es lo que hace `export_secrets` **[R]**
(`RUST:.../secret_store.rs:452-470`) — y para eso hacen falta las claves privadas de
cross-signing, que el FFI no expone. **[C]** Sería reimplementar 4S en TypeScript por
fuera del SDK. Descartado.

### 3.3 La asimetría con web, y por qué no importa

En web la restricción **no existe**: `bootstrapSecretStorage({ createSecretStorageKey })`
llama al callback de la app y usa `recoveryKey.privateKey` tal cual **[J]**
(`JS:lib/rust-crypto/rust-crypto.js:706-726` y `:779-787`), donde
`GeneratedSecretStorageKey.privateKey` es un `Uint8Array` **[J]**
(`JS:lib/crypto-api/index.d.ts`, tipo en `develop:src/crypto-api/index.ts:1257-1268`).
O sea, **en web se puede inyectar la clave de 32 bytes derivada directamente, sin
PBKDF2 y sin salt del servidor.**

Es tentador y hay que resistirlo. Sólo existe **un** store de 4S por cuenta: el que
lo crea manda, y el otro sólo puede abrirlo. Si nativo crea con passphrase y web crea
con clave cruda, el material es incompatible y el primero que arranque decide. Como
el primer dispositivo de un usuario real será casi siempre el móvil, la vía cruda de
web quedaría muerta de todos modos.

**La buena noticia es que no hace falta elegir: el passphrase route es simétrico.**
`matrix-js-sdk` implementa exactamente los mismos parámetros **[J]**
(`JS:lib/rust-crypto/rust-crypto.js:827-844`):

```js
const salt = secureRandomString(32);
const recoveryKey = await deriveRecoveryKeyFromPassphrase(password, salt, this.RECOVERY_KEY_DERIVATION_ITERATIONS);
```

con `RECOVERY_KEY_DERIVATION_ITERATIONS = 500000` **[J]**
(`JS:lib/rust-crypto/rust-crypto.js:76`) y
`deriveRecoveryKeyFromPassphrase` = PBKDF2 vía WebCrypto con `hash: "SHA-512"` y 256
bits por defecto **[J]** (`JS:lib/crypto-api/key-passphrase.js:17,28,39`). Está
exportado públicamente **[J]** (`JS:lib/crypto-api/index.d.ts:1187`).

Coinciden pieza a pieza: SHA-512, 500 000, salt de 32 caracteres alfanuméricos, 32
bytes de salida. Y el encoding del passphrase también: Rust hace `passphrase.as_bytes()`
(UTF-8) **[R]** (`RUST:.../secret_storage.rs:331`) y JS hace
`new TextEncoder().encode(passphrase)` (UTF-8) **[J]**
(`JS:lib/crypto-api/key-passphrase.js:32`) — idénticos mientras el passphrase sea
ASCII, que es un requisito que se cumple por construcción (§3.6).

Comprobé además que las dos implementaciones producen **la misma representación
base58** de una clave de 32 bytes, porque de eso depende poder mostrar o transportar
la clave entre plataformas: porté a JavaScript el `to_base58` de Rust **[R]**
(`RUST:.../secret_storage.rs:475-506`) y el `encodeRecoveryKey` de `matrix-js-sdk`
**[J]** (`JS:lib/crypto-api/recovery-key.js:28`), y las contrasté sobre 5002 entradas
incluyendo los casos límite todo-ceros y todo-`0xff`: **0 discrepancias** **[T]**
(script en el scratchpad de la sesión, no comiteado). Prefijo `0x8b 0x01`, byte de
paridad XOR, alfabeto Bitcoin, grupos de cuatro. Son el mismo formato.

### 3.4 El esquema que recomiendo

**[C]** Un solo camino, el mismo en las dos plataformas:

```ts
// Derivación — TypeScript puro, idéntica en nativo y web.
// Reutiliza el HKDF que Oxy ya tiene: node_modules/@oxyhq/core/src/crypto/kdf.ts
const seed = await bip39.mnemonicToSeed(oxyPhrase);        // 64 bytes [V] recoveryPhrase.ts:231
const raw  = hkdfSha256(
  seed,
  utf8('allo-matrix-v1'),          // salt: dominio nuevo, versionado
  utf8('allo-matrix-4s-passphrase'),// info: etiqueta nueva, NO reutilizar las de Oxy
  32,
);
const passphrase = base64url(raw);  // 43 chars ASCII, sin padding
```

La separación de dominio no es decorativa: Oxy ya usa `oxy-backup-encryption-key` y
`oxy-backup-lookup-id` sobre el salt `oxy-identity-backup-v1` **[V]**
(`node_modules/@oxyhq/core/src/crypto/recoveryPhrase.ts:36-40`). Una etiqueta nueva
garantiza que filtrar el passphrase de Matrix no revela la clave de backup de Oxy ni
al revés. Y el `-v1` deja la puerta abierta a rotar el esquema sin ambigüedad.

Por qué base64url y no los bytes crudos: el FFI toma un `string` **[B]** (`FFI:25056`)
y las dos implementaciones lo pasan por UTF-8. Manteniéndolo ASCII, las dos producen
exactamente los mismos bytes de entrada a PBKDF2, sin depender de normalización
Unicode.

**La máquina de estados.** `RecoveryState` no describe el servidor, describe **este
dispositivo**: `check_recovery_state` devuelve `Enabled` sólo si 4S existe en el
servidor **y** `all_known_secrets_available()` es cierto, y esa función comprueba que
*este* cliente tenga completas las claves privadas de cross-signing y el backup
habilitado localmente **[R]** (`RUST:crates/matrix-sdk/src/encryption/recovery/mod.rs:606-616`
y `:514-533`). Eso hace el flujo trivial y sin heurísticas:

| `recoveryState()` **[B]** `FFI:25078` | Acción |
|---|---|
| `Disabled` | 4S no existe → `enableRecovery(false, passphrase, listener)` |
| `Incomplete` | 4S existe, a este dispositivo le faltan secretos → `recover(passphrase)` |
| `Enabled` | Nada. El dispositivo ya está completo y verificado |
| `Unknown` | Esperar a `recoveryStateListener` **[B]** `FFI:25079` |

Nunca llamar a `enableRecovery` en estado `Enabled` o `Incomplete`: crea un store
nuevo y **reemplaza** la clave por defecto **[R]**
(`RUST:crates/matrix-sdk/src/encryption/recovery/futures.rs:100-110`), tirando la
anterior. Y si hay un backup en el servidor que no está habilitado localmente, falla
con `RecoveryError::BackupExistsOnServer` **[R]** (mismo fichero, `:90-98`), que es un
error que la UI tiene que saber distinguir.

En web el equivalente es `bootstrapSecretStorage({ createSecretStorageKey: () => createRecoveryKeyFromPassphrase(passphrase) })`
para crear **[J]** (`JS:lib/crypto-api/index.d.ts:375,353`), y responder al callback
`getSecretStorageKey` **[J]** (`JS:lib/secret-storage.d.ts:140`) con
`deriveRecoveryKeyFromPassphrase(passphrase, keyInfo.passphrase.salt, keyInfo.passphrase.iterations)`
para abrir.

### 3.5 Implicaciones de seguridad de un passphrase determinista

**El salt es aleatorio y vive en el servidor.** No es fijo. Consecuencias, en orden:

1. **La derivación no es reproducible offline.** Hace falta bajar el account data
   `m.secret_storage.key.<id>` para conocer el salt. **[C]** Para 4S esto es
   irrelevante: recuperar 4S ya exige sesión iniciada. Pero elimina un escenario que
   alguien podría dar por supuesto: no se puede reconstruir la clave "en frío" desde
   sólo la frase de Oxy, sin servidor.
2. **Un homeserver hostil puede denegar la recuperación, no robarla.** Si sirve un
   salt distinto, la clave derivada es otra y `check_zero_message` falla contra el MAC
   publicado **[R]** (`RUST:.../secret_storage.rs:251-291`, invocado desde
   `from_passphrase` en `:407`). Resultado: `recover` da error. Lo que **no** puede es
   extraer la clave: nunca ve el passphrase ni la clave, sólo salt, iteraciones, IV y
   MAC.
3. **El work factor de PBKDF2 es irrelevante aquí, y eso es bueno.** Las 500 000
   iteraciones existen para proteger passphrases humanos de baja entropía. El nuestro
   es una salida HKDF de 256 bits: no hay diccionario que atacar. La seguridad del
   esquema es **exactamente la de la semilla BIP39 de Oxy** — 128 bits con frase de 12
   palabras, 256 con 24 **[V]** (`recoveryPhrase.ts:111,143`). Ni más ni menos.
4. **Hay un oráculo de verificación público.** El MAC del `ZERO_MESSAGE` en el account
   data permite a cualquiera que lo lea comprobar offline si un candidato de clave es
   el correcto **[R]** (`RUST:.../secret_storage.rs:251-291`). Contra 256 bits de
   entropía da igual. Contra un factor extra de baja entropía, no da igual en absoluto
   — es la razón por la que un PIN numérico no sirve (§3.6).
5. **El passphrase derivado es una credencial, no un identificador.** No debe
   loggearse, ni enviarse al backend, ni guardarse fuera de memoria. El propio FFI lo
   pone a cero después de usarlo **[R]** (`RUST:bindings/matrix-sdk-ffi/src/encryption.rs:368`),
   y el lado TypeScript debería tener la misma disciplina en lo que pueda.

### 3.6 El riesgo que hay que nombrar: quien tenga la frase de Oxy tiene todo Allo

Es cierto, y hay que decirlo tal cual. Pero hay que medirlo bien, porque el
contrafactual no es "el atacante no tiene nada".

**Qué se pierde de verdad.** La identidad de Allo ya viene de Oxy. Un atacante con la
frase de Oxy **ya** puede tomar la cuenta y, desde ese momento, leer todo lo que se
envíe. Lo que el esquema derivado le añade es el **historial anterior** al compromiso,
lo que en el modelo estándar de Matrix estaría protegido por una segunda credencial
independiente. Es una pérdida real, pero es la pérdida del *historial pasado*, no de
la cuenta — la cuenta ya estaba perdida.

**Qué se pierde estructuralmente, que es lo más importante.** La frase de Oxy pasa a
ser un punto único de fallo sin segundo factor para todo el ecosistema. Eso es un
cambio de modelo de amenaza que afecta a más que a Allo, y merece decisión explícita
de quien sea dueño de Oxy, no de quien implementa Allo.

**Sobre la capa extra con PIN. [C] Un PIN numérico no la da.** Existe el oráculo del
punto 4 de §3.5: un atacante con la frase puede probar candidatos offline contra el
MAC público. Con la medición de §3.1 (143 ms por intento), un PIN de 6 dígitos son
10⁶ × 143 ms ≈ **40 horas de un solo núcleo**, y PBKDF2-HMAC-SHA512 paraleliza bien en
GPU. Un PIN de 6 dígitos compra horas, no seguridad. Venderlo como "capa extra" sería
peor que no tenerlo, porque cambia lo que el usuario cree.

**Lo que sí recomiendo, en este orden:**

1. **Enviar la derivación por defecto.** El beneficio de UX es exactamente el objetivo
   del encargo —el historial se abre solo al entrar con Oxy, y de paso el dispositivo
   se verifica solo (§2.4)— y el coste marginal en seguridad es acotado y explicable.
2. **Decirlo en la interfaz, con esas palabras.** "Tu frase de recuperación de Oxy
   también abre el historial de Allo." Sin eufemismos. Un usuario que trata su frase
   como la llave de todo actúa correctamente; uno que cree que Allo tiene un secreto
   aparte, no.
3. **Ofrecer separación como opción, y que sea una passphrase con entropía real, no un
   PIN.** Si el usuario la activa, entra en el `ikm` del HKDF. Se documenta que si la
   pierde, pierde el historial — que es exactamente el modelo estándar de Matrix, y es
   una elección legítima para quien la quiera.
4. **No apoyar los chats secretos en esto.** La defensa real de un chat secreto es
   quedarse fuera de 4S y del key backup, que es la discusión abierta de
   `data-model.md` §5.2(c) **[V]** (`docs/matrix/data-model.md:452-490`). El esquema de
   esta sección es para chats normales; que el historial normal sea recuperable es
   una feature, no un descuido.
5. **No exponer `resetRecoveryKey()` ni `recoverAndReset()` en la UI** (§3.2). Rompen
   el vínculo en silencio.

### Recomendación — Incógnita 2

**Hacerlo, por la vía del passphrase, con HKDF y dominio propio.**

1. `passphrase = base64url(HKDF-SHA256(seedBIP39, salt="allo-matrix-v1", info="allo-matrix-4s-passphrase", 32))`.
2. Nativo: `enableRecovery(false, passphrase, listener)` para crear,
   `recover(passphrase)` para abrir, gobernado por `recoveryState()` (§3.4).
3. Web: `bootstrapSecretStorage({ createSecretStorageKey: () => createRecoveryKeyFromPassphrase(passphrase) })`
   para crear, y el callback `getSecretStorageKey` con `deriveRecoveryKeyFromPassphrase`
   para abrir. Mismos parámetros PBKDF2 verificados en ambos lados.
4. **No** usar la inyección de clave cruda que web permite: fragmentaría el esquema
   sin ganar nada.
5. Decir en la UI que la frase de Oxy abre el historial de Allo, y ofrecer una
   passphrase adicional opcional —con entropía, no un PIN— para quien quiera
   separación.

---

## 4. Lo que no pude verificar

En orden de cuánto duele si sale mal:

1. **Que `matrix-js-sdk` + el `.wasm` sobrevivan a `expo export --platform web` bajo
   Metro.** Es el único riesgo de la §2 sin cerrar. La API tiene la escotilla
   (`initAsync(url)`) y `public/` existe, pero no lo he ejecutado. Un spike de un día
   lo cierra, y debe hacerse **antes** de escribir el puerto de §2.3.
2. **El coste de PBKDF2 en un Android real.** Medí 143 ms en máquina de desarrollo
   **[T]**; no en teléfono. No cambia la decisión, sí el copy de la pantalla de espera.
3. **Que el homeserver que se despliegue sirva sliding sync nativo.** Es un requisito
   duro para móvil **[B]** y no depende de este documento.
4. **Nada de lo que afirmo sobre el spec de Matrix por sí mismo.** Todo lo marcado
   **[R]**/**[B]**/**[J]** es lo que estas implementaciones concretas hacen, que es lo
   que la app va a ejecutar. Donde el spec diga otra cosa, gana el código, pero
   conviene saberlo.
5. **Multi-pestaña en web.** Sé que el problema existe y está documentado **[J]**; no
   he evaluado cuál de las dos soluciones (`navigator.locks` o `SharedWorker`) encaja
   mejor con el arranque de Expo web.

---

## 5. Tabla de correspondencias entre las dos implementaciones

Para la §2.3, la equivalencia real de la superficie de cifrado — que es la parte del
puerto donde más importa que no haya sorpresas.

| Operación | Nativo (binding) | Web (`matrix-js-sdk`) |
|---|---|---|
| Estado de recuperación | `recoveryState()` **[B]** `FFI:25078` | `isSecretStorageReady()` / `getSecretStorageStatus()` **[J]** `index.d.ts:330,334` |
| Crear 4S con passphrase | `enableRecovery(w, pass, l)` **[B]** `FFI:25056` | `bootstrapSecretStorage({createSecretStorageKey})` **[J]** `index.d.ts:353` |
| Derivar clave desde passphrase | interno a `enableRecovery` **[R]** | `createRecoveryKeyFromPassphrase(pass)` **[J]** `index.d.ts:375` |
| Abrir 4S | `recover(passOrKey)` **[B]** `FFI:25072` | callback `getSecretStorageKey` **[J]** `secret-storage.d.ts:140` |
| Estado de verificación | `verificationState()` **[B]** `FFI:25113` | `getDeviceVerificationStatus(u,d)` **[J]** `index.d.ts:244` |
| Cross-signing listo | implícito en `recoveryState()` **[R]** | `isCrossSigningReady()` / `bootstrapCrossSigning()` **[J]** `index.d.ts:286,316` |
| Key backup (crear) | `enableBackups()` **[B]** `FFI:25053` | `resetKeyBackup()` **[J]** `index.d.ts:548` |
| Key backup (restaurar) | implícito en `recover()` **[R]** `secret_store.rs:447` | `restoreKeyBackup(opts)` **[J]** `index.d.ts:580` |
| Codificar clave base58 | devuelto por `enableRecovery` **[R]** | `encodeRecoveryKey(bytes)` **[J]** `recovery-key.js:28` |

Las dos últimas filas son la evidencia de por qué el puerto de §2.3 es viable en esta
zona: **el mismo formato de clave, el mismo KDF, los mismos parámetros y el mismo
`OlmMachine` de Rust por debajo** — verificado byte a byte para el encoding **[T]** y
línea a línea para el KDF **[R]**/**[J]**.

[facebook/hermes#429]: https://github.com/facebook/hermes/issues/429
[`callstackincubator/polygen`]: https://github.com/callstackincubator/polygen
