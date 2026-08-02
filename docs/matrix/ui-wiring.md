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
  attachments.ts         elegir una foto, un vídeo o un fichero, y describirlo
  attachmentViewer.ts    qué contiene la galería del visor y por dónde se abre
  matrixViewModel.ts     AlloRoomSummary → Conversation, AlloTimelineItem → Message
  newConversation.ts     lo que las dos mitades del alta comparten (§8)
  matrixConversations.ts crear una sala: MXIDs, y esperar a que sync la traiga
  alloApiConversations.ts crear una conversación en Express, y mapear su respuesta
  matrixIdentity.ts      id de Oxy → MXID, y por qué es aritmética
  invitations.ts         aceptar o rechazar una invitación
lib/matrix/
  directMessage.ts       cuándo crear una conversación es reutilizar una
  roomCreation.ts        qué es toda sala que Allo crea, antes de cada SDK
  native/createRoom.ts   los parámetros del binding, con `isEncrypted` a la vista
  web/createRoom.ts      las opciones de matrix-js-sdk, con el evento de cifrado
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
  useCreateConversation.ts  la costura del alta: gente dentro, un id fuera
components/matrix/
  MatrixSignInGate.tsx      pinta a sus hijos salvo que falte sesión
  MatrixInvitationCard.tsx  una invitación, y las dos respuestas que admite
