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
| `(chat)/_layout.tsx` | Bloom's `AppShell` over Allo's destinations (`components/navigation/AlloNavigation.tsx`, a Bloom `TabPagerProvider`): the shell draws the rail's rows, the phone's bottom bar (only while a page is in front, floating over the page: `reserveBottomBarSpace={false}`, so no band of shell background shows under the pill) and the floating action from them — the action of the page in front (`lib/navigation/pageAction.ts`: Chats a new chat, Status add to your status through `hooks/usePostStatus.ts`, Calls `/new?call=voice`), while the rail's compose row stays new chat; the rail's foot carries the own profile and Settings. From 768px, `ConversationList` sits beside the routed detail; below it, the detail slot holds the phone stack (`stackSceneLayout`, so a covered scene's Screens go inactive) and the chats page supplies the list. `ConversationInfo` is the optional third pane from 1100px. Settings routes bridge to `AlloSettingsProvider`/Bloom `SettingsModal` and never replace the conversation list. `CallPill` is mounted here, so a minimised call survives walking around |
| `(chat)/(tabs)/_layout.tsx` | Bloom's `TabPagerLayout`: the three pages side by side, swiped between on a phone (`react-native-pager-view`), each kept mounted |
| `(chat)/(tabs)/index.tsx` | Phone: `ConversationList`. Wide: the empty detail pane |
| `(chat)/c/[id]/index.tsx` | `ConversationScreen`; an account id opens (creates) the DM |
| `(chat)/c/[id]/info.tsx` | `ConversationInfo` as a screen (phone) |
| `(chat)/new.tsx` | People picker: DM, group, `?addTo=<id>` to add members, or `?call=voice` to pick ONE person to call (opens the DM, then replaces itself with `/c/<id>/call`, which dials). A directory search, not an address book: one "People" section in the directory's relevance order (no A–Z), offering only accounts a conversation can have (`lib/people/directorySearch.ts`: no federated, agent or automated profiles) |
| `(chat)/share.tsx` | `/share?text=<message>` (`allo://share?text=…`, `https://allo.you/share?text=…`): another app's "send" (Mention's on a post). Previews the message as a bubble, then recent conversations and a people search; sends via `messages.send`, a person through `useCreateConversation` (the DM). One destination opens it |
| `(chat)/[username].tsx` | `/@handle` profile; otherwise 404 |
| `(chat)/dm/[username].tsx` | `/dm/handle`: resolves the handle and replaces with `/c/<account id>` (the DM) |
| `(chat)/(tabs)/calls.tsx` | Call history, and the banner an arriving call would use |
| `(chat)/c/[id]/call.tsx` | The call itself: `IncomingCallScreen` while ringing, else `CallScreen` |
| `(chat)/(tabs)/updates.tsx` | Status updates. `/updates`, not `/status`: Metro's dev server answers `/status` itself, so that route can never be opened while developing |
| `(chat)/updates/[accountId].tsx` | The status viewer (Bloom's `StoryViewer`), pushed over the page that opened it so it has the whole height; Back closes it |
| `(chat)/settings/*` | Appearance, language, privacy (online status, and `privacy/blocked`), devices, backup |
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
- **Drafts** survive Back: the composer reports its text (`onDraftChange`, not while editing a sent message) to `stores/draftStore.ts`, keyed by account and conversation, and `ConversationScreen` opens with it unless the link brought a `?text=`. In memory only (it is plaintext of an E2EE message, and nothing on the chat path is persisted outside `@allo/core`); sending empties it, signing out forgets every one.
- **The header's title is never empty** (`conversationHeaderTitle`: the name, else `@handle`, else "This person" / "Group"); on a phone search lives in the header's menu so the name and the short "last seen 53 min ago" keep the room.
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

`BloomProvider` in `app/_layout.tsx` keeps the device's last theme
(`lib/theme.ts`) and wears the Oxy account's (`useAccountTheme`; Settings →
Appearance uses `useAccountThemeControls`). Bloom resolves every Oxy file id to
a URL through the SDK's `assets.renderUrl` (`imageResolver`) and owns the status
bar. Every colour is `useTheme().colors.*` from `@oxy.so/bloom/theme`.

