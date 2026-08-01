# El modelo de datos de Allo sobre Matrix

Diseño de la capa de datos para la migración a Matrix. Cubre qué desaparece, qué
sobrevive, qué hay que construir, y dónde Matrix no tiene respuesta.

No es un plan de implementación ni una guía de despliegue. Es la decisión de
dónde vive cada dato y por qué.

---

## 0. Cómo leer este documento

Cada afirmación está marcada, porque la diferencia importa:

| Marca | Significa |
|-------|-----------|
| **[V]** | Verificado leyendo el código de Allo. Lleva `ruta:línea`. |
| **[B]** | Verificado en las tipificaciones del binding que usa el spike (`@unomed/react-native-matrix-sdk@0.9.1`). Lleva `FFI:línea`. |
| **[C]** | Criterio de diseño. Es una opinión defendida, no un hecho. |
| **[?]** | Afirmación sobre el spec de Matrix que hay que contrastar contra la versión del homeserver que se despliegue. Mi conocimiento del spec no es una fuente verificable desde este repo. |

`FFI` abrevia
`spikes/matrix-rn/node_modules/@unomed/react-native-matrix-sdk/lib/typescript/module/src/generated/matrix_sdk_ffi.d.ts`.
Los números de línea son de la copia instalada hoy; una actualización del paquete
los mueve, los nombres de los métodos no.

Las marcas **[B]** valen más que **[?]**: describen lo que la app puede llamar
*hoy*, no lo que el protocolo permite en abstracto. Varias decisiones de este
documento cambian según esa distinción, y la más importante — los chats secretos
— se decide entera ahí.

---

## 1. El punto de partida, medido

Once modelos Mongo, 36 manejadores de ruta bajo `/api` (10 en `profileSettings`,
9 en `conversations`, 8 en `messages`, 7 en `devices`, 2 en `reports`), más
`GET /api/health` y el receptor de webhook `POST /webhooks/crowdsource`
[V] `packages/backend/server.ts:255-272`.

Antes de mapear nada hay tres hechos del código actual que cambian el alcance de
la migración. Los tres son verificables y ninguno es evidente leyendo el
diseño.

### 1.1 `Block` y `Restrict` no se aplican en ningún sitio

Las dos colecciones tienen CRUD completo
[V] `packages/backend/src/routes/profileSettings.ts:186-326` y nada más. Ninguna
consulta de `conversations.ts` ni de `messages.ts` las mira: crear una
conversación con alguien que te ha bloqueado funciona, y enviarle un mensaje
también. La única referencia fuera del CRUD está en comentarios y tests de
moderación [V] `packages/backend/src/services/moderation/ModerationDecisionWorker.ts:20-27`.

Y no son alcanzables desde la app: el layout registra las pantallas
`settings/privacy/blocked` y `settings/privacy/restricted`
[V] `packages/frontend/app/(chat)/_layout.tsx:144-145`, pero **esos ficheros de
ruta no existen**, y ningún fichero del frontend llama a `/profile/blocks` ni a
`/profile/restricts`.

Consecuencia para este diseño: mover `Block` a Matrix no es migrar una feature,
es **implementarla por primera vez**. Eso cambia el criterio de aceptación —
no hay comportamiento previo que preservar — y elimina la deuda de compatibilidad.

### 1.2 Las notificaciones push no funcionan

- El fichero `packages/backend/src/routes/notifications.ts` fue **borrado** en el
  commit `670f008` y nunca se volvió a montar. Los routers montados son
  exactamente cinco [V] `server.ts:264-268`.
- El cliente sigue llamando a `POST /notifications/push-token`
  [V] `packages/frontend/components/notifications/RegisterPushToken.tsx:34` sobre
  una base que ya incluye `/api` [V] `packages/frontend/config.ts:5-8`. Es decir,
  llama a una ruta inexistente. La colección `PushToken` no la escribe nadie.
- `sendPushToUser` [V] `packages/backend/src/utils/push.ts:43` sólo lo invoca
  `createNotification` [V] `packages/backend/src/utils/notificationUtils.ts:37`, y
  a `createNotification` no lo invoca nadie fuera de su propio fichero.

`firebase-admin` es una dependencia de producción que no se ejecuta
[V] `packages/backend/package.json:35`. La sección 7 de este documento no
sustituye un sistema en funcionamiento: sustituye un hueco.

### 1.3 `ConversationService` es código muerto

`packages/backend/src/services/ConversationService.ts` (309 líneas) no lo importa
ningún fichero. La única mención es un comentario en
`packages/backend/src/middleware/errorHandler.ts:5`. Se borra sin análisis de
impacto.

### 1.4 La ruta de texto plano sigue viva

El cliente cae a texto plano cuando el destinatario no tiene dispositivos
registrados [V] `packages/frontend/stores/messagesStore.ts:567-581`, y el servidor
lo acepta y lo guarda [V] `packages/backend/src/routes/messages.ts:317, 368`. El
registry de moderación ya documenta esto como un problema de seguridad abierto
[V] `packages/backend/src/services/moderation/subjects/registry.ts:33-63`.

Matrix lo resuelve por construcción: en una sala con `m.room.encryption` no hay
ruta de texto plano que tomar, porque el SDK cifra o falla. Es la ganancia de
seguridad más concreta de toda la migración y conviene que aparezca en la
justificación del proyecto, no sólo aquí.

---

## 2. Qué muere

### 2.1 Colecciones y su código

| Qué | Ficheros a borrar |
|-----|-------------------|
| `Conversation` | `packages/backend/src/models/Conversation.ts`, `packages/backend/src/routes/conversations.ts`, `packages/backend/src/services/ConversationService.ts`, `packages/shared-types/src/conversation.ts` |
| `Message` | `packages/backend/src/models/Message.ts`, `packages/backend/src/routes/messages.ts`, `packages/shared-types/src/message.ts` |
| `Device` | `packages/backend/src/models/Device.ts`, `packages/backend/src/routes/devices.ts`, `packages/shared-types/src/device.ts` |
| `PushToken` | `packages/backend/src/models/PushToken.ts`, `packages/backend/src/utils/push.ts`, `packages/backend/src/utils/notificationUtils.ts` |

Más las líneas de carga de modelos correspondientes en `server.ts:287-298` y la
dependencia `firebase-admin`.

