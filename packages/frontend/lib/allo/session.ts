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
): OxySessionAdapter & { dispose(): void } {
  const ownerAccountId = oxy.session.userId;
  const linked = oxy.createLinkedClient({ baseURL });
  let disposed = false;
  const ownsSession = () =>
    !disposed && ownerAccountId !== null && oxy.session.userId === ownerAccountId;
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
      return oxy.session.userId;
    },
    subscribe(cb) {
      return oxy.session.onChange(() => cb());
    },
    dispose() {
      disposed = true;
      linked.dispose();
    },
  };
}
