# Fase 0 — spike de matrix-rust-sdk en Expo

Harness mínimo para decidir si Allo migra a Matrix envolviendo `matrix-rust-sdk`.
Es el kill switch del plan: si las comprobaciones marcadas como bloqueantes no
pasan en **dispositivo físico**, el plan no sigue.

Este directorio está **fuera de los workspaces de Allo** (`packages/*`), así que
`bun install` en la raíz del monorepo no lo toca y el `bun.lock` principal no se
contamina con los ~1,2 GB de dependencias nativas que necesita el spike.

## Corrección de alcance respecto al plan original

La tarea decía "envolver matrix-rust-sdk con uniffi en un módulo nativo de Expo".
**Eso ya existe y no hay que reescribirlo**: [`@unomed/react-native-matrix-sdk`](https://github.com/unomed-dev/react-native-matrix-sdk)
envuelve `matrix-sdk-ffi` entero (66.399 líneas de TypeScript generado) como
TurboModule vía `uniffi-bindgen-react-native`, que es exactamente el enfoque de
Element X. El spike valida ese paquete en vez de duplicarlo.

Consecuencia: **la Fase 0 no necesita toolchain de Rust en CI**. Los binarios
vienen precompilados (los `.so` de Android dentro del tarball npm, el
`.xcframework` de iOS vía `postinstall`). El pipeline de Rust sólo hace falta si
tras el spike decidimos forkear el wrapper, y ese es un entregable de la Fase 1.

## Estado: qué está verificado y qué no

Verificado ya, en Linux, sin hardware:

| Hecho | Cómo |
|---|---|
| El harness compila contra los tipos reales del SDK 0.9.1 | `bunx tsc --noEmit` en verde, con prueba de control |
| `bun` bloquea el `postinstall` y deja iOS sin binario | `bun add` sin `trustedDependencies` → no existe `build/RnMatrixRustSdk.xcframework` |
| `trustedDependencies` arregla lo anterior | Con el campo puesto, el xcframework se descarga (ios-arm64 + ios-arm64_x86_64-simulator) |
| El módulo autolinka en Expo sin config plugin | `expo-modules-autolinking react-native-config` lo lista con `cmakeListsPath` y `packageImportPath` |
| `expo prebuild` genera el proyecto Android | Ejecutado; requirió subir `ios.deploymentTarget` a 16.4 (mínimo de SDK 57) |

**No verificado, y sólo verificable con hardware:** absolutamente todo lo que
hace el harness en tiempo de ejecución. Nadie ha ejecutado aún este SDK en
RN 0.86.

## Requisitos

- **macOS con Xcode** para la parte de iOS. No hay atajo: el `.xcframework` sólo
  se enlaza en un build de Xcode.
- **Un iPhone físico y un Android físico.** El simulador de iOS no sirve para la
  comprobación que más importa (ver C6/C7 abajo).
- Un **Synapse ≥ 1.114** accesible, con Simplified Sliding Sync (MSC4186)
  activado — es el valor por defecto desde esa versión.
- Dos cuentas de prueba en ese homeserver si quieres la comprobación C9.
- ~1,2 GB de disco para `node_modules`.

⚠️ **El emulador de Android x86_64 no funciona.** El paquete sólo trae
`arm64-v8a` y `armeabi-v7a`; en x86_64 revienta con `UnsatisfiedLinkError`. En
Apple Silicon el emulador arm64 sí vale. El simulador de iOS sí está cubierto
(el xcframework trae el slice `arm64_x86_64-simulator`), pero no lo uses para
C6/C7.

## Ejecutar

```bash
cd spikes/matrix-rn
bun install                       # ~1,2 GB, descarga el xcframework de iOS
bunx tsc --noEmit                 # debe salir limpio antes de compilar nada

bunx expo prebuild --clean        # genera android/ e ios/
bunx expo run:android --device    # con el móvil conectado por USB
bunx expo run:ios --device        # desde macOS, con el iPhone conectado
```

Alternativa con EAS (no necesita Mac local para iOS, pero sí una cuenta con
credenciales de firma configuradas):

```bash
bunx eas build --profile device --platform ios
bunx eas build --profile device --platform android
```

En la app: rellenar homeserver y credenciales, pulsar **Ejecutar spike**, y
copiar el log completo (es seleccionable) al reportar el resultado.

## Qué comprueba cada check

| ID | Qué demuestra | ¿Bloqueante? |
|---|---|---|
| **C1** | El módulo nativo carga y JSI→Rust responde (`sdkGitSha()`). Cubre el [issue #47](https://github.com/unomed-dev/react-native-matrix-sdk/issues/47), el crash de JNI `mHybridData` en RN 0.80+. Si falla, la app se cae al arrancar y nada más importa. | **Sí** |
| **C2** | Login contra Synapse y sesión con `deviceId`. | **Sí** |
| **C3** | El `SyncService` arranca y reporta estado: sliding sync nativo operativo, sin proxy. | **Sí** |
| **C4** | Se crea una sala y el SDK la considera cifrada. | Sí |
| **C5** | Un mensaje se cifra, se envía y se relee **descifrado** en el timeline. Distingue explícitamente descifrado de `UnableToDecrypt`: si llega el evento pero no descifra, es fallo, no éxito. | **Sí** |
| **C6** | Adjunto cifrado desde bytes en memoria (`UploadSource.Data`). | **Sí** |
| **C7** | Adjunto cifrado desde fichero en disco (`UploadSource.File`). | **Sí** |
| **C8** | Estado de cross-signing, verificación y key backup. Informativo: reporta los estados, no falla por ellos. | No |
| **C9** | Ida y vuelta entre **dos dispositivos**: B se une a la sala y A descifra su mensaje. Es la única que demuestra el reparto de claves de sala. Se salta si no configuras usuario B. | Sí |

### C6 y C7 son el punto de decisión

Reproducen el [issue #55](https://github.com/unomed-dev/react-native-matrix-sdk/issues/55),
abierto desde el 2026-07-15 y sin arreglar: `sendFile()` y `sendVoiceMessage()`
fallan **siempre** con `RoomError.InvalidAttachmentData` en iPhone físico y
funcionan **siempre** en simulador. El texto sí se envía. El reporte original ya
descartó validez del fichero, metadatos, ambas variantes de `UploadSource` y el
límite del servidor, y el tracing de Rust no emite nada — lo que apunta a la capa
de glue FFI.

Por eso el harness ejecuta las dos variantes por separado, y por eso hay que
correrlo en un iPhone real. **Una app de mensajería sin fotos ni notas de voz no
es un producto.** Si C6/C7 fallan y no encontramos la causa en una semana, la
recomendación es parar y reevaluar: estaríamos construyendo meses de producto
sobre una capa FFI cuyo fallo no sabemos diagnosticar.

## Si algo falla

- **C1 falla o la app se cae al abrir (Android):** es el issue #47. La causa raíz
  ([ubrn#295](https://github.com/jhugman/uniffi-bindgen-react-native/issues/295))
  se cerró en diciembre de 2025 y 0.9.1 ya usa ubrn 0.31.0-2, así que
  *debería* estar arreglado — pero nadie lo ha confirmado en RN 0.86. Si
  reaparece, el parche de `cpp-adapter.cpp` está en el propio issue #47.
- **El build de iOS falla porque no encuentra el xcframework:** es `bun` saltándose
  el `postinstall`. Comprueba `bun pm untrusted`; el `trustedDependencies` de
  `package.json` debe incluir `@unomed/react-native-matrix-sdk`.
- **C3 se queda colgado:** el homeserver probablemente no tiene MSC4186. Verifica
  la versión de Synapse.
- **C5 reporta UnableToDecrypt:** el transporte va y el E2EE no. Es un fallo peor
  que un timeout, no lo confundas con un problema de red.

## Después del spike

Si pasa: el siguiente paso **no** es integrar el paquete de npm tal cual, sino
forkearlo — mantenedor único, 6 commits en todo 2026, `matrix-rust-sdk` 0.17
cuando ya va por 0.18, sin ABI x86_64, y 222 MB de `postinstall` desde GitHub
Releases en cada build de EAS. Ahí es donde entra el pipeline de Rust en CI.

Si falla en C6/C7: hay que decidir entre invertir en depurar la capa FFI ajena o
replantear el enfoque.
