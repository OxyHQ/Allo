# Spike de Matrix — instrucciones

Una app de Android que comprueba si la librería de Matrix cifrada funciona de
verdad en un móvil. Sirve para decidir si seguimos por ese camino o no.

Necesitas: **un móvil Android**, **un ordenador con navegador**, y **una cuenta
de matrix.org**. Nada más. No hay que instalar ningún servidor.

---

## 1. Crear la cuenta de matrix.org

Si ya tienes una, sáltate esto.

1. Entra en <https://app.element.io> desde el ordenador.
2. Pulsa **Crear cuenta**, deja el servidor en `matrix.org`.
3. Pon usuario y contraseña, confirma el email y resuelve el captcha.
4. Apunta el usuario y la contraseña. Los vas a escribir en el móvil.

Cuando entres, Element te preguntará por la verificación del dispositivo.
**Sáltala de momento**, ya la haremos en el paso 4.

---

## 2. Instalar el APK en el móvil

1. Copia el fichero `.apk` al móvil (cable USB, Drive, Telegram, lo que sea).
2. Ábrelo desde el móvil. Android dirá que la app viene de un origen
   desconocido: dale a **Ajustes** → activa **Permitir de esta fuente** →
   vuelve atrás e instala.
3. Abre la app, que se llama **Allo Matrix Spike**.

Es normal que Android avise de que la app no está verificada. Está firmada con
una clave de pruebas, no se publica en ningún sitio.

---

## 3. Fase A — en el móvil

1. Deja **Homeserver** como está (`https://matrix.org`).
2. Escribe tu **usuario** (sólo el nombre, sin `@` ni `:matrix.org`) y tu
   **contraseña**.
3. Deja el resto como está y pulsa **Fase A · ejecutar en el móvil**.
4. Espera. Tarda entre unos segundos y un par de minutos.

Cuando acabe verás una lista de resultados con ✅ o ❌, y —si todo fue bien— un
recuadro amarillo con cuatro datos. **No cierres la app**, los necesitas ahora.

Si algo sale ❌, para aquí y manda el log entero (se puede seleccionar y copiar).

---

## 4. Fase B — en el ordenador

El recuadro amarillo del móvil te da cuatro cosas: una **clave de
recuperación**, el nombre de una **sala**, un **mensaje** y un **PING**.

1. Entra en <https://app.element.io> con la misma cuenta.
2. Cuando pida verificar la sesión, elige **verificar con clave de
   recuperación** (o «usar clave de seguridad») y escribe la clave de
   recuperación que aparece en el móvil.
3. Busca la sala que dice el móvil y ábrela.
4. **Mira el mensaje.** Tienes que poder leerlo.
   - Si se lee → bien.
   - Si pone «no se puede descifrar» o sale un candado roto → apúntalo, eso es
     un fallo importante.
5. Escribe en esa sala el **PING** exactamente como aparece en el móvil
   (por ejemplo `PING-m4x8k2`) y envíalo.
6. Vuelve al móvil y pulsa **Fase B · esperar el PING**.
7. Espera a que salga ✅ o ❌.

### Comprobación extra (opcional pero útil)

Abre una **ventana de incógnito** y entra en Element con la misma cuenta, pero
esta vez **sáltate la verificación** y no metas la clave de recuperación.
Entra en la misma sala. Los mensajes **no** se deberían poder leer.

Si se leen sin haber metido la clave, avisa: significa que el historial no está
protegido como creemos.

---

## 5. Qué mandar de vuelta

- El log completo del móvil (se selecciona y se copia).
- Si el mensaje del paso 4.4 se leía o no.
- Si en la comprobación extra los mensajes se leían o no.

---

## Qué significa cada resultado

| | Qué comprueba | Si sale ❌ |
|---|---|---|
| **C1** | Que la librería nativa arranca y responde en el móvil. | La app se cae o no arranca. Todo lo demás da igual. |
| **C2** | Que se puede iniciar sesión en matrix.org. | Usuario o contraseña mal, o el servidor no responde. |
| **C3** | Que funciona el sistema de sincronización moderno. | El servidor no lo soporta. |
| **C4** | Que se puede crear una sala cifrada. | El cifrado no se activa al crear salas. |
| **C5** | Que un mensaje se cifra, se envía y se vuelve a leer. | El cifrado no funciona de ida y vuelta. |
| **C6** | Que se genera la clave de recuperación y hay copia de seguridad en el servidor. | Sin esto, cambiar de móvil pierde todo el historial. |
| **C7** | Que un mensaje escrito en el ordenador llega al móvil y se lee. | Los dispositivos no se pasan las claves entre ellos. |
| **C8** | Que se pueden enviar ficheros en una sala cifrada. | Esta suele fallar en iPhone; en Android es la primera vez que se prueba. |

---

## Para quien construye el APK

El proyecto es Expo SDK 57 / React Native 0.86 y envuelve
[`@unomed/react-native-matrix-sdk`](https://github.com/unomed-dev/react-native-matrix-sdk),
que a su vez envuelve `matrix-rust-sdk`.

```bash
cd spikes/matrix-rn
bun install          # ~1,2 GB; trae los binarios nativos ya compilados
bunx tsc --noEmit    # debe salir limpio
```

Dos cosas que hay que saber:

- **Las ABIs ya están fijadas** por `plugins/withMatrixSdkAbis.js`, que pone
  `reactNativeArchitectures=armeabi-v7a,arm64-v8a` — exactamente las dos para
  las que el módulo trae `libmatrix_sdk_ffi.so`. Con `x86`/`x86_64` el APK se
  instala pero revienta al abrir con `UnsatisfiedLinkError`, que no falla en el
  build sino en el dispositivo. Por lo mismo, **el emulador x86_64 no sirve**:
  hace falta hardware ARM o un emulador arm64.
- **Hace falta el NDK de Android.** Los `.so` de Rust vienen precompilados,
  pero el pegamento C++ entre JavaScript y Rust (7 ficheros, incluido uno de
  2,5 MB generado) se compila en cada build. Con EAS Build esto pasa en la
  nube y no hay que instalar nada localmente; el perfil `standalone` de
  `eas.json` produce un APK de release con el JavaScript ya embebido, que es
  lo que se puede copiar al móvil.

El spike vive fuera de los workspaces del monorepo, así que `bun install` en la
raíz de Allo no lo toca y el `bun.lock` principal no se ve afectado.
