# El tercer nivel: conversaciones efímeras

El nivel que se pidió como «secreto» y que Matrix no puede dar con ese nombre.
Complementa `data-model.md` §5.2 —donde se tomó la decisión de redefinirlo— y
`ui-wiring.md` §3, que es de dónde salen los datos de la pantalla.

Este documento existe sobre todo por su §7. Es la única funcionalidad de Allo
cuyo valor el usuario **no puede comprobar por su cuenta**: no ve si la copia de
la otra persona desapareció. Una interfaz que insinuara más de lo que el
protocolo cumple sería la app mintiendo sobre seguridad, que es peor que no
tener la función.

---

## 1. Lo que se pidió, y por qué no existe

El encargo original era una sala cuyas claves no salen nunca de los dispositivos
presentes: sin key backup, con verificación obligatoria y con mensajes
autodestructivos. Tres de las cuatro piezas no se pueden construir tal cual, y no
por falta de ganas.

**(a) El key backup es por cuenta y no por sala.** Ninguna función de la
superficie de cifrado toma un `roomId`. En el binding nativo,
`EncryptionLike` es `backupExistsOnServer`, `backupState`, `curve25519Key`,
`disableRecovery`, `ed25519Key`, `enableBackups`, `enableRecovery`,
`hasDevicesToVerifyAgainst`, `isLastDevice`, `recover`, `recoverAndReset`,
`recoveryState`, `resetIdentity`, `resetRecoveryKey`, `userIdentity`,
`verificationState`, `waitForBackupUploadSteadyState` y
`waitForE2eeInitializationTasks` — dieciocho métodos, ninguno con sala. Como los
chats normales **exigen** que el backup esté encendido (es lo que hace que un
teléfono nuevo lea el historial), las claves de una sala «secreta» se subirían
igual. Y aunque nuestro cliente las excluyera, cualquier otro cliente de Matrix
con la misma cuenta las sube, porque para él no son especiales.

**(b) `roomKeyRecipientStrategy` es por cliente y no por sala.** Ver §5.

**(c) Los mensajes autodestructivos no están en el spec.** MSC2228 sigue sin
estabilizarse. Lo que sí hay es `redactEvent`.

Y una cuarta cosa que el diseño de `data-model.md` §5.2 daba por hecha y tampoco
existe: **el binding nativo no sabe leer ni escribir un evento de estado propio.**
Ver §3.

## 2. Lo que se construyó en su lugar

El nivel dejó de definirse por *dónde están las claves* y pasa a definirse por
*cuánto dura el contenido*. Si el contenido no persiste, tener la clave no sirve
de nada: un evento redactado no se descifra con ninguna clave porque ya no hay
nada que descifrar.

Se llama **efímero** y no secreto, en el código y en la interfaz, precisamente
porque «secreto» prometía lo de la §1.

Tres piezas, y son de fuerza muy distinta:

| Pieza | Quién la hace cumplir | Fuerza |
|---|---|---|
| Redacción del propio contenido pasado un plazo | el homeserver, a petición de este dispositivo | **real**: desaparece para todo el mundo, en todos los clientes |
| Dejar de dibujar los mensajes al vencer el plazo | este dispositivo | cooperativa: una app modificada, otro cliente o una captura la esquivan |
| Negarse a enviar si no se puede dar cuenta de quién está en la sala | el puerto, antes de que nada salga del dispositivo | **real**: no sale nada, luego tampoco se comparte ninguna clave de sala |

```
lib/matrix/ephemeral/
  policy.ts     dónde se apunta que una conversación es efímera, y su formato
  expiry.ts     la aritmética del plazo: qué se oculta y qué se redacta
  trust.ts      la regla por la que una conversación efímera se niega a enviar
  guard.ts      la comprobación por la que pasa cada envío
lib/matrix/native/trust.ts   identidad → confianza, en el binding
lib/matrix/web/trust.ts      lo mismo en el navegador
lib/matrix/web/accountData.ts   el account data de Allo, declarado a matrix-js-sdk
lib/chat/
  ephemeralPolicies.ts  qué conversaciones son efímeras, como external store
  ephemeralSweep.ts     quitar del homeserver los mensajes propios ya vencidos
components/matrix/
  EphemeralSection.tsx   el interruptor, el plazo, y lo que sí y lo que no
  EphemeralBanner.tsx    la franja bajo la cabecera de la conversación
  ephemeralLifetimes.ts  «24 horas», compartido por los dos sitios que lo dicen
  ephemeralRefusal.ts    la negativa del puerto, en el idioma del usuario
hooks/
  useEphemeralPolicy.ts  → AlloEphemeralPolicy | undefined
  useEphemeralSweep.ts   suscribirse es lo que pone en marcha el barrido
```

