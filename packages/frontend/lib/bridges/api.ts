import * as z from 'zod';

import { api } from '@/utils/api';
import {
  bridgeAccountListSchema,
  bridgeCancelResultSchema,
  bridgeLinkPollSchema,
  bridgeLinkStateSchema,
  bridgeNetworkListSchema,
  bridgeReconnectResultSchema,
  bridgeUnlinkResultSchema,
  type BridgeAccount,
  type BridgeAccountState,
  type BridgeLinkPoll,
  type BridgeLinkState,
  type BridgeNetwork,
} from './contract';

/**
 * The eight calls the linked-accounts screens make (`docs/matrix/bridges.md` §5.2).
 *
 * Thin on purpose: this file adds parsing and one error type to `utils/api`, and
 * decides nothing. What a network is offered, which flows exist, how long a step
 * lasts and whether an attempt is still alive are all the server's answers —
 * §9.2 is explicit that the app carries no list of its own, and a client that
 * cached any of those judgements would be a second place they could be wrong.
 *
 * ## Circuit breakers are per endpoint, and that matters here
 *
 * `utils/api` keys a breaker on the request path with identifier segments
 * collapsed, so `/bridges/links/lnk_ab…` and `/bridges/links/lnk_cd…` share one
 * breaker under `/bridges/links/:id`. That is the behaviour we want: five
 * consecutive failures on the long-poll should stop the polling, not just move to
 * the next attempt. It also means a bridge outage cannot open the breaker that
 * the device-key lookups ride on, which is the reason the breakers are scoped
 * that way in the first place.
 */

/**
 * A call to `/api/bridges/*` that did not succeed.
 *
 * `code` is the backend's own error string and is what callers branch on. The
 * ones worth naming, from `routes/bridges.ts`:
 *
 * | code | what happened |
 * |---|---|
 * | `Not Found` | the network is off, unknown, or the attempt is gone (§9.2 rule 3) |
 * | `too_many_accounts` | the per-network limit is reached |
 * | `link_expired` | the step outlived its window — WhatsApp's QR is ~2m40s |
 * | `bridge_unreachable` / `bridge_error` | the bridge, not the user, is the problem |
 * | `FI.MAU.TELEGRAM.PHONE_CODE_INVALID` and friends | the user's input was refused |
 *
 * The last row is why this is not an enum: those codes are the bridge's, they
 * arrive verbatim, and there is no version of this app that knows all of them.
 */
export class BridgeApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'BridgeApiError';
  }
}

/**
 * The backend's failure envelope, `{ error, message }`.
 *
 * Read off whatever the HTTP client threw rather than assumed: the linked client
 * raises its own error type, and the response body may not have survived it.
 */
const errorEnvelopeSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

function toBridgeApiError(cause: unknown, fallbackMessage: string): BridgeApiError {
  if (cause instanceof BridgeApiError) return cause;

  const status =
    typeof cause === 'object' && cause !== null
      ? readNumber(cause, 'status') ?? readNumber(cause, 'statusCode')
      : undefined;

  const body =
    typeof cause === 'object' && cause !== null
      ? (Reflect.get(cause, 'data') ?? Reflect.get(cause, 'response'))
      : undefined;
  const envelope = errorEnvelopeSchema.safeParse(body);
  const code = envelope.success ? envelope.data.error : undefined;
  const message = envelope.success ? envelope.data.message : undefined;

  return new BridgeApiError(
    message ?? (cause instanceof Error ? cause.message : fallbackMessage),
    code ?? 'bridge_request_failed',
    status,
  );
}

function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'number' ? value : undefined;
}

/**
 * Runs a call and turns both failure modes into one error type.
 *
 * A transport failure and a response whose shape moved are different bugs, and
 * they are labelled differently — `bridge_request_failed` against
 * `bridge_response_invalid` — because the first is an outage and the second is a
 * deploy skew, and a support ticket that cannot tell them apart costs an
 * afternoon.
 */
