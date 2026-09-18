/* LOCAL HARNESS ONLY. */
const PEOPLE: Record<string, { id: string; username: string; name: { displayName: string }; avatar?: string }> = {
  '6700000000000000000000a1': { id: '6700000000000000000000a1', username: 'nate', name: { displayName: 'Nate Isern' } },
  '6700000000000000000000a2': { id: '6700000000000000000000a2', username: 'ana', name: { displayName: 'Ana Restrepo' }, avatar: 'ana' },
  '6700000000000000000000a3': { id: '6700000000000000000000a3', username: 'teodor', name: { displayName: 'Teodor Ilić' }, avatar: 'teodor' },
  '6700000000000000000000a4': { id: '6700000000000000000000a4', username: 'mira', name: { displayName: 'Mira Halvorsen' }, avatar: 'mira' },
  '6700000000000000000000a5': { id: '6700000000000000000000a5', username: 'kwabena', name: { displayName: 'Kwabena Osei' } },
};

const known: Record<string, unknown> = {
  getAccessToken: () => 'harness',
  getCurrentUser: async () => PEOPLE['6700000000000000000000a1'],
  getUsersByIds: async (ids: string[]) => ids.map((id) => PEOPLE[id]).filter(Boolean),
  getProfileByUsername: async (handle: string) => PEOPLE[`acc-${handle}`] ?? PEOPLE['6700000000000000000000a2'],
  getFileDownloadUrl: (id: string) => `https://i.pravatar.cc/200?u=${id}`,
  searchProfiles: async () => ({ data: Object.values(PEOPLE) }),
};

/** Anything else the app or Bloom reaches for answers with a no-op rather than crashing the harness. */
export const oxyClient: Record<string, any> = new Proxy(known, {
  get(target, key: string) {
    if (key in target) return target[key];
    return (...args: unknown[]) => (key === 'createLinkedClient' ? oxyClient : undefined);
  },
});

export function getNativeLanguageName(code: string): string {
  return code;
}
