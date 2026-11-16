/*
 * LOCAL HARNESS ONLY — never imported unless ALLO_HARNESS=1 (see
 * `metro.config.js` and `README.md`). It stands in for the Oxy session so the
 * chat screens can be opened in a browser with no account and no backend.
 */
import { APP_COLOR_PRESETS, useBloomTheme, type ThemeMode } from '@oxy.so/bloom/theme';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Pressable, Text } from 'react-native';

export { useSupervision } from './supervision';

// Opt in to the real SDK sheet with an empty, local-only account. No bearer is
// ever issued; the linked client below cannot contact a server or write data.
const askAliaHarness =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('harnessAskAlia');
const appAssertion = {
  getAppAssertion: async () => null,
  getAppAssertionHeaders: async () => ({}),
};
export function useAppAssertion() {
  return appAssertion;
}

export const HARNESS_ME = {
  id: '6700000000000000000000a1',
  username: 'nate',
  name: { displayName: 'Nate Isern' },
  avatar: undefined,
};

/** The people the harness's directory knows, so search has something to answer with. */
const DIRECTORY = [
  {
    id: '6700000000000000000000a2',
    username: 'ana',
    name: { displayName: 'Ana Restrepo' },
    avatar: 'ana',
  },
  {
    id: '6700000000000000000000a3',
    username: 'teodor',
    name: { displayName: 'Teodor Ilić' },
    avatar: 'teodor',
  },
  {
    id: '6700000000000000000000a4',
    username: 'mira',
    name: { displayName: 'Mira Halvorsen' },
    avatar: 'mira',
  },
  {
    id: '6700000000000000000000a5',
    username: 'kwabena',
    name: { displayName: 'Kwabena Osei' },
    avatar: 'kwabena',
  },
  {
    id: '6700000000000000000000a6',
    username: 'juno',
    name: { displayName: 'Juno Fábregas' },
    avatar: 'juno',
  },
  {
    id: '6700000000000000000000a7',
    username: 'bea',
    name: { displayName: 'Béa Lindqvist' },
    avatar: 'bea',
  },
];

const services = {
  createLinkedClient: () => ({
    client: {
      getSessionEpoch: () => 0,
      addTokenChangeListener: () => () => undefined,
      requestAuthenticatedResponse: async ({ method, url }: { method: string; url: string }) => {
        if (!askAliaHarness || method !== 'GET') {
          throw new Error('The Alia harness permits only local read fixtures.');
        }
        const path = url.split('?')[0];
        const data =
          path === '/v1/conversations'
            ? { conversations: [], hasMore: false, nextCursor: null }
            : path === '/mcp/installed'
              ? { servers: [] }
              : undefined;
        return Response.json(data ?? { message: 'No local fixture for this request.' }, {
          status: data ? 200 : 404,
        });
      },
    },
    getAccessToken: async () => null,
    dispose: () => undefined,
  }),
  http: { getSessionEpoch: () => 0 },
  safety: {
    people: async (input: { accountIds?: string[]; query?: string }) => ({
      items: DIRECTORY.filter((person) =>
        input.accountIds
          ? input.accountIds.includes(person.id)
          : `${person.name.displayName} ${person.username}`
              .toLowerCase()
              .includes((input.query ?? '').toLowerCase()),
      ).map((person) => ({
        accountId: person.id,
        username: person.username,
        displayName: person.name.displayName,
      })),
    }),
  },
  assets: {
    publicUrl: (id: string, variant?: string) =>
      `https://i.pravatar.cc/200?u=${id}${variant ?? ''}`,
  },
  users: {
    byUsername: async (handle: string) => ({
      id: handle,
      username: handle,
      name: { displayName: handle },
    }),
    getMany: async (ids: string[]) =>
      ids.map((id) => ({ id, username: id, name: { displayName: id } })),
    search: async (term: string) => ({
      data: DIRECTORY.filter((person) =>
        `${person.name.displayName} ${person.username}`
          .toLocaleLowerCase()
          .includes(term.toLocaleLowerCase()),
      ),
    }),
    me: async () => HARNESS_ME,
  },
  session: { accessToken: 'harness', userId: HARNESS_ME.id, onChange: () => () => undefined },
};

export function useOxy() {
  return {
    user: HARNESS_ME,
    isLoading: false,
    isAuthenticated: askAliaHarness,
    canUsePrivateApi: askAliaHarness,
    isAccountCacheReady: askAliaHarness,
    oxyServices: services,
    logout: async () => undefined,
    currentLanguage: 'en-US',
    currentLanguages: ['en-US'],
    showBottomSheet: () => undefined,
  };
}

/** The account theme: the harness account has none, so Allo keeps its own green. */
export function useAccountTheme(): void {}

/** Settings → Appearance: the mode stays on this device, there is no account to write to. */
export function useAccountThemeControls() {
  const { setMode } = useBloomTheme();
  return {
    source: 'app' as const,
    changeThemeSource: () => undefined,
    changeThemeMode: async (mode: ThemeMode) => setMode(mode),
  };
}

/** Every colour, applied locally. */
export function useAccountColorSave() {
  const { colorPreset, setColorPreset } = useBloomTheme();
  return {
    colors: Object.keys(APP_COLOR_PRESETS),
    value: colorPreset,
    saveColor: async (name: typeof colorPreset) => setColorPreset(name),
  };
}

/** Open the SDK only when the explicit local fixture is requested. */
export function useAuth() {
  return { canUsePrivateApi: askAliaHarness, signIn: async () => undefined };
}

/** Like the real provider, it owns the app's React Query client. */
export function OxyProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function OxySignInButton() {
  return (
    <Pressable>
      <Text>Continue with Oxy</Text>
    </Pressable>
  );
}