```

Lo que dibuja un adjunto —el visor, el reproductor, la fila de un documento— no
está en esta lista y no es de Matrix: vive en `components/media/` y
`components/messages/`, y se alimenta de `Message`. Ver §9.

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

**El vocabulario no cambió: `Conversation` y `Message`.** `MessageBubble`,
`DaySeparator`, las filas de la lista, el layout de tres paneles y los temas por
conversación siguen recibiendo tal cual, y lo único que cambia es de dónde
salen. Los tres tipos han ganado campos opcionales, y todos siguen la misma
regla: son hechos sobre una conversación o un mensaje, no sobre un backend, y el
camino de Express simplemente no los rellena.

- `Conversation.isInvitation` — sólo lo pone Matrix, y lo lee un solo sitio: la
  rama de Matrix de la ruta `/c/:id` (§8.4). Ninguna fila de la lista lo mira
  todavía.
- `MediaItem.fullSizeId` y `MediaItem.filename` — el original detrás de la
  miniatura, para el visor (§7.3).
- `Message.attachment` — un adjunto que ningún carrusel puede dibujar: una nota
  de voz, un audio, un documento (§9).

El único componente de presentación que cambió es `MessageBlock`, que ha ganado
un prop (`getAttachmentUrl`) y dibuja esas tres filas nuevas. En cada punto de
conexión la rama vieja sigue siendo la expresión que ya estaba:

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
- **Crear una conversación, desde la pantalla de siempre** (`app/(chat)/new.tsx`),
  directa y de grupo. Siempre privada, sólo por invitación y **cifrada**; un
  mensaje directo con un solo invitado reutiliza la sala que ya existe con esa
  persona en vez de acuñar una segunda. Ver §8.
- **Aceptar o rechazar una invitación**. Una sala a la que a uno le han invitado
  no es una conversación todavía —no tiene timeline que leer— y así se dibuja:
  abrirla ofrece unirse o rechazar, y no un compositor que escribiría en una sala
  en la que esta cuenta no está. Es como empieza un grupo para todos los que no
  lo crearon.
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
  resumen, `Conversation.isInvitation` en la pantalla), y abrirla lleva a las dos
  respuestas que admite. La fila de la lista todavía se dibuja igual: ver §5.
- **Adjuntos: fotos, vídeos, notas de voz y documentos.** Se eligen del carrete,
  de la cámara o del selector de ficheros, se envían y se reciben. Es la única
  de estas líneas que no es una migración: en Allo la media nunca funcionó,
  porque el backend de Express nunca tuvo endpoint de subida. Ver §7.
- **Un adjunto se abre a tamaño completo**, con zoom de pellizco, arrastrar para
  cerrar y compartir o guardar. El visor no es de Matrix: se alimenta de
  `Message.media`, que rellenan los dos backends. Ver §9.
- **Una nota de voz se escucha**, con play, pausa, barra arrastrable y duración.
  Sin forma de onda, y a propósito: §7.4.
- **Un documento se abre**, en la app que el sistema tenga para él.
- **Un vídeo grabado en Allo va con su miniatura**, sacada del primer fotograma
  en iOS y Android. En web sigue yendo sin ella. Ver §9.4.

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
4. **Una conversación nueva no se puede nombrar después, ni cambiar de gente.**
   El nombre del grupo se escribe al crearlo y ahí se queda: no hay pantalla de
   ajustes de sala, ni forma de invitar a alguien más, ni de salirse de un grupo
   al que uno pertenece. Rechazar una invitación es lo único parecido a salir, y
   sólo vale antes de entrar.
5. **Una sesión revocada desde fuera no se nota hasta el siguiente arranque.** Si
   el usuario borra este dispositivo desde otro cliente, el sync empieza a fallar
   y la app lo dibuja como un error de sincronización, no como «te han cerrado la
   sesión». El binding lo cuenta (`ClientDelegate.didReceiveAuthError`) y
   `matrix-js-sdk` también (`HttpApiEvent.SessionLoggedOut`); el puerto no expone
   ninguno de los dos todavía. El camino de vuelta existe —cerrar sesión desde
   Ajustes— pero hay que saber que hace falta.
6. **La fila de una invitación se pinta como cualquier otra.** Abrirla ya ofrece
   unirse o rechazar (§8.4), pero en la lista no hay nada que diga que lo es: sin
   vista previa y sin hora, parece una conversación en la que nadie ha escrito.
   `Conversation.isInvitation` llega hasta esa fila y la fila no lo lee.
7. **Ubicación, contacto y encuesta** siguen sin implementar, y por eso
   `AttachmentMenu` **ya no los dibuja**: un manejador ausente quita la casilla,
   porque un botón que abre, cierra la hoja y no hace nada parece un fallo de la
   función y no su ausencia. No es cableado lo que falta: hay que decidir qué se
   envía en cada caso — `m.location` está en la especificación y el puerto no lo
   traduce, una tarjeta de contacto no tiene tipo de evento ninguno, y una
   encuesta es MSC3381.
8. **Una nota de voz no dibuja su forma de onda**, ni la propia ni la ajena.
   Ver §7.4: la propia no existe porque el grabador de Allo no muestrea
   amplitudes, y la ajena —MSC3246, que Element sí manda— llega al homeserver
   pero no al puerto, porque `AlloMediaContent` no tiene ese campo. Ensancharlo
   toca `types.ts` y las dos mitades.
9. **Un vídeo grabado en Allo va sin miniatura en web.** En iOS y Android sí la
   lleva (§9.4); `expo-video` no sabe sacar fotogramas en un navegador y
   hacerlo a mano es un `<video>` oculto, un `<canvas>` y un `seek` que resuelve
   distinto en cada uno. Un vídeo de otro cliente suele traer la suya y ésa se
   dibuja en los tres sitios.
10. **El visor no reordena ni recarga.** La galería es una foto fija del momento
    en que se abrió, así que un adjunto que llega mientras está abierto no
    aparece hasta cerrarlo y volver a abrirlo. Es deliberado —una galería que
    crece por debajo mueve la foto que se está mirando— y el precio es ése.

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

Esta sección es el **transporte**: cómo salen y entran los bytes. Lo que se hace
con ellos una vez dentro —el visor, el reproductor, la fila de un documento— es
la §9, y está separada porque no es de Matrix: se alimenta de `Message.media` y
`Message.attachment`, que rellenan los dos backends.

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

Elegirla tenía un precio que hasta ahora se pagaba entero: **el ref del original
se perdía**. `MediaItem` sólo llevaba un id, así que en cuanto la fila decidía
dibujar la miniatura no quedaba nada en la pantalla que supiera dónde estaba la
foto de verdad — y ésa es la razón de fondo por la que tocar un adjunto no hacía
nada. `MediaItem.fullSizeId` es lo que arregla eso: sólo se rellena cuando el
emisor hizo miniatura, para que un `fullSizeId` presente signifique siempre
«esta fila está dibujando una copia pequeña» y no haga bajar dos veces los
mismos bytes.

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

Al recibir tampoco hay forma de onda, y ahí la razón es otra: la que manda
Element (MSC3246, `org.matrix.msc3246.audio.waveform`) llega al evento pero no
al puerto, porque `AlloMediaContent` no tiene ese campo. Dibujar barras sacadas
de cualquier otra cosa —del tamaño del fichero, de un ruido— sería el mismo
dibujo inventado, así que `VoiceNoteBubble` pinta una barra de progreso lisa, que
es honesta sobre lo que se sabe: cuánto dura y por dónde va.

### 7.5 El documento

`AttachmentMenu` abre `expo-document-picker` y lo que sale va por el mismo
`sendAttachment` que una foto, con `kind: 'file'` — es decir, por
`resolveAttachmentSource` en web y por `Timeline.sendFile` en nativo. No hay
segundo camino de subida, que es justo lo que vigila
`web/onePlaceUploads.test.ts` (§7.2) y lo que ese test decía que haría «la
próxima persona que añada un selector de documentos».

`copyToCacheDirectory` se deja encendido y no es un ajuste de rendimiento: en
Android el selector devuelve un `content://` de la app que lo sirvió, y eso no es
una ruta que el SDK de Rust pueda abrir después, en otro hilo. La copia que hace
el selector está en el directorio de caché de Allo y sí lo es.

