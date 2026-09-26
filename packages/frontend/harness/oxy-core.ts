/* LOCAL HARNESS ONLY. */
const PEOPLE: Record<string, { id: string; username: string; name: { displayName: string }; avatar?: string; verified?: boolean; bio?: string }> = {
  '6700000000000000000000a1': { id: '6700000000000000000000a1', username: 'nate', name: { displayName: 'Nate Isern' } },
  '6700000000000000000000a2': { id: '6700000000000000000000a2', username: 'ana', name: { displayName: 'Ana Restrepo' }, avatar: 'ana', verified: true, bio: 'Restoring a 1920s loft, one wall at a time.' },
  '6700000000000000000000a3': { id: '6700000000000000000000a3', username: 'teodor', name: { displayName: 'Teodor Ilić' }, avatar: 'teodor' },
  '6700000000000000000000a4': { id: '6700000000000000000000a4', username: 'mira', name: { displayName: 'Mira Halvorsen' }, avatar: 'mira' },
  '6700000000000000000000a5': { id: '6700000000000000000000a5', username: 'kwabena', name: { displayName: 'Kwabena Osei' } },
};

const users = {
  me: async () => PEOPLE['6700000000000000000000a1'],
  getMany: async (ids: string[]) => ids.map((id) => PEOPLE[id]).filter(Boolean),
  byUsername: async (handle: string) => PEOPLE[`acc-${handle}`] ?? PEOPLE['6700000000000000000000a2'],
  search: async () => ({ data: Object.values(PEOPLE) }),
};

/** Anything else the app or Bloom reaches for answers with a no-op rather than crashing the harness. */
function noop(known: Record<string, unknown>): Record<string, any> {
  return new Proxy(known, {
    get(target, key: string) {
      if (key in target) return target[key];
      return () => undefined;
    },
  });
}

const client: Record<string, any> = noop({
  users: noop(users),
  assets: noop({ publicUrl: (id: string) => `https://i.pravatar.cc/200?u=${id}` }),
  session: noop({ accessToken: 'harness', userId: '6700000000000000000000a1', onChange: () => () => undefined }),
  http: noop({}),
  createLinkedClient: () => ({ client: noop({}), dispose: () => undefined }),
});

/** `new OxyServices(…)` in `@/lib/oxy` gets the harness client. */
export class OxyServices {
  constructor() {
    return client;
  }
}

export function getNativeLanguageName(code: string): string {
  return code;
}
