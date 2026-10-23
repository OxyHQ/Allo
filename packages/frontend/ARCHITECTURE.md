# Frontend architecture

The UI is Bloom's messaging family on top of the Allo platform SDK. There is no
second component library, no second theme and no hand-built chat UI: when a
screen needs something Bloom does not have, it is added to Bloom and released,
never patched here.

## Layers

```
@allo/core ─ @allo/react ─ lib/chat/model.ts ─ components/chat/* ─ Bloom
 (MLS, sync,   (hooks)      (pure projections:   (compose Bloom
  outbox)                    SDK views → Bloom    components, own
                             ChatSummary /        the gestures and
                             MessageListItem)     the state)
```

- **`lib/allo/`** builds the client and holds every platform adapter
  (see the root `AGENTS.md`).
- **`lib/chat/model.ts`** turns `ConversationView` / `TimelineItemView` into
  `ChatSummary` / `MessageListItem`, with names, times and labels already
  strings: Bloom's chat components compute nothing. `format.ts` owns the clock
  and the locale. Both are pure and tested (`__tests__/chat/model.test.ts`).
- **`hooks/useChatContext.ts`** supplies the projections with the viewer, the
  people layer, `t` and the locale; **`useChatSummaries`** is the list's data.

## Screens

| Route | Screen |
|---|---|
| `(chat)/_layout.tsx` | Bloom `AppShell variant="split"` owns the viewport, rail/drawer, pane surfaces and resizing. From 768px, `ConversationList` sits beside the routed detail; below it, the detail slot holds the phone stack and the home route supplies the list. Existing lists own scrolling (`paneScroll={false}`). `ConversationInfo` is the optional third pane from 1100px. Settings routes bridge to `AlloSettingsProvider`/Bloom `SettingsModal` and never replace the conversation list. `CallPill` is mounted here, so a minimised call survives walking around |
| `(chat)/index.tsx` | Phone: `ConversationList`. Wide: the empty detail pane |
| `(chat)/c/[id]/index.tsx` | `ConversationScreen`; an account id opens (creates) the DM |
| `(chat)/c/[id]/info.tsx` | `ConversationInfo` as a screen (phone) |
| `(chat)/new.tsx` | People picker: DM, group, or `?addTo=<id>` to add members |
| `(chat)/share.tsx` | `/share?text=<message>` (`allo://share?text=…`, `https://allo.you/share?text=…`): another app's "send" (Mention's on a post). Previews the message as a bubble, then recent conversations and a people search; sends via `messages.send`, a person through `useCreateConversation` (the DM). One destination opens it |
| `(chat)/[username].tsx` | `/@handle` profile; otherwise 404 |
| `(chat)/dm/[username].tsx` | `/dm/handle`: resolves the handle and replaces with `/c/<account id>` (the DM) |
| `(chat)/calls.tsx` | Call history, and the banner an arriving call would use |
| `(chat)/c/[id]/call.tsx` | The call itself: `IncomingCallScreen` while ringing, else `CallScreen` |
| `(chat)/updates.tsx` | Status updates. `/updates`, not `/status`: Metro's dev server answers `/status` itself, so that route can never be opened while developing |
| `(chat)/settings/*` | Appearance, language, privacy, devices, backup |
| `(auth)/index.tsx` | Sign in with Oxy. A link opened while signed out is kept and followed after sign-in (`lib/navigation/usePendingHref.ts`) |

## The conversation

