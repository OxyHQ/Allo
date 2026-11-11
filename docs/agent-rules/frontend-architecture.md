# Frontend architecture and theming

Moved verbatim from the root `AGENTS.md`; the rules below are unchanged and binding.

```
packages/
  frontend/       @allo/frontend      Expo / React Native / NativeWind
  backend/        @allo/backend       Express / drizzle / Socket.io
  shared-types/   @allo/shared-types  TypeScript type definitions
```

The frontend UI is **Bloom's messaging family** (`@oxy.so/bloom` chat-list,
chat-screen, message-bubble, message-media, chat-composer, chat-people) in
Bloom's `AppShell` with `AppShellPanels`, which owns the Sidebar rail/drawer and pane surfaces, composed from the app's destinations (a Bloom `TabPagerProvider`: the rail's rows, the phone's bottom bar and pager, the new-chat floating action); every page is a Bloom `Screen`; settings use Bloom's `SettingsModal`;
`packages/frontend/ARCHITECTURE.md` maps every screen.

**Nothing is hand-built that Bloom has.** Not the transcript (`MessageList`),
not the conversation list (`ChatList`), not the picker (`ContactList`), not one
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

NativeWind is on a **prerelease** (a `5.0.0-preview` tag), paired with Tailwind
v4 and `react-native-css` v3, and is there only for Bloom's design tokens: the
app's own components use `StyleSheet` with theme colours. Check the exact tag in
`packages/frontend/package.json` before blaming your own code.

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

**OxyProvider owns the React Query client.** Do not wrap it in a second
`QueryClientProvider`: the SDK's provider shadows it, so the outer client and
its options were never used. App query keys carry the account
(`user?.id`) and use roots of their own: `users` and `privacy` are the SDK's,
which it keeps on disk for the device. Nothing on the chat path is persisted
through React Query (the people layer stays in memory, like every other chat
read outside `@allo/core`'s encrypted store).

