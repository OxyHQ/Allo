# Notificaciones push sobre Matrix

Cómo suena el teléfono cuando llega un mensaje, y por qué el servidor de Allo ya
no guarda ni un solo token de dispositivo. Complementa `client-strategy.md` (qué
SDK corre dónde) y `ui-wiring.md` (qué llega a la pantalla); esto es la parte que
ocurre con la app cerrada.

---

## 1. Lo que había, y por qué no sonaba nunca

El camino viejo estaba roto en tres sitios independientes, y los tres había que
arreglarlos para que sonara una sola vez:

1. `packages/backend/src/utils/push.ts` enviaba por FCM leyendo la colección
   `PushToken`. **Nada escribía nunca esa colección**, así que
   `sendPushToUser` encontraba cero tokens y devolvía éxito. Todos los días,
   desde el día que se escribió.
2. El cliente (`components/notifications/RegisterPushToken.tsx`) mandaba su token
   a `/notifications/push-token` de la API de **Oxy** —`authenticatedClient` es
   `oxyClient.getClient()`—, no a la de Allo. O sea que el token aterrizaba en
   una base de datos que el emisor de Allo no lee.
3. El emisor de Oxy publica en la **Expo Push API**, que sólo acepta
   `ExponentPushToken[...]`. El cliente llamaba a
   `Notifications.getDevicePushTokenAsync()`, que devuelve el token **nativo** de
   FCM/APNs. Aunque los dos primeros puntos se hubieran arreglado, Expo habría
   rechazado todos los tokens.

Ninguno de los tres se ve desde dentro de la app: no hay error, no hay pantalla
distinta, sólo un teléfono que no suena.

Se ha borrado: `models/PushToken.ts`, `utils/push.ts` entero y
`utils/notificationUtils.ts` (que no tenía ni un solo llamador fuera de sí mismo).
Ver §7 para lo que dependía de ellos.

## 2. Quién guarda qué ahora

En Matrix **el homeserver es el registro de pushers**. Un dispositivo se
registra una vez con `POST /_matrix/client/v3/pushers/set`, y a partir de ahí
Synapse decide qué eventos merecen una notificación y hace `POST` a una *push
gateway* con el token del dispositivo dentro de cada petición.

```
  el móvil                Allo backend              Synapse            APNs/FCM
     │                         │                       │                   │
     │ 1. token del sistema    │                       │                   │
     ├────────────────────────►│                       │                   │
     │    POST /api/push/gateway (con sesión Oxy)      │                   │
     │◄────────────────────────┤                       │                   │
     │    { url, appId }       │                       │                   │
     │                         │                       │                   │
     │ 2. POST /_matrix/client/v3/pushers/set          │                   │
     ├─────────────────────────────────────────────────►                   │
     │    kind=http, pushkey=<token>, data.url=<url>,  │                   │
     │    data.format=event_id_only                    │                   │
     │                         │                       │                   │
     │                         │ 3. POST /_matrix/push/v1/notify?t=…       │
     │                         │◄──────────────────────┤                   │
     │                         │   { event_id, room_id, counts, devices }  │
     │                         ├──────────────────────────────────────────►│
     │                         │   4. entrega                              │
     │                         ├──────────────────────►│                   │
     │                         │   { "rejected": [...] }                   │
     │◄─────────────────────────────────────────────────────────────────────
     │                         5. la notificación                          │
```

**Allo no guarda ningún token.** El paso 1 lo firma y lo olvida en la misma
llamada; el paso 3 lo trae Synapse dentro de cada petición. Un segundo registro
aquí sería uno que puede discrepar del del homeserver, y la forma de esa
discrepancia es un teléfono que dejó de sonar hace meses sin que nadie se
enterara.

## 3. `event_id_only`, y por qué no es un parámetro

