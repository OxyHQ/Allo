/*
 * LOCAL HARNESS ONLY — never imported unless ALLO_HARNESS=1 (see
 * `metro.config.js` and `README.md`). It stands in for the Oxy session so the
 * chat screens can be opened in a browser with no account and no backend.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';

export const HARNESS_ME = { id: '6700000000000000000000a1', username: 'nate', name: { displayName: 'Nate Isern' }, avatar: undefined };

const services = {
  getFileDownloadUrl: (id: string, variant?: string) => `https://i.pravatar.cc/200?u=${id}${variant ?? ''}`,
  getProfileByUsername: async (handle: string) => ({ id: handle, username: handle, name: { displayName: handle } }),
  getUsersByIds: async (ids: string[]) => ids.map((id) => ({ id, username: id, name: { displayName: id } })),
  searchProfiles: async () => ({ data: [] as unknown[] }),
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
