<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Key features

- **Authentication:** `Authorization: Bearer` carries an Oxy token, read by
  `oxy.middleware.auth()` only from a header beginning with the exact string `"Bearer "`.
  The Socket.IO handshake requires the same Oxy token.
- **People directory:** `/api/directory/*` (`packages/backend/src/routes/directory.ts`)
  answers the five Oxy lookups the app makes — `users.byUsername`,
  `users.get`, `users.getMany`, `users.search`, `assets.publicUrl` — so an
  app with no Oxy session can still draw a person. **The frontend still calls Oxy
  directly**; this is the surface it moves to. Every underlying Oxy route
  answers anybody; the one `OxyServer` (`src/oxy.ts`, `serviceIdentity:
  'when-anonymous'`) asks with Allo's workload service token rather than
  anonymously, `by-ids` uses `users.lookupMany` and answers 502 when Oxy could
  not answer for an id (an outage is never "no such account"), and the
  responses are a PROJECTION
  (`DirectoryUser` in `@allo/shared-types`) rather than the Oxy `User`, which
  carries `email`, `phone`, `address` and `birthday`.
- **E2E encryption, sync, media, devices:** all `@allo/core`, reached through
  `@allo/react`; see "The Allo platform" above. Media is fetched and decrypted
  on demand by `useMediaUri` (a cache file on native, released on unmount; an
  object URL on web); a voice note or a document is not fetched until played or
  opened. `UploadMediaMeta.thumbnail` (`{ bytes, mime, width, height }`) sends
  a rendered preview as a second encrypted blob named by the same `media`
  message, and `MediaView.thumbnail.ref` fetches it alone; `lib/chat/upload.ts`
  reads the rendered thumbnail for `sendMedia`, and `MessageMedia` draws it in
  the bubble; the original is fetched only when Bloom's gallery opens. Delivery receipts
  are encrypted `delivered` messages: an own bubble shows `delivered` once
  another account's device has it and `read` once a read receipt covers it.
- **There is no archive;** the list's swipe action LEAVES the conversation.
- **Real time:** the SDK's socket.
- **Polls, places, cards and pins are message kinds, not features bolted on.**
  Each is an E2EE `AppMessage` (`poll`, `poll_vote`, `location`, `contact`,
  `pin`) that the server carries as ciphertext like any other, so none of them
  needed a backend change. A vote is a statement of the voter's CURRENT answer,
  not an increment: the last one wins and an empty list retracts, so a client
  that missed one still totals correctly, and `anonymous` is a request the UI
  honours rather than a guarantee — every client in the group can still see who
  voted. `pin` folds the last op per target, so two devices that pin and unpin
  in either order agree. `ConversationView.lastMessage` must list every kind a
  row can speak for (`LAST_MESSAGE_KINDS` in `conversations/service.ts`) or the
  list keeps showing the message before it.
- **Presence is a watch set, and it is reciprocal.** A client says which
  accounts it is SHOWING (`presence.watch`), beats every 30 s, and hears about
  those accounts and no others; online is that heartbeat still being inside its
  75 s deadline, held in Redis, and last seen is one coarse row per account in
  `account_presence`. Four rules are enforced in `presenceService.ts`: an
  account that hides its own presence receives nobody else's, you may only ask
  about accounts you share a conversation with, a block cuts both directions,
  and hidden, blocked, unknown and offline are all the same answer — a client
  that could tell them apart could tell it had been blocked. The old shape
  (announce to every co-member on connect) is gone.
- **A status update is one ciphertext and a key sealed per device.** The
  poster encrypts it under a random per-status key and HPKE-seals that key to
  each recipient INSTANCE's transfer key (`STATUS_KEY_SEAL_INFO`); the audience
  is resolved on the device, so the server is never asked for a contact list.
  It is NOT an MLS group: RFC 9420 gives every member the ratchet tree, so
  "everybody except Ana" as a group would publish the audience to the audience.
  The server refuses three kinds of recipient (not there, no shared
  conversation, blocked either way) and NAMES them back, so the app never says
  "posted" to somebody who did not get it. 24 hours, swept like everything else
  with a deadline; the client keeps the deadline it verified in the signature
  rather than a later claim; and a status already decrypted on a device is that
  device's, which the screens say rather than implying a remote delete.