## 8. Empezar una conversación

`app/(chat)/new.tsx` es la pantalla de siempre y busca gente donde siempre: en
los perfiles de Oxy. Lo único que cambió es a quién le pide la conversación.

### 8.1 Una costura, no dos pantallas

```ts
const createConversation = useCreateConversation();
const id = await createConversation({ participantIds, name });
router.replace(`/c/${id}`);
```

`useCreateConversation` es donde la bandera elige, y es lo único que elige: la
pantalla no sabe si al otro lado hay un documento de Mongo o una sala cifrada en
un homeserver, y no tiene ninguna rama que lo pregunte. El tipo de la costura —
`ConversationCreator` en `lib/chat/newConversation.ts` — es toda la promesa:
gente dentro, un id de conversación fuera.

Lo que **no** está en la costura, porque las dos mitades no lo comparten:
`alloApiConversations.ts` escribe la conversación nueva en el store de Zustand
que dibuja la lista, y `matrixConversations.ts` no escribe en ninguna parte. La
lista de Matrix la alimenta el sync y nada más; una fila metida a mano ahí sería
una segunda fuente de verdad para la misma conversación, y la equivocada.

`planConversation` es lo que sí comparten, y es una decisión por sitio en vez de
dos: **una persona es un mensaje directo, dos o más son un grupo**, un grupo se
llama como lo llamó quien lo creó y un directo no se llama de ninguna manera. En
Matrix esa diferencia es permanente — `m.direct` es lo que hace que todo cliente
dibuje una conversación de dos con la cara del otro y no con un título generado —
así que dejar que cada mitad la decidiera por su cuenta es cómo el mismo botón
acaba creando cosas distintas en cada backend.

### 8.2 A quién se invita

