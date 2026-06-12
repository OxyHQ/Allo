/**
 * Interop bridge (F3.x) — typed client for the backend `/api/bridge/*` routes.
 *
 * Every route is flag-gated server-side (`BRIDGE_ENABLED`): when the flag is off
 * the backend returns 404. These helpers surface that as `BridgeUnavailableError`
 * so the UI can degrade to a graceful "not available" state instead of an error.
 *
 * Session/login operations are PROXIED by the backend to the bridge connector;
 * the Allo backend never stores external credentials. Codes/passwords submitted
 * here travel straight through to the connector and are never persisted.
 *
 * Response envelope: the backend wraps success payloads as `{ data: <payload> }`
 * (see `apiHelpers.sendSuccessResponse`), and the frontend `api` client returns
 * `{ data: response.data }` — so the payload lives at `response.data.data`.
 */

import type { Network, BridgeLinkStepResult, BridgeExternalSelf } from '@allo/shared-types';
import { api } from '@/utils/api';

/**
 * Canonical synchronous link-step result, re-exported from the shared contract.
 * The connector is the source of truth for link state; the backend relays this
 * body verbatim. Use the enum `status` (`pending` | `needs_code` |
 * `needs_password` | `active` | `error`) and the canonical `loginUrl` field.
 */
export type { BridgeLinkStepResult, BridgeExternalSelf } from '@allo/shared-types';

/**
 * Status of a single PERSISTED linked external account (mirrors backend
 * `LinkedAccountStatus`). This is the ASYNCHRONOUS session lifecycle returned by
 * `GET /accounts/:network/status` — distinct from the synchronous
 * `BridgeLinkStatus` of a link step (see shared-types `interop.ts`).
 */
export type LinkedAccountStatus =
  | 'pending_login'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'error';

/** The user's own identity on an external network (persisted shape, allows avatar). */
export interface ExternalSelf extends BridgeExternalSelf {
  avatarUrl?: string;
}

/** A linked external account as returned by `GET /api/bridge/accounts`. */
export interface LinkedAccount {
  userId: string;
  network: Network;
  status: LinkedAccountStatus;
  externalSelf?: ExternalSelf;
  lastSyncAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** An external contact as returned by `GET /api/bridge/contacts`. */
export interface ExternalContact {
  ownerUserId: string;
  network: Network;
  externalId: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  phoneHint?: string;
}

/**
 * Thrown when a bridge route 404s, which the backend uses to mean
 * "BRIDGE_ENABLED is off". Callers treat this as "feature unavailable", not a
 * hard failure.
 */
export class BridgeUnavailableError extends Error {
  constructor() {
    super('Bridge feature is not available');
    this.name = 'BridgeUnavailableError';
  }
}

/**
 * Fallback link step result when the connector returns an empty/missing body.
 * Treated as an error step so the UI never silently stalls on a malformed reply.
 */
const MALFORMED_LINK_STEP: BridgeLinkStepResult = { v: 1, status: 'error' };

/** True when an axios-style error carries an HTTP 404. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 404;
}

/**
 * Run a bridge request, converting a 404 into `BridgeUnavailableError`. Any other
 * error propagates unchanged so React Query / callers can handle it.
 */
async function callBridge<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNotFound(error)) throw new BridgeUnavailableError();
    throw error;
  }
}

/** Unwrap the `{ data: <payload> }` envelope the backend returns. */
function unwrap<T>(response: { data: { data?: T } }): T {
  const payload = response.data?.data;
  if (payload === undefined || payload === null) {
    throw new Error('Bridge response was empty');
  }
  return payload;
}

/** GET /api/bridge/accounts — list the user's linked external accounts. */
export async function listLinkedAccounts(): Promise<LinkedAccount[]> {
  return callBridge(async () => {
    const response = await api.get<{ data?: { accounts?: LinkedAccount[] } }>('/bridge/accounts');
    return response.data?.data?.accounts ?? [];
  });
}

