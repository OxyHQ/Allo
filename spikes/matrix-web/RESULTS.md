# Resultados — ejecutados el 2026-08-02

Contra Synapse local (`http://localhost:8008`) salvo el paso OIDC, que va contra
matrix.org. Ejecutado sobre el **export de producción** servido estáticamente,
no sobre el dev server: era justo ahí donde el diseño temía que rompiera.

| | Resultado | Evidencia |
|---|---|---|
| 1. WASM en el export | **PASS** | Carga e instancia en 62 ms. `dist/matrix_sdk_crypto_wasm_bg.wasm`, 7,8 MB. OlmMachine con identidad curve25519 + ed25519 |
| 2. Crypto stack | **PASS** | Dispositivo A arriba, `crossSigningReady=false` de partida |
| 3. Ida y vuelta E2EE | **PASS** | El servidor solo ve `m.room.encrypted`, 491 bytes de contenido |
| 4a. 4S desde passphrase | **PASS** | `algorithm=m.pbkdf2`, `iterations=500000` — los parámetros que el diseño predijo |
| 4b. Recuperación en dispositivo nuevo | **PASS** | Importa las claves, descifra un mensaje anterior a su alta, y `ownDeviceCrossSigningVerified=true` |
| OIDC / MSC2965 | **PASS** | Descubrimiento correcto, URL de autorización con PKCE S256, scope `urn:matrix:client:api:*` |
| Multi-pestaña | **PASS** | Sobrevive a la colisión y completa una ida y vuelta después |

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

- PBKDF2 con 500 000 iteraciones: **~110 ms** en navegador de escritorio. Sin
  problema de UX; falta medirlo en un móvil real.
- El `.wasm` pesa **7,8 MB**. Queda por decidir si se carga siempre al abrir la
  app web o solo cuando hace falta cripto. Es una decisión de primera carga.

## Lo que no se ha probado

- Registro dinámico de cliente OIDC: anunciado por matrix.org, no ejercitado.
- El homeserver fue Synapse local con login por contraseña. Producción llevará
  MAS, así que el login será OIDC — soportado, pero no ejercitado de extremo a
  extremo.