Las salas de Allo están cifradas y la gateway **no puede recibir el texto de un
mensaje**. Con el formato por defecto, el homeserver manda en cada notificación
el `content` del evento, el `sender` y el nombre de la sala. En una sala cifrada
el contenido es texto cifrado —sobrevivible—, pero los metadatos no lo son, y en
una sala sin cifrar el contenido *es* el mensaje.

`AlloPusher` **no tiene campo para el formato** (`lib/matrix/types.ts`), y eso es
una decisión del mismo tipo que la de `AlloOutgoingAttachment` con el cifrado: un
parámetro ahí sería la vía por la que una pantalla, un refactor o un argumento
por defecto apagan la protección, y nada se vería distinto después, porque la
notificación seguiría llegando.

| | Quién lo garantiza |
|---|---|
| nativo | el binding: `PushFormat` en Rust tiene **una** variante, `EventIdOnly` |
| web | esta línea de `client.web.ts` y el test que la vigila (`__tests__/matrix/onePlacePushers.test.ts`) |

La gateway además **cuenta** si llega un campo que `event_id_only` excluye
(`plaintextFieldsPresent`): significa que existe un pusher registrado con el
formato equivocado y que va a seguir mandando texto hasta que se reemplace. Se
registran los **nombres** de los campos, nunca los valores; escribirlos en un log
sería la misma fuga con más retención.

## 4. La gateway

`POST /_matrix/push/v1/notify`, en `@allo/backend`.

Montada en `server.ts` **antes de `express.json()`, antes del middleware de
autenticación de Oxy y antes del rate limiter por usuario**, exactamente igual
que `/webhooks` y `/internal/bridges`. Un homeserver no tiene sesión de Oxy y no
se le puede dar una: detrás de ese middleware la ruta sólo podría contestar 401 a
su único llamador. El router trae su propio parser de cuerpo por lo mismo.

No se monta en absoluto si no hay ninguna plataforma configurada: un despliegue
sin push contesta 404, que es indistinguible de no tener la función — que es lo
que es.

Respuestas:

| Situación | Respuesta |
|---|---|
| entregado | `200 { "rejected": [] }` |
| el proveedor dice que el token está muerto | `200 { "rejected": ["<pushkey>"] }` |
| fallo transitorio en cualquier dispositivo | `502 { "rejected": [...] }` |
| el cuerpo no es una notificación | `400` |
| no trae token de capacidad | `401` |

El 502 es lo que devuelve la notificación a la cola de reintentos de Synapse, y
es lo que hace la gateway de referencia por la misma razón: la alternativa a un
duplicado es un mensaje del que nadie se enteró. Los dos emisores colapsan sobre
el `event_id` (`collapseKey` en FCM, `apns-collapse-id` en APNs), así que un
reintento sustituye el intento anterior en la pantalla de bloqueo en vez de
sonar dos veces.

## 5. Qué lleva la notificación, y qué no lleva

Lleva el `event_id`, el `room_id`, el número de no leídos, y **el texto que el
cliente eligió al registrarse**. No lleva el mensaje, porque la gateway no lo ha
visto nunca.

El texto viaja en `data.default_payload` del pusher, que el homeserver devuelve
intacto en `devices[].data` de cada notificación. Está ahí porque la gateway no
puede escribirlo: no conoce el mensaje (por diseño) y no conoce el idioma del
lector —`lang` se guarda en el pusher y no se reenvía—. El cliente conoce las dos
cosas, así que lo dice una vez, al registrarse. Una familia que usa Allo en
español lee «Nuevo mensaje», no «New message».

> Los dos SDK no se ponen de acuerdo en la forma: el binding de Rust parsea la
> cadena a un valor JSON antes de mandarla y `matrix-js-sdk` la manda tal cual,
> así que el mismo registro llega como objeto en un sitio y como cadena en el
> otro. La gateway acepta las dos.