/**
 * POST /api/bridge/accounts/:network/link — begin a login.
 *
 * The backend forwards the request body to the connector verbatim. For the PHONE
 * flow the caller passes `{ phoneNumber }` so the connector can text a code; for
 * the QR flow no body is sent and the connector returns a `loginUrl` to render.
 */
export async function startLink(
  network: Network,
  phoneNumber?: string
): Promise<BridgeLinkStepResult> {
  return callBridge(async () => {
    const body = phoneNumber ? { phoneNumber } : undefined;
    const response = await api.post<{ data?: BridgeLinkStepResult }>(
      `/bridge/accounts/${network}/link`,
      body
    );
    return response.data?.data ?? MALFORMED_LINK_STEP;
  });
}

/** POST /api/bridge/accounts/:network/link/code — submit a phone login code. */
export async function submitLinkCode(
  network: Network,
  code: string
): Promise<BridgeLinkStepResult> {
  return callBridge(async () => {
    const response = await api.post<{ data?: BridgeLinkStepResult }>(
      `/bridge/accounts/${network}/link/code`,
      { code }
    );
    return response.data?.data ?? MALFORMED_LINK_STEP;
  });
}

/** POST /api/bridge/accounts/:network/link/password — submit a 2FA password. */
export async function submitLinkPassword(
  network: Network,
  password: string
): Promise<BridgeLinkStepResult> {
  return callBridge(async () => {
    const response = await api.post<{ data?: BridgeLinkStepResult }>(
      `/bridge/accounts/${network}/link/password`,
      { password }
    );
    return response.data?.data ?? MALFORMED_LINK_STEP;
  });
}

/** GET /api/bridge/accounts/:network/status — current link status (404 if unlinked). */
export async function getLinkStatus(network: Network): Promise<LinkedAccountStatus | null> {
  try {
    const response = await api.get<{ data?: { status?: LinkedAccountStatus } }>(
      `/bridge/accounts/${network}/status`
    );
    return response.data?.data?.status ?? null;
  } catch (error) {
    if (isNotFound(error)) {
      // 404 here is ambiguous: either the flag is off OR the account simply isn't
      // linked. The status poller only runs after a successful `startLink`, so we
      // treat 404 as "no active link yet" rather than throwing.
      return null;
    }
    throw error;
  }
}

/** DELETE /api/bridge/accounts/:network — unlink (keeps conversations as history). */
export async function unlinkAccount(network: Network): Promise<void> {
  await callBridge(async () => {
    await api.delete(`/bridge/accounts/${network}`);
  });
}

/** GET /api/bridge/contacts?network= — list the user's external contacts. */
export async function listExternalContacts(network: Network): Promise<ExternalContact[]> {
  return callBridge(async () => {
    const response = await api.get<{ data?: { contacts?: ExternalContact[] } }>(
      '/bridge/contacts',
      { network }
    );
    return response.data?.data?.contacts ?? [];
  });
}

/**
 * Raw bridged-conversation document returned by `POST /api/bridge/conversations`.
 * The route spreads the Mongo document and overrides `network`, so we read the
 * fields the conversations store needs to map it.
 */
export interface BridgedConversationResponse {
  _id?: string;
  id?: string;
  type?: 'direct' | 'group';
  name?: string;
  avatar?: string;
  theme?: string;
  network: Network;
  createdAt?: string;
  lastMessageAt?: string;
  participants?: { userId?: string; username?: string; avatar?: string }[];
  externalParticipants?: {
    network: Network;
    externalId: string;
    displayName?: string;
    username?: string;
    avatar?: string;
  }[];
}

/** POST /api/bridge/conversations — open (or fetch) a bridged 1:1 conversation. */
export async function openBridgedConversation(
  network: Network,
  externalId: string
): Promise<BridgedConversationResponse> {
  return callBridge(async () => {
    const response = await api.post<{ data?: BridgedConversationResponse }>(
      '/bridge/conversations',
      { network, externalId }
    );
    return unwrap(response);
  });
}
