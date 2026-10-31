/** The provider owns bearer refresh; Allo retains its account and instance fences. */
import type { OxySessionAdapter } from '@allo/core';
import type { LinkedHttpClient } from '@oxy.so/core';

export interface OxySessionSource {
  readonly session: {
    readonly userId: string | null;
    onChange(listener: (accessToken: string | null) => void): () => void;
  };
  createLinkedClient(config: {
    baseURL: string;
  }): Pick<LinkedHttpClient, 'fetch' | 'getAccessToken' | 'dispose'>;
}

export function createSessionAdapter(
  oxy: OxySessionSource,
  baseURL: string,
  ownerAccountId: string | null = oxy.session.userId,
): OxySessionAdapter & { dispose(): void } {
  const linked = oxy.createLinkedClient({ baseURL });
  let disposed = false;
  let retired = oxy.session.userId !== null && oxy.session.userId !== ownerAccountId;
  const stopWatching = oxy.session.onChange(() => {
    const accountId = oxy.session.userId;
    // A missing bearer can be restored; a different known account retires this client.
    if (accountId !== null && accountId !== ownerAccountId) retired = true;
  });
  const ownsSession = () =>
    !disposed && !retired && ownerAccountId !== null && oxy.session.userId === ownerAccountId;
  return {
    authenticatedFetch: async (input, init) => {
      if (!ownsSession()) throw new Error('The Allo account session changed');
      const response = await linked.fetch(input, init);
      if (!ownsSession()) throw new Error('The Allo account session changed');
      return response;
    },
    async getAccessToken() {
      if (!ownsSession()) return null;
      const token = await linked.getAccessToken(baseURL);
      return ownsSession() ? token : null;
    },
    getAccountId() {
      return ownsSession() ? ownerAccountId : null;
    },
    subscribe(cb) {
      return oxy.session.onChange(() => cb());
    },
    dispose() {
      disposed = true;
      stopWatching();
      linked.dispose();
    },
  };
}
