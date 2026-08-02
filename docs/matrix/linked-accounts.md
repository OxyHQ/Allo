# Cuentas vinculadas: las redes puenteadas desde el lado del usuario

Qué ve y qué puede hacer una persona con las redes externas, contra la API de
orquestación que ya existía. Complementa `bridges.md` (el diseño completo: proxies,
licencias, topología) y `ui-wiring.md` (de dónde salen los datos que la UI dibuja);
esto es sólo la capa de pantalla.

`bridges.md` sigue mandando. Donde este documento y aquél no coincidan, gana
aquél — salvo en §5, que es precisamente el sitio donde encontré que el diseño se
contradice consigo mismo.

---

## 1. Qué se puede vincular hoy: nada

La respuesta corta, y conviene leerla antes que nada: **hoy no hay ninguna red
que un usuario pueda vincular**, en ningún despliegue. No es un fallo de esta
pantalla; es lo que la configuración permite.

`ALLO_BRIDGES_ENABLED` está vacío en todas partes, y aunque no lo estuviera, cada
red tiene su propio muro:

| Red | Estado | Qué la bloquea |
|---|---|---|
| Telegram | **lista, si se despliega** | nada en el código; hace falta el bridge corriendo, `api_id`/`api_hash` propios (§11) y las tres variables de entorno |
| Slack | **lista, si se despliega** | ídem |
| Discord | **imposible de encender** | habla el protocolo `legacy` (`/v1`); `PROVISIONABLE_ARCHITECTURES` sólo acepta `bridgev2`, así que listarla revienta el arranque |
| WhatsApp | **implementada y apagada** | `requiresProxy: true` y no hay proveedor de proxies contratado (§9.2 regla 2) |
| Instagram | **implementada y apagada** | ídem |
| Messenger | **implementada y apagada** | ídem, y además su login es por `cookies`, un tipo de paso que ni el backend traduce ni la app dibuja (§6.4) |

O sea: de las seis del catálogo, dos se pueden encender con una variable de
entorno y un despliegue, una no se puede encender en absoluto, y tres están
apagadas por una decisión de producto que el arranque hace cumplir.

**Las tres de proxy no "aparecen deshabilitadas": no aparecen.** Eso es §9.1
literal, y no lo hace esta pantalla — lo hace `loadBridgesConfig`, que se niega a
arrancar si alguien lista WhatsApp sin proveedor de proxies. La app no tiene lista
propia de redes, así que pinta lo que devuelve el catálogo, y el catálogo no puede
contenerlas. No hay nada que ocultar porque no hay nada que llegue.

## 2. Por dónde se entra

```
Ajustes → Otras redes → Cuentas vinculadas
```

Dos pantallas:

```
app/(chat)/settings/
  linked-accounts.tsx              la lista: qué hay vinculado, qué se puede añadir
  linked-accounts/[network].tsx    vincular una red, paso a paso
```

Y el trozo que no vive en Ajustes:

```
components/bridges/
  ConversationSecurityMark.tsx  el único sitio de la app que dibuja un candado
  NetworkGlyph.tsx              la marca de red, monocroma
  BanRiskWarning.tsx            el aviso de baneo
  LoginStepForm.tsx             un paso `user_input`
  LoginStepDisplay.tsx          un paso `display_and_wait`: QR, código, emoji, espera
lib/bridges/
  contract.ts                   los esquemas zod de todo lo que contesta la API
  api.ts                        las ocho llamadas
  networkPresentation.ts        cómo se dibuja una red, y cuándo se avisa
lib/chat/
  roomOrigin.ts                 la regla del candado y de la marca de red
hooks/
  useBridges.ts                 catálogo, cuentas, desvincular, reconectar
  useBridgeLinkAttempt.ts       un intento de login, de principio a fin
```

## 3. El login lo conduce el servidor, y eso es deliberado

En la app **no está escrito** que Telegram pida teléfono y luego código, ni que
WhatsApp enseñe un QR. §6.2 y §6.3 documentan esas secuencias y ninguna aparece en
el código de la pantalla.

El bridge manda un paso, la app lo dibuja, la respuesta vuelve, llega otro paso.
Los tres tipos que pueden llegar (§5.2 los fija en tres de los seis de bridgev2):

| Tipo | Qué dibuja | Cómo avanza |
|---|---|---|
| `user_input` | un formulario con los campos que declaró el bridge | alguien pulsa un botón |
| `display_and_wait` | QR, código, emoji, o una espera | pasa algo en otro sitio |
| `complete` | la cuenta ya creada | — |