## Rules

- Import Bloom by subpath (`@oxy.so/bloom/chat-list`, `@oxy.so/bloom/icons/RiImageLine`), never the root or the icon barrel: `check:bundle-imports` refuses a value import from either.
- No colour literals; `StyleSheet` with theme colours.
- Every string through `t()`; bundles are flat dotted keys.
- Navigate with literal paths so `__tests__/routes/navigationTargets.test.ts` can see them.
- Every page is a Bloom `Screen`: its `PageHeader` in `header` (Back comes from `BloomProvider back`; a page under the tab pager has none), its content in `ScreenScrollView` (padding as `contentContainerClassName`, which the chrome footprint does not override), or `scroll="none"` when the content scrolls itself (the transcript, `ContactList`). The app action is the shell's `primaryAction`; a page's own would be `Screen primaryAction`. Pressing the page in front again is Bloom's reselect (`Screen reselect`).
- Sheets, menus and confirms are Bloom surfaces: `confirm()`, `confirmWithSuppression()` (a confirm with a checkbox, as "also delete for them"), `alert()`, or `present()` for a panel of content, which closes itself with `surface.dismiss()`. One `<SurfaceHost />` in `AppProviders` renders them beneath i18n, the query client and the stickers (OxyProvider's own host steps aside). No raw `BottomSheet`, no app-owned modal or overlay: a full-screen view is a route.
- Safe areas are NativeWind's safe-area classes on a View (`pt-safe`, `pb-safe`, `pt-safe-offset-6`), never `SafeAreaView` or `useSafeAreaInsets()` padding.
- "Cannot check access" (`ConversationAccessState` `unavailable`, from `AlloRoot`'s supervision query or `ConversationReadGate`) is never drawn for a blip: `lib/allo/transientRetry.ts` asks a transient failure again after 1, 3 and 8 s while the screen says "checking", shows the failure only once those are spent (at once for a 4xx), and then still recovers by itself on reconnect (`onlineManager`) and every 30 s.
- "Can the reader see it?" is Bloom's `useScreenVisible()` (the Screen in front and the app in the foreground), never `useIsFocused`, `useFocusEffect` or `AppState` per feature.

### Bloom navigation and settings

`NavigationTheme` uses Expo Router’s public theme provider to map Bloom tokens. Its transparent variant is scoped to AppShell’s detail navigator: the base owns that surface on web and native, including the navigator’s otherwise-grey Background wrapper. Individual routes do not paint another full-pane background.

Settings pages compose Bloom `SettingsGeneralPage`, `SettingsSection`, `SettingsCard` and `SettingsRow`; they own neither a header nor a ScrollView. The modal owns responsive navigation, PageHeader and its viewport. Account/language operations close the modal before opening Services’ shared account flow. Backup keeps its existing route-removal guard and publishes only a pending boolean to the modal departure guard; the recovery phrase stays solely in BackupPanel memory.

Privacy has exactly two settings, both enforced by the server: the online-status switch on the Privacy page and the Blocked profiles page (`privacy-blocked`, `components/settings/pages/privacy/blocked.tsx`). Profile visibility, restricted profiles and hidden words were removed because nothing acted on them; their backend columns remain until a `post`-phase migration drops them, and `lib/privacy/api.ts` neither reads nor writes them. A settings row is added only for something the app enforces.

Native calling registers `@livekit/react-native` globals in `lib/calls/globals.native.ts`. Its required LiveKit client/WebRTC peers and both Expo config plugins are installed explicitly (https://docs.livekit.io/transport/sdk-platforms/expo/); do not install the second `react-native-webrtc` implementation alongside LiveKit’s fork. This corrects the previously undeclared native import without changing call signalling/media logic. Android export verifies bundling, not device permissions or an actual call.
