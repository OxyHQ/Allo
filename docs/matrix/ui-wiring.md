# La UI contra el puerto de Matrix

Cómo se enciende el backend de Matrix en la app, qué llega hasta la pantalla y
qué todavía no. Complementa `client-strategy.md` (qué SDK corre dónde) y
`data-model.md` (dónde vive cada dato); esto es la capa de en medio: la que
decide de dónde salen los datos que la UI ya sabía dibujar.

---

## 1. La bandera

Una sola variable, leída en un solo sitio
(`packages/frontend/lib/chat/backend.ts`):

```
EXPO_PUBLIC_CHAT_BACKEND=matrix
```

| Valor | Qué habla |
|---|---|
| sin definir, o vacío | `allo-api` — Express, Socket.IO y `signalProtocol.ts`. **El comportamiento de siempre.** |
| `allo-api` | lo mismo, dicho en voz alta |
| `matrix` | el homeserver, a través del puerto de `lib/matrix/` |
| cualquier otra cosa | **lanza al importar** |

Lo último no es rigidez: quien escribe `EXPO_PUBLIC_CHAT_BACKEND=true` y recibe
en silencio el backend viejo no tiene forma de notarlo desde dentro de la app —
todas las pantallas funcionan y es la app equivocada.

Expo sustituye `process.env.EXPO_PUBLIC_*` por el literal en tiempo de
compilación, así que el valor no cambia mientras la app corre y `CHAT_BACKEND`
es una constante, no una función.

**Con la bandera apagada no se ejecuta nada de Matrix.** El puerto se carga con
un `import()` dinámico desde `matrixRuntime.ts`, y esa ruta sólo se recorre si la
bandera está encendida. Importa más que el tamaño del bundle: el SDK nativo
configura el log global de Rust en cuanto se evalúa su módulo, y el de web va a
por IndexedDB.

## 2. Las otras variables

Sólo se leen cuando la bandera está en `matrix`
(`packages/frontend/lib/chat/matrixConfig.ts`):

| Variable | Para qué | Por defecto |
|---|---|---|
| `EXPO_PUBLIC_MATRIX_HOMESERVER` | el homeserver | **ninguno; lanza** |
| `EXPO_PUBLIC_MATRIX_OIDC_CLIENT_ID` | client id acordado de antemano con MAS | registro dinámico |
| `EXPO_PUBLIC_MATRIX_OIDC_REDIRECT_URI` | a dónde vuelve el navegador | `allo://matrix/oidc` en nativo, `/matrix-oidc-callback.html` en web |

No hay homeserver por defecto a propósito: tendría que ser el de producción de
Allo, que no existe, o el de otro, y una build que habla en silencio con un
servidor que nadie eligió es peor que una que no arranca.

Para desarrollo:

```bash
EXPO_PUBLIC_CHAT_BACKEND=matrix \
EXPO_PUBLIC_MATRIX_HOMESERVER=https://matrix.org \
bun run dev:frontend
```

## 3. Cómo está montado

```
lib/chat/
  backend.ts             la bandera
  matrixConfig.ts        homeserver, OIDC, almacén
  matrixRuntime.ts       el cliente y su ciclo de vida, fuera de React
  matrixSession.ts       la sesión guardada: versión, validación, homeserver
  matrixSessionStorage.ts dónde vive: llavero en nativo, localStorage en web
  roomListSource.ts      la lista de salas como external store
  timelineSource.ts      un timeline por sala, ídem, más paginar y enviar
  mediaCache.ts          adjuntos ya bajados y descifrados, ídem
  attachments.ts         elegir una foto y describirla; las miniaturas
  matrixViewModel.ts     AlloRoomSummary → Conversation, AlloTimelineItem → Message
lib/matrix/
  directMessage.ts       cuándo crear una conversación es reutilizar una
  store.native.ts        dos directorios, y cómo borrarlos
  store.web.ts           una base de IndexedDB, y cómo borrarla
  readReceipts.ts        de «quién tiene recibo aquí» a «alguien ha leído esto»
  native/media.ts        `MessageType` → `AlloMediaContent`, y los records de subida
  web/attachments.ts     cifrar o negarse, y el contenido del evento
  web/mediaTransfer.ts   fetch, la máquina de cripto y los object URL
hooks/
  useMatrixRuntime.ts       useSyncExternalStore sobre el runtime
  useMatrixConversations.ts → Conversation[] | undefined
  useMatrixTimeline.ts      → { messages, loadOlder, send, … } | undefined
  useMatrixMedia.ts         → { url(ref) } | undefined, para `getMediaUrl`
  useMatrixEventLabels.ts   las palabras de los eventos que no tienen ninguna
components/matrix/
  MatrixSignInGate.tsx      pinta a sus hijos salvo que falte sesión
```

