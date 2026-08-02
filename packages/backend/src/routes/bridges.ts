import { Router, type Response } from "express";
import type { OxyAuthRequest as AuthRequest } from "@oxyhq/core/server";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import {
  bridgesConfig,
  enabledBridgeNetwork,
  enabledBridgeNetworks,
  type EnabledBridgeNetwork,
} from "../config/bridges";
import BridgeAccount, { type LeanBridgeAccount } from "../models/BridgeAccount";
import BridgeLinkSession, {
  type LeanBridgeLinkSession,
} from "../models/BridgeLinkSession";
import {
  awaitStep,
  BridgeLinkError,
  cancelLink,
  startLink,
  submitStep,
  userFacingLoginFlows,
  type AlloLinkState,
} from "../services/bridges/BridgeLinkService";
import {
  BridgeRejectedError,
  BridgeUnreachableError,
  createBridgeProvisioningClient,
} from "../services/bridges/BridgeProvisioningClient";
import { matrixUserIdForOxyUser } from "../services/bridges/matrixIdentity";
import { accountStateForBridgeState } from "../services/bridges/bridgeStateMapping";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";

/**
 * `/api/bridges/*` — the only surface the app ever talks to (docs/matrix/bridges.md §5.2).
 *
 * ## A disabled network answers 404, not 403
 *
 * §9.2 rule 3, and the reason is enumeration: 403 says "this exists but you may
 * not", which is a roadmap the app can read by probing identifiers. 404 says
 * nothing. Every route below goes through `resolveNetwork`, which returns the
 * same 404 for a network that is unknown, unlisted, half-configured or missing
 * its proxy provider — cases the caller cannot tell apart, on purpose.
 *
 * ## The MXID is never taken from the request
 *
 * §5.1's non-negotiable rule. Everything here derives it from
 * `getRequiredOxyUserId(req)`. The provisioning shared secret makes a bridge
 * believe `?user_id=` without further checks, so an MXID a client could
 * influence would make these endpoints "link an account for whoever you like".
 * The same rule is why every lookup below is scoped by `oxyUserId` rather than
 * by identifier alone.
 */

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The 404 that a disabled, unknown or unconfigured network all produce. */
function resolveNetwork(
  res: Response,
  candidate: string,
): EnabledBridgeNetwork | undefined {
  const network = enabledBridgeNetwork(candidate);
  if (!network) {
    sendErrorResponse(res, 404, "Not Found", "No such network");
    return undefined;
  }
  return network;
}

function publicAccount(account: LeanBridgeAccount) {
  return {
    id: account._id.toString(),
    network: account.network,
    state: account.state,
    remoteName: account.remoteName,
    remoteProfile: account.remoteProfile,
    spaceRoomId: account.spaceRoomId,
    linkedAt: account.linkedAt,
    lastStateAt: account.lastStateAt,
    lastConnectedAt: account.lastConnectedAt,
    /**
     * The bridge's own error code, and nothing else from `rawState`.
     *
     * `FI.MAU.TELEGRAM.PHONE_CODE_INVALID` and friends are worth surfacing —
     * the app can act on them. The bridge's free-text `message` is not: it is
     * written for an operator, changes between releases, and is the field most
     * likely to name internal hosts.
     */
    errorCode: account.rawState?.error,
  };
}

function publicLinkState(state: AlloLinkState) {
  return {
    linkId: state.linkId,
    network: state.network,
    expiresAt: state.expiresAt,
    step: state.step,
    ...(state.account ? { account: publicAccount(state.account) } : {}),
  };
}

/**
 * Turns a failure into a response.
 *
 * Bridge-side refusals keep their code so the app can tell "wrong verification
 * code" from "the bridge is down" — the difference between a field to correct
 * and a screen to back out of.
 */