Una pantalla de Allo conoce a la gente por su id de Oxy; un homeserver no conoce
a nadie por ese nombre. `lib/chat/matrixIdentity.ts` es esa traducción, y es
**aritmética de cadenas**: `@{oxyUserId}:{serverName}`, como pide §6.2 de
`data-model.md` — el localpart del MXID se deriva del `sub` de Oxy en MAS,
precisamente para que no haga falta una tabla con sus huérfanos y sus colisiones.

Dos detalles que no son de estilo:

- **El nombre del servidor sale del MXID del propio usuario**, no de una variable
  de entorno. `EXPO_PUBLIC_MATRIX_HOMESERVER` es una URL, que no es un nombre de
  servidor (`https://matrix-client.matrix.org` sirve a `matrix.org`), y una
  variable con el nombre sería una cosa más que puede contradecir a la cuenta con
  la que la app está dentro. La sesión no puede contradecirse a sí misma.
- **Un id que no encaja se rechaza, no se arregla.** Un localpart admite `a-z`,
  `0-9` y `._=-/+`; la reparación obvia —minúsculas y tirar el resto— es cómo dos
  personas distintas acaban compartiendo un MXID, que aquí es una invitación
  enviada a quien no era. El backend hace la misma aritmética en
  `services/bridges/matrixIdentity.ts` y se niega por la misma razón.

### 8.3 Cifrada, y no por convenio

Ninguna sala que Allo cree puede salir sin cifrar, y no porque nadie vaya a
escribir el parámetro mal: **no hay parámetro**. `AlloCreateRoomRequest` no tiene
campo para pedirlo, `native/createRoom.ts` escribe `isEncrypted: true` desde un
literal y `web/createRoom.ts` mete el `m.room.encryption` en `initial_state`
desde constantes. El cifrado en Matrix es de ida y no de vuelta: una sala creada
en claro no se puede cifrar después, así que una familia con una conversación mal
creada la tiene mal creada para siempre, y no hay nada en pantalla que se vea
distinto.

Lo que lo sostiene son tres pruebas, y las tres leen datos en vez de llamadas:

- `__tests__/matrix/nativeCreateRoom.test.ts` y `web/createRoom.test.ts` miran
  **los parámetros que llegan al SDK**, para cada forma de petición que existe.
- `__tests__/matrix/encryptedRooms.test.ts` cubre lo que las unitarias no pueden:
  que no aparezca un **segundo** sitio donde se cree una sala, que es lo que hará
  la próxima persona que añada un canal o una sala de notas. Sigue el patrón de
  `web/onePlaceUploads.test.ts`.
- `__tests__/matrix/portBoundary.test.ts` comprueba que ningún SDK de Matrix se
  importa fuera de `lib/matrix/`.

### 8.4 La invitación

Crear un grupo invita a su gente, y una invitación no es una conversación: no
tiene timeline que leer hasta que se acepta. `MatrixConversationRoute` lo dibuja
como lo que es —`MatrixInvitationCard`, con unirse o rechazar— en vez de un
compositor que escribiría en una sala donde esta cuenta no está.

Aceptar no navega a ningún sitio: cambia la pertenencia en el homeserver, el sync
lo cuenta, la lista deja de llamarlo invitación y la ruta pasa a dibujar la
conversación. Rechazar sí navega, porque después de salirse la sala ya no existe
para este usuario y la ruta no nombra nada.

**Unirse no hace legible lo anterior.** Las claves de los mensajes de antes se
compartieron con los dispositivos que estaban en la sala entonces, y éste no
estaba. Lo que llegue a partir de ahora sí, que es lo que espera todo el mundo de
alguien a quien acaban de dejar entrar.

### 8.5 Esperar a que la sala llegue

`createRoom` responde con un id de sala **antes** de que el sync la haya
entregado, y el puerto lo dice en su contrato. Navegar ahí directamente abre una
conversación de la que este cliente no sabe nada: sin nombre —el id de sala hace
de título—, sin miembros y con un timeline que ni siquiera se puede abrir, porque
`openTimeline` no encuentra la sala.