async function parsed<T>(
  schema: z.ZodType<T>,
  fallbackMessage: string,
  call: () => Promise<{ data: unknown }>,
): Promise<T> {
  let payload: unknown;
  try {
    ({ data: payload } = await call());
  } catch (cause) {
    throw toBridgeApiError(cause, fallbackMessage);
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new BridgeApiError(
      `${fallbackMessage}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
      'bridge_response_invalid',
      undefined,
    );
  }
  return result.data;
}

/**
 * The networks this deployment offers, in the order the server chose.
 *
 * Not sorted here. `loadBridgesConfig` already emits them in catalogue order —
 * stable across deployments, unlike the order somebody typed into an environment
 * variable — and a second sort in the client would be a second thing that can
 * disagree with the first.
 */
export async function listBridgeNetworks(): Promise<readonly BridgeNetwork[]> {
  const { networks } = await parsed(
    bridgeNetworkListSchema,
    'The list of networks could not be read',
    () => api.get('/bridges/networks'),
  );
  return networks;
}

export async function listBridgeAccounts(): Promise<readonly BridgeAccount[]> {
  const { accounts } = await parsed(
    bridgeAccountListSchema,
    'The list of linked accounts could not be read',
    () => api.get('/bridges/accounts'),
  );
  return accounts;
}

export interface StartBridgeLinkInput {
  readonly networkId: string;
  readonly flowId: string;
  /**
   * A phone number used ONLY to choose the country a proxy lease egresses from,
   * and never stored (§5.5, §8.3 rule 2).
   *
   * Sent only for networks that declare `requiresProxy`, because for every other
   * network it is a phone number the backend has no use for — and the cheapest
   * way not to leak a piece of data is not to send it.
   */
  readonly phoneNumberHint?: string;
}

export async function startBridgeLink(
  input: StartBridgeLinkInput,
): Promise<BridgeLinkState> {
  return await parsed(
    bridgeLinkStateSchema,
    'The link attempt could not be started',
    () =>
      api.post(`/bridges/networks/${encodeURIComponent(input.networkId)}/link`, {
        flowId: input.flowId,
        ...(input.phoneNumberHint ? { phoneNumberHint: input.phoneNumberHint } : {}),
      }),
  );
}

/**
 * Asks whether a `display_and_wait` step has moved.
 *
 * The backend holds a blocking call open against the bridge for its own timeout
 * and then answers either way, so this resolves with a step or with
 * `{ waiting: true }`. Both are successes; only a thrown `BridgeApiError` is not.
 */
export async function pollBridgeLink(linkId: string): Promise<BridgeLinkPoll> {
  return await parsed(
    bridgeLinkPollSchema,
    'The link attempt could not be read',
    () => api.get(`/bridges/links/${encodeURIComponent(linkId)}`),
  );
}

export async function submitBridgeLinkStep(
  linkId: string,
  values: Readonly<Record<string, string>>,
): Promise<BridgeLinkState> {
  return await parsed(
    bridgeLinkStateSchema,
    'The answer could not be sent',
    () => api.post(`/bridges/links/${encodeURIComponent(linkId)}/submit`, { values }),
  );
}

export async function cancelBridgeLink(linkId: string): Promise<void> {
  await parsed(
    bridgeCancelResultSchema,
    'The link attempt could not be cancelled',
    () => api.delete(`/bridges/links/${encodeURIComponent(linkId)}`),
  );
}

export async function unlinkBridgeAccount(accountId: string): Promise<void> {
  await parsed(
    bridgeUnlinkResultSchema,
    'The account could not be unlinked',
    () => api.delete(`/bridges/accounts/${encodeURIComponent(accountId)}`),
  );
}

/**
 * Re-reads the account's state from the bridge.
 *
 * bridgev2's provisioning API has no "reconnect", so the backend does the only
 * useful thing it does support: re-reads `whoami` and reconciles. That is what
 * clears an account the staleness sweep marked `failed` while the bridge was in
 * fact fine, and it is why this button is not a no-op that returns 200.
 */
export async function reconnectBridgeAccount(
  accountId: string,
): Promise<BridgeAccountState> {
  const { state } = await parsed(
    bridgeReconnectResultSchema,
    'The account could not be refreshed',
    () => api.post(`/bridges/accounts/${encodeURIComponent(accountId)}/reconnect`, {}),
  );
  return state;
}
