/*
 * LOCAL HARNESS ONLY — never imported unless ALLO_HARNESS=1 (see
 * `metro.config.js` and `README.md`). It stands in for the Oxy session so the
 * chat screens can be opened in a browser with no account and no backend.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';

export const HARNESS_ME = { id: '6700000000000000000000a1', username: 'nate', name: { displayName: 'Nate Isern' }, avatar: undefined };

/** The people the harness's directory knows, so search has something to answer with. */
const DIRECTORY = [
  { id: '6700000000000000000000a2', username: 'ana', name: { displayName: 'Ana Restrepo' }, avatar: 'ana' },
  { id: '6700000000000000000000a3', username: 'teodor', name: { displayName: 'Teodor Ilić' }, avatar: 'teodor' },
  { id: '6700000000000000000000a4', username: 'mira', name: { displayName: 'Mira Halvorsen' }, avatar: 'mira' },
  { id: '6700000000000000000000a5', username: 'kwabena', name: { displayName: 'Kwabena Osei' }, avatar: 'kwabena' },
  { id: '6700000000000000000000a6', username: 'juno', name: { displayName: 'Juno Fábregas' }, avatar: 'juno' },
  { id: '6700000000000000000000a7', username: 'bea', name: { displayName: 'Béa Lindqvist' }, avatar: 'bea' },
];

const services = {
  getFileDownloadUrl: (id: string, variant?: string) => `https://i.pravatar.cc/200?u=${id}${variant ?? ''}`,
  getProfileByUsername: async (handle: string) => ({ id: handle, username: handle, name: { displayName: handle } }),
  getUsersByIds: async (ids: string[]) => ids.map((id) => ({ id, username: id, name: { displayName: id } })),
  searchProfiles: async (term: string) => ({
    data: DIRECTORY.filter((person) =>
      `${person.name.displayName} ${person.username}`.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
    ),
  }),
  getAccessToken: () => 'harness',
  getCurrentUser: async () => HARNESS_ME,
};

export function useOxy() {
  return {
    user: HARNESS_ME,
    isLoading: false,
    oxyServices: services,
    logout: async () => undefined,
    currentLanguage: 'en-US',
    currentLanguages: ['en-US'],
    showBottomSheet: () => undefined,
  };
}

export function OxyProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function OxySignInButton() {
  return (
    <Pressable>
      <Text>Continue with Oxy</Text>
    </Pressable>
  );
}