Así que `matrixConversations.ts` se suscribe a la lista y espera a que aparezca,
con un tope de 15 segundos. **Si se agota, navega igual y lo avisa por el log**:
la sala existe, las invitaciones ya salieron y las demás personas ya la ven;
negarse a abrirla porque el sync de este dispositivo va lento sería contar un
fallo que no ha ocurrido.

Lo segundo que hacía falta para eso está en `timelineSource.ts`: un `openTimeline`
que falla ya no deja el timeline «abriéndose» para siempre. Antes, un intento
pendiente era justo lo que impedía el siguiente, así que el primer fallo era lo
último que esa conversación hacía — un spinner hasta que la app se cerrara.
## 9. Lo que se hace con un adjunto una vez está aquí

La §7 termina cuando los bytes están descargados y descifrados. Todo lo de aquí
empieza ahí, y **nada de ello es de Matrix**: el visor, el reproductor y la fila
de un documento leen `Message.media` y `Message.attachment`, que rellenan los dos
backends, y piden sus URL al resolver que `ConversationView` ya reconcilia. Un
`import` de `CHAT_BACKEND` en cualquiera de estos ficheros sería el principio de
un segundo visor.

```
lib/chat/
  attachmentViewer.ts       qué contiene la galería y por dónde se abre
components/media/
  AttachmentViewer.tsx      el modal, el pager y los gestos
  AttachmentViewerVideo.tsx un vídeo con los controles del sistema
  zoom.ts                   pellizco, arrastre y descarte, como aritmética
  pager.ts                  dónde cae un swipe, y qué páginas se construyen
  shareAttachment.*.ts      compartir en móvil, descargar en navegador
components/messages/
  VoiceNoteBubble.tsx       play, pausa, barra arrastrable, duración
  FileBubble.tsx            nombre, tamaño, y abrir
  attachmentFormat.ts       el reloj, la fracción, el tamaño de fichero
```

### 9.1 El visor

La galería es **toda la conversación**, no el mensaje que se tocó: un evento de
Matrix lleva un adjunto, así que cinco fotos son cinco mensajes y un visor
construido a partir de uno solo no se podría deslizar. Por dónde se abre lo
decide `selectViewerItem`, a partir del par mensaje + media — el mismo fichero
enviado dos veces tiene el mismo id de media dos veces, y la clave de página lleva
la longitud del id de mensaje por delante para que ningún par pueda colisionar
con otro.

**Sólo se construyen tres páginas**: la que está en pantalla y sus dos vecinas.
No es una optimización. Pedir la URL de una página es lo que arranca su descarga
(§7.3), así que un visor que construyera todas bajaría y descifraría todos los
adjuntos de la conversación en cuanto alguien tocara uno. Es un test
(`__tests__/media/pager.test.ts`), no un comentario.

Debajo de la foto grande se dibuja **la miniatura que la burbuja ya tenía**
mientras baja el original: está descargada y descifrada, y sin ella el visor se
abre en negro tanto como tarde una foto de 12 Mpx por una conexión que no eligió
el usuario.

El pager **no es un `ScrollView`**. Un scroll nativo dentro de un `Modal`,
envolviendo una vista que además quiere pellizco y arrastre, es una negociación
de gestos que se resuelve distinto en cada plataforma; llevar la traslación a
mano deja todo en una sola composición de `react-native-gesture-handler` y
convierte «dónde cae un swipe» en aritmética, que es lo que se puede probar.

El estado se reinicia **remontando**: `ConversationView` le pone al elemento una
`key` derivada de lo que se tocó, así que tocar una segunda foto construye un
segundo visor en vez de empujarle un índice nuevo desde un Effect.

### 9.2 Guardar y compartir

