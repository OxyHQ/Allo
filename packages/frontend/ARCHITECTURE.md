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
| `(chat)/_layout.tsx` | Phone: a stack. From 768px: Bloom `ChatSplitLayout` behind a `Sidebar` rail (Chats, Calls, Status) — list pane (`ConversationList`, or `SettingsMenu` under `/settings`), the route as the detail pane, `ConversationInfo` as the info pane when opened from the header. `CallPill` is mounted here, so a minimised call survives walking around |
| `(chat)/index.tsx` | Phone: `ConversationList`. Wide: the empty detail pane |
| `(chat)/c/[id]/index.tsx` | `ConversationScreen`; an account id opens (creates) the DM |
| `(chat)/c/[id]/info.tsx` | `ConversationInfo` as a screen (phone) |
| `(chat)/new.tsx` | People picker: DM, group, or `?addTo=<id>` to add members |
| `(chat)/[username].tsx` | `/@handle` profile; otherwise 404 |
| `(chat)/calls.tsx` | Call history, and the banner an arriving call would use |
| `(chat)/c/[id]/call.tsx` | The call itself: `IncomingCallScreen` while ringing, else `CallScreen` |
| `(chat)/updates.tsx` | Status updates. `/updates`, not `/status`: Metro's dev server answers `/status` itself, so that route can never be opened while developing |
| `(chat)/settings/*` | Appearance, language, privacy, devices, backup |
| `(auth)/index.tsx` | Sign in with Oxy |

## The conversation

`ConversationScreen` = `ChatHeader` + `ChatBackground` › `Transcript` +
`Composer`, with a `MediaViewer` (Bloom's zoomable gallery).

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

Calls are NOT. There is no signalling and no media anywhere in the platform,
so `lib/phase2/calls.ts`
holds that state in memory for the life of the tab and the screens say so in
their own words (`components/phase2/NotConnectedNotice.tsx`). Its header
states exactly what a transport must supply to replace it, and it exports a
`DEMO_*` constant that is the only sample data to delete. Nothing there opens a
socket, touches a microphone or persists anything.

## Theme

`BloomProvider` in `app/_layout.tsx`, controlled by the account's appearance
settings (`stores/appearanceStore.ts` → `lib/theme.ts`): mode and a Bloom colour
preset. Every colour is `useTheme().colors.*` from `@oxy.so/bloom/theme`.

## Rules

- Import Bloom by subpath (`@oxy.so/bloom/chat-list`), never the root barrel.
- No colour literals; `StyleSheet` with theme colours.
- Every string through `t()`; bundles are flat dotted keys.
- Navigate with literal paths so `__tests__/routes/navigationTargets.test.ts` can see them.