- **Calls connect. Native ring code exists; physical validation and the relay remain outstanding.**
  The backend runs the part a client cannot — who may ring
  (a joined member, never across a block), the fork across a callee's devices,
  first-to-answer-wins as an UPDATE guarded on the state, the ring nobody
  answered, and whether the media is relayed (`relayed = group || either side
  hides its address`, told to everybody and attributed to nobody). Routes are
  `POST /v1/calls` plus `/ice`, `/token`, `/answer`, `/decline`, `/end`.
  **Nothing about the media passes through it**: the offer, the candidates and
  the per-sender frame keys are encrypted `call` messages in the conversation.
  `GET /v1/calls/:id/token` is the SFU ticket and applies three rules — a 1:1
  call has none (its media is peer to peer or through TURN), an ended call has
  none, and only a device that has ANSWERED gets one; `identity` is the
  instance, because a per-sender key is per device, and the grant opens no data
  channel because nothing rides LiveKit's.
  The client half is `packages/core/src/calls/` — the state machine, the
  signalling and the rule that a description with no `a=fingerprint` ends the
  call rather than connecting it. **There is no comparison of fingerprints and
  there cannot be one**: the SDP is an MLS message, so the encrypted copy is
  the only copy, and WebRTC binds the peer's certificate to the line inside it
  without being asked. WebRTC itself cannot live in core, which runs in Node
  under test, so the media is an injected `CallMediaAdapter`
  (`packages/frontend/lib/calls/webrtc.ts`, one implementation for both
  platforms) and a client built without one still rings, answers, declines and
  ends — it just carries no audio.
  **`/c/:id/call` is the app's ONE dialler.** Opening it with no call in
  progress places one and nothing else calls `start`; every other entry point
  pushes the route. A screen that navigated AND dialled placed two calls per
  press, twice — once from the conversation header, then again from the
  call-back row after the first was fixed.
  Native ringing now uses a local Expo module (PushKit/CallKit and Android
  FCM/Telecom with a `phoneCall` foreground service), a separate instance-signed
  call token and durable native actions. See `docs/adr/0002-calls-status-presence.md`
  for configuration and the physical-device validation still required. Incoming
  routes carry `incomingCallId` and must never fall into the outgoing dialler
  when their call has disappeared. The stage now renders live video (below).
  What is still missing: the speaker, screen sharing, the camera flip and hold, which are simply
  not passed to Bloom, because Bloom draws a control when it is handed a
  HANDLER and a control nothing can do is a prop nobody passes; and coturn, so
  a relayed call cannot connect. The status route is `/updates` because
  Metro's dev server answers `/status` itself, and a screen that cannot be
  opened while developing is a screen nobody checks.
