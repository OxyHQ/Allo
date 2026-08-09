import { randomBytes } from "crypto";
import {
  bridgesConfig,
  type BridgeNetworkId,
  type EnabledBridgeNetwork,
} from "../../config/bridges";
import { uuidv7 } from "@oxyhq/db";
import { getDb } from "../../db";
import {
  countAccounts,
  upsertLinkedAccount,
  type BridgeAccountDetails,
  type BridgeAccountRow,
} from "../../db/bridges/accounts";
import {
  closeLinkSession,
  completeLinkSession,
  insertLinkSession,
  recordLinkSessionStep,
  type BridgeLinkSessionRelayRow,
} from "../../db/bridges/linkSessions";
import type { BridgeLoginStepType } from "../../db/schema/bridges";
import { logger } from "../../utils/logger";
import {
  createBridgeProvisioningClient,
  isUserFacingLoginFlow,
  loginStepType,
  type BridgeLoginFlow,
  type BridgeLoginStep,
  type BridgeProvisioningClient,
} from "./BridgeProvisioningClient";
import { matrixUserIdForOxyUser } from "./matrixIdentity";
import {
  ensureProxyLease,
  verifyLeaseExitIfPossible,
} from "./proxy/ProxyLeaseService";

/**
 * Driving a login attempt from start to linked account (docs/matrix/bridges.md §5.2).
 *
 * The app never talks to a bridge (§5.1). Everything a client sends arrives
 * here, is checked against the AUTHENTICATED Oxy identity, and is relayed. In
 * particular the MXID on every provisioning call is derived from that identity
 * and never from a request — with the shared secret in hand, a client-supplied
 * MXID would turn linking into "link an account for whoever you like".
 */

export class BridgeLinkError extends Error {
  constructor(
    message: string,
    readonly code: BridgeLinkErrorCode,
  ) {
    super(message);
    this.name = "BridgeLinkError";
  }
}

export type BridgeLinkErrorCode =
  | "network_not_found"
  | "flow_not_found"
  | "too_many_accounts"
  | "link_not_found"
  | "link_expired"
  | "unsupported_step";

/** The login step, translated into the shape the app renders. */
export interface AlloLoginStep {
  readonly type: BridgeLoginStepType;
  readonly stepId: string;
  readonly instructions?: string;
  readonly fields?: readonly {
    readonly id: string;
    readonly type: string;
    readonly name?: string;
    readonly description?: string;
    readonly pattern?: string;
  }[];
  readonly display?: {
    readonly type: string;
    readonly data?: string;
    readonly imageUrl?: string;
  };
}

export interface AlloLinkState {
  readonly linkId: string;
  readonly network: BridgeNetworkId;
  readonly expiresAt: Date;
  readonly step: AlloLoginStep;
  /** Present once the attempt completed: the account it produced. */
  readonly account?: BridgeAccountRow;
}

/**
 * The step types a client can actually render (§5.2).
 *
 * `cookies` and `client_http` are Meta's webview login and `webauthn` is
 * WhatsApp's passkey. All three belong to networks this deployment cannot enable
 * and to UI that does not exist. A step Allo cannot render must fail with a
 * traceable error rather than reach the app as something it will silently draw
 * as nothing — which is a login that hangs forever with no way to tell why.
 */
const RENDERABLE_STEP_TYPES: readonly BridgeLoginStepType[] = [
  "user_input",
  "display_and_wait",
  "complete",
];

interface CachedFlows {
  readonly flows: readonly BridgeLoginFlow[];
  readonly fetchedAt: number;
}

const FLOW_CACHE_TTL_MS = 5 * 60_000;
const flowCache = new Map<BridgeNetworkId, CachedFlows>();

export function resetBridgeFlowCacheForTests(): void {
  flowCache.clear();
}

/**
 * The login flows to offer for a network, filtered and cached.
 *
 * Stale-on-error rather than empty-on-error: a bridge that is briefly
 * unreachable must not make the network vanish from the account-linking screen
 * and reappear a minute later. `undefined` — nothing cached and the bridge is
 * unreachable — is the only case where the network is genuinely unofferable.
 */