`ConversationScreen` = `ChatHeader` + `ChatBackground` › `Transcript` +
`Composer`, with a `MediaViewer` (Bloom's zoomable gallery).

- **The wallpaper** is Bloom's `ChatBackground variant="pattern"` with Allo's
  doodle tile as `patternImage` (`assets/images/chat-wallpaper.png`, a seamless
  540 x 981 white-on-transparent tile drawn 360 pt wide). Bloom uses only its
  alpha and inks it like its own glyphs, so it follows the theme in both modes;
  never pass it as `variant="image"`, which stretches and dims a photo.
- **The tones** are `useConversationSounds` (the three files in
  `assets/sounds/`), played by `lib/sounds/useTones`. On a phone a tone is an
  ALERT, not media: `modules/allo-tones` plays it through iOS System Sound
  Services and Android's notification stream (`USAGE_NOTIFICATION_EVENT`), so
  it is silent on silent or vibrate, follows the ringer volume and never
  pauses the user's music. Never play one through expo-audio there: the
  AVAudioSession is one setting for the whole app, expo-video sets it to
  `.playback` whenever a video exists and never puts it back, and anything in
  `.playback` ignores the silent switch. The web, which has no ringer, uses
  expo-audio. `lib/chat/soundCue.ts` decides, purely,
  whether a change to the open transcript is a message arriving (from somebody
  else, new and under 30 s old, so opening, paging and a synced backlog stay
  quiet), leaving (an own message `pending` → accepted) or failing. One tone per
  change and at most one per 1.5 s, except a failure, which always plays; none
  in the background or during a call. Settings → Preferences →
  "Conversation tones" turns them off for this device (`stores/soundStore.ts`).

- **`Transcript`** is Bloom's `MessageList` in a scroller: the list owns the
  runs, the separators, the avatars and the bubbles, and the app owns only the
  scrolling, because the history it pages through is the app's.
- **The message actions** are one `MessageContextMenu` for the screen (reply,
  copy, edit, pin/unpin, delete, reactions), opened by a bubble's long press.
  `PinnedMessageBar` sits under the header while anything is pinned.
- **`MessageMedia`** fills the bubble's `media` slot for every content kind that
  has one: pictures and videos (decrypted through `useMediaUri` — the sender's
  thumbnail first, the original only when the viewer opens), voice notes and
  files (fetched only when played or opened), and Bloom's `PollMessage`,
  `LocationMessage` and `ContactMessage`. `hasMessageMedia` keeps a plain text
  message from getting an empty slot.
- **`Composer`** is `ChatComposer` with reply/edit banners, the "has not set up
  Allo" note, the voice recorder (`expo-audio`) and an attachment menu that
  sends a picture, a document, a place (`expo-location`), a card
  (`expo-contacts`, native only — a browser has no address book) or a poll
  (`PollComposer`). Each of the last three goes as its own message.

## Phase 2, and what is real in it

Polls, votes, places, cards and pins are REAL: new E2EE message kinds in
`@allo/shared-types` → `@allo/core` → `@allo/react`, sent, folded and projected
like anything else. The server carries ciphertext, so none of them needed a
backend change.

Presence is real too, and is a WATCH SET: `usePresence(accountIds)` tells the
server which accounts a screen is drawing and hears about those. The
conversation list watches its DM counterparties (capped), the conversation
header watches the one person it is showing, and nothing watches a group's
members — one dot cannot speak for eight people. `lib/presence.ts` is the
projection: a dot only for somebody who is there, and a line that says nothing
at all when the server declined to answer, because hidden, blocked, unknown and
offline are deliberately one answer.

Status updates are real as well, and are NOT a group: one ciphertext, a key
sealed to each recipient device, twenty-four hours. `useStatuses` is the whole
surface; `lib/statuses.ts` groups a flat list by author and decides the ring
and the words, `lib/allo/useStatusMedia.ts` fetches and decrypts a picture only
when one is actually opened, and `/updates` posts through the SDK with the
audience resolved on the device. Nothing about a status is persisted locally —
its key lives in memory with its decrypted envelope, so it is gone when the
status is.

Calls are real too, and the frontend's share of them is small on purpose: the
state machine and the encrypted signalling are `@allo/core`, reached through
`useCall` / `useCallActions` / `useCallHistory`. What lives here is the media
(`lib/calls/webrtc.ts`, the `RTCPeerConnection`, the microphone and the camera,
one implementation for web and native) and two projections —
`lib/calls/session.ts` for the ONE live call, `lib/calls/history.ts` for every
finished one, read out of the `call_log` messages rather than a store of its
own. `/c/:id/call` is the only place in the app that dials; everything else
pushes that route. The screens still carry a notice
(`components/phase2/NotConnectedNotice.tsx`) because two things really are
missing — a phone with the app closed does not ring, and a relayed call has no
relay to use.

## Theme

`BloomProvider` in `app/_layout.tsx`, controlled by the account's appearance
settings (`stores/appearanceStore.ts` → `lib/theme.ts`): mode and a Bloom colour
preset. Every colour is `useTheme().colors.*` from `@oxy.so/bloom/theme`.

## Rules

- Import Bloom by subpath (`@oxy.so/bloom/chat-list`), never the root barrel.
- No colour literals; `StyleSheet` with theme colours.
- Every string through `t()`; bundles are flat dotted keys.
- Navigate with literal paths so `__tests__/routes/navigationTargets.test.ts` can see them.

### Bloom navigation and settings

`NavigationTheme` uses Expo Router’s public theme provider to map Bloom tokens. Its transparent variant is scoped to AppShell’s detail navigator: the base owns that surface on web and native, including the navigator’s otherwise-grey Background wrapper. Individual routes do not paint another full-pane background.

Settings pages compose Bloom `SettingsGeneralPage`, `SettingsSection`, `SettingsCard` and `SettingsRow`; they own neither a header nor a ScrollView. The modal owns responsive navigation, PageHeader and its viewport. Account/language operations close the modal before opening Services’ shared account flow. Backup keeps its existing route-removal guard and publishes only a pending boolean to the modal departure guard; the recovery phrase stays solely in BackupPanel memory.

Native calling registers `@livekit/react-native` globals in `lib/calls/globals.native.ts`. Its required LiveKit client/WebRTC peers and both Expo config plugins are installed explicitly (https://docs.livekit.io/transport/sdk-platforms/expo/); do not install the second `react-native-webrtc` implementation alongside LiveKit’s fork. This corrects the previously undeclared native import without changing call signalling/media logic. Android export verifies bundling, not device permissions or an actual call.
