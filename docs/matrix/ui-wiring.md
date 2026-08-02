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
  backend.ts          la bandera
  matrixConfig.ts     homeserver, OIDC, almacén
  matrixRuntime.ts    el cliente y su ciclo de vida, fuera de React
  roomListSource.ts   la lista de salas como external store
  timelineSource.ts   un timeline por sala, ídem, más paginar y enviar
  matrixViewModel.ts  AlloRoomSummary → Conversation, AlloTimelineItem → Message
hooks/
  useMatrixRuntime.ts       useSyncExternalStore sobre el runtime
  useMatrixConversations.ts → Conversation[] | undefined
  useMatrixTimeline.ts      → { messages, loadOlder, send, … } | undefined
components/matrix/
  MatrixSignInGate.tsx      pinta a sus hijos salvo que falte sesión
```

**Ningún componente de presentación cambió.** `MessageBubble`, `MessageBlock`,
`DaySeparator`, las filas de la lista, el layout de tres paneles y los temas por
conversación siguen recibiendo `Conversation` y `Message`. Lo único que cambia es
de dónde salen, y en cada punto de conexión la rama vieja es la expresión que ya
estaba:

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

- Lista de conversaciones, en el orden que da el puerto (no se reordena aquí).
- Timeline de una conversación, con paginación hacia atrás al llegar arriba.
- Envío de texto.
- Login OIDC en tres pasos, con `expo-web-browser`.
- Estados propios para los eventos sin texto: no descifrable, redactado, y
  «Allo no sabe dibujar esto todavía». Ninguno se pinta como una burbuja vacía.

## 5. Qué no llega, y por qué

Por orden de cuánto se nota:

1. **La sesión no se persiste.** Cada arranque es un login nuevo y, por tanto, un
   dispositivo Matrix nuevo. No es un olvido: `AlloSession` documenta que el SDK
   rota los tokens sin avisar a la app y que una sesión guardada se queda rancia
   y deja de restaurarse. Cerrar ese hueco es trabajo en el puerto. Por lo mismo
   el almacén es `in-memory`: un almacén de cripto en disco sólo acumularía las
   claves de dispositivos que nadie va a volver a usar.
2. **La fila de la lista no tiene ni vista previa ni hora.** `AlloRoomSummary` no
   lleva último evento ni marca de actividad. El orden no se pierde —lo da el
   puerto— pero el texto y la hora se quedan vacíos, que es lo que el formateador
   dibuja como nada. Inventar `Date.now()` pondría «ahora» al lado de cada
   conversación de la app.
3. **El tamaño de letra por mensaje no viaja.** `AlloTimelineHandle.sendText`
   manda un cuerpo y nada más; `so.oxy.allo.font_size` (§4.2 de
   `data-model.md`) necesita una llamada que el puerto no tiene.
4. **Un envío fallido dibuja el reloj, no un error.** `MessageMetadata` sólo
   conoce pendiente / enviado / entregado / leído. El reloj es cierto en móvil,
   donde la cola del SDK sigue reintentando, y optimista en web, donde no.
5. **Sin reacciones, sin edición, sin borrado, sin adjuntos, sin recibos de
   lectura, sin indicador de escribiendo, sin crear conversaciones.** El puerto
   no expone ninguna de esas operaciones todavía.
6. **Sin cerrar sesión.** El único camino de vuelta es reiniciar la app.
7. **Las invitaciones aparecen como filas normales.** El puerto las incluye
   («todo lo que el usuario no ha abandonado»), y abrir una probablemente no dé
   timeline. No se filtran aquí: la definición de qué es una conversación es del
   puerto, no de este mapeo.

## 6. Web

El redirect de OIDC apunta a `public/matrix-oidc-callback.html`, un fichero
estático que **no** es una ruta de la app. El export web responde `index.html` a
las rutas desconocidas (`public/_redirects`), así que un redirect a una ruta de
la app arrancaría una segunda copia de Allo dentro del popup — y dos copias son
dos `MatrixClient` sobre un IndexedDB, que es la corrupción del almacén de cripto
que avisa el SDK. Sigue en pie lo que dice `client.web.ts`: Allo en web es segura
en una pestaña y no está probada en dos.