`shared-types` queda con `api.ts` y poco más. Merece revisarse si el paquete
sigue justificando su existencia una vez que los tres DTOs grandes se van; esa
decisión no la toma este documento.

### 2.2 El transporte propio

Matrix trae su propio transporte, su propia cola de envío y su propio almacén
local. Todo lo que Allo construyó para eso desaparece:

- **Socket.IO entero**, servidor y cliente. El servidor son ~140 líneas de
  `server.ts:104-244` más `src/utils/socket.ts` y `src/types/realtime.ts`; el
  cliente es `packages/frontend/lib/network/` y `hooks/useRealtimeMessaging.ts`.
  Los eventos `newMessage`, `messageUpdated`, `messageDeleted`, `typing`,
  `messageReactionUpdated` y `conversationThemeUpdated` los sustituye el sync de
  Matrix.
- **Signal Protocol.** `packages/frontend/lib/signalProtocol.ts` y
  `stores/deviceKeysStore.ts`. Lo sustituye el cripto del Rust SDK: Olm/Megolm,
  cross-signing y verificación de dispositivos.
- **P2P.** `packages/frontend/lib/p2pMessaging.ts` (WebRTC data channels para
  mensajes). Matrix no tiene equivalente y no lo va a tener: el modelo es
  cliente-servidor con el servidor ciego. *Esto es una pérdida de función real* y
  hay que decirlo en voz alta, no dejarlo en una tabla — hoy dos usuarios en la
  misma red pueden intercambiar mensajes sin que el servidor vea ni la señal de
  que hablaron. Si esa propiedad importa al producto, Matrix no la ofrece. (El
  WebRTC de *llamadas* es otra cosa y sigue existiendo: Matrix lo estandariza con
  `m.call.*`.)
- **Cola offline y almacén local.** `lib/offlineQueue/`, `lib/offlineStorage.ts`,
  `lib/optimistic/`. El SDK trae cola de envío persistente
  [B] `FFI:26429 enableSendQueue` y un almacén SQLite propio.
- **Stores de Zustand de datos de servidor.** `stores/messagesStore.ts` (727
  líneas) y `stores/conversationsStore.ts` (481). Los sustituyen las listas
  observables del SDK (`RoomList`, `Timeline`). Los stores de **UI**
  (`chatUIStore`, `appearanceStore`, `usersStore`,
  `conversationSwipePreferencesStore`, `messagePreferencesStore`) se quedan.

### 2.3 Lo que hay que borrar del dispositivo

El corte limpio no es sólo servidor. En el dispositivo quedan:

- Claves privadas Signal en `expo-secure-store` (Keychain / Keystore)
  [V] `docs/encryption.mdx:56`.
- Mensajes descifrados en AsyncStorage.

Dejarlas es dejar material criptográfico privado de un protocolo que ya no se
usa, en el llavero del sistema, indefinidamente. **[C]** La primera versión Matrix
debe borrarlas explícitamente en el arranque, una vez, y ese código de borrado
debe llevar una fecha de retirada: es una migración, no una feature.

---

## 3. Qué se conserva, y por qué

| Modelo | Por qué se queda |
|--------|------------------|
| `UserSettings` | Preferencias de la app, no de la mensajería. Apariencia, `profileCustomization`, `privacy`. Matrix no tiene dónde ponerlas y no debería. El bloque `security` [V] `models/UserSettings.ts:74-78` sí cambia de significado — ver §3.1. |
| `UserBehavior` | Preferencias de UX opacas al servidor de mensajería. |
| `Report` | El recibo local y el estado de integración con CrowdSource. Ver §6. |
| `ModerationOutbox` | La garantía transaccional de §7.1 del contrato. Nada de Matrix la sustituye. |
| `ModerationEvent` | Deduplicación de webhooks entre tareas ECS y auditoría. Nada de Matrix la sustituye. |
| `Restrict` | **[C]** Ver §4.3: Matrix no tiene esta primitiva y el binding sólo cubre el caso de los DM. |

Se conserva también todo `packages/backend/src/services/moderation/` sin cambios
estructurales. El único cambio es de identificadores, y está acotado (§6.2).

`Block` **no** aparece en esta tabla: se va a `m.ignored_user_list` (§4.3).

### 3.1 `UserSettings.security` deja de significar lo que dice

Los tres flags actuales quedan sin referente:

- `encryptionEnabled` — en Matrix el cifrado es una propiedad de la **sala**
  (`m.room.encryption`), no de la cuenta, y una vez activada no se puede
  desactivar [?]. Un flag por usuario que dijera "cifra o no" no tendría dónde
  aplicarse. Se borra.
- `cloudSyncEnabled` — hoy decide si el cliente hace POST a `/api/messages`
  [V] `stores/messagesStore.ts:625`. En Matrix el homeserver *siempre* tiene el
  ciphertext; no hay modo "no subas nada". Lo más parecido es el key backup, que
  es una decisión distinta y con otra UI (§5.1). Se borra, y su UI se sustituye
  por la de la clave de recuperación.
- `peerToPeerEnabled` — desaparece con el P2P.

**[C]** Borrar los tres, en vez de reinterpretarlos. Un flag que sobrevive con el
mismo nombre y otro significado es exactamente cómo una app acaba prometiendo en
Ajustes algo que el código dejó de hacer — que es el problema que este proyecto ya
tuvo con `docs/encryption.mdx`.

---

## 4. Las cuatro features de Allo que Matrix no tiene de fábrica

Antes de las cuatro, un hecho del protocolo que decide tres de ellas:

> **Los eventos de estado no se cifran.** En Matrix sólo los eventos de timeline
> se envuelven en `m.room.encrypted`. `m.room.name`, `m.room.topic`,
> `m.room.avatar` y cualquier evento de estado personalizado viajan y se
> almacenan en claro, legibles por el homeserver. [?]

Eso significa que "lo pongo en un evento de estado" es cómodo y es una fuga. Y
significa que la metadata de grupo (nombre, descripción, avatar) pasa a ser
legible por el servidor — igual que hoy, donde son campos de texto plano en Mongo
[V] `models/Conversation.ts:52-54`. No hay regresión frente a hoy, pero sí frente
a lo que la gente asume de una app cifrada, y **si se abre la federación pasa a
ser legible por servidores de terceros**, lo cual sí es nuevo. **[C]** Empezar con
federación cerrada.