Es la única forma de que un cliente sobreviva a una release de mautrix, que sale
mensualmente y a la que §10.1 le da probabilidad casi segura de romper algo.

**Un `display_and_wait` no se resuelve con un temporizador.** El backend mantiene
abierta una llamada bloqueante contra el bridge y contesta o con el paso siguiente
o con `waiting: true` cuando se le agota su propio timeout; la app vuelve a
preguntar. Un timeout no es un error. El QR de WhatsApp se refresca como un paso
**nuevo con el mismo `stepId`**, y la pantalla repinta sin reiniciar el intento.

Detalle de implementación que merece nombrarse porque parece un rodeo y no lo es:
el paso que llega por el poll se adopta **durante el render**, no en un efecto. Un
efecto pintaría el paso anterior durante un frame, y en una pantalla de QR ese
frame es un código que alguien puede intentar escanear.

## 4. Lo que se le dice al usuario antes de tocar nada

Dos cosas, y las dos son puertas, no notas al pie.

**El aviso de baneo**, para toda red cuyo `requiresProxy` sea verdadero. Se
deriva; no hay ninguna lista de `['whatsapp', 'instagram']` en el frontend. El
motivo es concreto: una lista escrita a mano se queda vieja el día que se encienda
Messenger, y el fallo sería un usuario vinculando una cuenta baneable sin ningún
aviso — exactamente lo que la función existe para evitar.

`requiresProxy` es la palabra del servidor para "el antifraude de esta red no
tolera una salida compartida" (§8), que es la misma población que "esta red banea
cuentas que pilla en un cliente no oficial". El proxy residencial reduce una
señal; no convierte el cliente en oficial. Y la cuenta que se arriesga es la del
usuario.

**Lo que la red no va a poder hacer**, leído de `capabilities`. Hoy eso es
`secretChats: false` en Telegram: no es una funcionalidad que falte, es
imposible — el bridge se autentica como un dispositivo nuevo y las claves de un
chat secreto están atadas al dispositivo que lo aceptó. §11 dice que hay que
decirlo al vincular y no en un FAQ, porque quien no lo lea concluirá que el bridge
está roto y tendrá razón en quejarse.

Y para las redes con proxy, el teléfono que se pide antes de empezar lleva su
explicación pegada: sirve **sólo** para elegir el país por el que sale la conexión
(§8.3 regla 2) y no se guarda. Pedir un teléfono sin decir para qué se parece
demasiado a recolectarlo.

## 5. El candado: dónde el diseño se contradice

`data-model.md` §5.3 enuncia la regla, y dice explícitamente que la enuncia porque
es donde se cometen los errores:

> **el candado lo decide el estado de cifrado; el icono de red lo decide el evento
> de bridge.** Mezclarlos es cómo se acaba mostrando un candado en una sala que el
> bridge lee entera.

La regla es correcta. La marca primaria que propone para aplicarla, no.

§5.3 dice que la marca primaria de una sala puenteada es
`latestEncryptionState() == NotEncrypted`, y razona bien por qué: es una propiedad
criptográfica del estado de la sala, verificable, que nadie puede falsificar
poniendo un campo. El problema es que **da por supuesto que una sala puenteada no
está cifrada**, y `bridges.md` §2.3 fija la regla contraria para la Fase 1:
`encryption.msc4190: true` en todos los bridges, o sea cifrado end-to-bridge.

Con eso encendido, la sala de Matrix **sí** está cifrada. El bridge tiene las
claves y descifra cada mensaje para volver a cifrarlo hacia WhatsApp o Telegram —
que es lo que hace un bridge. Una sala puede estar cifrada y ser leída entera por
un tercero.

Bajo la marca primaria de §5.3 en solitario, esa sala se lleva un candado: la
afirmación de que sólo las dos personas pueden leerla, hecha sobre una
conversación que un proceso de nuestro propio clúster descifra completa.

Así que `conversationSecurity` exige **las dos cosas** — sala cifrada *y* origen
que no consta puenteado — antes de decir `end-to-end`. La condición extra no es
un cinturón para un caso imposible: es el caso que el plan de despliegue crea a
propósito.

En la práctica, en la app:

| Situación | Marca |
|---|---|
| cifrada, sin fantasma | 🔒 |
| cifrada, con fantasma de bridge | logo de la red, **nunca** candado |
| sin cifrar, con fantasma | logo de la red |
| sin cifrar / `unknown` | nada |