function sendBridgeFailure(res: Response, error: unknown, context: string): Response {
  if (error instanceof BridgeLinkError) {
    const status =
      error.code === "network_not_found" || error.code === "flow_not_found"
        ? 404
        : error.code === "too_many_accounts"
          ? 409
          : error.code === "link_not_found"
            ? 404
            : error.code === "link_expired"
              ? 410
              : 501;
    return sendErrorResponse(res, status, error.code, error.message);
  }

  if (error instanceof BridgeRejectedError) {
    /**
     * 4xx from the bridge is relayed as 400 with its code: it is the user's
     * input that was refused. 5xx becomes 502: the bridge is the upstream that
     * failed, and calling that a client error would send the user to re-type a
     * correct code forever.
     */
    if (error.status >= 400 && error.status < 500) {
      return sendErrorResponse(
        res,
        400,
        error.errorCode ?? "bridge_rejected",
        error.bridgeMessage ?? "The network refused this step",
      );
    }
    return sendErrorResponse(res, 502, "bridge_error", "The network could not be reached");
  }

  if (error instanceof BridgeUnreachableError) {
    return sendErrorResponse(res, 502, "bridge_unreachable", "The network could not be reached");
  }

  logger.error(`[Bridges] ${context}`, error);
  return sendErrorResponse(res, 500, "Internal Server Error", "Something went wrong");
}

/**
 * `GET /api/bridges/networks` — the catalogue the app renders.
 *
 * The single source of truth for the account-linking screen: the app carries no
 * list of its own, so turning a network on is an environment variable and a
 * deploy rather than a release in two app stores (§9.2).
 *
 * A network whose flows cannot be read right now is omitted rather than listed
 * without them — a row in the picker that cannot start a login is worse than no
 * row. `userFacingLoginFlows` serves a cached list through a brief outage, so
 * this only happens when a bridge has never answered.
 */
router.get("/networks", async (req: AuthRequest, res: Response) => {
  try {
    const networks = await Promise.all(
      enabledBridgeNetworks().map(async (network) => {
        const flows = await userFacingLoginFlows(network);
        if (!flows || flows.length === 0) return undefined;
        return {
          id: network.id,
          displayName: network.displayName,
          /**
           * Whether this network's anti-fraud makes a shared datacentre egress
           * unacceptable (§8) — and therefore, from the app's side, whether
           * linking it puts the user's remote account at risk of being banned.
           *
           * It is the same property under both readings, which is why the app is
           * given this one rather than a second "banRisk" field that could drift
           * from it. A network only reaches this catalogue with a proxy provider
           * configured (§9.2 rule 2, enforced at boot), so `true` here means "the
           * egress is per-user AND the remote network bans unofficial clients" —
           * exactly the pair the user has to weigh before deciding.
           */
          requiresProxy: network.requiresProxy,
          capabilities: network.capabilities,
          loginFlows: flows.map((flow) => ({
            id: flow.id,
            name: flow.name ?? flow.id,
            description: flow.description,
          })),
        };
      }),
    );

    return sendSuccessResponse(res, 200, {
      networks: networks.filter((network) => network !== undefined),
    });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to list networks");
  }
});

/** `GET /api/bridges/accounts` — this user's linked accounts, and nobody else's. */
router.get("/accounts", async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const accounts = await BridgeAccount.find({ oxyUserId })
      .sort({ linkedAt: 1 })
      .lean<LeanBridgeAccount[]>();

    return sendSuccessResponse(res, 200, { accounts: accounts.map(publicAccount) });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to list accounts");
  }
});

/** `POST /api/bridges/networks/:network/link` — start a login attempt. */
router.post("/networks/:network/link", async (req: AuthRequest, res: Response) => {
  const network = resolveNetwork(res, req.params.network);
  if (!network) return res;

  const body: unknown = req.body;
  if (!isRecord(body)) {
    return sendErrorResponse(res, 400, "Bad Request", "A JSON object body is required");
  }
  const flowId: unknown = body.flowId;
  if (typeof flowId !== "string" || flowId.trim().length === 0) {
    return sendErrorResponse(res, 400, "Bad Request", "flowId is required");
  }

  /**
   * A hint used ONLY to decide a proxy lease's country, and never stored (§5.5,
   * §8.3 rule 2). The country that comes out of it is stored; a country is not a
   * phone number.
   */
  const phoneNumberHint: unknown = body.phoneNumberHint;
  if (phoneNumberHint !== undefined && typeof phoneNumberHint !== "string") {
    return sendErrorResponse(res, 400, "Bad Request", "phoneNumberHint must be a string");
  }

  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const state = await startLink({
      oxyUserId,
      network,
      flowId: flowId.trim(),
      ...(typeof phoneNumberHint === "string" ? { phoneNumberHint } : {}),
      ...(requestCountry(req) ? { requestCountry: requestCountry(req) } : {}),
    });

    emitLinkUpdate(req, oxyUserId, state);
    return sendSuccessResponse(res, 201, publicLinkState(state));
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to start a link");
  }
});