## 3. Dónde se apunta que una conversación es efímera

`data-model.md` §5.2 proponía un evento de estado, `so.oxy.allo.room_class`, con
un buen argumento: el estado de sala se comparte con las demás personas, así que
sus clientes sabrían comportarse igual.

**Ese plan no sobrevive al binding nativo.** `@unomed/react-native-matrix-sdk`
0.9.1 no tiene ninguna API para leer ni escribir un evento de estado arbitrario:

- `StateEventType` es un enum cerrado de veintidós tipos del spec
  (`CallMember`, `PolicyRule*`, `Room*`, `Space*`) y no admite una cadena.
- `RoomInfo` —lo que devuelve `roomInfo()`— no lleva estado en crudo.
- `Room.sendRaw(eventType, content)` sí toma un tipo arbitrario, pero manda un
  evento **message-like**, no de estado; y un tipo que Ruma no conoce ni siquiera
  llega al timeline del SDK, así que el receptor no lo vería.
- `Timeline.send` toma un `RoomMessageEventContentWithoutRelation` construido a
  partir de `MessageType`, cuyos records tienen campos fijos: tampoco se puede
  colgar un campo propio de un mensaje. La única variante libre es
  `MessageType.Other({ msgtype, body })`, que cambia el `msgtype` y no admite
  nada más.

Lo que **sí** alcanzan las dos mitades es el account data global con un tipo de
evento arbitrario: `Client.accountData(eventType)` / `setAccountData(eventType,
content)` en el binding, `getAccountData` / `setAccountData` en `matrix-js-sdk`.

Así que la política vive en el account data **de la propia cuenta**:

```json
{
  "rooms": {
    "!abc:allo.you": { "lifetime_ms": 86400000 }
  }
}
```

en `so.oxy.allo.ephemeral_rooms`. Llega a los demás dispositivos de esta persona
—el homeserver lo sincroniza— y **no llega a nadie más**. Eso tiene una
consecuencia que hay que decir en voz alta y que la interfaz dice:

> Los mensajes que desaparecen son los tuyos. A la otra persona no se le avisa,
> así que los suyos se quedan salvo que ella también lo active.

No es un detalle de implementación: es la forma del nivel. Ver hueco 1.

El homeserver ve el tipo de evento y los ids de sala en claro, porque el account
data no va cifrado. Es inevitable más que descuidado: las redacciones que va a
recibir unas horas después le cuentan lo mismo.

## 4. Cómo se distingue de una conversación normal

Una conversación efímera es idéntica a una normal —mismas burbujas, mismo
compositor, mismo candado— hasta que sus mensajes empiezan a desaparecer, que es
después del momento en el que alguien podría haber decidido otra cosa. Así que la
marca es permanente y está en los dos sitios donde se mira:

- **La fila de la lista** lleva un icono de temporizador al lado de la vista
  previa. Al lado y no en su lugar: lo que se dijo sigue perteneciendo a la fila.
- **La conversación** lleva una franja bajo la cabecera, encima del timeline y
  encima del estado vacío —que es justo cuando alguien va a escribir el primer
  mensaje— y dice el plazo **y de quién**: «Los mensajes desaparecen de este
  dispositivo tras 24 horas. Los tuyos se borran para todo el mundo.» Decir
  «los mensajes desaparecen» sin decir de quién sería la frase en la que un
  lector confiaría algo que no debe.

El interruptor está en la pantalla de administración de la sala, con dos avisos
permanentes: qué hace y qué no puede hacer. No hay forma de crear una
conversación efímera desde la pantalla de chat nuevo, y es deliberado: la costura
`ConversationCreator` es la misma para los dos backends (`ui-wiring.md` §8.1) y
un parámetro que sólo una mitad entiende la rompería.

