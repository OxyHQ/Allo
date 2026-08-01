# Orquestación de bridges multi-red

Diseño de la capa que permite a Allo hablar con WhatsApp, Telegram, Instagram y
demás redes a través de los bridges de [mautrix](https://github.com/mautrix),
desplegados por nosotros como application services contra nuestro homeserver.

**Estado**: documento de diseño. No hay código escrito para esto todavía.
**Fecha de la investigación**: 1 de agosto de 2026.

---

## 0. Cómo leer este documento

La investigación mezcla dos cosas y conviene no confundirlas:

- **[V]** — **Verificado**. Leído en el código fuente, en la configuración de
  ejemplo o en la documentación oficial del proyecto correspondiente. Cada
  afirmación marcada así tiene una fuente en §11.
- **[C]** — **Criterio**. Es una decisión de diseño mía o una inferencia. Puede
  estar equivocada; discutidla.
- **[?]** — **No confirmado**. No he podido verificarlo con las fuentes
  disponibles. Están todos recogidos también en §10 para que no se pierdan.

Las decisiones que ya venían tomadas (bridges en servidor, proxy residencial por
usuario, WhatsApp/Meta apagadas por flag, Telegram primero) se dan por hechas y
no se discuten. Sí señalo, donde procede, qué restricción técnica verificada
choca con ellas — porque una restricción no se negocia.

---

## 1. Resumen de las conclusiones que mandan sobre el diseño

Cinco hechos verificados condicionan toda la arquitectura. Si sólo se lee una
sección de este documento, que sea ésta.

1. **[V] Synapse carga los registros de appservice al arrancar, desde ficheros
   estáticos, y hay que reiniciarlo cada vez que se añade o se modifica uno.**
   No existe registro dinámico. Esto elimina de raíz el modelo "un bridge por
   usuario creado bajo demanda" que usa Beeper — Beeper puede hacerlo porque su
   homeserver es propio (hungryserv) y no tiene esa limitación. Nosotros no.

2. **[V] El proxy de salida se configura por proceso, no por usuario.** Ni
   `mautrix-whatsapp` ni `mautrix-meta` ni `mautrix-telegram` permiten asociar un
   proxy distinto a cada cuenta vinculada dentro del mismo proceso. En WhatsApp y
   Meta existe un endpoint `get_proxy_url` que el bridge consulta al conectar,
   pero **sólo le manda un parámetro `reason=login|connect`**: no hay forma de
   saber por qué usuario pregunta. Ambos ficheros llevan un comentario
   `// TODO this should be moved into mautrix-go`, o sea que la funcionalidad ni
   siquiera está en el framework.

3. **[V] Un proceso bridgev2 sirve a muchos usuarios de Matrix sin problema.**
   El modelo de datos es `User (mxid) 1—N UserLogin`, y los permisos se conceden
   por dominio o por MXID. Un proceso por red basta técnicamente.

4. De 2 + 3 sale la conclusión operativa: **[C] hay dos topologías, y la elección
   entre ellas la decide únicamente si la red necesita proxy por usuario.**
   Telegram, Slack, Discord y Matrix van en un proceso compartido por red.
   WhatsApp y Meta necesitan un proceso dedicado por usuario, y por tanto un
   *slot* de appservice preasignado (§4.3). Como esas dos redes van apagadas por
   flag hasta que haya presupuesto, la complejidad cara se paga cuando se
   encienden, no antes.

5. **[V] Los bridges son AGPLv3 y las excepciones de licencia que existen están
   concedidas nominalmente a Beeper y a Element. Allo no está en esa lista.**
   Ejecutarlos sin modificar es cómodo; parchearlos activa el §13 de la AGPL.
   Esto tiene consecuencias reales y está desarrollado en §7.

Un corolario incómodo: la única forma de dar a cada usuario un proxy distinto
**sin parchear los bridges** es aislar procesos. Si en algún momento se decide
compartir proceso en WhatsApp para ahorrar, hay que parchear, y entonces hay que
publicar el parche. No hay tercera opción.

---

## 2. Arquitectura appservice: qué implica para nuestro Synapse

### 2.1 Cómo se registra un bridge

**[V]** El flujo de alta de cualquier bridge mautrix moderno es:

```bash
./mautrix-telegram -e            # genera config.yaml de ejemplo
# ... editar homeserver.domain, homeserver.address, database.uri ...
./mautrix-telegram -g            # genera registration.yaml y escribe los tokens en config.yaml
# ... copiar registration.yaml donde Synapse pueda leerlo ...
./mautrix-telegram               # arrancar
```

**[V]** `-g` genera un fichero de registro y, en la misma operación, escribe
`as_token` y `hs_token` de vuelta en `config.yaml`. Por eso `-g` es incompatible
con `--no-update`: el bridge necesita persistir los tokens que acaba de generar.

**[V]** El registro que produce bridgev2 contiene:

| Campo | Valor |
|---|---|
| `id` | `appservice.id` de la config (por defecto el ID de la red) |
| `url` | `appservice.address` — dónde Synapse empuja las transacciones |
| `as_token` / `hs_token` | generados aleatoriamente |
| `sender_localpart` | **una cadena aleatoria de 32 caracteres**, no el nombre del bot |
| `rate_limited` | `false` |
| `namespaces.users` | **dos regex, ambas exclusivas**: la del bot (`^@telegrambot:dominio$`) y la de los ghosts, derivada de `username_template` |
| `de.sorunome.msc2409.push_ephemeral` / `receive_ephemeral` | según `appservice.ephemeral_events` |
| MSC4190 / MSC3202 | según `encryption.msc4190` y `encryption.appservice` |

Dos detalles que sorprenden y conviene tener presentes:

- **[V] bridgev2 no registra namespaces de alias ni de salas.** Sólo de usuarios.
  Los portales se crean sin alias. Si alguien esperaba poder resolver
  `#whatsapp_XXX:allo.oxy.so`, no va a existir.
- **[V] `sender_localpart` es aleatorio y distinto del bot visible.** El usuario
  del appservice y el bot que aparece en las salas de gestión no son el mismo
  MXID.

### 2.2 Lo que hay que tocar en Synapse

**[V]** En `homeserver.yaml`:

```yaml
app_service_config_files:
  - /data/appservices/allo-telegram.yaml
  - /data/appservices/allo-slack.yaml
  - /data/appservices/allo-discord.yaml
```

**[V]** Y, citando literalmente la documentación de mautrix:

> After updating the config, restart Synapse to apply changes. If you change or
> regenerate the registration file, you will need to restart Synapse every time.

**[C]** Consecuencias operativas que hay que asumir desde ya:

- El array de registros es parte del **estado de despliegue**, no del estado de
  la aplicación. Vive en el repo de infraestructura, versionado, no en Mongo.
- Añadir una red nueva = reinicio planificado de Synapse. Aceptable: pasa una vez
  por red.
- Añadir un *slot* de usuario para WhatsApp = reinicio de Synapse. **No
  aceptable** si se hace por cada alta. De ahí el pool preasignado de §4.3.
- Los ficheros de registro contienen `as_token`, que da control total sobre todo
  el namespace de ghosts. Van en el gestor de secretos, montados como fichero, y
  nunca en el repo.

**[V]** Los appservices no tienen límites de rate (`rate_limited: false`), lo cual
es necesario para el backfill pero significa que un bridge en bucle puede tumbar
Synapse sin que ningún limitador lo pare. **[C]** Hay que vigilarlo desde fuera.

### 2.3 Cifrado end-to-bridge y MAS

La Fase 1 despliega Synapse con MAS (MSC3861) y Oxy como OIDC. Eso interactúa
con los bridges de una forma concreta:

- **[V]** El login de appservice clásico (`m.login.application_service`) **no
  existe en MAS**. La documentación de MAS todavía dice, textualmente, que "los
  bridges cifrados no funcionarán con Matrix Authentication Service" y sugiere
  desactivar E2EE.
- **[V]** Esa página está desactualizada: la solución es **MSC4190** (gestión de
  dispositivos para appservices), que está fusionado en la spec, implementado en
  Synapse y soportado por los bridges de mautrix. La documentación de mautrix lo
  dice sin ambigüedad: *"the `encryption` → `msc4190` config option must be set to
  true for encryption to work if you use next-gen auth"*.
- **[V]** `encryption.msc4190: true` **cambia el fichero de registro** (añade el
  flag `io.element.msc4190`), o sea que hay que regenerarlo y reiniciar Synapse.
- **[V]** Se puede activar `msc4190` *antes* de migrar a MAS, y así los bridges
  siguen funcionando durante la migración.

**[C]** Regla para Fase 1: activar `encryption.msc4190: true` en todos los
bridges desde el primer despliegue, aunque todavía no estemos en MAS. Es gratis y
evita un incidente el día de la migración.

**[V]** `encryption.appservice: true` (MSC3202, recibir datos de cifrado por
transacción en vez de por `/sync`) requiere Synapse ≥ 1.141 con
`msc3202_transaction_extensions` y `msc2409_to_device_messages_enabled` en
`experimental_features`. La propia documentación de mautrix dice que **no es
recomendable**. **[C]** No lo usamos.

---

## 3. bridgev2: qué es y en qué estado está cada bridge

### 3.1 El framework

**[V]** `bridgev2` es un módulo dentro de `mautrix-go` (licencia **MPL-2.0**, no
AGPL — el framework y los bridges tienen licencias distintas). Contiene toda la
lógica genérica de puenteo y define interfaces a ambos lados:

- `NetworkConnector` — ciclo de vida del bridge: `Init`, `Start`,
  `GetCapabilities`, `GetConfig`, `GetLoginFlows`, `CreateLogin`, `LoadUserLogin`.
- `NetworkAPI` — una instancia por cuenta vinculada: `Connect`, `Disconnect`,
  `IsLoggedIn`, `LogoutRemote`, `HandleMatrixMessage`, `GetChatInfo`.
- `LoginProcess` — una máquina de estados de login por intento (§6).

**[V]** El cambio respecto a la arquitectura antigua lo describe Tulir así: *"In
the old architecture, bridges were strictly singletons"*. Con bridgev2 se pueden
instanciar varios en un proceso, que es de donde viene el nombre "megabridge".

**[V]** El modelo de datos es: `User` (clave: `bridge_id`, `mxid`) tiene N
`UserLogin` (clave: `bridge_id`, `user_mxid`, `id`). Los `Portal` llevan una
clave compuesta `{ID, Receiver}` donde `Receiver` es opcional y sirve para
segregar portales por cuenta.

**[V] Detalle importante y fácil de pasar por alto**: los bridges standalone
llaman a `bridgev2.NewBridge("", ...)` — es decir, `bridge_id` vacío. La columna
`bridge_id` sólo se usa de verdad cuando se embeben varios bridges en un proceso.
**[C] Consecuencia: dos procesos de bridge standalone no pueden compartir la
misma base de datos.** Cada proceso necesita su propia base (mismo servidor
Postgres, bases distintas) o su propio fichero SQLite.

### 3.2 Estado por bridge (comprobado el 2026-08-01)

| Bridge | Lenguaje | Arquitectura | Licencia | Notas |
|---|---|---|---|---|
| `mautrix/telegram` | **Go** | **bridgev2** | AGPL-3.0 | Reescrito de Python a Go en **v26.04** (abril 2026). Usa `gotd` (MTProto). |
| `mautrix/whatsapp` | Go | bridgev2 | AGPL-3.0 | `whatsmeow`. |
| `mautrix/meta` | Go | bridgev2 | AGPL-3.0 | Messenger + Instagram en un solo bridge. |
| `mautrix/signal` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/slack` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/gmessages` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/twitter` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/bluesky` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/linkedin` | Go | bridgev2 | AGPL-3.0 | |
| `mautrix/gvoice` | Go | bridgev2 | AGPL-3.0 | |
| **`mautrix/discord`** | Go | **legacy** | AGPL-3.0 | Sin `pkg/connector`. API de provisioning propia `/v1/*`. |
| `mautrix/googlechat` | **Python** | legacy | AGPL-3.0 | |

**Corrección al brief**: `mautrix-telegram` **ya no es Python**. Fue reescrito en
Go sobre bridgev2 en la release v26.04 (16 de abril de 2026), y desde entonces
sigue el mismo esquema CalVer y las mismas convenciones que el resto. El
changelog dice literalmente *"Rewrote bridge in Go using bridgev2 architecture"* y
que la migración desde v0.15.3 es in-place, con migración automática de base de
datos y config (aunque avisa de que no todo se migra: el relaybot antiguo no, y
partes de la config tampoco). Para nosotros, que partimos de cero, esto es una
buena noticia: **todas nuestras redes de lanzamiento excepto Discord hablan la
misma API de provisioning**.

**[C]** Discord es la excepción y hay que tratarla como tal: un adaptador
específico en el backend que traduzca nuestra API a `/_matrix/provision/v1/*`. Es
poco trabajo (login por QR o por token, logout, ping) pero no se puede reutilizar
el cliente genérico.

### 3.3 Modelo de despliegue

**[V]** Un binario bridgev2 = un proceso = un appservice = una red. Escucha en un
`hostname:port` propio y sirve, en el mismo listener HTTP:

- `/_matrix/app/v1/*` — transacciones del homeserver
- `/_matrix/provision/*` — API de provisioning (§6)
- `/_mautrix/publicmedia/*` — si se activa media pública
- `/debug/*` — pprof, si se activa

**[V]** `mxmain.BridgeMain` es el punto de entrada estándar y no expone forma de
correr dos redes en un proceso: eso requeriría escribir nuestro propio binario
instanciando varios `NetworkConnector`. **[C]** No merece la pena. Un proceso por
red, en contenedores separados.

**[V]** Base de datos: `postgres` o `sqlite3-fk-wal`. La documentación pide
PostgreSQL ≥ 16 para producción.

**[V]** Toda la config se puede pasar por variables de entorno mediante
`env_config_prefix`, con anidamiento por punto o por doble guion bajo
(`BRIDGE_APPSERVICE__AS_TOKEN`), y con sufijo `_FILE` para leer el valor de un
fichero. **[C] Esto es clave para el modelo de slots**: los procesos por usuario
se parametrizan enteramente por entorno, sin generar ficheros de config distintos.

---

## 4. Arquitectura de despliegue propuesta

### 4.1 Topología A — proceso compartido (Telegram, Slack, Discord, Matrix)

**[C]** Un proceso por red, multiusuario, con un único registro de appservice.

```
Synapse ──appservice──> allo-bridge-telegram   (:29317)  ──MTProto──> Telegram
        ──appservice──> allo-bridge-slack      (:29318)  ──HTTPS───> Slack
        ──appservice──> allo-bridge-discord    (:29319)  ──WS──────> Discord
                              │
                              └── Postgres: una base por bridge
```

Configuración relevante:

```yaml
bridge:
  permissions:
    "*": relay              # nadie de fuera puede loguearse
    "allo.oxy.so": user     # todos nuestros usuarios pueden vincular cuentas
    "@allo-admin:allo.oxy.so": admin
  split_portals: true       # ver más abajo — IRREVERSIBLE
  bridge_status_notices: none
  cleanup_on_logout:
    enabled: true
homeserver:
  status_endpoint: https://api.allo.oxy.so/internal/bridges/status
provisioning:
  shared_secret: <secreto de 32+ chars, del gestor de secretos>
  allow_matrix_auth: false  # sólo el backend habla con el bridge
encryption:
  allow: true
  default: true
  msc4190: true
```

**`split_portals: true` merece un párrafo propio.** **[V]** Su comentario en la
config de ejemplo dice, textualmente:

> Should every user have their own portals rather than sharing them? By default,
> users who are in the same group on the remote network will be in the same
> Matrix room bridged to that group. If this is set to true, every user will get
> their own Matrix room instead.
> **SETTING THIS IS IRREVERSIBLE AND POTENTIALLY DESTRUCTIVE IF PORTALS ALREADY
> EXIST.**

**[C] Hay que ponerlo a `true` desde el primer despliegue, antes de que exista un
solo portal.** Con el valor por defecto, dos usuarios de Allo que estén en el
mismo grupo de Telegram acabarían **en la misma sala de Matrix**, viéndose
mutuamente y descubriendo que el otro usa Allo. Para un producto de consumo eso
es una fuga de privacidad, no una optimización. El coste es más salas y más
tráfico; se paga.

Los ghosts (`@telegram_123456:allo.oxy.so`) **[V]** siguen siendo compartidos
entre usuarios aunque los portales estén separados. Eso está bien: un contacto de
Telegram es la misma persona para todos.

### 4.2 Por qué compartido y no aislado en estas redes

**[C]** Porque no hay razón para aislar:

- No necesitan proxy por usuario, que es lo único que fuerza el aislamiento.
- Un proceso escala a miles de `UserLogin` — Telegram mantiene una conexión
  MTProto por cuenta, que es barata.
- Un registro de appservice, un reinicio de Synapse, para siempre.
- El coste marginal por usuario es memoria y conexiones, no un contenedor.

El precio: **[C]** un compromiso del proceso o de su base de datos expone las
sesiones de *todos* los usuarios de esa red. Está en la lista de riesgos (§9.7) y
se mitiga con cifrado en reposo y aislamiento de red, no con arquitectura.

### 4.3 Topología B — slot dedicado por usuario (WhatsApp, Meta)

**[C]** Aquí el proxy por usuario obliga a un proceso por usuario, y Synapse
obliga a que el registro exista antes de que el usuario se dé de alta. La
solución es un **pool de slots preasignados**.

Un *slot* es una tupla estática, creada en despliegue:

| Elemento | Ejemplo |
|---|---|
| ID de appservice | `allo-wa-0042` |
| Fichero de registro | `/data/appservices/allo-wa-0042.yaml` |
| `username_template` | `wa0042_{{.}}` → ghosts `@wa0042_34600111222:allo.oxy.so` |
| Bot | `@wa0042bot:allo.oxy.so` |
| Puerto | `29500 + 42` |
| Base de datos | SQLite en volumen propio, o `allo_wa_0042` en Postgres |
| Proxy | resuelto en runtime vía `get_proxy_url` (§8) |

Ciclo de vida:

1. En despliegue se generan N slots (p. ej. 128), sus registros y sus entradas en
   `app_service_config_files`. **Un** reinicio de Synapse.
2. Los slots arrancan *apagados*. Un slot sin usuario no consume nada.
3. Cuando un usuario vincula WhatsApp, el backend reserva un slot libre, le
   asigna un proxy (§8), arranca el contenedor con el entorno del slot y le
   manda el login por la API de provisioning.
4. Al desvincular, el contenedor se para, el slot se marca en cuarentena durante
   un periodo, y luego vuelve al pool. **[C]** La cuarentena existe porque el
   namespace de ghosts es del slot: reciclarlo inmediatamente haría que el
   siguiente usuario heredase MXIDs de ghosts con historial ajeno.
5. Cuando el pool baja de un umbral, se amplía en bloque, con un reinicio
   planificado.

**[C] Esto es caro y hay que decirlo claro.** Un contenedor y una IP por usuario
de WhatsApp. Con proxies ISP estáticos en el rango de precios habitual del
mercado, el coste marginal por usuario de WhatsApp es del orden de unos pocos
dólares al mes sólo en IP, más el cómputo. **[?]** No he verificado precios de
ningún proveedor concreto; hay que pedir presupuesto antes de comprometer nada.
Es exactamente el motivo por el que estas redes van apagadas por flag.

**[C] Cómo se le pasa el proxy al proceso sin parchear el bridge.** Ésta es la
pieza que hace que el diseño funcione:

**[V]** `getProxy` construye la URL así: parsea `get_proxy_url` como URL,
**preserva su query string existente** y le añade `reason`. Es decir, si
configuramos:

```yaml
network:
  get_proxy_url: https://api.allo.oxy.so/internal/bridges/proxy?slot=allo-wa-0042&t=<token>
```

el bridge llamará a
`.../internal/bridges/proxy?slot=allo-wa-0042&t=<token>&reason=connect`, y el
backend sabe perfectamente para quién es. **La falta de identificador por login
deja de importar cuando el proceso tiene un solo login.** Con esto no hace falta
tocar ni una línea del código de mautrix, y por tanto no se activa el §13 de la
AGPL.

**[C]** El token del query string es un secreto por slot, rotable, distinto del
`shared_secret` de provisioning. Sin él, cualquiera que llegue al endpoint podría
enumerar la asignación de proxies.

### 4.4 Lo que NO vamos a hacer, y por qué

- **Un appservice por usuario creado bajo demanda.** **[V]** Imposible con
  Synapse: reinicio por alta.
- **Compartir proceso en WhatsApp con proxies distintos por usuario.** **[V]**
  Requiere parchear `updateProxy` para pasar el `UserLoginID`. Técnicamente son
  unas diez líneas. Legalmente, activa la AGPL §13 (§7).
- **Enrutar el egress por namespace de red en un proceso compartido.** **[C]** No
  funciona: en un proceso compartido nada en el paquete IP identifica al usuario,
  así que no hay criterio por el que enrutar.
- **hungryserv o cualquier homeserver alternativo.** **[C]** Propietario de
  Beeper. No es una opción.

---

## 5. La API de orquestación de `@allo/backend`

### 5.1 Principio: la app nunca habla con un bridge

**[C]** Todo pasa por el backend. Tres razones, en orden de importancia:

1. **[V]** El `shared_secret` de provisioning permite actuar **como cualquier
   usuario** de ese bridge: el middleware compara el header con el secreto y, si
   coincide, se cree el `?user_id=` del query string sin más comprobaciones. Ese
   secreto no puede salir del servidor jamás.
2. El flag por red tiene que aplicarse en servidor (§7 del brief, §9 aquí). Si la
   app hablara con los bridges, la lista de redes sería un dato del cliente.
3. El backend necesita estar en el camino para reservar slot y proxy *antes* de
   que empiece el login.

**[C] Regla de seguridad no negociable**: el MXID que se manda en `?user_id=` se
deriva **siempre** de la identidad Oxy autenticada (`getRequiredOxyUserId(req)`),
nunca de nada que venga en el cuerpo o en la query de la petición del cliente.
Aceptar un MXID del cliente convertiría el endpoint en un "vincula la cuenta de
quien quieras".

**[V]** Además, `bridge.permissions` tiene que conceder nivel `user` a nuestro
dominio: el middleware rechaza con 403 si `user.Permissions.Login` es falso.

### 5.2 Superficie HTTP

Siguiendo la convención de `server.ts` — rutas autenticadas bajo `/api` con
`createOxyAuthMiddleware`, webhooks internos montados aparte y antes de
`express.json()` si necesitan cuerpo crudo.

```
# Públicas para el usuario autenticado
GET    /api/bridges/networks
GET    /api/bridges/accounts
POST   /api/bridges/networks/:network/link
GET    /api/bridges/links/:linkId
POST   /api/bridges/links/:linkId/submit
DELETE /api/bridges/links/:linkId
DELETE /api/bridges/accounts/:accountId
POST   /api/bridges/accounts/:accountId/reconnect

# Internas: sólo las llaman los bridges, nunca la app
POST   /internal/bridges/status
GET    /internal/bridges/proxy
```

#### `GET /api/bridges/networks`

Catálogo de redes **habilitadas** (§9). Es la única fuente de verdad para la
pantalla de "vincular cuenta": la app no lleva lista propia.

```jsonc
{
  "networks": [
    {
      "id": "telegram",
      "displayName": "Telegram",
      "icon": "mxc://allo.oxy.so/...",
      "loginFlows": [
        { "id": "phone", "name": "Número de teléfono", "description": "..." },
        { "id": "qr",    "name": "Código QR",          "description": "..." }
      ],
      "capabilities": { "secretChats": false }
    }
  ]
}
```

**[C]** `loginFlows` se obtiene del bridge (`GET /v3/login/flows`) y se cachea,
pero se **filtra**: `bot` y `manual` de Telegram no se exponen a usuarios finales.
Un flujo que la UI no sabe pintar no debe llegar a la UI.

#### `POST /api/bridges/networks/:network/link`

Inicia una vinculación. Cuerpo: `{ "flowId": "phone" }`.

Lo que hace el backend, en orden:

1. Comprueba que la red está habilitada. **Si no lo está, 404** (§9).
2. Comprueba el límite de cuentas por usuario y por red.
3. Si la red es de Topología B: reserva slot, asigna o recupera el lease de proxy
   (§8), arranca el proceso, espera a que esté sano.
4. `POST /_matrix/provision/v3/login/start/{flowId}?user_id=<mxid>` contra el
   bridge.
5. Persiste una `BridgeLinkSession` y devuelve el primer paso ya traducido.

```jsonc
{
  "linkId": "lnk_01J...",
  "expiresAt": "2026-08-01T12:34:56Z",
  "step": {
    "type": "user_input",
    "stepId": "fi.mau.telegram.login.phone_number",
    "instructions": "Introduce tu número de teléfono en formato internacional",
    "fields": [
      { "id": "fi.mau.telegram.login.phone_number", "type": "phone_number",
        "name": "Número de teléfono", "pattern": "^\\+[0-9]+$" }
    ]
  }
}
```

**[V]** Los tipos de paso que puede devolver bridgev2 son exactamente:
`user_input`, `cookies`, `client_http`, `display_and_wait`, `webauthn`,
`complete`. Los tipos de campo de `user_input`: `username`, `password`,
`phone_number`, `email`, `2fa_code`, `token`, `url`, `domain`, `select`,
`captcha_code`. Los tipos de `display_and_wait`: `qr`, `emoji`, `code`, `nothing`.

**[C]** De esos seis tipos de paso, para el lanzamiento sólo hay que soportar
`user_input`, `display_and_wait` y `complete`. `cookies` y `client_http` son de
Meta (webview) y llegan con el flag de Meta. `webauthn` aparece en el login de
WhatsApp por passkey; **[V]** existe la opción `provisioning.fail_on_webauthn`
precisamente para que los clientes que no lo soportan reciban un error rastreable
en vez de colgarse. Ponerla a `true` hasta que la app lo implemente.

#### `POST /api/bridges/links/:linkId/submit`

Manda la respuesta del usuario al paso actual. El backend traduce a
`POST /v3/login/step/{loginProcessID}/{stepID}/{stepType}` y devuelve el paso
siguiente, con la misma forma que arriba. Cuando el tipo es `complete`, la
respuesta incluye la cuenta ya creada.

#### `GET /api/bridges/links/:linkId`

Para pasos `display_and_wait`. **[V]** En el protocolo del bridge esto es
`POST .../display_and_wait`, una llamada **bloqueante** que no vuelve hasta que
hay un paso nuevo.

**[C]** El backend mantiene esa llamada larga abierta contra el bridge y expone al
móvil dos caminos: emisión por Socket.io (ya existe infraestructura en
`server.ts`, namespace de mensajería) y este `GET` como long-poll de respaldo con
timeout propio. Un móvil no puede sostener una petición HTTP colgada
indefinidamente; el socket es el camino bueno y el poll el que funciona siempre.

**[V] El QR de WhatsApp caduca rápido**: el primer código vale 1 minuto y los
cinco siguientes 20 segundos cada uno — unos 2 minutos y 40 segundos de ventana
total, tras la cual el login expira. Cada refresco es un paso
`display_and_wait` nuevo con el mismo `stepId`. **[C]** La app tiene que repintar
el QR sin reiniciar la sesión, y `expiresAt` de la `BridgeLinkSession` debe
reflejar esa ventana real, no un valor genérico de 10 minutos.

#### `DELETE /api/bridges/accounts/:accountId`

`POST /v3/logout/{loginID}`. En Topología B, además para el proceso y libera el
slot a cuarentena. **[C]** El lease de proxy **no se libera**: si el usuario
vuelve a vincular la misma red, tiene que salir por la misma geografía (§8).

### 5.3 Estados de una cuenta vinculada

**[V]** El bridge emite `BridgeState` con `state_event` en este conjunto cerrado:
`STARTING`, `UNCONFIGURED`, `RUNNING`, `BRIDGE_UNREACHABLE`, `CONNECTING`,
`BACKFILLING`, `CONNECTED`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`,
`UNKNOWN_ERROR`, `LOGGED_OUT`. Junto con: `error` (código), `message`, `reason`,
`info`, `remote_id`, `remote_name`, `remote_profile`, `ttl`, `timestamp` y
`user_action` (`OPEN_NATIVE`, `RELOGIN`, `RESTART`).

**[C]** Ese vocabulario es demasiado fino para una UI. Lo colapsamos a seis
estados, y guardamos el original para diagnóstico:

| Estado de Allo | Estados del bridge | Qué ve el usuario | Acción |
|---|---|---|---|
| `linking` | (sesión de login abierta) | "Conectando tu cuenta…" | — |
| `connecting` | `STARTING`, `CONNECTING`, `BACKFILLING` | "Sincronizando…" | — |
| `connected` | `CONNECTED`, `RUNNING` | verde | — |
| `degraded` | `TRANSIENT_DISCONNECT` | "Reconectando…" | ninguna, es transitorio |
| `action_required` | `BAD_CREDENTIALS`, `LOGGED_OUT` | "Vuelve a vincular" | re-login |
| `failed` | `UNKNOWN_ERROR`, `UNCONFIGURED`, `BRIDGE_UNREACHABLE` | "Hay un problema" | reintentar / soporte |

**[C]** `degraded` no se enseña inmediatamente. **[V]** El propio bridge trae
`bridge.transient_state_debounce` para retener `TRANSIENT_DISCONNECT` y
`CONNECTING` un rato antes de reportarlos, y si llega otro estado mientras tanto
el anterior no se reporta en absoluto. Se configura a unos 30 segundos y así una
reconexión normal no genera ni una notificación.

**[V]** `BAD_CREDENTIALS` y `LOGGED_OUT` son distintos: el primero es "las
credenciales dejaron de valer", el segundo es "la red cerró la sesión". Para el
usuario son lo mismo (hay que volver a vincular), pero para nosotros no: una
subida de `LOGGED_OUT` en una red concreta es la señal temprana de una oleada de
baneos. **[C]** Se alertan por separado.

### 5.4 Cómo se reporta una desconexión

**[V]** `homeserver.status_endpoint` hace que el bridge mande un `POST` con el
`BridgeState` en JSON cada vez que cambia el estado de la conexión remota de un
usuario, autenticado con `Authorization: Bearer <as_token>`.

**[C]** Nuestro receptor:

```
POST /internal/bridges/status
```

1. Se monta **antes** de `express.json()` y de la autenticación de Oxy, igual que
   `/webhooks` para CrowdSource.
2. Autentica comparando el bearer contra el `as_token` del bridge que
   corresponda, en tiempo constante. Cada bridge tiene su token; el header
   identifica de cuál viene.
3. Mapea `remote_id` → `BridgeAccount` y actualiza estado.
4. Si el estado nuevo es `action_required`, encola una notificación push. Con
   deduplicación: `BAD_CREDENTIALS` se reenvía mientras persista.

**[V] El TTL es la pieza que detecta el silencio.** `BridgeState.Fill` pone
`ttl: 3600` cuando hay error y `ttl: 21600` cuando no. Y `ShouldDeduplicate`
considera un estado repetido sólo si además no ha vencido su TTL — o sea que el
bridge **reenvía** el mismo estado al caducar. **[C]** Por tanto: un barrido
periódico que marque como `failed` (con motivo `stale`) toda cuenta cuyo último
estado sea más viejo que su TTL más un margen. Eso cubre el caso "el proceso se
murió y no dijo nada", que es justo el que ningún webhook puede reportar.

**[C]** El backend **no** hace polling de `/v3/whoami` en régimen normal. Sólo al
arrancar, para reconciliar, y cuando una cuenta lleva demasiado tiempo sin
noticias. **[V]** `whoami` devuelve `logins[]` con `state`, `id`, `name`,
`profile` y `space_room`, que es exactamente lo que hace falta para reconciliar.

### 5.5 Modelo de datos (Mongo)

**[C]** Tres colecciones nuevas, siguiendo el estilo de `packages/backend/src/models`:

**`BridgeAccount`** — una cuenta vinculada.
`oxyUserId`, `network`, `remoteLoginId`, `remoteName`, `remoteProfile`,
`slotId?`, `state`, `rawState` (`{stateEvent, error, message, reason, ttl, at}`),
`spaceRoomId`, `linkedAt`, `lastStateAt`, `lastConnectedAt`.
Índice único `{oxyUserId, network, remoteLoginId}`; índice `{state, lastStateAt}`
para el barrido de TTL.

**`BridgeLinkSession`** — un intento de vinculación en curso.
`linkId`, `oxyUserId`, `network`, `flowId`, `slotId?`, `remoteLoginProcessId`,
`currentStepId`, `currentStepType`, `expiresAt`, `outcome`. TTL index sobre
`expiresAt`. **[C]** Nunca almacena lo que el usuario ha escrito: ni teléfonos, ni
códigos, ni contraseñas de 2FA. Se pasan al bridge y se olvidan.

**`BridgeProxyLease`** — §8.

**[C]** Ninguna de estas colecciones guarda credenciales de la red remota. Las
sesiones de WhatsApp o Telegram viven en la base de datos del bridge, cifrada en
reposo, y el backend no las ve nunca. Es una frontera que conviene mantener
explícita.

---

## 6. Flujo de vinculación: cómo es de verdad

### 6.1 Existe API de provisioning, y es buena

**[V]** No hace falta hablarle a la sala de administración. bridgev2 expone una
API HTTP en `/_matrix/provision/` sobre el mismo listener del appservice, con
estas rutas:

```
GET  /v3/whoami
GET  /v3/capabilities
GET  /v3/login/flows
POST /v3/login/start/{flowID}
POST /v3/login/step/{loginProcessID}/{stepID}/{stepType}
POST /v3/login/cancel/{loginProcessID}
POST /v3/logout/{loginID}
GET  /v3/logins
GET  /v3/contacts
POST /v3/search_users
GET  /v3/resolve_identifier/{identifier}
POST /v3/create_dm/{identifier}
POST /v3/create_group/{type}
POST /v3/backfill/{roomID}
GET  /v3/image_pack/import  |  POST /v3/image_pack/import  |  GET /v3/image_pack/list
```

**[V]** Autenticación, por orden de intento en el middleware:

1. `Authorization: Bearer <shared_secret>` + `?user_id=<mxid>` → acceso total,
   actuando como ese usuario. **Es el que usamos.**
2. `Authorization: Bearer <access_token_matrix>` + `?user_id=<mxid>` → el bridge
   valida el token haciendo `/whoami` contra el homeserver. Requiere
   `allow_matrix_auth: true`.
3. `Authorization: Bearer openid:<token>` → valida por federación con
   `GetOpenIDUserInfo`.

En los tres casos, después se comprueba `user.Permissions.Login`.

**[V]** Hay CORS habilitado en el router de provisioning, y `mautrix/manager` es
una app Electron oficial que usa exactamente esta API para gestionar logins. O
sea: es una API pensada para ser consumida por clientes, no un detalle interno.

**[V]** Existen dos ganchos, `GetAuthFromRequest` y `GetUserIDFromRequest`, para
sacar el token y el MXID de otro sitio. **[C]** Sólo sirven si escribimos nuestro
propio binario; con los binarios oficiales no están disponibles.

**[V]** `mautrix-discord`, al ser legacy, expone otra cosa:
`/v1/ping`, `/v1/login/qr`, `/v1/login/token`, `/v1/logout`, `/v1/reconnect`,
`/v1/disconnect`, `/v1/guilds`. Adaptador aparte.

### 6.2 Telegram: teléfono y código

**[V]** Cuatro flujos declarados: `phone`, `qr`, `bot`, `manual` (este último con
descripción literal *"Log in using existing session credentials (advanced, do not
use)"*).

El flujo `phone`, con IDs de paso reales:

| Paso | Tipo | `stepId` |
|---|---|---|
| 1 | `user_input` (`phone_number`) | `fi.mau.telegram.login.phone_number` |
| 2 | `user_input` (`2fa_code`) | `fi.mau.telegram.login.code` |
| 2b | `user_input` (`2fa_code`), tras código erróneo | `fi.mau.telegram.login.code.incorrect` |
| 3 | `user_input` (`password`), si hay 2FA | `fi.mau.telegram.login.password` |
| 3b | idem, tras contraseña errónea | `fi.mau.telegram.login.password.incorrect` |
| 4 | `complete` | `fi.mau.telegram.login.complete` |

**[V] El código de 6 dígitos no llega por SMS: llega a otro cliente de Telegram ya
autenticado.** La documentación lo dice: hace falta tener la app oficial. **[C]**
Esto hay que explicarlo en la UI o generará soporte: el usuario va a mirar los
SMS.

**[V]** Errores tipados que la app puede tratar:
`FI.MAU.TELEGRAM.INVALID_PASSWORD`, `FI.MAU.TELEGRAM.PHONE_CODE_INVALID`,
`FI.MAU.TELEGRAM.SIGN_UP_NOT_SUPPORTED` (no se pueden crear cuentas nuevas desde
el bridge; Telegram cerró el registro por terceros en febrero de 2023).

**[V]** El bridge valida y normaliza el teléfono antes de enviarlo
(`CleanPhoneNumber`: quita espacios, guiones y paréntesis; exige `+` inicial y
sólo dígitos después). **[C]** La app debe hacer la misma validación con el
`pattern` que viene en el campo, para no gastar un viaje.

### 6.3 WhatsApp: QR y código de emparejamiento

**[V]** Dos flujos: `qr` ("Scan a QR code to pair the bridge to your WhatsApp
account") y `phone` ("Input your phone number to get a pairing code"). Pasos:
`fi.mau.whatsapp.login.qr` (`display_and_wait` tipo `qr`),
`fi.mau.whatsapp.login.phone` (`user_input`),
`fi.mau.whatsapp.login.code` (`display_and_wait` tipo `code`),
`fi.mau.whatsapp.login.passkey` (`webauthn`),
`fi.mau.whatsapp.login.complete`.

**[V]** Errores propios: `ErrLoginMultideviceNotEnabled` (QR escaneado sin
multidispositivo), `ErrLoginClientOutdated`, `ErrLoginTimeout`,
`ErrRateLimitedByWhatsApp`, `FI.MAU.WHATSAPP.PAIR_ERROR`.

**[V] `proxy_only_login`**: si se activa, el proxy se usa **sólo** para el
websocket de login, no para la conexión autenticada ni para media. **[C]** Para
nuestro caso hay que dejarlo en `false`: queremos que *toda* la sesión salga por
la IP del país del usuario, no sólo el emparejamiento. Una sesión que se empareja
desde España y luego conecta desde un datacenter alemán es peor que no usar proxy.

### 6.4 Meta (Instagram/Messenger)

**[V]** El login es por **cookies** (`LoginStepTypeCookies`): el bridge devuelve
una URL, una lista de campos a extraer (cookies, local storage, cabeceras de
petición o campos del cuerpo), opcionalmente un snippet de JavaScript
(`extract_js`) y un `wait_for_url_pattern`. El cliente tiene que abrir un webview,
dejar que el usuario se loguee en Meta y extraer los valores.

**[C]** Esto es trabajo real en la app: un webview con inyección de JS y
extracción de cookies. No es "otro flujo más", es un componente nuevo. Cuando se
encienda el flag de Meta, hay que presupuestarlo aparte.

**[V]** Modos disponibles: `facebook`, `facebook-tor`, `messenger`,
`messenger-lite`, `messenger-lite-android`, o `unset` para que el usuario elija.
Se restringen con `allowed_modes`.

---

## 7. Licencias: AGPLv3 y qué significa exactamente para nosotros

**Esto no es asesoramiento legal.** Es la lectura literal de las licencias, para
que quien tenga que decidir lo haga con los hechos delante. **[C] Antes de
encender WhatsApp o Meta en producción hay que pasar esta sección por un abogado.**

### 7.1 Los hechos

**[V]** Licencias comprobadas hoy:

- `mautrix/go` (el framework, incluido `bridgev2`): **MPL-2.0**.
- Todos los bridges (`whatsapp`, `telegram`, `meta`, `signal`, `slack`,
  `discord`, `gmessages`, `twitter`, `bluesky`, `linkedin`, `gvoice`,
  `googlechat`): **AGPL-3.0**.

**[V]** Casi todos los bridges llevan además un fichero `LICENSE.exceptions`, con
este texto (el de mautrix-telegram, idéntico en los demás salvo el nombre):

> The mautrix-telegram developers grant the following special exceptions:
>
> - to **Beeper** the right to embed the program in the Beeper clients and
>   servers, and use and distribute the collective work without applying the
>   license to the whole.
> - to **Element** the right to distribute compiled binaries of the program as a
>   part of the Element Server Suite and other server bundles without applying
>   the license.
>
> All exceptions are only valid under the condition that any modifications to the
> source code of mautrix-telegram remain publicly available under the terms of the
> GNU AGPL version 3 or later.

**Allo no está en esa lista.** Las excepciones son nominativas. Que Beeper haga
algo no significa que nosotros podamos hacerlo.

*(`mautrix/discord` no tiene `LICENSE.exceptions`: AGPL pura.)*

### 7.2 Ejecutarlos sin modificar

**[V]** AGPLv3 §13, literal:

> Notwithstanding any other provision of this License, **if you modify the
> Program**, your modified version must prominently offer all users interacting
> with it remotely through a computer network (if your version supports such
> interaction) an opportunity to receive the Corresponding Source of your version
> by providing access to the Corresponding Source from a network server at no
> charge, through some standard or customary means of facilitating copying of
> software.

La obligación adicional de la AGPL respecto a la GPL **se dispara al modificar**.
Si ejecutamos los binarios oficiales tal cual, sin tocar el código:

- **[C]** No hay "conveying" (no distribuimos el binario a nadie), así que no se
  activan §5 ni §6.
- **[C]** No hay modificación, así que no se activa §13.
- **[C]** Sigue siendo prudente publicar un aviso indicando qué versión exacta de
  qué bridge se está ejecutando y enlazar al repo original. Cuesta nada y es la
  interpretación defensiva.

### 7.3 ¿Contamina nuestro backend?

**[C]** Nuestro backend habla con los bridges por HTTP, entre procesos distintos,
en contenedores distintos, mediante una API pública y documentada. La posición
tradicional de la FSF es que procesos separados que se comunican a distancia
(sockets, tuberías, argumentos de línea de órdenes) forman normalmente programas
separados, no una obra combinada. Y **[V]** el §5 de la AGPL reconoce el
"agregado": *"a compilation of a covered work with other separate and independent
works, which are not by their nature extensions of the covered work, and which
are not combined with it such as to form a larger program"*.

**[C] Pero esto es zona gris de verdad, no una formalidad.** El criterio de
"programa separado" no está en el texto de la licencia sino en su interpretación,
y depende de hechos concretos: si el backend es inútil sin el bridge, si comparten
estructuras de datos íntimas, si se distribuyen juntos. Nuestro caso está del lado
bueno (API HTTP genérica, el backend hace muchas otras cosas), pero **[?]** no
puedo afirmar que un tribunal lo vea igual. Que lo mire un abogado.

### 7.4 Si parcheamos

**[C]** Aquí no hay ambigüedad. Parchear el bridge —por ejemplo, para pasar el
`UserLoginID` a `get_proxy_url`— nos convierte en autores de una versión
modificada, y §13 exige ofrecer el código fuente correspondiente **a todos los
usuarios que interactúen con él remotamente por red**.

Preguntas abiertas que hay que resolver antes, no después:

- **[?]** ¿Quién es "user interacting with it remotely"? Si sólo nuestro backend
  habla con el bridge, se puede argumentar que los usuarios finales interactúan
  con el backend y no con el bridge. Es un argumento fino y no me fío de él.
- **[C]** La postura segura y barata: publicar el fork parcheado en un repo
  público bajo AGPL, con los cambios encima del upstream. No expone nada de valor
  —el parche sería "pasa el login ID en la query string"— y elimina el problema
  entero.
- **[C]** Y nótese que la excepción de Beeper y Element **también** exige que las
  modificaciones sigan siendo públicas. Ni siquiera ellos pueden parchear en
  privado.

### 7.5 Recomendación

**[C]**

1. **No parchear.** El diseño de §4.3 (un slot por usuario + el identificador en
   el query string de `get_proxy_url`) consigue el proxy por usuario sin tocar una
   línea. Ésa es la razón principal para preferirlo, por encima incluso de la
   operativa.
2. Si en algún momento hace falta parchear, se hace **en público desde el primer
   commit**. Un fork privado que luego hay que abrir es un incidente; uno abierto
   desde el principio no es nada.
3. Mantener un inventario de qué versión exacta de qué bridge corre en producción,
   con su hash. Es requisito de cumplimiento y además hace falta para depurar.
4. Consulta legal antes de encender WhatsApp o Meta.

---

## 8. El asignador de proxies

### 8.1 El requisito, y la tensión que esconde

El requisito es: **un proxy estable por usuario y red, en el país del usuario**.
Un cambio de país entre sesiones es señal de detección, así que la estabilidad
importa más que la rotación.

**[C] Hay una tensión real que conviene ver antes de diseñar nada.** "Residencial"
y "estable durante meses" son, en el mercado de proxies, casi excluyentes:

- **[V]** Los proxies residenciales rotativos con sesión pegajosa mantienen la IP
  típicamente **10–30 minutos**, y algunos proveedores llegan a 24 horas. Son IPs
  de dispositivos reales de una red de pares; no se pueden reservar
  indefinidamente porque el dispositivo se apaga.
- **[V]** Lo que se comercializa como "static residential" es casi siempre un
  **proxy ISP**: una IP alojada en datacenter pero registrada a nombre de un ISP.
  Ésas sí se mantienen durante meses, y se facturan por IP y mes.

**[C]** Es decir: no se puede tener a la vez "IP residencial de verdad" y "la
misma IP durante seis meses". Hay que elegir qué invariante se protege. Mi
recomendación es proteger **la geografía, no la IP**:

> El invariante que el asignador garantiza es que un usuario sale siempre por el
> **mismo país, la misma región y el mismo ASN**. La IP concreta puede cambiar.

Esto es lo correcto de todas formas, porque es lo que miran los antifraude: un
salto de España a Alemania entre sesiones es una señal; un cambio de IP dentro del
mismo rango de un ISP español es lo que le pasa a cualquier usuario doméstico
cuando su router renegocia la conexión.

**[C]** Con eso, la decisión de producto es:

- **Proxy ISP estático, uno por usuario**, para WhatsApp y Meta. Máxima
  estabilidad; el riesgo es que el ASN sea reconocible como hosting.
- **Residencial con sesión pegajosa y país fijo** si el coste por IP no cuadra.
  Más "residencial", pero la IP baila y por tanto sube la probabilidad de un
  reto de verificación.

**[?]** No he verificado precios ni políticas de ningún proveedor concreto y no
voy a inventarlos. Hay que pedir presupuesto a dos o tres y comparar sobre
condiciones reales antes de encender el flag.

### 8.2 El modelo

**[C]**

```ts
// packages/backend/src/models/BridgeProxyLease.ts
interface BridgeProxyLease {
  oxyUserId: string;
  network: BridgeNetworkId;          // el lease es por (usuario, red)

  provider: string;                  // "provider-a" — nunca la marca en el código
  countryCode: string;               // ISO 3166-1 alpha-2, congelado al crear
  regionCode?: string;
  sessionSeed: string;               // aleatorio y estable; identifica la sesión

  state: "active" | "quarantined" | "released";

  lastExitIp?: string;
  lastExitCountry?: string;
  lastVerifiedAt?: Date;

  rotations: Array<{
    at: Date;
    fromSeed: string;
    toSeed: string;
    reason: "provider_retired" | "ban_quarantine" | "operator_forced";
  }>;

  createdAt: Date;
  releasedAt?: Date;
}
```

Índice único `{oxyUserId, network}`.

**[C] La credencial del proxy no se guarda en Mongo.** El lease guarda país,
región y semilla; la URL completa se compone en el momento de servirla, con
credenciales que vienen de variables de entorno. Así una fuga de la base de datos
no es una fuga de proxies, y rotar la contraseña del proveedor es cambiar una
variable, no migrar una colección.

**[C]** La composición depende del proveedor —casi todos codifican país y sesión
dentro del usuario, del estilo
`usuario-country-<cc>-session-<seed>:contraseña@gateway:puerto`— pero eso hay que
confirmarlo contra la documentación del que se contrate. Por eso va detrás de una
interfaz:

```ts
interface ProxyProvider {
  readonly id: string;
  supportsCountry(countryCode: string): boolean;
  composeUrl(lease: BridgeProxyLease): string;
  verifyExit(lease: BridgeProxyLease): Promise<{ ip: string; country: string }>;
}
```

### 8.3 Reglas de asignación

**[C]**

1. **Se asigna al vincular, no al conectar.** El lease se crea en el mismo paso
   que reserva el slot, antes del primer paquete hacia la red remota. Asignarlo al
   conectar significa que el proxy podría cambiar entre reconexiones, que es justo
   lo que hay que evitar.

2. **El país se congela.** Se determina una sola vez, con esta prioridad:
   país declarado en el perfil de Oxy → prefijo del teléfono que el usuario está
   vinculando → país geolocalizado en el momento del alta. Se escribe en el lease
   y **no se recalcula nunca**, ni aunque el usuario viaje. Un usuario que se muda
   de país de verdad es un caso de soporte con intervención manual, no un
   automatismo: exactamente porque el automatismo es indistinguible de la señal
   que queremos no emitir.

3. **Se reutiliza al revincular.** Si el usuario desvincula y vuelve a vincular la
   misma red, recibe el mismo lease. Por eso `DELETE /accounts/:id` no libera el
   lease.

4. **Rotar es la excepción y siempre dentro del país.** Sólo tres motivos:
   - `provider_retired`: el proveedor retira el rango.
   - `ban_quarantine`: la cuenta fue baneada y sospechamos de la IP.
   - `operator_forced`: intervención manual, con registro.
   En los tres casos el nuevo lease conserva `countryCode` y `regionCode`. Toda
   rotación queda en `rotations[]`, que es el historial que se mira cuando algo
   va mal.

5. **Se verifica y se alarma.** Antes de arrancar el proceso, y periódicamente
   después, el backend hace una petición de eco a través del proxy y compara el
   país observado con el del lease. Si no coinciden: **no se conecta**, el lease
   pasa a `quarantined` y salta una alerta. Es mejor una cuenta que no conecta que
   una cuenta que conecta desde el país equivocado. **[C]** Esta regla es la que
   convierte el diseño en algo que se puede operar: sin verificación de salida,
   un fallo de configuración del proveedor se manifiesta como una oleada de
   baneos tres semanas después, sin causa aparente.

6. **Se sirve por el endpoint interno.**
   `GET /internal/bridges/proxy?slot=<id>&t=<token>&reason=<login|connect>` →
   `{"proxy_url": "..."}`. **[V]** El campo tiene que llamarse exactamente
   `proxy_url`: es lo que deserializa el bridge. Un 5xx o un JSON inválido hace
   que el bridge falle la conexión, así que el endpoint no puede depender de nada
   lento. **[C]** Cache en memoria del lease compuesto, invalidada por rotación.

7. **Nunca se comparte un lease entre usuarios.** Es el requisito original: si dos
   usuarios comparten IP, un baneo correlaciona. Un slot en cuarentena mantiene su
   lease hasta que se libera el lease también.

### 8.4 Telegram no lleva proxy

**[C]** Telegram es la primera red y va sin proxy: API oficial, y el proxy
añadiría un punto de fallo sin beneficio. **[V]** Si en algún momento hiciera
falta, `mautrix-telegram` soporta `proxy.type: socks5` o `mtproxy` — pero es
**global al proceso**, así que activarlo obligaría a mover Telegram a Topología B
y multiplicar su coste. Es una decisión que no habría que tomar a la ligera.

---

## 9. El flag por red

### 9.1 Objetivo

Una red apagada no debe aparecer en la UI de vincular cuenta. No "aparece
deshabilitada": no aparece.

### 9.2 Diseño

**[C]** Siguiendo el patrón de `packages/backend/src/config/crowdsource.ts`:
módulo enfocado, validado con zod una vez al arrancar, memoizado y congelado.

```ts
// packages/backend/src/config/bridges.ts

/** Catálogo estático. Añadir una red aquí no la enciende. */
const NETWORK_CATALOG = {
  telegram: { displayName: "Telegram", architecture: "bridgev2", requiresProxy: false },
  slack:    { displayName: "Slack",    architecture: "bridgev2", requiresProxy: false },
  discord:  { displayName: "Discord",  architecture: "legacy",   requiresProxy: false },
  whatsapp: { displayName: "WhatsApp", architecture: "bridgev2", requiresProxy: true  },
  instagram:{ displayName: "Instagram",architecture: "bridgev2", requiresProxy: true  },
  messenger:{ displayName: "Messenger",architecture: "bridgev2", requiresProxy: true  },
} as const;
```

Variables de entorno:

```
ALLO_BRIDGES_ENABLED=telegram,slack,discord
ALLO_BRIDGE_TELEGRAM_BASE_URL=http://allo-bridge-telegram:29317
ALLO_BRIDGE_TELEGRAM_SHARED_SECRET=<32+ chars>
ALLO_BRIDGE_TELEGRAM_AS_TOKEN=<token del registro, para validar el webhook>
```

**[C]** Las tres reglas que hacen que esto sea un flag y no una sugerencia:

1. **Una red está habilitada sólo si está en `ALLO_BRIDGES_ENABLED` *y* tiene su
   trío de variables completo.** Media configuración es peor que ninguna: media
   configuración se manifiesta en producción como un endpoint que devuelve 502.
   Se valida en el `superRefine`, al arrancar, igual que hace
   `crowdsource.ts` con `SERVICE_KEY` y `WEBHOOK_SECRET`.

2. **Si `requiresProxy` es verdadero, además exige que el proveedor de proxies
   esté configurado.** Encender WhatsApp sin proveedor de proxies configurado es
   exactamente el fallo que el flag existe para prevenir: todos los usuarios
   saliendo por la IP del datacenter, correlacionados. Debe ser imposible por
   construcción, no por disciplina.

3. **`GET /api/bridges/networks` sólo devuelve las habilitadas, y
   `POST /api/bridges/networks/:network/link` devuelve `404` —no `403`— para una
   red deshabilitada.** Un 403 dice "existe pero no puedes"; un 404 dice "no
   existe". Con 404, la app no puede enumerar nuestro roadmap probando IDs.

**[C]** La app **no lleva lista de redes**. Pinta lo que devuelve el catálogo:
nombre, icono, flujos de login. Encender una red es una variable de entorno y un
despliegue, no una release de la app en dos tiendas.

**[C]** Y el flag tiene un correlato en infraestructura: una red deshabilitada no
tiene proceso corriendo ni registro de appservice en Synapse. El flag de
aplicación y el estado de despliegue tienen que ser coherentes; **[C]** una
comprobación de salud al arrancar que verifique `GET /v3/whoami` contra cada red
habilitada, y que falle ruidosamente si alguna no responde, evita el escenario
"habilitada en la config, inexistente en el clúster".

---

## 10. Riesgos operativos, por probabilidad

Ordenados de más a menos probable. La probabilidad es criterio mío **[C]**; los
hechos en los que se apoyan están verificados donde se indica.

### 10.1 Casi seguro que pasa

**1. Reinicio de Synapse por cada registro nuevo de appservice.** **[V]** Sin
recarga dinámica. Si alguien implementa "un bridge por usuario" a lo Beeper sin
leer esto, cada alta de WhatsApp será un reinicio del homeserver.
*Mitigación*: pool preasignado (§4.3). Ampliaciones en bloque, planificadas.

**2. Rotura por actualización de bridge.** **[V]** Los bridges publican en CalVer
mensualmente (v26.04, v26.05, v26.06, v26.07…) y cada release toca config,
esquema de base de datos o capa de API de la red. La v26.06, por ejemplo,
**eliminó el soporte de la API de provisioning `/v1`**. Un `latest` en producción
es una avería programada.
*Mitigación*: pinear versión por hash de imagen, canary con cuentas internas,
suscribirse a los changelogs.

**3. La estabilidad de IP que el diseño quiere no existe en producto residencial
puro.** **[V]** Sesiones pegajosas de 10–30 minutos.
*Mitigación*: proteger geografía en vez de IP (§8.1), y verificar el país de
salida en cada conexión.

**4. Telegram baja de calidad de servicio a nivel de `api_id`.** **[V]** Telegram
pone "bajo observación automática" a las cuentas que usan clientes no oficiales;
la documentación de mautrix avisa de que *"Telegram is known to ban suspicious
users, and a brand new account using a 3rd party client is considered
suspicious"*; y **[V]** un `api_id` publicado o sobreutilizado produce
`API_ID_PUBLISHED_FLOOD`. Como **[V]** cada número de teléfono sólo puede tener un
`api_id`, todos nuestros usuarios comparten uno.
**Esto matiza el "riesgo de baneo cero" del brief**: el riesgo por cuenta
individual es bajo, pero el riesgo *correlacionado* a nivel de `api_id` no lo es,
y su modo de fallo es que se caen todos los usuarios a la vez. No cambia la
decisión de lanzar con Telegram —sigue siendo la red de menor riesgo con
diferencia— pero sí obliga a instrumentarlo.
*Mitigación*: `api_id` propio (obligatorio de todas formas), vigilar
`FLOOD_WAIT`/`API_ID_PUBLISHED_FLOOD` como métrica de primer nivel, limitar el
ritmo de altas nuevas, y tener un `api_id` de reserva registrado con otro número.

### 10.2 Probable

**5. `split_portals` mal puesto el primer día.** **[V]** Es irreversible y
destructivo si ya hay portales. Si se arranca con el valor por defecto y luego se
descubre la fuga de privacidad entre usuarios, la corrección exige destruir
portales.
*Mitigación*: `split_portals: true` desde el primer despliegue. Ponerlo en la
lista de verificación de Fase 4 y en el test de la config.

**6. AGPL: alguien parchea un bridge para salir del paso.** **[C]** Es el atajo
natural cuando algo no encaja, y activa §13 sin que nadie se dé cuenta.
*Mitigación*: la política de §7.5 escrita, y CI que falle si aparece un
`replace` hacia un fork privado en cualquier `go.mod`.

**7. Un compromiso del proceso compartido expone todas las sesiones de esa red.**
**[C]** En Topología A todas las sesiones de Telegram viven en una base.
*Mitigación*: cifrado en reposo, red aislada sin salida a internet salvo la red
remota, sin acceso interactivo al contenedor, rotación de `pickle_key`. No se
arregla con arquitectura salvo pagando el aislamiento por usuario en todas las
redes, que no es asumible.

**8. E2BE roto al migrar a MAS.** **[V]** Sin `msc4190: true`, un bridge con
cifrado no puede crear su dispositivo bajo MSC3861.
*Mitigación*: activarlo desde el principio (§2.3), y una prueba de humo que envíe
un mensaje cifrado extremo a extremo en cada despliegue.

### 10.3 Posible

**9. El coste de WhatsApp/Meta sorprende al encenderlo.** **[C]** Un contenedor y
una IP por usuario escala linealmente con los usuarios y no con el uso.
*Mitigación*: presupuesto y precios en firme antes de encender el flag; alerta de
gasto; techo duro de altas por día.

**10. Discord se queda descolgado.** **[V]** Arquitectura legacy, API de
provisioning `/v1` distinta, `mautrix-go` v0.16.x. Si migra a bridgev2, nuestro
adaptador se rompe; si no migra, se queda sin funcionalidades nuevas.
*Mitigación*: adaptador aislado con su propio contrato y sus propios tests.

**11. La sesión de login expira antes de que el usuario reaccione.** **[V]** El QR
de WhatsApp da unos 2 min 40 s en total, y el código de Telegram llega a otra app
de Telegram, no por SMS.
*Mitigación*: repintar el QR sin reiniciar sesión, texto explicativo sobre dónde
llega el código, y `expiresAt` realista.

**12. Un usuario espera ver sus chats secretos de Telegram.** Ver §11.

### 10.4 Poco probable pero caro

**13. Deriva entre el flag de aplicación y el estado del clúster.** **[C]** Red
habilitada en la config sin proceso desplegado.
*Mitigación*: comprobación de salud al arrancar contra cada red habilitada.

**14. Un bridge en bucle tumba Synapse.** **[V]** Los appservices no tienen
límites de rate.
*Mitigación*: monitorización externa de tasa de peticiones por appservice, con
corte manual.

---

## 11. Telegram: confirmaciones concretas

**`api_id` / `api_hash` propios: obligatorios.** **[V]** La config de ejemplo del
bridge trae marcadores de posición y un comentario que apunta a
`https://my.telegram.org/apps`. **[V]** Los términos de la API de Telegram exigen
explícitamente "obtain your own api_id". **[V]** Cada número de teléfono sólo
puede tener un `api_id` asociado.

**Obligaciones de los términos que nos afectan como producto** **[V]**:

- No usar "Telegram" en el nombre de la app salvo precedido de "Unofficial", ni
  usar sus logotipos.
- Revelar el uso de la API de Telegram en la ficha de la tienda y dentro de la app.
- No actuar en nombre del usuario sin su conocimiento y consentimiento, ni
  interferir con confirmaciones de lectura, indicadores de escritura o contenido
  autodestructivo.
- **No usar los datos obtenidos de la plataforma para entrenar modelos de IA.**
  **[C]** Merece atención específica dado que el backend ya tiene dependencias de
  `ai` y `@ai-sdk/openai`: cualquier función de IA sobre mensajes tiene que
  excluir explícitamente los que vengan de Telegram.
- Telegram da 10 días de subsanación tras notificar un incumplimiento antes de
  suspender el acceso a la API.

**Límites** **[V]**: las cuentas que usan clientes no oficiales quedan "bajo
observación automática". Existe `API_ID_PUBLISHED_FLOOD` para `api_id`
publicados. La sincronización inicial de miembros está limitada por el servidor a
10.000 por chat, y la config del bridge trae `member_list.max_initial_sync: 100`,
`sync.create_limit: 15`, `ping.interval_seconds: 30` y opciones de `takeout` (modo
exportación de datos) para sincronizaciones grandes. **[?]** No he podido
encontrar una tabla oficial de límites de `FLOOD_WAIT` por método; son
propietarios y varían.

**Chats secretos: confirmado que NO se pueden puentear.** Dos fuentes
independientes:

- **[V]** El `ROADMAP.md` del bridge lista `[ ] ‡ Secret chats (i.e.
  end-to-bridge encryption on Telegram)` sin marcar, donde `‡` significa
  literalmente *"Maybe, i.e. this feature may or may not be implemented at some
  point"*.
- **[V]** Y la razón es arquitectónica, no de esfuerzo. La documentación de
  Telegram dice: *"Secret chats are associated with specific devices (or rather
  with authorization keys), not users"*, y que al aceptar un chat secreto en un
  dispositivo, *"for all of Client B's authorized devices, except the current one,
  updateEncryption updates are sent with the constructor encryptedChatDiscarded"*.