**Se manda además un bloque `notification` visible**, y eso es una concesión
deliberada, no un descuido. Un mensaje sólo-de-datos es lo que querría un cliente
que descifra el evento en local, y es lo que Allo querrá el día que pueda; pero
hasta que algo lo escuche, un mensaje sólo-de-datos no le enseña nada al usuario.
Un mensajero que no notifica no se usa. Así que el sistema pinta la notificación
con el texto del cliente y las coordenadas viajan al lado, en `data`, para el día
en que la app pueda convertirlas en el mensaje de verdad. Ver §8.

Una notificación **sin `event_id`** no es un error: es la que manda Synapse
cuando el usuario ya ha leído en otro sitio y sólo hay que bajar el contador. Se
entrega como push silenciosa (`content-available` en iOS, datos en Android), sin
alerta. Anunciar mensajes que el usuario ya ha leído es exactamente lo que este
caso evita.

## 6. Cómo se protege una gateway que la especificación deja abierta

La Push Gateway API **no tiene autenticación**. Synapse hace POST a la URL que el
cliente puso en `data.url` y no manda credencial ninguna, y no se le puede
enseñar a mandarla: la gateway no la configura el servidor, la configura el
*cliente*. Una gateway publicada en internet sin pensarlo más acepta un POST de
cualquiera, y lo que hace ese POST es sonar un teléfono. Con un token de
dispositivo —algo que una app en el mismo móvil puede leer, y que no es un
secreto criptográfico— cualquiera podría notificar el teléfono de otro tantas
veces como quisiera. La gateway es un megáfono apuntando a los usuarios propios.

Lo único que viaja del cliente, por el homeserver, hasta nosotros en cada
notificación es **la URL**: Synapse valida que el `path` sea
`/_matrix/push/v1/notify` y guarda el resto literalmente, query string incluida.

No puede ser una constante compilada en la app: un secreto que se envía a todas
las instalaciones no es un secreto. Así que la URL se **acuña por dispositivo**
en `POST /api/push/gateway`, que sí está detrás de la sesión de Oxy, y el token
que lleva es un HMAC sobre la identidad del pusher:

```
t = base64url(HMAC-SHA256(secreto, len(app_id):app_id:pushkey))
```

Lo que da la propiedad que importa: **producir una URL que esta gateway sirva
exige a la vez una sesión de Oxy y el token del dispositivo concreto**. Tener un
token de dispositivo robado no basta, y tener una URL robada sólo llega al
dispositivo para el que se acuñó.

El mensaje va con prefijo de longitud y no con un separador: un `pushkey` es un
token opaco del proveedor y su alfabeto no es nuestro para prometer nada, y una
ambigüedad ahí compraría un token acuñado para el móvil del atacante que
autentica también el de otra persona.

Detrás de esto **no hay base de datos**. El token se recalcula a partir del
`app_id` y el `pushkey` de la propia petición y se compara en tiempo constante.

### 6.1 Rotación

`ALLO_PUSH_GATEWAY_SECRETS` es una **lista**. El primero acuña; todos verifican.
Se rota anteponiendo el nuevo, y el viejo se retira cuando todas las
instalaciones hayan arrancado una vez —un arranque vuelve a registrar el pusher
con una URL recién acuñada—.

Importa hacerlo así porque un token presente que **no** cuadra con el
dispositivo se contesta poniendo ese `pushkey` en `rejected`: significa que el
pusher lo acuñó otro —otro despliegue, un secreto ya retirado del todo, una
falsificación— y un pusher que esta gateway no puede servir vale más borrado que
reintentado eternamente. También se cura solo: la app acuña una URL nueva en el
arranque siguiente. Pero si se retiran **todos** los secretos a la vez, se borran
todos los pushers del sistema de golpe.

Una petición **sin token** es un 401, no un `rejected`: nada que se haya
registrado alguna vez con este despliegue produce una petición así, así que es un
escáner.

### 6.2 Lo que esto no cubre

