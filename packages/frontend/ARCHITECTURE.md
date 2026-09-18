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
| `(chat)/_layout.tsx` | Phone: a stack. From 768px: Bloom `AppShell variant="split"` — rail nav, list pane (`ConversationList`, or `SettingsMenu` under `/settings`), the route as the detail pane, `ConversationInfo` as the info pane when opened from the header |
| `(chat)/index.tsx` | Phone: `ConversationList`. Wide: the empty detail pane |
| `(chat)/c/[id]/index.tsx` | `ConversationScreen`; an account id opens (creates) the DM |
| `(chat)/c/[id]/info.tsx` | `ConversationInfo` as a screen (phone) |
| `(chat)/new.tsx` | People picker: DM, group, or `?addTo=<id>` to add members |
| `(chat)/[username].tsx` | `/@handle` profile; otherwise 404 |
| `(chat)/settings/*` | Appearance, language, privacy, devices, backup |
| `(auth)/index.tsx` | Sign in with Oxy |

## The conversation

`ConversationScreen` = `ChatHeader` + `ChatBackground` › `Transcript` +
`Composer`, with a `MediaViewer` (Bloom's zoomable gallery).

- **`Transcript`** runs Bloom's `groupMessages` over the projected items and
  renders the entries in a `FlashList` (Bloom's `MessageList` does not
  virtualize), starting from the bottom, loading older pages at the top. Runs
  longer than 20 messages are split so every list row stays recyclable.
- **`MessageRow`** is one `MessageBubble` inside a `MessageContextMenu` (reply,
  copy, edit, delete, reactions); media goes in the bubble's `media` slot via
  `MessageMedia`, which decrypts through `useMediaUri` — the sender's thumbnail
  for pictures, the original only when the viewer opens, voice notes and files
  only when played or opened.
- **`Composer`** is `ChatComposer` with reply/edit banners, the "has not set up
  Allo" note, the attachment menu and the voice recorder (`expo-audio`).

## Theme

`BloomProvider` in `app/_layout.tsx`, controlled by the account's appearance
settings (`stores/appearanceStore.ts` → `lib/theme.ts`): mode and a Bloom colour
preset. Every colour is `useTheme().colors.*` from `@oxy.so/bloom/theme`.

## Rules

- Import Bloom by subpath (`@oxy.so/bloom/chat-list`), never the root barrel.
- No colour literals; `StyleSheet` with theme colours.
- Every string through `t()`; bundles are flat dotted keys.
- Navigate with literal paths so `__tests__/routes/navigationTargets.test.ts` can see them.