## 5. La verificación obligatoria: lo que Matrix puede y lo que no

Ésta es la parte que el encargo daba por resuelta —«esto Matrix sí lo puede
imponer, vía `roomKeyRecipientStrategy`»— y que resulta ser cierta a medias.

### 5.1 Existe, y es por cliente

En el binding: `ClientBuilder.roomKeyRecipientStrategy(strategy)` con
`CollectStrategy` ∈ { `AllDevices`, `ErrorOnVerifiedUserProblem`,
`IdentityBasedStrategy`, `OnlyTrustedDevices` }. Aparece **sólo** sobre
`ClientBuilder`, es decir, se decide al construir el cliente.

En web: `CryptoApi.setDeviceIsolationMode(mode)` con `AllDevicesIsolationMode` u
`OnlySignedDevicesIsolationMode`, también sobre el cliente.

Y un cliente tiene un almacén de cripto. Dos clientes con estrategias distintas
sobre la misma cuenta es corrupción del almacén, no una configuración
(`data-model.md` §5.2a).

### 5.2 Por qué no se enciende

Encenderla afecta a **todas** las conversaciones de la sesión, incluidas las
normales, y las dos variantes rompen algo distinto:

- Con `OnlyTrustedDevices`, un mensaje a alguien que instaló Allo esta mañana no
  llega a ninguno de sus dispositivos, porque nadie lo ha verificado — y Allo no
  tiene flujo de verificación con el que verificarlo (hueco 4).
- Con `IdentityBasedStrategy`, no llega a nadie que aún no haya publicado
  identidad de cross-signing, que es exactamente el estado de una cuenta recién
  creada y el de web mientras no haya frase de recuperación
  (`client-strategy.md` §3.7).

O sea: los chats normales se romperían para proteger un nivel que el usuario no
eligió para ellos. Es el fallo de producto que `data-model.md` §5.2a ya nombraba.

**Hay un override por sala, y sólo en una de las dos mitades.**
`matrix-js-sdk` tiene `Room.setBlacklistUnverifiedDevices(value)`, que
`RoomEncryptor.ensureEncryptionSession` lee (`this.room.getBlacklistUnverifiedDevices()
?? globalBlacklistUnverifiedDevices`) y convierte en
`CollectStrategy.deviceBasedStrategy(onlyAllowTrustedDevices, …)`. El binding
nativo no tiene equivalente. No se usa, por dos razones: usarlo haría que las dos
plataformas se comportaran distinto de una forma que el puerto no puede expresar
—y `types.ts` dice que un miembro que sólo una mitad puede contestar es la señal
de que la abstracción se rompe—; y significa *verificado*, que hoy no es nadie.

### 5.3 Lo que sí se impone

La comprobación vive en el puerto, encima de los dos SDK, en
`ephemeral/guard.ts`, y **cada envío que crea un evento cifrado pasa por ella**:
`sendText`, `sendAttachment`, `toggleReaction` y `edit`. Una reacción está en la
lista porque la mitad de lo que hace `toggleReaction` es mandar un
`m.annotation`, que en una sala cifrada va cifrado como todo lo demás y dice
quién reaccionó a qué.

`redact` **no** está guardado, y no es un olvido: es el mecanismo sobre el que se
sostiene todo el nivel, y una regla que lo bloqueara mantendría contenido vivo en
el homeserver para protegerlo. Los recibos de lectura y el indicador de
escribiendo tampoco: no llevan nada de la conversación y no van cifrados.

La regla, en `ephemeral/trust.ts`:

> Se envía si **este dispositivo** está verificado por cross-signing **y** la
> identidad de todas las personas de la sala es conocida aquí y no ha cambiado.

Estados por persona (`AlloIdentityTrust`): `verified` (esta cuenta firmó su clave
maestra), `pinned` (identidad conocida aquí y sin cambios desde la primera vez),
`changed` (era otra) y `unknown` (no ha publicado ninguna, o este dispositivo no
ha podido traerla). Se aceptan `verified` y `pinned`.