**Un dispositivo Matrix por instalación.** Un login acuña un dispositivo, y de
ese dispositivo cuelgan unas claves de cifrado; una app que hace login en cada
arranque llena la cuenta de dispositivos que nadie puede verificar y que no leen
el historial de los demás. Lo que lo evita son dos hechos, ambos en
`matrixRuntime.ts`:

- **la sesión guardada manda.** El almacén en disco pertenece a la sesión que hay
  en el llavero y a ninguna otra, así que un arranque que no encuentra sesión
  borra el almacén *antes* de abrirlo. Eso hace que todas las formas de perder
  una sesión —un cierre de sesión, un cierre a medias, un registro de una versión
  vieja de Allo— terminen en el mismo estado limpio.
- **la sesión no es una foto.** El SDK rota sus tokens por su cuenta, así que lo
  que se escribió en el login caduca en menos de una hora. `observeSession` es
  cómo el puerto lo cuenta —delegado del constructor en nativo, callback del
  `TokenRefresher` en web— y el runtime está suscrito mientras el cliente viva.

**Ningún componente de presentación cambió.** `MessageBubble`, `MessageBlock`,
`DaySeparator`, las filas de la lista, el layout de tres paneles y los temas por
conversación siguen recibiendo `Conversation` y `Message`. `Conversation` ganó un
campo opcional —`isInvitation`, que sólo el camino de Matrix rellena— y ningún
componente lo lee todavía. Lo único que cambia es de dónde salen los datos, y en
cada punto de conexión la rama vieja es la expresión que ya estaba:

```ts
const conversations = roomConversations ?? storedConversations;
const messages = matrixTimeline?.messages ?? storedMessages;
```

Los hooks devuelven `undefined` —no una lista vacía— cuando la bandera está
apagada, que es lo que hace que el `??` sea suficiente.

**Sin `useEffect` para nada de esto.** El cliente con su bucle de sync sí es
sincronización con un sistema externo, que es el caso legítimo, pero pertenece a
la *app* y no a la pantalla que se montó primero: un Effect lo ataría al ciclo de
vida de un componente, y desmontar la lista pararía el sync. Vive en
`matrixRuntime.ts` a nivel de módulo y React lo lee con `useSyncExternalStore`.
Suscribirse es lo que lo arranca, así que ninguna pantalla tiene que acordarse de
encenderlo.

## 4. Qué llega a la pantalla hoy

- Lista de conversaciones, en el orden que da el puerto (no se reordena aquí),
  **con vista previa del último mensaje y su hora**. La hora sale del mensaje y
  no de un campo aparte: son el mismo hecho visto dos veces, y una fila no puede
  enseñar honestamente una sin la otra. Una sala cuyo último mensaje este
  dispositivo no conoce se queda sin texto y sin hora, que es lo que el
  formateador dibuja como nada.
- Timeline de una conversación, con paginación hacia atrás al llegar arriba.
- Envío de texto.
- **Crear una conversación**, en el puerto (`createRoom`). Siempre privada, sólo
  por invitación y cifrada; un mensaje directo con un solo invitado reutiliza la
  sala que ya existe con esa persona en vez de acuñar una segunda. Ninguna
  pantalla lo llama todavía.
- Login OIDC en tres pasos, con `expo-web-browser`.
- **Sesión persistida**: el segundo arranque no pasa por el navegador. Se guarda
  en el llavero del móvil (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, para que una
  restauración de iCloud no lleve la sesión a un teléfono donde no están las
  claves) y en `localStorage` en web.
- **Cerrar sesión**, desde Ajustes. Avisa al homeserver, y borre o no borre el
  homeserver, se lleva la sesión guardada, el almacén de estado y el de cripto.
