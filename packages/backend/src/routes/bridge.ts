import { Router, Response } from "express";
import { isNetwork, type Network, type BridgeLinkStepResult } from "@allo/shared-types";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import LinkedAccount from "../models/LinkedAccount";
import ExternalContact from "../models/ExternalContact";
import {
  getBridgeServiceUrl,
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_REQUEST_TIMEOUT_MS,
} from "../config/bridge";
import { signBridgeRequest } from "../services/BridgeService";
import { fetchWithTimeout } from "../utils/bridgeSigning";
import { findOrCreateBridgedConversation } from "../services/BridgeInboundService";

/** HTTP method used for every connector proxy call. */
const CONNECTOR_METHOD = "POST";

/**
 * User-facing bridge routes (`/api/bridge`, under Oxy auth, flag-gated in
 * server.ts). Let an Allo user link an external account, browse their external
 * contacts, and open bridged conversations.
 *
 * Session/login operations are PROXIED to the bridge connector (signed with the
 * shared HMAC). The Allo backend never stores external credentials — the
 * connector owns the session; we only keep an opaque `LinkedAccount` record.
 */

const router = Router();

/** Result of a proxied connector call. */
type ProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false };

/**
 * POST a signed JSON body to a connector path (relative, e.g. `/sessions/telegram/link`).
 * Returns the parsed JSON response, or `{ ok: false }` when the connector is
 * unreachable / misconfigured. Never logs the request/response body.
 */
async function proxyToConnector(relativePath: string, payload: unknown): Promise<ProxyResult> {
  const baseUrl = getBridgeServiceUrl();
  if (!baseUrl) {
    logger.error("Bridge proxy attempted but BRIDGE_SERVICE_URL is not configured");
    return { ok: false };
  }
  const rawBody = JSON.stringify(payload);
  try {
    // The connector verifies method + the path IT receives (`relativePath`) +
    // timestamp + body, so we sign that exact tuple.
    const { timestamp, signature } = signBridgeRequest(CONNECTOR_METHOD, relativePath, rawBody);
    const response = await fetchWithTimeout(
      `${baseUrl}${relativePath}`,
      {
        method: CONNECTOR_METHOD,
        headers: {
          "Content-Type": "application/json",
          [BRIDGE_TIMESTAMP_HEADER]: timestamp,
          [BRIDGE_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      },
      BRIDGE_REQUEST_TIMEOUT_MS
    );
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Connector may return an empty body; treat as null payload.
      body = null;
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    logger.error(`Bridge proxy to ${relativePath} failed`, error);
    return { ok: false };
  }
}

/**
 * Treat a request body as a plain field bag we can spread into a connector
 * payload. Arrays and `null` (both `typeof === "object"`) are NOT plain objects
 * and would corrupt the payload, so they collapse to an empty bag. The
 * authenticated `ownerUserId` is always applied AFTER this spread, so a client
 * can never override it (e.g. by sending `{"ownerUserId":"attacker"}`).
 */
function asClientFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

/**
 * Relay a connector link-step response to the HTTP client.
 *
 * The connector is the SOURCE OF TRUTH for link state, so on the normal path we
 * relay its JSON object verbatim (no reshaping, no field stripping). The only
 * guard is structural: a non-object connector body (null/array/primitive) is a
 * contract violation we surface as a typed `error` step rather than leaking a
 * malformed shape to the client.
 */
function asLinkStepResult(body: unknown): BridgeLinkStepResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { v: 1, status: "error", error: "Bridge service returned a malformed response" };
  }
  return body as BridgeLinkStepResult;
}

/** Parse and validate the `:network` route param, or send a 400. */
function parseNetworkParam(req: AuthRequest, res: Response): Network | null {
  const network = req.params.network;
  if (!isNetwork(network)) {
    sendErrorResponse(res, 400, "Bad Request", "Unknown network");
    return null;
  }
  return network;
}

/**
 * GET /api/bridge/accounts
 * List the user's linked external accounts.
 */
router.get("/accounts", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const accounts = await LinkedAccount.find({ userId });
    return sendSuccessResponse(res, 200, { accounts });
  } catch (err) {
    logger.error("Failed to list linked accounts", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to list linked accounts");
  }
});

/**
 * POST /api/bridge/accounts/:network/link
 * Begin linking a network: mark the account pending and ask the connector to
 * start a login. The client body is forwarded to the connector (e.g.
 * `{ phoneNumber }` for phone login, or `{}` for QR login) so phone-based flows
 * work; `ownerUserId` is always the authenticated user (applied AFTER the spread
 * so a client cannot override it). The connector's `BridgeLinkStepResult` is
 * relayed verbatim.
 */
