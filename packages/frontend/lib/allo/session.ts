/** The provider owns bearer refresh; Allo retains its account and instance fences. */
import type { OxySessionAdapter } from '@allo/core';
import type { LinkedHttpClient } from '@oxy.so/core';

export interface OxySessionSource {
  readonly http: { getSessionEpoch(): number };
  readonly session: {
    readonly accessToken: string | null;
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
  const ownerEpoch = oxy.http.getSessionEpoch();
  const linked = oxy.createLinkedClient({ baseURL });
  let disposed = false;
  let retired = !oxy.session.accessToken || oxy.session.userId !== ownerAccountId;
  const stopWatching = oxy.session.onChange((token) => {
    if (
      !token ||
      oxy.http.getSessionEpoch() !== ownerEpoch ||
      oxy.session.userId !== ownerAccountId
    ) {
      retired = true;
    }
  });
  const ownsSession = () =>
    !disposed &&
    !retired &&
    ownerAccountId !== null &&
    ownerEpoch === oxy.http.getSessionEpoch() &&
    oxy.session.userId === ownerAccountId;
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