O sea: el bridge se autentica como un dispositivo nuevo, y un dispositivo nuevo
**no puede** acceder a chats secretos existentes, porque las claves están atadas a
la clave de autorización del dispositivo que los aceptó. No es una limitación del
bridge; ningún cliente podría hacerlo.

**[C]** Implicación de producto: hay que decirlo en la UI, en el momento de
vincular y no en un FAQ. Un usuario que no vea sus chats secretos en Allo asumirá
que el bridge está roto, y tendrá razón en quejarse si nadie se lo avisó.

**Otros flujos disponibles** **[V]**: `bot` (token de BotFather; los chats sólo se
sincronizan al recibir un mensaje) y `manual` (credenciales de sesión existentes,
descrito por el propio bridge como *"advanced, do not use"*). **[C]** Ninguno se
expone a usuarios finales.

---

## 12. Lo que no he podido confirmar

Recogido aquí para que no se pierda entre el texto.

1. **Precios y políticas de proveedores de proxies.** No he consultado la
   documentación de ninguno en concreto. Los rangos de precio que circulan vienen
   de comparativas de terceros, no de tarifas oficiales. Hay que pedir presupuesto.
2. **La sintaxis exacta de usuario para codificar país y sesión** varía por
   proveedor. El patrón `usuario-country-xx-session-yyy` es el más extendido, pero
   hay que confirmarlo contra la documentación del que se contrate.