- Estados propios para los eventos sin texto: no descifrable, redactado, y
  «Allo no sabe dibujar esto todavía». Ninguno se pinta como una burbuja vacía,
  y la vista previa de la lista usa las mismas palabras: una conversación cuyo
  último mensaje no se puede leer aquí lo dice, en vez de quedarse en blanco y
  parecer una conversación en la que nadie ha escrito.
- **Reacciones**, poner y quitar, desde la barra de emoji del menú de acciones.
  Una sola llamada para los dos sentidos: cuál de los dos es depende de si esta
  cuenta ya anotó el evento, y eso lo sabe el SDK y no un snapshot de la
  pantalla.
- **Edición y borrado** de los mensajes propios. El borrado es una redacción, y
  una redacción no borra la fila: deja el esqueleto —quién y cuándo— en pie aquí
  y en todos los demás clientes, y la fila se pone a dibujarse como borrada. El
  compositor tiene un segundo modo, con una barra encima para cancelarlo.
- **Recibos de lectura**, en las dos direcciones: se envían mientras la
  conversación está en pantalla y el segundo tick aparece cuando alguien que no
  es quien lo envió ha leído. Un recibo de Matrix nombra un evento y cubre todos
  los anteriores, así que la respuesta por fila sale de recorrer el timeline
  hacia atrás (`lib/matrix/readReceipts.ts`) y no de preguntar por cada mensaje.
- **Indicador de escribiendo**, también en las dos direcciones, y por el
  homeserver: a diferencia del camino viejo, existe fuera de la web.
- **Un envío fallido se dibuja como error** y no como el reloj.
- **Una invitación se distingue de una conversación** (`membership` en el
  resumen, `Conversation.isInvitation` en la pantalla). Qué hacer con el dato es
  de la UI, y hoy no hace nada distinto: ver §5.
- **Adjuntos: fotos, vídeos y notas de voz.** Se eligen del carrete o de la
  cámara, se envían y se reciben. Es la única de estas líneas que no es una
  migración: en Allo la media nunca funcionó, porque el backend de Express nunca
  tuvo endpoint de subida. Ver §7.

## 5. Qué no llega, y por qué

Por orden de cuánto se nota:

1. **El tamaño de letra por mensaje no viaja.** `AlloTimelineHandle.sendText`
   manda un cuerpo y nada más; `so.oxy.allo.font_size` (§4.2 de
   `data-model.md`) necesita una llamada que el puerto no tiene.
2. **Nada reintenta un envío fallido.** Se ve que falló, y no hay forma de
   volver a intentarlo desde la burbuja; en móvil la cola del SDK ya no lo está
   intentando y en web nunca hubo cola. Reenviarlo es escribirlo otra vez.
3. **Las reacciones no se ven en la burbuja.** Se pueden poner y quitar, y el
   toggle sabe cuáles son las tuyas, pero nada las dibuja debajo del mensaje.
   No es un hueco del puerto: `Message.reactions` existe desde antes que él y
   ningún backend de Allo las ha pintado nunca. Hacerlo es UI nueva para los dos
   caminos, no cableado de éste.
4. **Nadie llama a `createRoom`.** El puerto sabe crear una conversación; no hay
   pantalla que lo pida, así que en la app sigue sin poder empezarse un chat
   nuevo por el camino de Matrix.
5. **Una sesión revocada desde fuera no se nota hasta el siguiente arranque.** Si
   el usuario borra este dispositivo desde otro cliente, el sync empieza a fallar
   y la app lo dibuja como un error de sincronización, no como «te han cerrado la
   sesión». El binding lo cuenta (`ClientDelegate.didReceiveAuthError`) y
   `matrix-js-sdk` también (`HttpApiEvent.SessionLoggedOut`); el puerto no expone
   ninguno de los dos todavía. El camino de vuelta existe —cerrar sesión desde
   Ajustes— pero hay que saber que hace falta.
6. **Una invitación se distingue pero se pinta igual.** El resumen dice cuál lo
   es (`membership`) y `Conversation.isInvitation` lo lleva hasta la pantalla,
   que todavía no hace nada distinto con él: la fila se dibuja como cualquier
   otra y abrirla no da timeline. Aceptar o rechazar tampoco existe — el puerto
   no expone ninguna de las dos.