**Que se acepte `pinned` es una decisión, y hay que decirla.** Allo no tiene
verificación interactiva —ni emojis ni QR—, así que hoy **nadie es `verified`
nunca**. Una regla que lo exigiera se negaría a enviar en toda conversación
efímera para siempre, lo cual no es una función más estricta: es una función
ausente. Lo que se exige es confianza en el primer uso. Frena a un homeserver que
sustituye la identidad de alguien *después*; no frena a uno que mintió la primera
vez. La interfaz lo dice con esas palabras: «Reconocida en este dispositivo», no
«verificada».

**La negativa es la imposición.** Al no enviarse nada, no se crea sesión de
Megolm y por tanto no se comparte ninguna clave: el reparto de claves ocurre al
cifrar, en los dos SDK. Lo que **no** hace es cambiar a quién van las claves
cuando el envío *sí* se permite: van a todos los dispositivos de todas las
personas de la sala, incluido uno que su dueño no haya firmado. Ver hueco 2.

Lo que impide que aparezca un quinto camino de envío sin guardia es
`__tests__/matrix/ephemeral/sendGate.test.ts`, que lee el código de las dos
mitades y falla ante un **segundo** sitio, no ante uno roto — el mismo patrón de
`encryptedRooms.test.ts` y `web/onePlaceUploads.test.ts`.

## 6. El plazo

`expiry.ts` es aritmética y nada más; todas sus funciones toman `now` como
argumento, que es lo que convierte un plazo en algo que se puede probar por los
dos lados en vez de esperarlo.

**Al vencer, dos cosas separadas.**

*Dejar de dibujarlo.* `maskExpiredItems` sustituye el contenido de las filas que
llevan algo escrito —`text`, `media`, `unsupported`— por `expired`. Deja en paz
`redacted` (ya no está en el homeserver: decir «caducado» cambiaría el hecho
fuerte por el débil) y `undecryptable` (una clave que falta es un problema que el
lector quizá tenga que atender, y sobrevive al mensaje). Lo hace
`TimelineSource`, que además programa un temporizador para el siguiente
vencimiento — una conversación normal no paga ni una copia de las filas ni un
temporizador.

*Quitarlo del homeserver.* `ephemeralRedactionsDue` devuelve las filas **propias**,
**aceptadas por el homeserver** y **no redactadas ya** que hayan vencido, y
`ephemeralSweep.ts` las redacta. Sólo las propias porque en Matrix sólo el emisor
puede redactar lo suyo; pedir lo ajeno es una petición que el servidor rechaza,
una vez por barrido, para siempre.

El barrido mantiene una suscripción al timeline de **cada** conversación efímera
mientras la app corre, no sólo de la que está en pantalla. Si sólo actuara sobre
la conversación abierta, la promesa se cumpliría para las que la gente mira y
fallaría en silencio para las que dejó de abrir, que son justo el caso para el
que existe el nivel. Una cuenta sin conversaciones efímeras no abre nada.

## 7. Lo que este nivel **no** protege

Dicho entero, porque es la parte que un usuario no puede comprobar:

- **No impide que la otra persona guarde una copia.** Ni una app modificada, ni
  otro cliente de Matrix, ni una captura de pantalla, ni una foto con otro
  teléfono. Igual que en Signal o en Telegram: es una promesa de interfaz, no
  criptográfica.
- **No saca las claves del key backup.** Están ahí, como las de cualquier otra
  sala (§1a). Lo que se busca es que, cuando alguien llegue a esas claves, no
  quede contenido que abrir.
- **No oculta al homeserver que la conversación es efímera** (§3), ni quién habla
  con quién, ni cuándo. La redacción deja el esqueleto del evento en pie: quién,
  cuándo y en qué sala.
- **No protege lo que ya se leyó.** Un mensaje que la otra persona vio, lo vio.
- **No es una defensa contra un homeserver hostil desde el principio.** La regla
  de §5.3 es confianza en el primer uso.

## 8. Huecos

Por orden de cuánto duele si sale mal.

1. **A las demás personas no se les avisa.** La política es account data de esta
   cuenta y nada que las dos mitades del puerto puedan alcanzar la lleva a la
   sala (§3). Consecuencia: los mensajes de la otra persona no tienen
   temporizador salvo que ella lo active por su cuenta, y su cliente sigue
   dibujando los nuestros hasta que llega la redacción. Cerrarlo pide una de dos
   cosas, y ninguna es de Allo: que el binding nativo exponga eventos de estado
   arbitrarios (contribución upstream a `matrix-sdk-ffi`, más regenerar el
   binding), o que MSC2228 se estabilice y los clientes lo implementen.

