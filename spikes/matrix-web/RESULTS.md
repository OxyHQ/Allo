# Resultados — ejecutados el 2026-08-02

Contra Synapse local (`http://localhost:8008`) salvo el paso OIDC, que va contra
matrix.org. Ejecutado sobre el **export de producción** servido estáticamente,
no sobre el dev server: era justo ahí donde el diseño temía que rompiera.

| | Resultado | Evidencia |
|---|---|---|
| 1. WASM en el export | **PASS** | Carga e instancia en 62 ms. `dist/matrix_sdk_crypto_wasm_bg.wasm`, 7,8 MB. OlmMachine con identidad curve25519 + ed25519 |
| 2. Crypto stack | **PASS** | `OlmMachine.initialize()` genera identidad real (curve25519 + ed25519); vodozemac 0.10.0. No es solo que el módulo importe |
| 3. Ida y vuelta E2EE | **PASS** | El servidor solo ve `m.room.encrypted`, 491 bytes de contenido |
| 4a. 4S desde passphrase | **PASS** | `algorithm=m.pbkdf2`, `iterations=500000` — los parámetros que el diseño predijo |
| 4b. Recuperación en dispositivo nuevo | **PASS** | Importa las claves, descifra un mensaje anterior a su alta, y `ownDeviceCrossSigningVerified=true` |
| OIDC / MSC2965 | **PARCIAL** | Descubrimiento correcto y URL de autorización bien construida (PKCE S256, scope `urn:matrix:client:api:*`). **No se completó ningún login**: ni registro dinámico de cliente ni canje del código. Prueba que `matrix-js-sdk` sabe descubrir y construir, no que sepa autenticar. **Actualización 2026-08-02:** el registro dinámico sí se ejercitó después, contra `account.matrix.org/oauth2/registration`, con la forma de payload de `client.web.ts:922` — `HTTP 201` y `client_id` devuelto. Sigue sin probarse el canje del código, que necesita a una persona consintiendo en un navegador. Ver `docs/matrix/interim-homeserver.md` |
| Multi-pestaña | **SIN CONCLUIR** | No conseguí reproducir el fallo. Ver abajo: no es un PASS |

## Multi-pestaña: por qué no es un PASS

El encargo pedía **reproducir y caracterizar** el fallo, no resolverlo. No lo
reproduje, que no es lo mismo que que no exista:

- Dos pestañas con **`device_id` distinto** sobre el mismo store: error limpio y
  determinista, `the account in the store doesn't match the account in the
  constructor`. Es una barandilla del SDK, no corrupción.
- El caso real —**misma sesión, mismo `device_id`, mismo IndexedDB, dos pestañas
  vivas**—: la segunda arranca sin error, ambas reportan idénticas claves de
  identidad, ambas envían y descifran, y cada una lee lo de la otra.
- Estrés: 10 mensajes alternando entre las dos pestañas, con un tercer
  dispositivo independiente conectado de antemano para hacer de testigo. Los 10
  descifrados, cero divergencia.

**Conclusión:** el peligro que documenta el SDK —*"the cryptography stack is not
thread-safe […] will cause data corruption and decryption failures"*— es una
**carrera**, no un fallo determinista, y una prueba de minutos no la fuerza. Que
no la haya visto no dice que no ocurra en producción con dos pestañas abiertas
durante horas. **El trabajo de `navigator.locks` o `SharedWorker` sigue habiendo
que presupuestarlo**; lo único que aporta este spike es que ambas primitivas
existen en el runtime (`navigator.locks=true`, `SharedWorker=true`) y que no
puedo cuantificar el daño.

## Lo que esto demuestra, más allá de "web funciona"

**El esquema de la clave derivada de Oxy es válido.** El paso 4b alimenta un
passphrase arbitrario, y el dispositivo nuevo recupera el historial anterior a su
existencia. Eso es exactamente lo que hará el cliente con un passphrase derivado
de la frase BIP39 de Oxy: sin criptografía propia, solo un `info` distinto en el
HKDF que Oxy ya tiene.

**Y el dispositivo se verifica solo.** `ownDeviceCrossSigningVerified=true` tras
recuperar confirma lo que el diseño afirmaba: recuperar desde 4S firma el propio
dispositivo con la clave de self-signing. Verificar móvil contra web deja de ser
una pantalla de QR o de emojis y pasa a ser un efecto secundario del login.

**Con control negativo.** Antes de recuperar, el dispositivo B **no** podía leer
el mensaje: *"This message was sent before this device logged in, and key backup
is not working"*. Sin eso, "lo descifró después" no probaría que fuera el backup.