7. **Un adjunto no se puede abrir a tamaño completo.** La burbuja dibuja la
   miniatura y `handleMediaPress` sigue vacío, así que del original sólo se baja
   lo que la miniatura no cubre: nada. El visor es UI nueva para los dos
   caminos, no cableado de éste.
8. **Una nota de voz se envía y no se escucha.** Llega como `m.audio` con su
   duración y otros clientes la reproducen; aquí la fila dice que hay un
   adjunto. Falta el reproductor, no el transporte.
9. **Un vídeo grabado en Allo va sin miniatura.** `expo-image-manipulator` lee
   imágenes, no fotogramas, así que sacar el primero necesita una dependencia
   nativa más. Un vídeo de otro cliente suele traer la suya y ésa sí se dibuja.
10. **Documentos, ubicación, contacto y encuesta** siguen sin implementar en
    `AttachmentMenu`. El puerto ya sabe enviar un `m.file`; lo que falta es el
    selector y, para los tres últimos, decidir qué se envía.

## 6. Web

El redirect de OIDC apunta a `public/matrix-oidc-callback.html`, un fichero
estático que **no** es una ruta de la app. El export web responde `index.html` a
las rutas desconocidas (`public/_redirects`), así que un redirect a una ruta de
la app arrancaría una segunda copia de Allo dentro del popup — y dos copias son
dos `MatrixClient` sobre un IndexedDB, que es la corrupción del almacén de cripto
que avisa el SDK. Sigue en pie lo que dice `client.web.ts`: Allo en web es segura
en una pestaña y no está probada en dos.

La sesión vive en `localStorage`, no en un llavero, porque un navegador no tiene
ninguno: lo que la protege es el origen, la misma protección de la que ya depende
el almacén de cripto en IndexedDB. Un navegador que lo niega —modo privado, algún
webview— se rechaza al primer intento de leerla, igual que el puerto ya rechaza
uno sin IndexedDB, y por la misma razón: la alternativa es hacer login en cada
arranque y acuñar un dispositivo cada vez.

Al cerrar sesión se borran las tres bases: el estado sincronizado y las dos del
motor de cripto. Una que quede de un cierre de sesión interrumpido sólo ocupa
sitio —lleva el id del dispositivo en el nombre, así que la sesión siguiente no
puede abrirla— y se barre en el arranque siguiente si el navegador ofrece
`indexedDB.databases()`, que Firefox no tuvo hasta la 126.

## 7. Adjuntos

No es una migración. **En Allo la media nunca ha funcionado**: los seis
manejadores de `AttachmentMenu` eran stubs vacíos, `onRecordEnd` un TODO, y el
backend de Express nunca tuvo endpoint de subida. Así que no hay compatibilidad
que mantener, y tampoco hay que construir un servidor de ficheros: el homeserver
trae el suyo.

### 7.1 Dónde viven los bytes

Un adjunto son dos cosas que llegan por separado: un evento en la sala, que es
lo que trae el timeline, y unos bytes en el repositorio de media del homeserver,
que se piden aparte. **En una sala cifrada el cliente que envía cifra los bytes
antes de subirlos**, así que el servidor guarda un blob opaco y la clave viaja
dentro del evento cifrado — la misma protección que ya tenía el cuerpo del
mensaje.

De ahí sale la forma de `AlloMediaRef`: es **opaco**, y sobre todo **no es una
URL**. Una URL sugiere algo que una vista puede pedir, y en una sala cifrada eso
es justo lo que no vale: lo que sirve el homeserver en esa dirección es texto
cifrado, y un `<Image>` apuntado ahí dibuja una imagen rota.
`AlloChatClient.downloadMedia` es el único camino de un ref a algo que se pueda
pintar.

### 7.2 El cifrado, y por qué la mitad web tiene un módulo entero para él

Las dos mitades del puerto llegan al mismo sitio por caminos muy distintos, y la
asimetría es la razón de casi todo el código:

- **Nativo.** `Timeline.sendImage` y sus hermanas leen el estado de cifrado de la
  sala dentro de Rust, cifran si toca, suben y envían el evento. No hay parámetro
  que pasar mal ni camino en claro al que caerse.
