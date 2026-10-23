# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Enable with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true` and `AWS_REGION`. The shared
SDK uses the same temporary AWS role provider as Allo's `OxyServer`: ECS task
identity or an authenticated local SSO/assumed role. Oxy verifies its registered
application and environment (ADR 0049); no activity key or internal scopes apply.
Invalid activation values fail at boot. Missing or revoked workload authority
is reported by the publisher with bounded retry backoff. Disabled collection
emits a warning and must not be interpreted as zero traffic.

HTTP middleware is mounted before body parsers and routers, including public
routes, webhooks, failures and authenticated internal calls. Outgoing fetch and
Node HTTP requests are observed by the shared SDK, including requests made by
background workers. Socket.IO message sends and receives are observed where
this service exposes Socket.IO. Internal/external scope is independent of
inbound/outbound direction; media is a separate activity category.

Only bounded aggregate fields leave the service. No bodies, message contents,
user identifiers, tokens or IP addresses are added to activity events. Visitor
origins represent the Cloudflare edge PoP, not an IP-derived country. Infrastructure
location follows `AWS_REGION`; registration and graceful removal update the
shared inventory, and crashed instances expire through the API registry.

The publisher does not observe database wire traffic, raw TCP, HTTP/2, WebRTC,
or a separate process that has not installed the collector. These transports
must not be represented by fabricated lines.

## Cloudflare web traffic

The web app's traffic (`allo.you`, the `allo-frontend` Worker) is measured
keylessly by Oxy from Cloudflare's own analytics; see OxyHQ/oxy
`docs/operations/cloudflare-web-activity.md`. This app holds no Oxy activity
secret and runs no activity code in its Worker. The `OXY_EDGE_ACTIVITY_*`
bindings were never provisioned and nothing reads them now; if one is ever found
on a deployment it can simply be deleted.