- **Call video and audio are adapter-owned.** `lib/calls/webrtc.ts` exposes
  per-client observable streams. Bloom slots render muted HTML video / native
  `RTCView`; the one web audio host in `AlloRoot` survives route changes. A view
  unmount never stops media. Pending capture is invalidated on end/account
  retirement. Group LiveKit publishes with per-sender E2EE, subscribes only
  after a verified sender key, and never accepts plaintext publications. Both
  providers use the same PBKDF2 passphrase encoding; do not reintroduce web
  HKDF while native defaults to PBKDF2. Any MLS epoch change ends the call and
  asks the user to start a new one. `bun run test:call-media:browser` runs real
  Chromium media; set `ALLO_CALL_LIVEKIT_BINARY` for a real local encrypted SFU.
  Physical native interoperability remains pending (ADR 0002, upstream #88).
- **The relay and the SFU are read at BOOT, in `runtimeApp.ts`, or they are not
  read at all.** `getIceConfig()`'s lazy fallback parses an EMPTY environment,
  so for as long as nothing called `setIceConfig` every deployment served STUN
  alone, `TURN_URLS` was dead, and a relayed call — anybody hiding their
  address, or any group call — was told `relayOnly: true` with no relay in the
  list, which is an impossible call rather than a degraded one.
  `mediaConfigWiring.test.ts` boots the app and holds that line, including
  that a HALF-configured relay or SFU fails the boot. `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` are **shared across Oxy** (`/oxy/_shared/`, owned by
  oxy-infra, bound per service by terraform): never `sync_secret` them from
  Allo's workflow, which would overwrite the value every other app uses.
  The shared LiveKit bindings are declared in infra's `app-allo.tf`. Dedicated
  coturn configuration now lives in `terraform-uswest2/allo-turn.tf` (manual
  apply only), with UDP/TCP 3478 and TLS 443. Enable the app binding only after
  the relay's external gate, via `ALLO_TURN_ENABLED=true`; its five SSM paths
  are read-only to the app deploy. `TURN_REQUIRED` fails boot on missing/weak
  configuration. See `docs/platform/turn-connectivity.md` and infra runbook 55
  for provisioning, real local relay evidence and pending device/network gates.
  Network recovery refreshes authorized ICE grants, preserving P2P tracks;
  callee-only loss requests a caller-led restart through encrypted MLS. Group
  recovery obtains a fresh ticket before recapture and rotates its sender key.
  Healthy coturn allocations continue across credential issuance expiry.
- **Moderation:** CrowdSource integration for account reports
  (`packages/backend/src/services/moderation/`, `POST /api/reports`). Message
  content is deliberately never sent for review.
- **Profiles:** `/@handle`, served by `app/(chat)/[username].tsx`. The `@` is part
  of the SEGMENT VALUE, the way Mention does it, so a handle copied between the
  two apps names the same Oxy account; `lib/profile/handle.ts` is the only place
  that writes or reads one. The screen resolves it with
  `oxyServices.getProfileByUsername` — **a handle, never an id**; see
  `hooks/useSenderInfo.ts` for what passing an id to it did in production. A
  profile here is who somebody is plus a button to talk to them, not a feed:
  `components/profile/ProfileIdentity.tsx` draws the person. A conversation's
  details are Bloom's `ChatInfoPanel` (`components/chat/info/ConversationInfo.tsx`).
- **Privacy settings:** two rows, and both are enforced — one switch in the
  list (online status) and one list screen (blocked,
  `components/settings/pages/privacy/blocked.tsx`). **`showOnlineStatus`** is
  honoured by the presence layer (an account that hides its own presence sees
  nobody else's), and **blocks** stop new direct messages and conversation
  invitations in both directions and cut presence both ways (ADR 0002). They
  preserve history and existing shared-group membership and messages. Pair
  transaction locks serialize block changes with sends and invitations. Allo
  shows no setting it does not enforce: profile visibility, restricted
  profiles and hidden words were removed from the app because nothing read
  them. **Their storage is left over**: the `user_settings` columns
  `privacy_profile_visibility`, `privacy_hidden_words` and
  `privacy_restricted_users`, and the `restricts` table with its
  `/api/profile/restricts` routes, along with Mention's feed fields
  (`allowTags`, `hide*Counts`), are still in the backend
  (`db/schema/social.ts`, `utils/userSettings.ts`, `routes/profileSettings.ts`)
  and nothing in the frontend reads or writes them (`lib/privacy/api.ts` sends
  only `showOnlineStatus`, pinned by `__tests__/privacy/api.test.ts`).
  Dropping them is a `post`-phase migration of its own.
- **i18n:** i18next with `locales/` (en, es, it). Keys follow Oxy's convention
  (oxy ADR 0055): `chat.sticker.unavailable` is stored as nested objects
  (`{"chat":{"sticker":{"unavailable":"…"}}}`), never one flat dotted string,
  and i18next's default `keySeparator` reads it. The first segment is a
  namespace, and a key is never both a string and the prefix of another key.
