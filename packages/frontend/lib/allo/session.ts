/**
 * The Oxy session, as the SDK wants to see it.
 *
 * `OxyProvider` is the session authority: the bearer token, and the account it
 * names, come from the `OxyServices` instance `useOxy()` hands out, and this
 * adapter reads them from that instance rather than from a copy. `subscribe`
 * is `session.onChange`, which fires on sign-in, sign-out, a silent refresh and
 * an account switch — every event the SDK needs to know about, because the
 * account id is decoded from the token and moves with it.
 */
import type { OxySessionAdapter } from '@allo/core';

/** The three members of `OxyServices.session` this adapter reads, so a test can hand in a fake. */
export interface OxySessionSource {
  readonly session: {
    readonly accessToken: string | null;
    readonly userId: string | null;
    onChange(listener: (accessToken: string | null) => void): () => void;
  };
}

export function createSessionAdapter(oxy: OxySessionSource): OxySessionAdapter {
  return {
    async getAccessToken() {
      return oxy.session.accessToken;
    },
    getAccountId() {
      return oxy.session.userId;
    },
    subscribe(cb) {
      return oxy.session.onChange(() => cb());
    },
  };
}