### 4.1 `conversation.theme`

Hoy: un id de tema (`classic`, `day`, …) compartido con todos los participantes,
guardado en la conversación [V] `models/Conversation.ts:10, 55`, editable por
cualquier participante [V] `routes/conversations.ts:220-222` y difundido por socket
al resto [V] `routes/conversations.ts:234-247`. Lo consume
`hooks/useConversationTheme.ts:12`.

Tres opciones, ninguna perfecta:

| Opción | Cifrado | Compartido | Disponible en el binding |
|--------|---------|-----------|--------------------------|
| Evento de estado `so.oxy.allo.theme` | **No** | Sí | Sí (`sendRaw` no vale para estado; haría falta REST) |
| Evento de timeline cifrado `so.oxy.allo.theme` | Sí | Sí | **Sí** [B] `FFI:26769 sendRaw` |
| Room account data por usuario | n/a (no cifrado, pero sólo lo ve tu servidor) | **No** | **No** — el binding expone account data **global** [B] `FFI:24008 setAccountData`, no de sala |

**[C] Recomendación: evento de timeline cifrado, gana el último por
`origin_server_ts`.** Razones:

1. Es la única opción que preserva a la vez las dos propiedades que el tema tiene
   hoy — compartido entre participantes y no legible por el servidor — y la única
   que el binding puede escribir hoy.