/**
 * `GET /api/bridges/links/:linkId` — the long-poll behind a QR code (§5.2).
 *
 * Socket.IO is the good path and this is the one that always works: a phone
 * cannot hold an HTTP request open indefinitely, so this returns after its own
 * timeout with the step unchanged and the client asks again. A timeout is not an
 * error here — WhatsApp's QR refreshes as a NEW `display_and_wait` step with the
 * same id, so the client repaints without restarting the attempt.
 */
router.get("/links/:linkId", async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const session = await findSession(oxyUserId, req.params.linkId);
    if (!session) {
      return sendErrorResponse(res, 404, "Not Found", "No such link attempt");
    }

    const network = resolveNetwork(res, session.network);
    if (!network) return res;

    const timeoutMs = Math.min(
      bridgesConfig().httpTimeoutMs,
      Math.max(0, session.expiresAt.getTime() - Date.now()),
    );

    const advanced =
      timeoutMs > 0 ? await awaitStep(oxyUserId, network, session, timeoutMs) : undefined;

    if (advanced) {
      emitLinkUpdate(req, oxyUserId, advanced);
      return sendSuccessResponse(res, 200, publicLinkState(advanced));
    }

    return sendSuccessResponse(res, 200, {
      linkId: session.linkId,
      network: session.network,
      expiresAt: session.expiresAt,
      outcome: session.outcome,
      waiting: true,
    });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to read a link attempt");
  }
});

/** `POST /api/bridges/links/:linkId/submit` — answer the current step. */
router.post("/links/:linkId/submit", async (req: AuthRequest, res: Response) => {
  const body: unknown = req.body;
  if (!isRecord(body)) {
    return sendErrorResponse(res, 400, "Bad Request", "A JSON object body is required");
  }

  const values = readStringValues(body.values);
  if (!values) {
    return sendErrorResponse(
      res,
      400,
      "Bad Request",
      "values must be an object of string answers",
    );
  }

  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const session = await findSession(oxyUserId, req.params.linkId);
    if (!session) {
      return sendErrorResponse(res, 404, "Not Found", "No such link attempt");
    }

    const network = resolveNetwork(res, session.network);
    if (!network) return res;

    const state = await submitStep({ oxyUserId, network, session, values });
    emitLinkUpdate(req, oxyUserId, state);
    return sendSuccessResponse(res, 200, publicLinkState(state));
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to submit a login step");
  }
});

/** `DELETE /api/bridges/links/:linkId` — give up on an attempt. */
router.delete("/links/:linkId", async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const session = await findSession(oxyUserId, req.params.linkId);
    if (!session) {
      return sendErrorResponse(res, 404, "Not Found", "No such link attempt");
    }

    const network = resolveNetwork(res, session.network);
    if (!network) return res;

    await cancelLink(oxyUserId, network, session);
    return sendSuccessResponse(res, 200, { linkId: session.linkId, outcome: "cancelled" });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to cancel a link attempt");
  }
});

/**
 * `DELETE /api/bridges/accounts/:accountId` — unlink.
 *
 * The proxy lease is deliberately NOT released (§5.2, §8.3 rule 3): coming back
 * to a network has to mean coming back through the same geography, and a lease
 * freed here would hand the user a different country next time.
 */
router.delete("/accounts/:accountId", async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const account = await findAccount(oxyUserId, req.params.accountId);
    if (!account) {
      return sendErrorResponse(res, 404, "Not Found", "No such account");
    }

    const network = resolveNetwork(res, account.network);
    if (!network) return res;

    const client = createBridgeProvisioningClient(network);
    await client.logout(matrixUserIdForOxyUser(oxyUserId), account.remoteLoginId);
    await BridgeAccount.deleteOne({ _id: account._id });

    logger.info("[Bridges] account unlinked", { network: network.id });
    return sendSuccessResponse(res, 200, { id: account._id.toString(), unlinked: true });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to unlink an account");
  }
});

/**
 * `POST /api/bridges/accounts/:accountId/reconnect` — ask the bridge again.
 *
 * bridgev2's provisioning API (§6.1) has no "reconnect" call, so this does the
 * only thing that API supports and that is actually useful: re-reads `whoami`
 * and reconciles the stored state from it. That is exactly what §5.4 prescribes
 * for an account that has gone quiet, and it is what clears an account the TTL
 * sweep marked `failed` while the bridge was in fact fine.
 *
 * It is deliberately not a no-op that returns 200 — a button that pretends to
 * act is worse than one that is not there.
 */
