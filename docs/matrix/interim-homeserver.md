# Usar Allo antes de tener homeserver propio

El cliente está terminado y no depende de que el homeserver sea el nuestro.
Necesita **un** homeserver, y `matrix.org` sirve. Este documento existe porque la
Fase 1 está bloqueada por permisos de IAM que nadie en el equipo de desarrollo
puede concederse, y esperar a eso no es la única opción.

## Qué está probado, y con qué

Contra `matrix.org`, el 2026-08-02:

| | Resultado |
|---|---|
| `.well-known/matrix/client` anuncia OIDC | sí — `org.matrix.msc2965.authentication`, issuer `https://account.matrix.org/` |
| Metadata de autenticación (MSC2965) | `HTTP 200`, con `authorization_endpoint`, `token_endpoint`, `jwks_uri` y `registration_endpoint` |
| **Registro dinámico de cliente** | **`HTTP 201`** contra `https://account.matrix.org/oauth2/registration`, con la misma forma de payload que envía `client.web.ts:922` — `application_type: web`, `token_endpoint_auth_method: none`, `grant_types: [authorization_code, refresh_token]`. Devolvió un `client_id` y aceptó el `redirect_uri` |

Esa última fila es la que importa. `spikes/matrix-web/RESULTS.md` marcaba OIDC como
**PARCIAL** precisamente porque *"no se completó ningún login: ni registro dinámico
de cliente ni canje del código"*. El registro dinámico ya no es una incógnita.

## Qué sigue sin estar probado

**El canje del código.** Requiere que una persona real consienta en un navegador;
no se puede ejercitar desde una terminal. Es el paso siguiente al que sí se probó,
y usa código de `matrix-js-sdk` y del binding nativo, no nuestro — pero no se ha
visto funcionar de extremo a extremo, y decir lo contrario sería repetir el error
que este repositorio ya cometió una vez con la documentación de cifrado.

## Lo que se pierde usando matrix.org

No es una decisión neutra y no debe presentarse como tal:

- **Los MXID son `@quien:matrix.org`**, no `@quien:allo.you`. `server_name` es
  permanente por sala y por evento: mudarse después al homeserver propio **no
  migra nada**. Serían cuentas nuevas y conversaciones nuevas.
- **No hay SSO con Oxy.** La familia se registra en matrix.org, no con su cuenta
  de Oxy. Todo el trabajo de MAS como proveedor upstream queda sin usar hasta que
  exista el homeserver.
- **Los datos viven en matrix.org.** El contenido de los mensajes va cifrado
  extremo a extremo y su servidor no lo lee, pero los metadatos —quién habla con
  quién, cuándo y con qué frecuencia— son suyos, no nuestros.
- **La moderación anclada a MXID** (`services/moderation/subjectIdentity.ts`)
  reconoce cuentas de Oxy por el homeserver propio. Contra matrix.org, un reporte
  sobre un usuario no resuelve a una cuenta de Oxy y se guarda como identificador
  sin resolver — que es el comportamiento correcto de §6.3, pero significa que no
  es entregable a CrowdSource.

## Cómo se enciende

```
EXPO_PUBLIC_CHAT_BACKEND=matrix
EXPO_PUBLIC_MATRIX_HOMESERVER=https://matrix-client.matrix.org
```

El segundo valor es el `m.homeserver.base_url` que publica el `.well-known` de
matrix.org, no `matrix.org` a secas.

Nada más cambia: `lib/chat/backend.ts` decide el backend y `matrixConfig.ts`
exige explícitamente el homeserver sin valor por defecto, precisamente para que
una compilación no acabe hablando con un servidor que nadie eligió.

## Cuándo tiene sentido

Cuando hablar con la familia **ahora** vale más que los MXID definitivos, y se
acepta que esas conversaciones no se mudan. Para probar la app entre dos personas
es claramente la vía corta. Para el lanzamiento real no lo es: el homeserver
propio es lo que hace que la identidad de Oxy signifique algo dentro de Matrix.