3. **Consumo de memoria y CPU por proceso de bridge y por `UserLogin`.** No hay
   cifras publicadas y no las voy a inventar. Hay que medirlo en el spike de
   Fase 4 antes de dimensionar nada.
4. **Si el argumento de "programa separado" de §7.3 se sostiene jurídicamente.**
   Es la interpretación habitual, no una certeza.
5. **A quién alcanza exactamente "users interacting with it remotely" del §13** si
   parcheásemos y sólo nuestro backend hablara con el bridge.
6. **Tabla oficial de límites de `FLOOD_WAIT` de Telegram por método.**
7. **Si `mautrix-discord` tiene previsto migrar a bridgev2**, y cuándo. El repo
   sigue activo (último push: 20 de julio de 2026) pero no he encontrado un
   anuncio.
8. **Cuántos slots hay que preasignar.** Depende de la conversión a WhatsApp, que
   nadie puede saber todavía. **[C]** Empezar por 128 y medir.

---

## 13. Fuentes

Todas consultadas el 1 de agosto de 2026.

**Especificación y homeserver**
- Matrix Application Service API — https://spec.matrix.org/latest/application-service-api/
- Registrar appservices (mautrix) — https://docs.mau.fi/bridges/general/registering-appservices.html
  · fuente: https://github.com/mautrix/docs/blob/master/bridges/general/registering-appservices.md