`unknown` no lleva candado abierto ni tachado. Significa literalmente "este
dispositivo no lo sabe", que es el estado de toda sala durante los primeros
instantes de sync, y un icono ahí afirmaría algo que nadie ha comprobado.

Todo esto se decide una vez, en `lib/chat/roomOrigin.ts`, y los componentes pintan
lo que reciben. `ConversationSecurityMark` es el único sitio de la app que puede
dibujar un candado, y pasa por `showsEncryptionPadlock`.

## 6. El agujero que queda, dicho en voz alta

**Reconocer que una sala está puenteada depende hoy de una convención.**

La marca secundaria de §5.3 son dos cosas: el evento de estado `m.bridge`
(MSC2346, todavía inestable, prefijo `uk.half-shot.bridge`) y el namespace del
MXID de los usuarios fantasma. El puerto de `lib/matrix/` **no expone estado de
sala arbitrario**, así que sólo está disponible la segunda, y el prefijo
(`@telegram_…`) sale de `username_template`, que es un ajuste del registro del
bridge. Un operador que lo cambie hace que estas salas dejen de reconocerse.

Dos consecuencias, y la segunda es la seria:

1. **Un `AlloRoomSummary` sólo trae un MXID**: el del remitente del último
   mensaje. Una conversación puenteada cuyo último mensaje sea del propio usuario
   no tiene fantasma que encontrar y no se marca hasta que el otro lado conteste.
   Cosmético, y se corrige solo.
2. **Una sala puenteada no reconocida y con cifrado end-to-bridge se dibujaría
   como end-to-end.** Eso sí es grave, y este código no lo cierra. Lo que lo
   cierra es exponer `m.bridge` en el puerto y decidir con él.

Hoy el agujero está acotado por el hecho de que no hay ningún bridge encendido en
ningún despliegue, así que no existe ninguna sala puenteada que etiquetar mal.
**Deja de estarlo el día que se encienda el primer bridge**, y ese día esto hay
que arreglarlo antes, no después.

## 7. Lo que la API soporta y la app todavía no

Ordenado por lo que costaría:

- **`bridgeLinkStep` por Socket.IO.** El backend ya lo emite en cada cambio de
  paso (`routes/bridges.ts`), y §5.2 lo llama "el camino bueno", con el long-poll
  como el que siempre funciona. La app sólo usa el long-poll. Funciona; gasta más
  batería y añade hasta medio segundo entre que alguien escanea un QR y la
  pantalla se entera.
- **Reconectar desde la conversación.** `POST /accounts/:id/reconnect` sólo está
  en la pantalla de cuentas vinculadas. Una sala cuya cuenta está en
  `action_required` no ofrece nada; hay que ir a Ajustes.
- **`spaceRoomId`.** Se recibe y se valida, y no lo lee nadie. Es el identificador
  que ata una cuenta vinculada a las salas que produjo, y es material para §6.
- **`errorCode` de una cuenta.** Se recibe. La lista enseña el estado colapsado,
  no el código, así que un `BAD_CREDENTIALS` y un `LOGGED_OUT` se ven igual — que
  es correcto para el usuario (§5.3) y significa que no hay nada más que enseñar.
- **Los pasos que el backend no traduce.** `cookies` y `client_http` (webview de
  Meta) y `webauthn` (passkey de WhatsApp). §6.4 dice que el webview con inyección
  de JS y extracción de cookies es un componente nuevo, no "otro flujo más". Nada
  de esto llega a la app: `BridgeLinkService` se niega a traducirlo antes.

## 8. Marcas de terceros

Los logos van **monocromos, con la tinta de la interfaz**. Dos razones que
coinciden: el color en Allo sale de `theme.colors.*` y de ningún otro sitio, y el
verde de una marca deja de cumplir contraste sobre una fila en modo oscuro.

Y §11 recoge que los términos de la API de Telegram prohíben usar sus logotipos.
Un glifo a tamaño de texto, en la tinta de la interfaz, junto al nombre de una
conversación, es identificación — lo mismo que hace el icono de un tipo de
fichero — y no branding prestado. Es la lectura estrecha, y es la que no necesita
un abogado antes de poder salir.

Una red cuyo id esta build no conozca se dibuja con su inicial. No es un error: es
el caso normal el primer día que un despliegue encienda una red nueva, que es
justo lo que §9.2 quiere que sea posible.