- **Web.** `matrix-js-sdk` no tiene equivalente. `uploadContent()` sube lo que le
  den a una URL pública y `sendMessage()` mete un `m.image` con `url` en claro en
  una sala cifrada sin decir nada: no avisa, no falla, el cuerpo del evento sigue
  cifrado y la burbuja es idéntica. La única diferencia es que la foto la puede
  leer cualquiera que tenga el mxc.

Por eso en web todo pasa por `resolveAttachmentSource`
(`lib/matrix/web/attachments.ts`), que decide desde el estado de la sala y de
nada más:

| Estado de la sala | Qué hace |
|---|---|
| `encrypted` | cifra, sube el texto cifrado, y envía un `file` |
| `unencrypted` | sube tal cual y envía un `url` |
| `unknown` | **se niega** (`MatrixMediaEncryptionUnknownError`) |

El tercero es el que importa. `unknown` es el estado normal de una sala que el
sync todavía no ha entregado, y las dos formas de adivinar fallan con tamaños
distintos: adivinar *cifrada* cuesta un envío fallido; adivinar *sin cifrar*
deja una fotografía en claro en el homeserver y no hay nada en pantalla que se
vea distinto. Reintentar en un momento es una recuperación que el usuario
entiende.

`AlloOutgoingAttachment` **no tiene un campo para pedir texto plano**, y eso es
una decisión: un booleano ahí sería la vía por la que una pantalla, un refactor
o un argumento por defecto apagan el cifrado.

Lo que lo sostiene son dos pruebas. `web/attachments.test.ts` mira **los bytes
que llegan al uploader**, no qué función se llamó — una implementación que cifra
y luego sube el original pasaría un test de «se llamó a `encrypt()`» y filtraría
la foto igual. Y `web/onePlaceUploads.test.ts` cubre lo que las unitarias no
pueden: que no aparezca un **segundo** camino de subida, que es lo que hará la
próxima persona que añada un selector de documentos o un avatar. Sigue el patrón
de `recovery/noSilentReset.test.ts`.

### 7.3 De un ref a un píxel

`MediaCarousel` no cambió. Pide la URL de forma **síncrona** durante el render,
con `getMediaUrl(id, kind)`, y conseguir una es una descarga y un descifrado. La
respuesta sale por tanto de `lib/chat/mediaCache.ts`, un external store con la
misma forma que `roomListSource` y `timelineSource`.

**Pedir una URL es lo que arranca la descarga.** `url(ref)` se llama en render;
si no la tiene, programa la petición y contesta `undefined`; la fila dibuja
nada, la descarga termina, el store notifica y la fila dibuja la foto. Hacerlo
desde un Effect sería un Effect por adjunto visible cuyo único trabajo es pedir
algo que el render ya sabe que necesita. El read es idempotente y deduplicado
—veinte filas pidiendo el mismo ref hacen una descarga— que es lo que lo hace
seguro desde render.

La caché está **acotada**, y no por rendimiento: cada entrada es una copia
descifrada de una foto de una conversación cifrada — un object URL que fija los
bytes en la pestaña, o un fichero en claro en el directorio de caché del móvil.
Al desalojar una se libera, y al cambiar de cuenta o cerrar sesión se liberan
todas.

En la burbuja **la miniatura del emisor gana al original**: 250pt no piden una
foto de 12 Mpx, y en una sala cifrada la del emisor es la única copia pequeña
que existe, porque un homeserver no puede redimensionar lo que no puede leer.
Allo genera la suya a 1024px al enviar.

**`utils/mediaVariant.ts` no interviene.** Resuelve variantes de renderizado de
Oxy Cloud, que es de donde vienen los avatares; un adjunto de mensaje va al
repositorio del homeserver y ninguno de los dos servidores entiende los
identificadores del otro. Los dos caminos conviven detrás de `getMediaUrl` y
sólo se elige uno.

### 7.4 La nota de voz

Se envía como `m.audio` con su duración real y el marcador MSC3245 que la
distingue de un fichero de audio. **Sin forma de onda**, y a propósito: el
grabador de Allo no muestrea amplitudes, y una forma de onda inventada es un
dibujo de un audio que nadie midió. Por eso tampoco se usa `sendVoiceMessage` en
nativo, que la exige.