2. La regla que el proyecto ya aplica en moderación ("el servidor no aprende nada
   que no necesite", `subjects/types.ts:33-38`) no admite excepción para datos
   estéticos. El tema de una conversación es una señal de afinidad entre dos
   personas; es poco, pero no es nada, y el coste de no filtrarlo es un evento
   más en el timeline.

Costes que hay que aceptar, no esconder:

- Un dispositivo nuevo sin claves del pasado no puede leer el evento del tema y
  cae al tema por defecto hasta que alguien lo vuelva a fijar. En chats normales
  el key backup lo resuelve; en secretos el tema es efímero como todo lo demás.
- Otros clientes Matrix (Element) ignoran el tipo desconocido y no muestran nada.
  Correcto: es una preferencia de Allo.
- No hay semántica de "estado" gratis: cada cliente tiene que doblar el último
  evento él mismo. Es diez líneas y hay que escribirlas.

### 4.2 `message.fontSize`

Hoy: un entero 10–72 por mensaje, validado por el esquema
[V] `models/Message.ts:103`, aceptado tal cual desde el cliente
[V] `routes/messages.ts:320, 371`, renderizado en
`components/messages/MessageBlock.tsx:324`.

**[C]** Va como campo extra dentro del `content` del `m.room.message`, con clave
namespaced (`so.oxy.allo.font_size`). Se cifra con el resto del contenido, viaja
con el mensaje, y los clientes ajenos lo ignoran porque ignoran las claves que no
conocen. No necesita evento propio ni estado.

Lo que sí cambia: **la validación desaparece del servidor y no puede volver**. El
homeserver no puede validar un rango dentro de un evento cifrado. Hoy el `min`/`max`
de Mongoose es la última línea; mañana no hay ninguna. El cliente **receptor**
tiene que acotar el valor al renderizar, no sólo el emisor al enviar — un cliente
hostil puede mandar `font_size: 90000` y el bug es de renderizado en el
destinatario, no en el atacante.

### 4.3 `Block` frente a `Restrict` frente a `m.ignored_user_list`

Son tres cosas distintas y hay que mantenerlas distintas.

**`Block` → `m.ignored_user_list`.** [B] `FFI:23781 ignoreUser`, `FFI:24106
unignoreUser`, `FFI:23784 ignoredUsers`. El servidor deja de entregar eventos de
ese usuario [?]. Es más fuerte que el `Block` actual, que no hace nada (§1.1). Lo
que `m.ignored_user_list` **no** hace [?]: no impide que te inviten a salas, no
oculta tu presencia, y no es bidireccional. **[C]** Para un bloqueo con la
semántica que un usuario espera hacen falta tres acciones juntas: `ignoreUser`,
salir de la sala directa, y — en grupos donde el usuario tenga nivel de poder —
`ban`. Eso es composición de cliente; Matrix no la ofrece como una llamada.

**`Restrict` no tiene equivalente.** Es deliberadamente más suave: el mensaje
llega, no se anuncia. Lo más cercano en Matrix son las push rules por remitente
(`sender` con acciones vacías), que son de cuenta y las sincroniza el servidor —
sería el sitio correcto. Pero:

- **[B]** El binding **no expone las push rules genéricas**. Expone una API
  curada de notificaciones: `setRoomNotificationMode(roomId, mode)`
  [B] `FFI:26095`, `unmuteRoom` [B] `FFI:26114`,
  `setDefaultRoomNotificationMode` [B] `FFI:26076`. Los tipos `ConditionalPushRule`
  y `PatternedPushRule` existen [B] `FFI:463, 1178` pero no hay método que los
  escriba.
- Es decir: **restringir a alguien en un DM sí se puede** (es silenciar esa sala),
  **restringir a un remitente concreto dentro de un grupo no**.

**[C] Recomendación:** `Restrict` se queda en Mongo como está, y el cliente lo
aplica en dos capas: silenciar la sala vía `setRoomNotificationMode` cuando el
restringido es el otro extremo de un DM, y atenuar en la UI en el resto de casos.
Es una implementación parcial y hay que documentarla como tal en la UI —
"restringido" no puede prometer silencio si en un grupo no lo da. La alternativa
correcta es una llamada REST directa a `/_matrix/client/v3/pushrules/` o una
contribución upstream al binding; ambas son trabajo, no configuración.

Nota aparte: hay dos fuentes de verdad para lo mismo. La colección `Restrict` y
`UserSettings.privacy.restrictedUsers` [V] `models/UserSettings.ts:64`,
escribible desde `PUT /profile/settings`
[V] `routes/profileSettings.ts:130-132`. Hay que quedarse con una. **[C]** La
colección, y borrar el campo.

### 4.4 Archivado (`archivedBy`)

Hoy: un array de user ids en la conversación [V] `models/Conversation.ts:19`, con
endpoints de archivar y desarchivar [V] `routes/conversations.ts:347-399` y filtro
en el listado [V] `routes/conversations.ts:70`. Semántica: por usuario.

Matrix tiene room tags (`m.tag`, room account data), que son exactamente
"etiqueta por usuario sobre una sala". Pero **[B]** el binding sólo expone dos
setters concretos: `setIsFavourite` [B] `FFI:26772` y `setIsLowPriority`
[B] `FFI:26775`. La enumeración `TagName` incluye una variante `User` para tags
personalizados [B] `FFI:21556-21561`, pero **no hay método para escribirlos**.

Dos caminos:

1. **`m.lowpriority` vía `setIsLowPriority`.** Disponible hoy, sincronizado por el
   servidor, interoperable con Element (aparece en "Baja prioridad"). Coste: se
   gasta la única etiqueta semánticamente cercana, y si mañana Allo quiere
   "silenciar" *y* "archivar" como cosas distintas, sólo queda una.
2. **Account data global `so.oxy.allo.archived` con una lista de room ids**, vía
   `setAccountData` [B] `FFI:24008`. Disponible hoy también. Coste: lectura-
   modificación-escritura sin transacción — dos dispositivos archivando a la vez
   pierden uno de los dos cambios — y una lista que crece sin límite.

**[C] Recomendación: `m.lowpriority`.** El riesgo del punto 1 es hipotético; el
del punto 2 es una carrera real que se manifiesta como "desarchivé una
conversación y volvió sola". Si más adelante hacen falta las dos etiquetas, el
momento de resolverlo es cuando el binding exponga tags de usuario, y esa es una
contribución upstream pequeña.

---

## 5. Los tres niveles de chat

Esta es la parte del documento con una conclusión incómoda, así que va primero:

> **De los tres niveles, dos salen de Matrix casi gratis y el tercero — los chats
> secretos — no existe en Matrix y no se puede construir sólo con configuración.**
> Requiere modificar el SDK o renunciar al key backup en toda la cuenta. El
> detalle está en §5.2 y es la decisión de arquitectura más importante de este
> documento.

### 5.1 Chats normales — E2EE con historial recuperable

Esto Matrix lo hace bien y el spike ya lo probó de punta a punta.

**Creación.** `createRoom` con `isEncrypted: true`
[B] `FFI:497-509 CreateRoomParameters`, [B] `FFI:23614 createRoom`. El spike lo
hace exactamente así [V] `spikes/matrix-rn/src/checks.ts:447-455`. Para DMs,
`isDirect: true` y el evento de account data `m.direct` [?]; el binding tiene
`getDmRoom(userId)` [B] `FFI:23674` para resolver la sala directa existente, que
es el equivalente del `findOne` de deduplicación de hoy
[V] `routes/conversations.ts:158-168`.

**Comprobar que está cifrada.** `latestEncryptionState()` [B] `FFI:26545`,
que devuelve `Encrypted` / `NotEncrypted` / `Unknown`
[B] `matrix_sdk_base.d.ts:76-90`. El spike documenta por qué **no** hay que usar
`isEncrypted()`: colapsa `Unknown` en `false` y produce un falso negativo justo
después de crear la sala
[V] `spikes/matrix-rn/src/checks.ts:456-468`. Ese comentario debería sobrevivir a
la migración; es el tipo de detalle que se re-descubre con un bug.

**Backup y clave de recuperación.** `enableRecovery(waitForBackupsToUpload,
passphrase, progressListener)` devuelve la clave de recuperación
[B] `FFI:25056`; `recover(recoveryKey)` [B] `FFI:25072` la consume en el
dispositivo nuevo. Alrededor: `backupExistsOnServer` [B] `FFI:25031`,
`backupState` [B] `FFI:25034`, `recoveryState` [B] `FFI:25078`, `resetRecoveryKey`
[B] `FFI:25087`, `isLastDevice` [B] `FFI:25069`.

El spike ya prueba el ciclo completo, incluido el control negativo — un
dispositivo frío que **no** puede leer el historial antes de introducir la clave y
**sí** después [V] `spikes/matrix-rn/README.md:91-98`,
`spikes/matrix-rn/src/checks.ts:550-580`. Sin ese control negativo la prueba sería
vacua, y está bien hecha.

**Una aclaración que evita un bug de diseño.** Lo que decide si un dispositivo
nuevo lee el historial es **el key backup**, no `m.room.history_visibility`. La
`history_visibility` gobierna qué eventos entrega el servidor; las claves para
descifrarlos son un problema aparte [?]. Confundirlas lleva a configurar
`history_visibility: shared` y creer que con eso el dispositivo nuevo verá el
pasado. No lo verá: verá ciphertext.

### 5.2 Chats secretos — lo que Matrix da y lo que hay que construir

Cuatro propiedades pedidas. Una por una.

#### (a) Verificación obligatoria — Matrix la tiene, pero no por sala

`CollectStrategy.OnlyTrustedDevices = 3`
[B] `matrix_sdk_crypto.d.ts:53-62`: sólo se comparten claves de sala con
dispositivos de confianza (verificados manualmente, verificados por SAS, o
firmados por una identidad verificada).

**El problema:** se configura en `ClientBuilder.roomKeyRecipientStrategy(strategy)`
[B] `FFI:24882`. Es una propiedad **del cliente**, decidida al construirlo. No hay
override por sala en este binding — lo busqué; `roomKeyRecipientStrategy` aparece
únicamente sobre `ClientBuilder`.

Con eso, tener salas secretas y normales en la misma app deja tres salidas:

1. **Dos clientes con estrategias distintas.** Inviable: es la misma cuenta y el
   mismo almacén criptográfico; dos clientes sobre el mismo store es una fuente
   de corrupción, no una configuración.
2. **`OnlyTrustedDevices` para toda la app.** Defendible como postura de producto
   — Allo es una app de mensajería cifrada y puede exigir verificación — pero
   rompe el envío a cualquier usuario que no haya publicado identidad
   cross-signed, y "no puedo escribirle a alguien recién instalado" es un fallo
   de producto grave.
3. **Contribuir upstream un `EncryptionSettings` por sala.** Es lo correcto y es
   trabajo en Rust más regeneración del binding.

**[C]** Recomendación: (3), y mientras tanto (2) restringido a un piloto. Lo que
**no** hay que hacer es prometer "verificación obligatoria" en la UI de los chats
secretos mientras la estrategia efectiva sea `AllDevices`; sería una casilla que
no hace nada.

#### (b) Claves sólo en los dispositivos presentes al enviar — esto es gratis

Es el comportamiento por defecto de Megolm: la sesión se comparte con los
dispositivos que estaban en la sala al crearla, y un dispositivo posterior no la
obtiene salvo que algo se la dé [?]. Ese "algo" son dos mecanismos que hay que
tener bajo control:

- **Key forwarding** (`m.room_key_request` / `m.forwarded_room_key`) entre
  dispositivos del mismo usuario. **[?]** Creo que matrix-rust-sdk ya no reenvía
  automáticamente por defecto, pero no lo he podido verificar en el binding — no
  hay superficie de API para ello, lo que sugiere que la política está fijada en
  Rust. **Hay que confirmarlo antes de prometer nada**, porque si reenvía, un
  dispositivo nuevo recupera el historial "secreto" sin key backup y la propiedad
  se cae sin que nada falle visiblemente.
- **Compartir historial al invitar** (MSC3061). **[?]** Mismo caso: hay que
  comprobar si el SDK lo hace.

#### (c) Sin key backup — aquí es donde Matrix no llega

**El key backup es por cuenta, no por sala.** No hay, en el spec ni en el binding,
manera de excluir una sala del backup. La superficie completa de `Encryption` en
el binding es `enableBackups`, `enableRecovery`, `disableRecovery`,
`backupExistsOnServer`, `backupState`, `recover`, `recoverAndReset`,
`recoveryState`, `resetRecoveryKey`, `resetIdentity`, `isLastDevice`,
`hasDevicesToVerifyAgainst` [B] `FFI:25031-25087`. Ninguna toma un `roomId`.

Consecuencias, en orden de gravedad:

1. **Con el backup activado (que es lo que quieren los chats normales), las claves
   de las salas secretas se suben también.** La propiedad "el historial no es
   recuperable" es falsa por defecto. Para que sea cierta hace falta que el
   cliente excluya las sesiones Megolm de las salas marcadas al subirlas al
   backup, y eso es código dentro de matrix-rust-sdk, no una opción.
2. **Otro cliente Matrix con la misma cuenta rompe la propiedad de todos modos.**
   Si el usuario inicia sesión con Element, Element sube al backup todas las
   claves que tenga, incluidas las de las salas secretas, porque para Element no
   son especiales. No hay mitigación criptográfica. La única mitigación es
   política: restringir en MAS qué `client_id` pueden autenticarse contra el
   homeserver. Es una defensa de despliegue, no del protocolo, y hay que
   escribirla como tal.
3. Por tanto **un chat secreto en Allo no puede prometer más que "Allo no guarda
   estas claves"**, no "estas claves no existen fuera de tus dispositivos".

**[C]** Hay que elegir explícitamente entre:

- **A.** Construir la exclusión por sala en el SDK (upstream) y aceptar la
  restricción de clientes en MAS. Es la única versión que cumple lo prometido.
- **B.** Redefinir "secreto" a lo que Matrix sí garantiza sin tocar nada:
  verificación obligatoria + sin reenvío de claves + borrado local por
  temporizador, y **decir en la UI que el historial puede sobrevivir en el backup
  de la cuenta**. Es honesto y es mucho menos de lo que la palabra "secreto"
  sugiere.

No hay opción C. Marcar la sala con un evento de estado o de timeline no cambia
qué hace el subsistema de backup; sólo se lo cuenta a la UI.

#### (d) Efímeros — no existe en el spec

No hay mensajes autodestructivos en Matrix [?] (el MSC más citado, MSC2228, sigue
sin estabilizarse). Se construye: temporizador en el cliente, borrado local, y
`redactEvent` [B] `FFI:29234` para que el servidor tire el contenido. La redacción
deja el esqueleto del evento (quién, cuándo, en qué sala) [?].

**[C]** Igual que en Signal: es una promesa de interfaz, no criptográfica. Un
cliente modificado no borra nada. Está bien construirlo, está mal describirlo como
una garantía.

#### Cómo se marca una sala como secreta

**[C]** Evento de estado `so.oxy.allo.room_class` con `{"class": "secret"}`. Aquí
sí conviene el estado y no el timeline, al revés que con el tema (§4.1): la clase
de la sala tiene que ser legible **antes** de tener ninguna clave, porque decide
cómo se trata la sala desde el primer sync. Un evento cifrado sería un
huevo-y-gallina. El coste — el servidor sabe que una sala es "secreta" — es
inevitable de todos modos: si el cliente tiene que comportarse distinto, ese
comportamiento es observable.

### 5.3 Chats puenteados — la marca no debe ser un flag

Una sala puenteada no es E2E: el bridge tiene las claves de la red externa y actúa
como participante. Lo importante del diseño es **de dónde saca la UI el candado**.

**[C] La marca primaria es `latestEncryptionState() == NotEncrypted`**
[B] `FFI:26545`, no un flag. Es una propiedad criptográfica del estado de la sala,
verificable por el cliente y que nadie puede falsificar poniendo un campo. Un flag
"esto es un bridge" puesto por el appservice sería confiable exactamente en la
medida en que confiemos en el appservice, que es lo que estamos tratando de
representar.

La marca **secundaria**, y sólo para decir *qué* red es (icono de WhatsApp,
nombre del canal), es el evento de estado `m.bridge` — que sigue siendo un MSC
inestable (MSC2346, prefijo `uk.half-shot.bridge`) [?] — más el namespace del MXID
de los usuarios fantasma del appservice (`@whatsapp_...:allo.oxy.so`).

La regla de UI, dicha explícitamente porque es donde se cometen los errores:
**el candado lo decide el estado de cifrado; el icono de red lo decide el evento
de bridge.** Mezclarlos es cómo se acaba mostrando un candado en una sala que el
bridge lee entera.

---

## 6. Moderación

El pipeline de CrowdSource se conserva íntegro. Cambian dos cosas: los
identificadores y el mapa de lo que es reportable.

### 6.1 El argumento del registry sigue siendo válido, palabra por palabra

`subjects/registry.ts` justifica que el único subject entregable sea `user`
porque el servidor guarda `Message.ciphertext` y no tiene código de descifrado
[V] `registry.ts:20-31`. Bajo Matrix el servidor guarda `m.room.encrypted` y
tampoco tiene las claves. **El razonamiento no cambia, cambia el nombre del campo.**

Lo que sí desaparece es el agujero que el propio fichero documenta: hoy existe un
`Message.text` legible que haría técnicamente posible un provider de `message`
con cobertura invertida [V] `registry.ts:33-63`. En Matrix esa ruta no existe.

### 6.2 Dos identificadores donde había uno

`Report.reportedId` es hoy un id de Oxy. Es la clave del índice único
`{reporter, reportedId, reportedType}` [V] `models/Report.ts:211`, y
`userSubject.snapshot` lo pasa directamente a `oxyClient.getUserById`
[V] `subjects/userSubject.ts:57`. El cliente, en cambio, va a tener a mano un MXID:
es lo que aparece en una sala.

**[C] `Report.reportedId` sigue siendo el id de Oxy.** La traducción MXID → Oxy id
se hace en el borde (ruta o cliente), no dentro del pipeline. Cambiar la clave a
MXID obligaría a tocar la clave de deduplicación de §7.3 del contrato y el
subject provider, para no ganar nada: CrowdSource juzga cuentas de Oxy.

Para que esa traducción sea una función total y no una colección más:
**el localpart del MXID debe derivarse determinísticamente del `sub` de Oxy** en la
configuración de MAS. Si es así, `mxid → oxyUserId` es aritmética de cadenas y no
hay estado que desincronizar. Si no lo es, hace falta una colección
`MatrixIdentity { oxyUserId, mxid }` con índice único en ambos campos, y con ella
llegan todos los modos de fallo de un mapa (huérfanos, colisiones, una fila
perdida = un usuario irreportable).

Restricción a comprobar en Fase 1: el localpart de un MXID admite sólo minúsculas,
dígitos y `._=-/+` [?]. Un ObjectId hexadecimal encaja sin transformar; cualquier
otro formato de id de Oxy hay que comprobarlo.

### 6.3 Sujetos que no son cuentas de Oxy — decisión nueva y obligatoria

Con Matrix aparecen MXIDs que **no tienen cuenta Oxy**: usuarios remotos si se
abre la federación, y fantasmas de bridge (`@whatsapp_...`). Reportar a uno de
esos hoy produciría un `getUserById` con 404, que `userSubject` traduce
correctamente a `null` [V] `subjects/userSubject.ts:66`, y el informe quedaría en
local sin explicación distinguible de un error.

**[C]** Hay que decidirlo explícitamente y escribirlo en el `localStatusReason`,
igual que se hizo con `message` [V] `ReportIntakeService.ts:114-120`: *"el sujeto
no es una cuenta de Oxy y CrowdSource sólo revisa cuentas de Oxy"*. Un jurado no
puede juzgar el perfil de una cuenta de WhatsApp, entre otras cosas porque no lo
hay.

### 6.4 Salas puenteadas: el agujero que hay que cerrar por escrito

Una sala puenteada **no está cifrada**, luego el servidor **sí** puede leer su
contenido. Eso reabre técnicamente la posibilidad de un provider de `message`,
condicionado al estado de cifrado.

**[C] No debe existir, y por tres razones — las dos primeras son las del registry
actual y la tercera es nueva:**

1. **La cobertura estaría exactamente invertida**, igual que con el fallback de
   texto plano [V] `registry.ts:48-52`: la moderación funcionaría sólo donde la
   promesa del producto no se cumple.
2. **Haría el puente load-bearing.** Si la moderación dependiera de leer salas
   puenteadas, cifrarlas algún día "rompería la moderación"
   [V] `registry.ts:53-57`.
3. **El otro extremo nunca aceptó nada.** El contenido de una sala puenteada lo
   escribió, en buena parte, un usuario de WhatsApp o Telegram que no tiene cuenta
   Oxy, no aceptó los términos de Allo y no puede ser parte de un caso de
   CrowdSource. Enviarlo a un jurado sorteado es disclosure de material de un
   tercero ajeno al sistema.

Y **[C]** el test que hoy pinea `deliverableTypes()` a exactamente `['user']`
[V] `registry.ts:134-146` debe extenderse: no basta con que no exista un provider
de `message`; hay que pinear que **no existe ningún provider condicionado al
estado de cifrado de la sala**. Sin esa segunda aserción, la vía de entrada es
"añadir un provider que sólo actúa en salas no cifradas", que suena razonable en
una PR y es exactamente el fallo.

### 6.5 Lo que Matrix añade: un segundo canal, con otra autoridad

El binding expone `reportContent(eventId, score, reason)` [B] `FFI:26716` y
`reportRoom(reason)` [B] `FFI:26731`. Eso reporta **al administrador del
homeserver**, no a CrowdSource.

Es un canal legítimo y nuevo: el homeserver puede actuar sobre metadatos (una
sala, un remitente, un patrón de frecuencia) sin leer contenido.

**[C] Mantenerlo separado del pipeline de CrowdSource.** Son dos destinatarios con
dos autoridades distintas y dos vocabularios de consecuencias distintos. Y en
particular: **el `eventId` no debe llegar nunca a CrowdSource.** Identifica un
mensaje concreto en una sala concreta; es metadato de conversación, precisamente
lo que hoy no sale del despliegue.

### 6.6 El modo `observe` pierde su razón técnica

El worker de decisiones no actúa nunca, y la justificación escrita es que Allo no
tiene primitiva de sanción a nivel de plataforma: `Block` y `Restrict` son
relaciones por usuario [V] `ModerationDecisionWorker.ts:17-33`.

Con Synapse eso deja de ser cierto: el admin API tiene suspensión, desactivación,
bloqueo y shadow-ban de cuentas [?]. La razón técnica desaparece.

**[C]** Eso **no** significa que haya que activar el enforcement. Significa que la
próxima vez que se hable de `observe` la respuesta ya no es "no se puede" sino "no
se ha decidido", que es una conversación distinta y de producto. Si algún día se
decide actuar, hacen falta dos cosas que hoy no existen: el código que llama al
admin API, y una ruta de reversión real para `restore` — que existe en el tipo
[V] `models/Report.ts:74` y no tiene implementación.

---

## 7. Notificaciones push

Recordatorio de §1.2: hoy no funciona nada de esto. No se sustituye un sistema; se
construye uno.

**El modelo Matrix.** El cliente registra un *pusher* en el homeserver con el token
FCM/APNs como `pushkey`: `setPusher(identifiers, kind, appDisplayName,
deviceDisplayName, profileTag, lang)` [B] `FFI:24040`, con `PusherKind.Http`
[B] `FFI:15490-15524`. El homeserver evalúa las *push rules* y, cuando una dispara,
avisa a un *push gateway* (Sygnal), que habla con FCM/APNs [?].

**Qué se elimina:** `models/PushToken.ts`, `utils/push.ts`,
`utils/notificationUtils.ts`, la dependencia `firebase-admin`, y las variables
`FIREBASE_SERVICE_ACCOUNT_BASE64` / `FIREBASE_PROJECT_ID`.

**Qué se conserva:** el permiso de notificaciones y la obtención del token nativo
en el cliente [V] `packages/frontend/utils/notifications.ts:81-95`. Cambia su
destino: alimenta `setPusher` en vez de un POST al backend de Allo.

**Qué aparece nuevo en infraestructura:** **Sygnal**. Es un servicio más que
desplegar, con las credenciales de FCM y APNs. Fase 1 tiene que contemplarlo; hoy
no está en `.github/workflows/deploy-aws.yml` porque no existía.

**Silenciar una conversación:** `setRoomNotificationMode(roomId, mode)`
[B] `FFI:26095`. Es la traducción directa de "mute" y está disponible.

**Una mejora de privacidad que conviene no perder.** Hoy el payload de FCM lleva
título y cuerpo [V] `utils/push.ts:57-60`, es decir, pasan por Google en claro.
En Matrix, para salas cifradas, el gateway envía el formato `event_id_only`: el
push sólo despierta a la app, que sincroniza, descifra localmente y compone la
notificación [?]. **[C]** Hay que configurarlo así explícitamente — Sygnal puede
mandar más — porque el modo por defecto no es necesariamente el mínimo.

---

## 8. Migración: corte limpio

La decisión ya está tomada: se conserva la identidad Oxy, no el historial. Lo que
sigue es lo que eso implica operativamente.

### 8.1 Qué se borra

**En Mongo** (las colecciones, no sólo el código): `conversations`, `messages`,
`devices`, `pushtokens`. **[C]** `blocks` también: la lista actual no ha tenido
efecto nunca (§1.1), y trasladar a `m.ignored_user_list` una lista que el usuario
creó creyendo que hacía algo distinto es peor que pedirle que la rehaga sobre una
feature que ahora sí funciona.

**En el dispositivo:** claves privadas Signal en secure-store y mensajes
descifrados en AsyncStorage (§2.3).

**En el código:** las rutas de §2.1 y §2.2.

**En la documentación:** `docs/encryption.mdx` describe entero el protocolo que se
elimina. Queda obsoleto de arriba abajo. (No lo toco: hay otro trabajo en curso
sobre ese fichero.)

### 8.2 Lo que un corte limpio no resuelve solo

**La cola de salida se pierde.** Al desinstalar `lib/offlineQueue/`, lo que
estuviera encolado desaparece. Es coherente con "no se conserva el historial",
pero un mensaje que el usuario cree enviado y nunca llegó es peor que un historial
ausente. **[C]** La última versión pre-Matrix debería vaciar o avisar de la cola.

**Los usuarios se particionan.** Mientras coexistan versiones, un usuario de la
versión vieja y uno de la nueva **no pueden hablarse**, y ninguna de las dos apps
lo detecta: los mensajes salen sin error y no llegan. En una app de mensajería, un
corte limpio no es sólo un corte de datos, es un corte de conectividad.

**[C] Recomendación: versión mínima forzada** (kill-switch que obliga a
actualizar). La alternativa — aceptar la partición — significa que durante
semanas dos personas creerán estar hablando. Eso no es un coste de migración
aceptable en una app de mensajería, y la actualización forzada, siendo molesta, es
honesta.

**La clave de recuperación es un concepto nuevo para el usuario.** Hoy perder el
dispositivo con `cloudSyncEnabled: false` pierde las conversaciones y no hay nada
que apuntar. Mañana hay una clave que, si se pierde, hace irrecuperable el
historial de los chats normales — que es justo el nivel que promete
recuperabilidad. El onboarding de esa clave es parte de la migración, no una
pantalla que se añade después.

### 8.3 Lo que sobrevive intacto

La identidad. Ningún usuario vuelve a registrarse: entra con Oxy, MAS le da un
MXID, y el `oxyUserId` sigue siendo la clave de `UserSettings`, `UserBehavior`,
`Restrict`, `Report` y todo el pipeline de moderación. Ese es el sentido de que
Oxy no cambie: el corte limpio corta las conversaciones, no las cuentas.

---

## 9. Tabla de correspondencias Allo → Matrix

**Conversaciones y mensajes**

| Allo (hoy) | Matrix | Marca |
|---|---|---|
| `Conversation` (documento) | Sala (`m.room.create`) | [?] |
| `Conversation.type: "direct"` | `isDirect: true` + account data `m.direct` | [B] `FFI:497-509` / [?] |
| `Conversation.type: "group"` | Sala normal, `preset: PrivateChat` | [B] `FFI:23614` |
| deduplicación de DM `findOne` (`routes/conversations.ts:158-168`) | `getDmRoom(userId)` | [B] `FFI:23674` |
| `Conversation.participants[]` | `m.room.member` | [?] |
| `participant.role: admin/member` | `m.room.power_levels` | [B] `FFI:1241` |
| `Conversation.name/description/avatar` | `m.room.name` / `m.room.topic` / `m.room.avatar` — **en claro** | [B] `FFI:26781, 26803, 26944` |
| `Conversation.theme` | evento de timeline **cifrado** `so.oxy.allo.theme`, gana el último | [C] + [B] `FFI:26769` |
| `Conversation.archivedBy[]` | tag `m.lowpriority` | [C] + [B] `FFI:26775` |
| `Conversation.unreadCounts` (Map) | contadores del sync + `setUnreadFlag` | [B] `FFI:26810` / [?] |
| `Conversation.lastMessage` (denormalizado) | último evento del timeline, descifrado en cliente | [?] |
| `Message` | `m.room.message` dentro de `m.room.encrypted` | [?] |
| `Message.ciphertext` (AES-GCM propio) | Megolm (`m.megolm.v1.aes-sha2`) | [?] |
| `Message.text` (fallback en claro) | **desaparece: no hay ruta en claro** | [V] `registry.ts:33-63` |
| `Message.encryptedMedia[]` | `m.image`/`m.video`/`m.audio`/`m.file` con `EncryptedFile` | [?] |
| `Message.replyTo` | `m.in_reply_to` | [?] |
| `Message.fontSize` (10–72) | campo `so.oxy.allo.font_size` en el `content` cifrado | [C] |
| `Message.editedAt` + `PUT /messages/:id` | `m.replace` | [?] |
| `Message.deletedAt` (borrado suave) | `m.room.redaction` | [B] `FFI:29234` |
| `Message.reactions` (Map) | `m.reaction` (`m.annotation`) — **no cifradas** aunque la sala lo esté | [?] |
| `Message.readBy` (Map) | `m.receipt` (`m.read` / `m.read.private`), `markAsRead` | [B] `FFI:26592` / [?] |
| `Message.deliveredTo[]` | **sin equivalente** — Matrix no tiene acuse de entrega | [?] |
| socket `typing` | EDU `m.typing` | [?] |
| socket `newMessage` y todo Socket.IO | sync (sliding sync) | [V] spike C3 |

**Dispositivos y claves**

| Allo (hoy) | Matrix | Marca |
|---|---|---|
| `Device` (bundle Signal) | dispositivos Matrix + `/keys/upload` · `/keys/query` | [?] |
| `identityKeyPublic`, `signedPreKey`, `preKeys[]` | claves Olm de dispositivo, one-time keys, fallback key | [?] |
| `GET /devices/user/:id/prekeys/:deviceId` | claim de one-time keys, dentro del SDK | [?] |
| — (no existe) | cross-signing + verificación SAS | [B] `FFI:28407` |
| — (no existe) | key backup + clave de recuperación | [B] `FFI:25056, 25072` |
| `docs/encryption.mdx` "device-first" | `enableRecovery` / `disableRecovery` | [B] `FFI:25056, 25043` |

**Relaciones entre usuarios y ajustes**

| Allo (hoy) | Matrix | Marca |
|---|---|---|
| `Block` (no aplicado hoy) | `m.ignored_user_list` (`ignoreUser`) + salir de la sala + `ban` donde haya poder | [C] + [B] `FFI:23781` |
| `Restrict` | **sin equivalente.** Se queda en Mongo; en DMs se aplica con `setRoomNotificationMode` | [C] + [B] `FFI:26095` |
| `UserSettings.appearance` / `privacy` / `profileCustomization` | **se queda en Mongo** | [C] |
| `UserSettings.security.*` | **se borra** (§3.1) | [C] |
| `UserBehavior` | **se queda en Mongo** | [C] |

**Push**

| Allo (hoy) | Matrix | Marca |
|---|---|---|
| `PushToken` (no escrito por nadie) | pusher en el homeserver (`setPusher`) | [B] `FFI:24040` |
| `firebase-admin` en el backend | Sygnal (push gateway) | [?] |
| — (no existe) | push rules | [?] |
| silenciar conversación | `setRoomNotificationMode` | [B] `FFI:26095` |

**Moderación**

| Allo (hoy) | Matrix | Marca |
|---|---|---|
| `Report` + outbox + webhook | **sin cambios**, sigue en Mongo | [C] |
| `Report.reportedId` = id de Oxy | **sigue siendo el id de Oxy**; MXID→Oxy se traduce en el borde | [C] |
| provider `user` (`identity.profile`) | igual, la fuente sigue siendo Oxy | [V] `userSubject.ts:39-47` |
| sin provider para `message` | igual, y además pinear que no lo haya condicionado al cifrado | [C] |
| — (no existe) | `reportContent` / `reportRoom` → admin del homeserver, canal separado | [B] `FFI:26716, 26731` |
| modo `observe` por falta de primitiva | la primitiva existe (Synapse admin API); seguir en `observe` pasa a ser decisión de producto | [?] + [C] |

---

## 10. Lo que este documento no resuelve

Por orden de riesgo para el proyecto:

1. **Los chats secretos no salen de la configuración** (§5.2c). O se contribuye la
   exclusión por sala del key backup a matrix-rust-sdk, o se redefine "secreto"
   públicamente a algo menos. Es una bifurcación de alcance, no un detalle.
2. **`OnlyTrustedDevices` es por cliente, no por sala** (§5.2a). Mismo tipo de
   problema, mismo tipo de solución.
3. **Reenvío de claves y compartición de historial al invitar**: no he podido
   verificar el comportamiento por defecto del SDK, y de él depende que (b) de
   §5.2 sea cierto. **Es lo primero que debería medir la Fase 2**, con un control
   negativo como el que ya tiene C7 del spike.
4. **Reacciones sin cifrar en salas cifradas** [?]: si es cierto, el servidor sabe
   quién reaccionó con qué emoji a qué evento. Hoy en Allo eso está en Mongo y
   también es legible [V] `models/Message.ts:112-116`, así que no es una
   regresión — pero sí es una promesa que la UI no debería hacer.
5. **`deliveredTo` no tiene equivalente.** Los "dos ticks" de entrega no existen en
   Matrix. O se construyen (evento propio, no interoperable, y con coste de
   metadatos) o se quitan de la UI. Decisión de producto pendiente.
6. **El formato del id de Oxy frente al grammar del localpart** (§6.2): trivial si
   es hex, no trivial si no. Lo resuelve Fase 1 en cinco minutos, pero condiciona
   si hace falta una colección de mapeo.
7. **Federación**: todo el documento asume federación cerrada. Abrirla cambia
   quién puede leer la metadata de grupo (§4) y añade sujetos de moderación sin
   cuenta Oxy (§6.3).