2. **La clave de sala sigue yendo a dispositivos sin firmar.** Cuando el envío se
   permite, el reparto es `AllDevices`: un dispositivo de una persona conocida
   que su dueño no haya firmado recibe la clave igual, y lo que descifre lo
   conserva — ninguna redacción llega a él. Lo que existiría para cerrarlo es
   `IdentityBasedStrategy`, que es por cliente y rompería los chats normales
   (§5.2). Lo correcto es un `EncryptionSettings` por sala en
   `matrix-rust-sdk`; es trabajo en Rust sobre un SDK ajeno.

3. **La redacción sólo ocurre con la app abierta.** Nada redacta nada con Allo
   cerrada, que en un móvil es la mayor parte del día. Un mensaje vence *en o
   después* de su plazo, cuando la app vuelva a estar despierta. La otra persona
   ve el contenido durante todo ese hueco. Cerrarlo del lado del cliente es
   trabajo en segundo plano nativo con los mismos problemas que enriquecer una
   notificación (`push.md` §9.1); del lado del servidor sería un módulo de
   Synapse, que es una promesa distinta y hay que decidirla.

4. **No hay verificación interactiva.** Nadie es nunca `verified`; lo más fuerte
   que puede decir la interfaz es «reconocida en este dispositivo» (§5.3). Los
   dos SDK tienen la maquinaria —`SessionVerificationController.requestUserVerification`
   en el binding, `CryptoApi.requestVerificationDM` en web—, así que es trabajo de
   puerto y de UI, no un imposible. Es lo siguiente que haría este nivel más
   fuerte de verdad.

5. **Una violación de *pin* se ve en web y no en el móvil.**
   `UserVerificationStatus.needsUserApproval` cubre las dos —identidad cambiada
   habiendo sido verificada, e identidad cambiada sin haberlo sido—; el binding
   ofrece `hasVerificationViolation()`, `wasPreviouslyVerified()` e `isVerified()`
   y nada sobre *pinning*. `IdentityState.PinViolation` existe en el crate de
   cripto pero sólo llega al binding por
   `Room.subscribeToIdentityStatusChanges`, que es un flujo de cambios y no una
   respuesta a una pregunta. Así que una identidad que cambió sin haber sido
   verificada nunca se lee `pinned` en el móvil y `changed` en el navegador. Está
   asertado en `nativeTrust.test.ts` y `webTrust.test.ts` en vez de tapado,
   porque taparlo sería una foto montada a partir de una suscripción.

6. **Un cambio hecho desde otro dispositivo no se ve hasta recargar.** El puerto
   no puede observar este account data: `observeAccountDataEvent` del binding toma
   un `AccountDataEventType` cerrado. `ephemeralPolicies.ts` lo lee al arrancar la
   sesión y después de cada cambio propio. Es un hueco de lo que se **dibuja**:
   la guardia dentro del puerto lee el account data en cada envío, así que la
   regla se aplica desde que el homeserver lo tiene.

7. **El barrido sólo ve la ventana viva del timeline.** Un dispositivo que estuvo
   fuera más tiempo del que la conversación es profunda tiene mensajes por debajo
   de lo que el timeline sostiene, y ésos se redactan la próxima vez que algo
   pagine hasta ellos. En la práctica la ventana cubre lo normal; en un caso
   extremo, no.

8. **Dos pestañas siguen sin estar resueltas.** No es de este nivel —está en la
   cabecera de `client.web.ts` desde la Fase 2— pero aquí importa más: dos
   `MatrixClient` sobre el mismo IndexedDB pueden corromper el almacén de cripto,
   y un almacén corrupto es un dispositivo que deja de poder redactar.

9. **El plazo es por conversación y no por mensaje.** Cambiarlo cambia el plazo de
   todo lo que ya hay, hacia delante y hacia atrás — bajar de siete días a una
   hora hace vencer de golpe casi todo el historial. Es coherente y puede
   sorprender; no hay confirmación antes de aplicarlo.