En móvil es `expo-sharing`, y la hoja del sistema es las dos cosas a la vez:
*Guardar imagen* y *Guardar en Archivos* están dentro. La alternativa,
`expo-media-library`, compra uno de esos destinos a cambio de pedir permiso de
escritura sobre todo el carrete. En web es una descarga: la Web Share API sólo
lleva ficheros en Safari de iOS y Chrome de Android, y en un escritorio no ofrece
nada.

**No se copia nada.** Lo que se comparte es el URI que la caché de media ya
tiene —el fichero descifrado en el directorio de caché, o el object URL de la
pestaña—, que es lo que ella libera al desalojarlo, al cambiar de cuenta y al
cerrar sesión. Escribir una segunda copia en un sitio más cómodo sería una foto
en claro de una conversación cifrada sobreviviendo a la sesión que podía leerla.
Por lo mismo el `<Image>` del visor va con `cachePolicy="memory"`: la caché de
disco de `expo-image` escribiría una copia donde nadie la libera.

El plugin de configuración de `expo-sharing` **no** se añade a `app.config.js`.
Ese plugin monta una *share extension* de iOS —recibir ficheros de otras apps—,
que es lo contrario de lo que se usa aquí y una entitlement que no hace falta.

### 9.3 El reproductor

`useAudioPlayer` de `expo-audio`, con un solo Effect y una razón concreta:
**nada se descarga hasta que se pulsa play**. Los bytes de una nota de voz son la
grabación entera, no una miniatura, así que una pantalla llena de notas que se
descargaran solas gastaría los datos de otro para dibujar una fila que es un
botón de todas formas. Pero eso significa que la pulsación llega cuando todavía
no hay nada que reproducir, y el momento en que sí lo hay es del reproductor y no
de React. El Effect es de un solo disparo —se atiende y se limpia— para que no
vuelva a arrancar cuando la reproducción termine sola.

La duración que se enseña sale de `displayDurationMs`: gana la que midió el
reproductor, porque leyó los bytes que hay; y mientras no haya bytes vale la del
evento, que es lo único que existe antes de la primera pulsación. Un reproductor
que contesta 0 cuenta como que no sabe, no como que dura cero.

`FileBubble` repite exactamente el mismo patrón por la misma razón: un documento
pesa lo que su emisor quiso, y una fila que se bajara sola 40 MB al pasar por
delante es peor que una que espera a que la toquen.

### 9.4 La miniatura de un vídeo

**Sin dependencia nueva.** `expo-image-manipulator` lee imágenes y no fotogramas,
que era el motivo de que un vídeo fuera sin miniatura; pero `expo-video` —que ya
estaba, ya es plugin en `app.config.js` y ya es lo que los reproduce— saca un
fotograma con `generateThumbnailsAsync`, y lo que devuelve es un
`SharedRef<'image'>`, que es justo lo que `ImageManipulator.manipulate` acepta.
Un decode y el mismo resize que ya existía dan el JPEG que quiere el puerto.

Se pide el fotograma del segundo 0. Algunos codificadores ponen ahí un negro o un
fundido, y buscar más adelante cuesta decodificar todo lo anterior y elige un
fotograma que tampoco escogió quien grabó.

En web `generateThumbnailsAsync` lanza, el `catch` se lo come y el vídeo sale sin
miniatura — que es lo que pasaba en las tres plataformas antes de esto. El
reproductor de un navegador no extrae fotogramas, y hacerlo a mano es un
`<video>` oculto, un `<canvas>` y un `seek` que resuelve distinto en cada uno.

### 9.5 Los dos colores que no son del tema

`AttachmentViewer` y `AttachmentViewerVideo` usan `#000000` de fondo y `#FFFFFF`
de primer plano, y es la única excepción a «nunca colores a mano» en toda la app.
Un visor es una habitación a oscuras: el fondo es negro opaco en los dos temas
porque lo que se quiere es que no haya nada iluminado salvo la foto, y sobre negro
el único primer plano legible es blanco. Un color del tema ahí sería oscuro sobre
oscuro la mitad de las veces.