## Coste medido

- PBKDF2 con 500 000 iteraciones: **109–117 ms** en navegador de escritorio. Pero
  se llama **una vez por secreto**: son 4 en el bootstrap de 4S (master,
  self\_signing, user\_signing, megolm\_backup), ≈450 ms de los 695 ms totales.
  Falta medirlo en un móvil real.
- El `.wasm` pesa **7 820 736 bytes** (2 093 185 con `gzip -9`; Cloudflare sirve
  Brotli, así que por red será menos). **No se descarga al abrir la app** — esto
  está medido, no deducido: cargando la página y esperando a `networkidle2` más
  5 s de margen, las peticiones son 3 y ninguna es el `.wasm`:

  ```
  requests: 3, total content-length: 2307885 bytes
    200     21075 text/html        /
    200   2265735 text/javascript  /_expo/static/js/web/entry-….js
    200     21075 text/html        /favicon.ico
  WASM ON LOAD: none — the .wasm is NOT downloaded just by opening the app
  ```

  Los 7,8 MB se piden **solo al llamar a `initAsync`**. Así que no queda por
  decidir "si se carga siempre": es diferido por construcción. Lo que queda por
  decidir es **cuándo llama el puerto a `initAsync`**, que en una app de
  mensajería será al abrir sesión, no al primer pintado. Reproducible con
  `bun run scripts/lazy-check.ts`.
- **Aviso de caché:** el `.wasm` se sirve desde una ruta fija sin hash de
  contenido, a diferencia de los bundles JS. Si se le pone `Cache-Control` largo,
  actualizar el paquete no invalida nada. Conviene meter la versión en el nombre
  al copiarlo.

## Restricciones que la implementación del puerto tiene que respetar

Salieron del spike y no son opcionales:

1. **`initAsync(url)` explícito, antes de cualquier cosa que dispare
   `initRustCrypto()`.** La carga por defecto **falla**: `import.meta.url` acaba
   en `globalThis.__ExpoImportMetaRegistry.url` y se pide
   `/_expo/static/js/web/pkg/matrix_sdk_crypto_wasm_bg.wasm`, que no existe en el
   export. Y no da 404: el fallback SPA (`/*  /index.html  200`, el `_redirects`
   que ya tiene `packages/frontend/public/`) devuelve el index con `text/html`,
   así que el error habla de MIME y no de ruta:

   ```
   TypeError: Failed to execute 'compile' on 'WebAssembly': Incorrect response MIME type. Expected 'application/wasm'.
   ```

2. **Recuperar desde 4S en web son tres llamadas en orden**, donde el binding
   nativo tiene un solo `recover(passphrase)`: `bootstrapCrossSigning({})` →
   `loadSessionBackupPrivateKeyFromSecretStorage()` → `restoreKeyBackup()`.
   Saltarse la del medio falla con `No decryption key found in crypto store`.

3. **`deriveRecoveryKeyFromPassphrase` no se exporta desde la raíz** del paquete,
   al contrario de lo que sugiere §3.4 del diseño: hay que importarla de
   `matrix-js-sdk/lib/crypto-api/index.js`, una ruta interna que se puede mover.

4. **Con OIDC el `device_id` lo elige el cliente**, no el servidor: va dentro del
   scope (`urn:matrix:client:device:<id>`). El puerto tiene que generarlo y
   persistirlo, y es el mismo identificador que decide el prefijo del store de
   cripto — con lo que enlaza con el problema de multi-pestaña.

5. **Prerrequisito de despliegue:** `getAuthMetadata()` usa la ruta estable
   `/_matrix/client/v1/auth_metadata` solo si el homeserver anuncia la spec
   **v1.15**; si no, cae a `/_matrix/client/unstable/org.matrix.msc2965/auth_metadata`.
   matrix.org anuncia como máximo v1.12 hoy y sirve las dos. Nuestro homeserver
   tiene que servir también la unstable, o anunciar v1.15.

## Lo que no se ha probado

- Registro dinámico de cliente OIDC: anunciado por matrix.org, no ejercitado a
  propósito — escribe estado en el servidor de autorización de un tercero.
- El homeserver fue Synapse local con login por contraseña. Producción llevará
  MAS, así que el login será OIDC — soportado, pero no ejercitado de extremo a
  extremo.
- **El dev server (`expo start --web`) no se probó.** Solo el export de
  producción, que era la puerta del spike.
- **La convivencia con las dependencias reales del frontend** (NativeWind, Bloom,
  el resto del árbol de `packages/frontend`) no se probó: el spike es una app
  Expo autónoma que replica la configuración de web, no el frontend real.