- Application Services (Synapse) — https://element-hq.github.io/synapse/latest/application_services.html
- Application Service login (MAS) — https://matrix-org.github.io/matrix-authentication-service/as-login.html
- MSC4190 en Synapse — https://github.com/element-hq/synapse/pull/17705
- Cifrado end-to-bridge — https://docs.mau.fi/bridges/general/end-to-bridge-encryption.html

**Framework bridgev2** (`mautrix/go`, MPL-2.0)
- Config base — `bridgev2/matrix/mxmain/example-config.yaml`
- Generación del registro — `bridgev2/bridgeconfig/appservice.go`
- API de provisioning — `bridgev2/matrix/provisioning.go`, `bridgev2/matrix/provisioning.yaml`
- Pasos de login — `bridgev2/login.go`
- Estados de bridge — `bridgev2/status/bridgestate.go`
- Modelo de datos — `bridgev2/database/user.go`, `bridgev2/database/userlogin.go`
- Punto de entrada — `bridgev2/matrix/mxmain/main.go`
- "Writing a Twilio bridge" (Tulir Asokan) — https://mau.fi/blog/megabridge-twilio/
- "Project updates" (Tulir Asokan) — https://mau.fi/blog/2024-h1-mautrix-updates/

**Bridges**
- `mautrix/telegram`: `CHANGELOG.md`, `ROADMAP.md`, `LICENSE.exceptions`,
  `pkg/connector/{example-config.yaml,login.go,loginphone.go,proxy.go}`