No impide que alguien que tenga **las dos mitades** de un dispositivo lo notifique
repetidamente. La respuesta a eso es un rate limit, y deliberadamente no está
aquí: este proceso es uno de varios detrás de un balanceador, así que un limitador
en memoria sería N veces más laxo de lo que dice mientras parece exacto.
Corresponde al borde, donde es compartido. **Está sin hacer.**

## 7. La lista `rejected`, que es lo único que puede borrar un pusher vivo

`rejected` y «falló» se ven igual desde el servidor —no llegó nada— y significan
lo contrario para el homeserver:

- **`rejected`** hace que Synapse **borre el pusher**. Sólo es correcto si el
  proveedor dijo que el token está muerto para siempre: la app se desinstaló, el
  token se reemitió, nunca fue nuestro. Decirlo de un dispositivo vivo termina en
  silencio las notificaciones de esa persona, y nada en la app se ve distinto
  después.
- **fallo** se queda fuera de la lista y se contesta con 5xx, así que Synapse
  conserva el pusher y reintenta.

**Cuando los dos son difíciles de distinguir, la respuesta es «fallo».** Un error
se arregla esperando; el otro no se arregla.

| Proveedor | Se rechaza | Se conserva, aunque lo parezca |
|---|---|---|
| FCM | `registration-token-not-registered`, `invalid-registration-token`, `invalid-recipient` | `invalid-argument` (se devuelve también para un *mensaje* mal formado: nuestro mensaje es el mismo para todos los dispositivos, así que si alguna vez está mal lo está para todo el mundo, y tratarlo como token muerto borraría todos los pushers del sistema de una pasada), `sender-id-mismatch` (casi siempre es la credencial de este lado) |
| APNs | `BadDeviceToken`, `Unregistered` (410), `DeviceTokenNotForTopic` | `ExpiredProviderToken`, `InvalidProviderToken` (nuestra clave), `BadTopic`, `TopicDisallowed` (nuestra configuración), `PayloadTooLarge` (nuestro payload) |

También se rechaza un `app_id` que este despliegue no sirve: no hay proveedor que
pueda aceptarlo y nunca lo habrá con esta configuración, así que reintentarlo es
reintentarlo para siempre.

Los tests de esto están mutados: romper cada una de estas reglas hace fallar un
test concreto (ver el plan de pruebas del PR).

## 8. Configuración

Ninguna plataforma se publica a medias. Un `app_id` sin credenciales detrás es
una gateway que acepta notificaciones y las tira, así que
`loadPushConfig` **no arranca** en ese caso — misma regla que
`config/bridges.ts`.

| Variable | Para qué |
|---|---|
| `ALLO_PUSH_GATEWAY_URL` | la URL que se entrega a los clientes; su path debe ser exactamente `/_matrix/push/v1/notify` y no puede traer query |
| `ALLO_PUSH_GATEWAY_SECRETS` | lista separada por comas, el primero acuña; mínimo 32 caracteres cada uno |
| `ALLO_PUSH_ANDROID_APP_ID` | p. ej. `so.oxy.allo.android`; su presencia exige FCM |
| `ALLO_PUSH_IOS_APP_ID` | p. ej. `so.oxy.allo.ios`; su presencia exige APNs |
| `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_BASE64` | credencial de FCM |
| `ALLO_APNS_KEY_ID`, `ALLO_APNS_TEAM_ID`, `ALLO_APNS_PRIVATE_KEY_BASE64`, `ALLO_APNS_TOPIC` | credencial de APNs; la clave es el `.p8` entero en base64 |
| `ALLO_APNS_ENVIRONMENT` | `production` (por defecto) o `sandbox` |

Sin ninguna de las dos `APP_ID` no hay push y la gateway no se monta. Eso **no**
es un error de configuración: es un despliegue sin push.

La clave de APNs se valida al arrancar —que decodifique a un PEM y que sea una
clave de curva elíptica—, porque si no el fallo aparece al firmar la primera
notificación del día y se lee como «los iPhone no reciben nada».

