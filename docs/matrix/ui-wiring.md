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
  matrixViewModel.ts     AlloRoomSummary → Conversation, AlloTimelineItem → Message
lib/matrix/
  directMessage.ts       cuándo crear una conversación es reutilizar una
  store.native.ts        dos directorios, y cómo borrarlos
  store.web.ts           una base de IndexedDB, y cómo borrarla
  readReceipts.ts        de «quién tiene recibo aquí» a «alguien ha leído esto»
hooks/
  useMatrixRuntime.ts       useSyncExternalStore sobre el runtime
  useMatrixConversations.ts → Conversation[] | undefined
  useMatrixTimeline.ts      → { messages, loadOlder, send, … } | undefined
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
4. **Sin adjuntos.** El puerto no expone la operación todavía.
5. **Nadie llama a `createRoom`.** El puerto sabe crear una conversación; no hay
   pantalla que lo pida, así que en la app sigue sin poder empezarse un chat
   nuevo por el camino de Matrix.
6. **Una sesión revocada desde fuera no se nota hasta el siguiente arranque.** Si
   el usuario borra este dispositivo desde otro cliente, el sync empieza a fallar
   y la app lo dibuja como un error de sincronización, no como «te han cerrado la
   sesión». El binding lo cuenta (`ClientDelegate.didReceiveAuthError`) y
   `matrix-js-sdk` también (`HttpApiEvent.SessionLoggedOut`); el puerto no expone
   ninguno de los dos todavía. El camino de vuelta existe —cerrar sesión desde
   Ajustes— pero hay que saber que hace falta.
7. **Una invitación se distingue pero se pinta igual.** El resumen dice cuál lo
   es (`membership`) y `Conversation.isInvitation` lo lleva hasta la pantalla,
   que todavía no hace nada distinto con él: la fila se dibuja como cualquier
   otra y abrirla no da timeline. Aceptar o rechazar tampoco existe — el puerto
   no expone ninguna de las dos.

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