export async function userFacingLoginFlows(
  network: EnabledBridgeNetwork,
  client: BridgeProvisioningClient = createBridgeProvisioningClient(network),
): Promise<readonly BridgeLoginFlow[] | undefined> {
  const cached = flowCache.get(network.id);
  if (cached && Date.now() - cached.fetchedAt < FLOW_CACHE_TTL_MS) {
    return cached.flows;
  }

  try {
    const flows = (await client.loginFlows()).filter(isUserFacingLoginFlow);
    flowCache.set(network.id, { flows, fetchedAt: Date.now() });
    return flows;
  } catch (error) {
    logger.warn("[Bridges] could not read login flows", {
      network: network.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return cached?.flows;
  }
}

export interface StartLinkInput {
  readonly oxyUserId: string;
  readonly network: EnabledBridgeNetwork;
  readonly flowId: string;
  /**
   * Used ONLY to decide a proxy lease's country and never stored (§5.5, §8.3).
   * A country is not a phone number.
   */
  readonly phoneNumberHint?: string;
  readonly profileCountry?: string;
  readonly requestCountry?: string;
}

export async function startLink(
  input: StartLinkInput,
  client: BridgeProvisioningClient = createBridgeProvisioningClient(input.network),
): Promise<AlloLinkState> {
  const config = bridgesConfig();
  const matrixUserId = matrixUserIdForOxyUser(input.oxyUserId);

  /**
   * The flow has to be one the catalogue would have offered.
   *
   * Filtering `bot` and `manual` out of `GET /networks` decides what the app
   * DRAWS; it decides nothing about what the app can ask for. Without this
   * check, a client could start Telegram's `manual` flow — "log in using
   * existing session credentials (advanced, do not use)" — simply by naming it.
   */
  const flows = await userFacingLoginFlows(input.network, client);
  if (!flows?.some((flow) => flow.id === input.flowId)) {
    throw new BridgeLinkError(
      `${input.network.id} has no login flow "${input.flowId}"`,
      "flow_not_found",
    );
  }

  const linked = await countAccounts(getDb(), {
    oxyUserId: input.oxyUserId,
    network: input.network.id,
  });
  if (linked >= config.maxAccountsPerNetwork) {
    throw new BridgeLinkError(
      `at most ${config.maxAccountsPerNetwork} ${input.network.displayName} account(s) can be linked`,
      "too_many_accounts",
    );
  }

  /**
   * The lease is taken BEFORE the first packet reaches the remote network (§8.3
   * rule 1), and its exit is checked before anything connects (rule 5). A
   * mismatch throws out of here, so the login never starts — which is the
   * intended outcome: an account that fails to link is a support ticket, and one
   * that links from the wrong country is a ban.
   */
  if (input.network.requiresProxy) {
    const lease = await ensureProxyLease({
      oxyUserId: input.oxyUserId,
      network: input.network.id,
      candidates: {
        ...(input.profileCountry ? { profileCountry: input.profileCountry } : {}),
        ...(input.phoneNumberHint ? { phoneNumber: input.phoneNumberHint } : {}),
        ...(input.requestCountry ? { requestCountry: input.requestCountry } : {}),
      },
    });
    await verifyLeaseExitIfPossible(lease);
  }

  const started = await client.startLogin(matrixUserId, input.flowId);
  const step = translateStep(started.step);
  const expiresAt = expiryFor(step.type);

  const session = await insertLinkSession(getDb(), {
    id: uuidv7(),
    linkId: newLinkId(),
    oxyUserId: input.oxyUserId,
    network: input.network.id,
    flowId: input.flowId,
    remoteLoginProcessId: started.loginProcessId,
    currentStepId: step.stepId,
    currentStepType: step.type,
    expiresAt,
  });

  return { linkId: session.linkId, network: input.network.id, expiresAt, step };
}

export interface SubmitStepInput {
  readonly oxyUserId: string;
  readonly network: EnabledBridgeNetwork;
  readonly session: BridgeLinkSessionRelayRow;
  /** What the user typed. Relayed and forgotten — never written to Mongo. */
  readonly values: Record<string, string>;
}

export async function submitStep(
  input: SubmitStepInput,
  client: BridgeProvisioningClient = createBridgeProvisioningClient(input.network),
): Promise<AlloLinkState> {
  assertLive(input.session);

  const stepId = input.session.currentStepId;
  const stepType = input.session.currentStepType;
  if (!stepId || !stepType) {
    throw new BridgeLinkError("this attempt has no step to answer", "link_not_found");
  }

  const matrixUserId = matrixUserIdForOxyUser(input.oxyUserId);
  const next = await client.submitStep(
    matrixUserId,
    input.session.remoteLoginProcessId,
    stepId,
    stepType,
    input.values,
  );

  return await advance(input.oxyUserId, input.network, input.session, next, client);
}

/**
 * Waits for the bridge to move past a `display_and_wait` step (§5.2).
 *
 * The bridge call BLOCKS until there is something new, so the backend holds it
 * open and the phone does not. A timeout here is not a failure: WhatsApp's QR
 * refreshes as a NEW `display_and_wait` step with the same id, so the client
 * repaints and asks again without restarting the attempt.
 */
export async function awaitStep(
  oxyUserId: string,
  network: EnabledBridgeNetwork,
  session: BridgeLinkSessionRelayRow,
  timeoutMs: number,
  client: BridgeProvisioningClient = createBridgeProvisioningClient(network),
): Promise<AlloLinkState | undefined> {
  assertLive(session);

  const stepId = session.currentStepId;
  if (session.currentStepType !== "display_and_wait" || !stepId) return undefined;

  const matrixUserId = matrixUserIdForOxyUser(oxyUserId);
  const next = await client.awaitDisplayStep(
    matrixUserId,
    session.remoteLoginProcessId,
    stepId,
    timeoutMs,
  );

  return await advance(oxyUserId, network, session, next, client);
}

export async function cancelLink(
  oxyUserId: string,
  network: EnabledBridgeNetwork,
  session: BridgeLinkSessionRelayRow,
  client: BridgeProvisioningClient = createBridgeProvisioningClient(network),
): Promise<void> {
  const matrixUserId = matrixUserIdForOxyUser(oxyUserId);
  try {
    await client.cancelLogin(matrixUserId, session.remoteLoginProcessId);
  } catch (error) {
    /**
     * The local record is closed regardless. A bridge that cannot be told to
     * cancel still must not leave the user with an attempt they cannot get rid
     * of; the bridge's own login process expires on its own.
     */
    logger.warn("[Bridges] could not cancel the login on the bridge", {
      network: network.id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  await closeLinkSession(getDb(), {
    id: session.id,
    outcome: "cancelled",
    at: new Date(),
  });
}

/**
 * Records the next step and, when the attempt completed, the account it made.
 */
async function advance(
  oxyUserId: string,
  network: EnabledBridgeNetwork,
  session: BridgeLinkSessionRelayRow,
  next: BridgeLoginStep,
  client: BridgeProvisioningClient,
): Promise<AlloLinkState> {
  const step = translateStep(next);

  if (step.type !== "complete") {
    const expiresAt = expiryFor(step.type);
    await recordLinkSessionStep(getDb(), {
      id: session.id,
      currentStepId: step.stepId,
      currentStepType: step.type,
      expiresAt,
      at: new Date(),
    });
    return { linkId: session.linkId, network: network.id, expiresAt, step };
  }

  /**
   * The account is recorded BEFORE the session is closed, and the order is now
   * load-bearing rather than incidental: `bridge_link_sessions.result_account_id`
   * is a real foreign key where Mongo had a bare `ObjectId` nothing checked, so
   * closing first would fail on a row that does not exist yet.
   */
  const account = await recordCompletedLogin(oxyUserId, network, next, client);
  await completeLinkSession(getDb(), {
    id: session.id,
    currentStepId: step.stepId,
    resultAccountId: account.id,
    at: new Date(),
  });
  return {
    linkId: session.linkId,
    network: network.id,
    expiresAt: session.expiresAt,
    step,
    account,
  };
}

async function recordCompletedLogin(
  oxyUserId: string,
  network: EnabledBridgeNetwork,
  step: BridgeLoginStep,
  client: BridgeProvisioningClient,
): Promise<BridgeAccountRow> {
  const remoteLoginId = step.complete?.user_login_id ?? step.complete?.login_id;
  if (!remoteLoginId) {
    throw new BridgeLinkError(
      "the bridge completed the login without naming the account it created",
      "unsupported_step",
    );
  }

  /**
   * The display name and space come from `whoami`, which §5.4 confirms returns
   * exactly what is needed. Best-effort: a linked account with no display name
   * is a cosmetic problem, and refusing to record a login that the remote
   * network has already accepted would leave a session running that Allo has no
   * record of.
   */
  const details = await readLoginDetails(oxyUserId, remoteLoginId, client);
  const now = new Date();

  /**
   * `linked_at` is set on insert only — it is when this user FIRST linked this
   * remote account, and a re-link is not a new one. The `id` is likewise
   * discarded by the database when the row already exists, which is what makes
   * two concurrent completions of one login produce ONE account rather than a
   * duplicate-key error somebody has to catch.
   */
  const account = await upsertLinkedAccount(getDb(), {
    id: uuidv7(),
    oxyUserId,
    network: network.id,
    remoteLoginId,
    at: now,
    ...details,
  });

  logger.info("[Bridges] account linked", { network: network.id });
  return account;
}

async function readLoginDetails(
  oxyUserId: string,
  remoteLoginId: string,
  client: BridgeProvisioningClient,
): Promise<BridgeAccountDetails> {
  try {
    const logins = await client.whoami(matrixUserIdForOxyUser(oxyUserId));
    const login = logins.find((candidate) => candidate.id === remoteLoginId);
    if (!login) return {};
    /**
     * Flat, because the columns are. The nested `remoteProfile` Mongo stored is
     * composed back in whichever serializer owes a client that shape; building it
     * here and flattening it again in the repository would be two mappings of one
     * fact.
     */
    return {
      ...(login.name ? { remoteName: login.name } : {}),
      ...(login.space_room ? { spaceRoomId: login.space_room } : {}),
      ...(login.profile?.name ? { remoteProfileName: login.profile.name } : {}),
      ...(login.profile?.username ? { remoteProfileUsername: login.profile.username } : {}),
      ...(login.profile?.phone ? { remoteProfilePhone: login.profile.phone } : {}),
      ...(login.profile?.avatar_url
        ? { remoteProfileAvatarUrl: login.profile.avatar_url }
        : {}),
    };
  } catch (error) {
    logger.warn("[Bridges] could not read login details after completing", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return {};
  }
}

function translateStep(step: BridgeLoginStep): AlloLoginStep {
  const type = loginStepType(step);
  if (!type || !RENDERABLE_STEP_TYPES.includes(type)) {
    throw new BridgeLinkError(
      `the bridge asked for a "${step.type}" step, which this version cannot present`,
      "unsupported_step",
    );
  }

  return {
    type,
    stepId: step.step_id,
    ...(step.instructions ? { instructions: step.instructions } : {}),
    ...(step.user_input
      ? {
          fields: step.user_input.fields.map((field) => ({
            id: field.id,
            type: field.type,
            ...(field.name ? { name: field.name } : {}),
            ...(field.description ? { description: field.description } : {}),
            ...(field.pattern ? { pattern: field.pattern } : {}),
          })),
        }
      : {}),
    ...(step.display_and_wait
      ? {
          display: {
            type: step.display_and_wait.type,
            ...(step.display_and_wait.data ? { data: step.display_and_wait.data } : {}),
            ...(step.display_and_wait.image_url
              ? { imageUrl: step.display_and_wait.image_url }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * When this step stops being answerable.
 *
 * §5.2 is explicit that this must reflect the REAL window rather than a generic
 * ten minutes. WhatsApp's first QR lasts a minute and the five refreshes twenty
 * seconds each — about 2m40s in total — so a `display_and_wait` step gets the
 * short window and everything else the long one. A session claiming to outlive
 * the code inside it teaches users to wait for something that already expired.
 */
function expiryFor(stepType: BridgeLoginStepType): Date {
  const config = bridgesConfig();
  const seconds =
    stepType === "display_and_wait" ? config.displayStepTtlSeconds : config.linkTtlSeconds;
  return new Date(Date.now() + seconds * 1_000);
}

function assertLive(session: BridgeLinkSessionRelayRow): void {
  if (session.outcome !== "pending") {
    throw new BridgeLinkError("this attempt is already finished", "link_not_found");
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new BridgeLinkError("this attempt expired", "link_expired");
  }
}

/**
 * An opaque, unguessable handle.
 *
 * Every lookup is also scoped to the authenticated user, so guessing one buys
 * nothing — but an identifier that is enumerable invites exactly one clever
 * refactor away from being the only thing a lookup relies on.
 */
function newLinkId(): string {
  return `lnk_${randomBytes(16).toString("hex")}`;
}
