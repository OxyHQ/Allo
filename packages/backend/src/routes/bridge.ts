import { Router, Response } from "express";
import { isNetwork, type Network } from "@allo/shared-types";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import LinkedAccount from "../models/LinkedAccount";
import ExternalContact from "../models/ExternalContact";
import { getBridgeServiceUrl, BRIDGE_TIMESTAMP_HEADER, BRIDGE_SIGNATURE_HEADER } from "../config/bridge";
import { signBridgeRequest } from "../services/BridgeService";
import { findOrCreateBridgedConversation } from "../services/BridgeInboundService";

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
    const { timestamp, signature } = signBridgeRequest(rawBody);
    const response = await fetch(`${baseUrl}${relativePath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TIMESTAMP_HEADER]: timestamp,
        [BRIDGE_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });
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
 * start a login (returns e.g. a QR / login token to relay to the client).
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

    const proxied = await proxyToConnector(`/sessions/${network}/link`, { ownerUserId: userId });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    return sendSuccessResponse(res, 200, proxied.body);
  } catch (err) {
    logger.error("Failed to start account link", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to start link");
  }
});

/**
 * POST /api/bridge/accounts/:network/link/code
 * Submit a login code (e.g. Telegram SMS code) to the connector.
 */
router.post("/accounts/:network/link/code", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const { code } = req.body as { code?: string };
    const proxied = await proxyToConnector(`/sessions/${network}/link/code`, {
      ownerUserId: userId,
      code,
    });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    return sendSuccessResponse(res, 200, proxied.body);
  } catch (err) {
    logger.error("Failed to submit link code", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to submit code");
  }
});

/**
 * POST /api/bridge/accounts/:network/link/password
 * Submit a 2FA password (e.g. Telegram cloud password) to the connector.
 */
router.post("/accounts/:network/link/password", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const network = parseNetworkParam(req, res);
    if (!network) return res;

    const { password } = req.body as { password?: string };
    const proxied = await proxyToConnector(`/sessions/${network}/link/password`, {
      ownerUserId: userId,
      password,
    });
    if (!proxied.ok) {
      return sendErrorResponse(res, 502, "Bad Gateway", "Bridge service unavailable");
    }
    return sendSuccessResponse(res, 200, proxied.body);
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