router.post("/accounts/:accountId/reconnect", async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const account = await findAccount(oxyUserId, req.params.accountId);
    if (!account) {
      return sendErrorResponse(res, 404, "Not Found", "No such account");
    }

    const network = resolveNetwork(res, account.network);
    if (!network) return res;

    const client = createBridgeProvisioningClient(network);
    const logins = await client.whoami(matrixUserIdForOxyUser(oxyUserId));
    const login = logins.find((candidate) => candidate.id === account.remoteLoginId);

    if (!login) {
      /**
       * The bridge does not know this login any more, which means the session is
       * gone on the remote side. `action_required` is the honest state: nothing
       * we do here will bring it back, and only the user can re-link.
       */
      await BridgeAccount.updateOne(
        { _id: account._id },
        { $set: { state: "action_required", lastStateAt: new Date() } },
      );
      return sendSuccessResponse(res, 200, { id: account._id.toString(), state: "action_required" });
    }

    const state = login.state ? accountStateForBridgeState(login.state) : account.state;
    const now = new Date();
    await BridgeAccount.updateOne(
      { _id: account._id },
      {
        $set: {
          state,
          lastStateAt: now,
          ...(login.name ? { remoteName: login.name } : {}),
          ...(login.space_room ? { spaceRoomId: login.space_room } : {}),
          ...(state === "connected" ? { lastConnectedAt: now } : {}),
        },
        ...(state === "connected"
          ? { $unset: { lastNotifiedState: "", lastNotifiedAt: "" } }
          : {}),
      },
    );

    return sendSuccessResponse(res, 200, { id: account._id.toString(), state });
  } catch (error) {
    return sendBridgeFailure(res, error, "Failed to reconnect an account");
  }
});

/** Scoped by `oxyUserId`, always: the link id alone must never be enough. */
async function findSession(
  oxyUserId: string,
  linkId: string,
): Promise<LeanBridgeLinkSession | null> {
  if (typeof linkId !== "string" || linkId.length === 0) return null;
  return await BridgeLinkSession.findOne({ oxyUserId, linkId }).lean<LeanBridgeLinkSession | null>();
}

async function findAccount(
  oxyUserId: string,
  accountId: string,
): Promise<LeanBridgeAccount | null> {
  if (!/^[a-f0-9]{24}$/.test(accountId)) return null;
  return await BridgeAccount.findOne({ oxyUserId, _id: accountId }).lean<LeanBridgeAccount | null>();
}

function readStringValues(candidate: unknown): Record<string, string> | undefined {
  if (candidate === undefined) return {};
  if (!isRecord(candidate)) return undefined;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string") return undefined;
    values[key] = value;
  }
  return values;
}

/**
 * The country the request appears to come from — the weakest of §8.3 rule 2's
 * three sources, and the last one consulted.
 *
 * Read from the edge's geo header rather than guessed from an address. When
 * nothing set one there is no answer, which is the correct outcome: a lease with
 * no country is refused rather than defaulted.
 */
function requestCountry(req: AuthRequest): string | undefined {
  const header = req.get("cloudfront-viewer-country") ?? req.get("x-vercel-ip-country");
  return typeof header === "string" && /^[A-Za-z]{2}$/.test(header) ? header : undefined;
}

/**
 * Pushes a step change down the socket the app already holds (§5.2).
 *
 * Best-effort by design: this is the fast path, and the `GET` long-poll above is
 * the one that always works. A socket that is not connected must not fail the
 * HTTP request that just succeeded.
 */
function emitLinkUpdate(req: AuthRequest, oxyUserId: string, state: AlloLinkState): void {
  try {
    const realtime: unknown = req.app.locals.realtime;
    if (!isRecord(realtime)) return;
    const namespace: unknown = realtime.messagingNamespace;
    if (!isRecord(namespace) || typeof namespace.to !== "function") return;
    const room: unknown = namespace.to(`user:${oxyUserId}`);
    if (!isRecord(room) || typeof room.emit !== "function") return;
    room.emit("bridgeLinkStep", publicLinkState(state));
  } catch (error) {
    logger.warn("[Bridges] could not emit a link update over the socket", error);
  }
}

export default router;