- `mautrix/whatsapp`: `pkg/connector/{example-config.yaml,proxy.go,client.go,login.go}`
  · config publicada: https://docs.mau.fi/configs/mautrix-whatsapp/latest
- `mautrix/meta`: `pkg/connector/{example-config.yaml,client.go}`
- `mautrix/discord`: `provisioning.go`, `go.mod`
- Setup de bridges Go — https://docs.mau.fi/bridges/go/setup.html
- Autenticación Telegram — https://docs.mau.fi/bridges/go/telegram/authentication.html
- Autenticación Meta — https://docs.mau.fi/bridges/go/meta/authentication.html

**Licencias**
- GNU AGPLv3 — https://www.gnu.org/licenses/agpl-3.0.en.html
- `LICENSE.exceptions` de cada repo de bridge

**Telegram**
- Obtener api_id — https://core.telegram.org/api/obtaining_api_id
- Términos de la API — https://core.telegram.org/api/terms
- Cifrado extremo a extremo (chats secretos) — https://core.telegram.org/api/end-to-end

**Beeper**
- `beeper/bridge-manager` — https://github.com/beeper/bridge-manager

**Proxies** (comparativas de terceros, no fuentes primarias)
- Bright Data, "Static vs Rotating Proxies" — https://brightdata.com/blog/proxy-101/static-vs-rotating-proxies
- AIMultiple, "Best Static Residential Proxies" — https://aimultiple.com/isp-proxies