router.post("/accounts/:network/link", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    await LinkedAccount.findOneAndUpdate(
      { userId, network },
      { $set: { status: "pending_login" } },
      { upsert: true, new: true }
    );

    const proxied = await proxyToConnector(`/sessions/${network}/link`, {
      ...asClientFields(req.body),
      ownerUserId: userId,
    });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    const result: BridgeLinkStepResult = asLinkStepResult(proxied.body);
    return sendSuccessResponse(res, 200, result);
  } catch (err) {
    logger.error("Failed to start account link", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to start link");
  }
});

/**
 * POST /api/bridge/accounts/:network/link/code
 * Submit a login code (e.g. Telegram SMS code) to the connector. The full client
 * body is forwarded so any extra fields the connector's code step needs (e.g. a
 * phone-code hash) pass through; `ownerUserId` stays authoritative. Relays the
 * connector's `BridgeLinkStepResult` verbatim.
 */
router.post("/accounts/:network/link/code", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const proxied = await proxyToConnector(`/sessions/${network}/link/code`, {
      ...asClientFields(req.body),
      ownerUserId: userId,
    });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    const result: BridgeLinkStepResult = asLinkStepResult(proxied.body);
    return sendSuccessResponse(res, 200, result);
  } catch (err) {
    logger.error("Failed to submit link code", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to submit code");
  }
});

/**
 * POST /api/bridge/accounts/:network/link/password
 * Submit a 2FA password (e.g. Telegram cloud password) to the connector. The full
 * client body is forwarded (so any extra fields the connector's password step
 * needs pass through); `ownerUserId` stays authoritative. Relays the connector's
 * `BridgeLinkStepResult` verbatim.
 */
router.post("/accounts/:network/link/password", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const proxied = await proxyToConnector(`/sessions/${network}/link/password`, {
      ...asClientFields(req.body),
      ownerUserId: userId,
    });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    const result: BridgeLinkStepResult = asLinkStepResult(proxied.body);
    return sendSuccessResponse(res, 200, result);
  } catch (err) {
    logger.error("Failed to submit link password", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to submit password");
  }
});

/**
 * GET /api/bridge/accounts/:network/status
 * Return the stored link status for a network (404 if not linked).
 */
router.get("/accounts/:network/status", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const account = await LinkedAccount.findOne({ userId, network });
    if (!account) {
      return sendErrorResponse(res, 404, "Not Found", "No linked account for this network");
    }
    return sendSuccessResponse(res, 200, { status: account.status });
  } catch (err) {
    logger.error("Failed to get account status", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to get status");
  }
});

/**
 * DELETE /api/bridge/accounts/:network
 * Unlink a network: ask the connector to log out, then mark the account revoked
 * locally. Local state is authoritative for the seam — if the connector is
 * unreachable we still revoke locally and return 200 (the proxy failure is
 * logged). Conversations are kept as history; GDPR-complete deletion (wiping
 * bridged conversations) is a later concern.
 */
router.delete("/accounts/:network", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const proxied = await proxyToConnector(`/sessions/${network}/logout`, { ownerUserId: userId });
    if (!proxied.ok) {
      logger.warn("Connector logout failed; revoking link locally anyway");
    }
    await LinkedAccount.findOneAndUpdate(
      { userId, network },
      { $set: { status: "revoked" } }
    );
    return sendSuccessResponse(res, 200, { status: "revoked" });
  } catch (err) {
    logger.error("Failed to unlink account", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to unlink account");
  }
});

/**
 * GET /api/bridge/contacts?network=
 * List the user's known external contacts on a network.
 */
router.get("/contacts", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = req.query.network;
    if (!isNetwork(network)) {
      return sendErrorResponse(res, 400, "Bad Request", "Unknown or missing network");
    }
    const contacts = await ExternalContact.find({ ownerUserId: userId, network });
    return sendSuccessResponse(res, 200, { contacts });
  } catch (err) {
    logger.error("Failed to list contacts", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to list contacts");
  }
});

/**
 * POST /api/bridge/conversations
 * Open (or fetch) a bridged 1:1 conversation with an external contact. For a 1:1
 * the externalChatId IS the contact's externalId.
 */
router.post("/conversations", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { network, externalId } = req.body as { network?: unknown; externalId?: unknown };
    if (!isNetwork(network)) {
      return sendErrorResponse(res, 400, "Bad Request", "Unknown or missing network");
    }
    if (typeof externalId !== "string" || externalId.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "externalId is required");
    }

    const contact = await ExternalContact.findOne({ ownerUserId: userId, network, externalId });
    const conversation = await findOrCreateBridgedConversation({
      network,
      ownerUserId: userId,
      externalChatId: externalId,
      contact: {
        externalId,
        displayName: contact?.displayName,
        username: contact?.username,
        avatar: contact?.avatarUrl,
      },
    });

    const obj = conversation.toObject();
    return sendSuccessResponse(res, 200, { ...obj, network: conversation.bridge?.network ?? "allo" });
  } catch (err) {
    logger.error("Failed to open bridged conversation", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to open conversation");
  }
});

export default router;
