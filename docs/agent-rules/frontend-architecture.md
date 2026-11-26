# Frontend architecture and theming

Moved verbatim from the root `AGENTS.md`; the rules below are unchanged and binding.

```
packages/
  frontend/       @allo/frontend      Expo / React Native / Bloom language
  backend/        @allo/backend       Express / drizzle / Socket.io
  shared-types/   @allo/shared-types  TypeScript type definitions
```

The frontend UI is **Bloom's messaging family** (`@oxy.so/bloom` list, chat-list,
chat-screen, message-bubble, message-media, chat-composer, chat-people) in
Bloom's `AppShell` with `AppShellPanels`, which owns the Sidebar rail/drawer and pane surfaces, composed from the app's destinations (a Bloom `TabPagerProvider`: the rail's rows, the phone's bottom bar and pager, the new-chat floating action); every page is a Bloom `Screen`; settings use Bloom's `SettingsModal`;
`packages/frontend/ARCHITECTURE.md` maps every screen.

**Nothing is hand-built that Bloom has.** Not the transcript (`MessageList`),
not the conversation list (`List` with conversation data), not the picker (`List` with person data), not one
icon — every glyph comes from `@oxy.so/bloom/icons`, and the app's only drawing
of its own is Allo's logotype, which is what `Sidebar.logo` is for. When Bloom
is missing a piece or gets one wrong, it is fixed IN BLOOM, released, and
consumed: 2.12.1 (a bubble holding controls is not a `<button>`) and 2.12.2
(`RiChatNewLine`, so the new-chat action stops wearing the compose-a-document
mark) both came out of building these screens. Import Bloom by subpath only.

**The chat screens can be opened without an account.** `ALLO_HARNESS=1 expo
start --web` swaps the Oxy session and the Allo client for in-memory stand-ins
(`packages/frontend/harness/`, resolved only under that flag) seeded with a DM,
a group, a picture, a document, a voice note and a link, so the UI is looked at
in a browser and compared with Bloom's own stories rather than assumed. Jest
cannot do this job: rendering a Bloom chat screen there dies in reanimated 4's
native worklets, so component coverage stays at the data-path level.

The app's UI is written in the **Bloom language** (`@oxy.so/bloom-language`):
views are chains of modifiers over Bloom tokens, placed in JSX with
`toElement()`, and what the language cannot draw yet stays Bloom JSX (with
`StyleSheet` and theme colours). The language compiler runs in front of Metro
and Jest (`metro.config.js`, `jest.config.js`) and rejects a wrong modifier or
token at build time. Allo's own code has no `className`.

There is no NativeWind, react-native-css or Tailwind: Bloom 23, the language,
Services 15 and the Gemies SDK 10 style through React Native styles and Bloom's
tokens. `styles/global.css` is plain CSS that Expo compiles on the web: the
element reset Tailwind's preflight used to compile, which gives the document
its font (without it, text Bloom does not draw falls back to a serif).

Bloom's, and nothing else. `BloomProvider` in `app/_layout.tsx` keeps this
device's last mode and colour (`persistKey`/`storage` from `lib/theme.ts`), so a
cold start paints them at once, and the Oxy account's portable theme lands on
top through the SDK's `useAccountTheme` (the colour always; the mode while
Settings → Appearance → "Follow my Oxy account" is on, which
`useAccountThemeControls` writes back to the account). Allo's green is the
default for a signed-out visitor. Bloom owns the native status bar; the app
renders no `StatusBar`. Every colour is `useTheme().colors.*` from
`@oxy.so/bloom/theme`; never a literal. There are no per-conversation themes
and no app colour tables.

**Allo owns its React Query client.** Services 15 keeps its own data in one
`@oxy.so/bloom-data` store per account and holds no React Query cache, so
`AppProviders` mounts `lib/query/queryClient.ts`'s client in a
`QueryClientProvider` above `OxyProvider` (one client; never a second). Every
query and mutation in it belongs to the signed-in account and none is
persisted: `AccountQueryScope` keeps it on the session (`lib/query/accountQueryCache.ts`
follows the Services runtime's own notification and, on any account change,
cancels every read in flight and drops every query and mutation before anything
renders for the next account). A write is guarded with the account it was
started for (`accountQueryCache.isActive(account)`): its request is refused and
its callbacks write nothing once the session has moved on
(`hooks/usePrivacySettings.ts`; `__tests__/privacy/accountQueryIsolation.test.tsx`).
App query keys still carry the account (`user?.id`). Nothing on the chat path is
persisted through React Query (the people layer stays in memory, like every
other chat read outside `@allo/core`'s encrypted store).