### 8.1 APNs sin librería

APNs es un POST por dispositivo a `/3/device/<token>` con un JWT ES256 en una
cabecera, y Node trae cliente HTTP/2 y firma ECDSA en su biblioteca estándar. Una
dependencia aquí sería un tercero en el camino de cada notificación, sosteniendo
una clave privada, para un protocolo que cabe en un fichero.

Dos detalles que fallan en Apple y no en la compilación:

- **`dsaEncoding: 'ieee-p1363'`** no es opcional. Node firma ECDSA en DER por
  defecto, y una firma JWS es el par `r || s` en crudo; la firma DER es válida y
  no la acepta ningún verificador de JWT. Apple lo devuelve como
  `InvalidProviderToken`, que se lee como «la clave está mal».
- **El token se cachea 50 minutos.** Apple rechaza uno de más de una hora
  (`ExpiredProviderToken`) y rechaza a un proveedor que acuña más de uno cada
  veinte minutos (`TooManyProviderTokenUpdates`). Ni «uno por petición» ni «uno
  para siempre» son correctos: el intervalo seguro es una banda.

La conexión HTTP/2 se reutiliza, como pide Apple, y está `unref` mientras está
ociosa para que no impida terminar a un proceso que ya acabó.

## 9. Lo que queda sin hacer

Dicho en voz alta, por orden de cuánto se nota:

1. **La notificación no dice quién ni qué.** Dice «Nuevo mensaje». Enriquecerla
   con el mensaje descifrado es trabajo **nativo**: en iOS una *Notification
   Service Extension* (un target aparte que hay que crear con un config plugin) y
   en Android un servicio en segundo plano, y las dos tienen que arrancar el SDK
   de Matrix y descifrar el evento dentro de su presupuesto de tiempo. El formato
   de cable ya es el correcto (`event_id_only` + `mutable-content: 1`), así que
   ese trabajo es sólo de cliente y no necesita tocar el servidor ni volver a
   registrar los pushers.
2. **En web no hay push.** Un navegador no tiene token de APNs ni de FCM;
   `utils/notifications.ts` contesta `null` allí. `client.web.ts` implementa
   `registerPusher` de todos modos —el puerto es un contrato y medio contrato es
   peor que uno sin usar— pero nada lo llama. Web Push (VAPID) sería otro emisor
   en la gateway.
3. **No hay rate limit en la gateway** (§6.2).
4. **El nudge de «vuelve a enlazar tu cuenta» de los bridges ya no se manda.**
   `BridgeStatusService` llamaba a `sendPushToUser`, que buscaba tokens en una
   colección que nadie escribía: no era un aviso, era la apariencia de uno.
   Ahora se registra en el log. El sitio donde debería estar es un mensaje del bot
   del bridge en la sala de administración —que es un evento de Matrix y por
   tanto notificaría por el camino normal—, y eso es un cambio del lado del
   bridge.
5. **Los tokens de Oxy siguen ahí.** `packages/api` de OxyHQServices guarda
   `PushToken` con `token` + `platform` sin validar el formato, descarta el campo
   `type` que Allo mandaba, y envía por la Expo Push API, que sólo acepta
   `ExponentPushToken[...]`. Allo ya no le manda nada, pero el desajuste afecta a
   cualquier otra app de Oxy que llame a `getDevicePushTokenAsync()`. Está
   reportado, sin tocar ese repositorio.
6. **La preferencia de notificaciones pasó a ser por dispositivo.** Antes se
   guardaba por cuenta de Oxy (`pref:<userId>:notificationsEnabled`) y quien la
   leía no conocía ese id. Hay un token de dispositivo por móvil y por tanto un
   pusher; las claves viejas no se leen. El coste es que a quien las tuviera
   apagadas se le encienden una vez, que es la dirección segura en la que
   equivocarse en un mensajero, y puede volver a apagarlas en la misma pantalla.
