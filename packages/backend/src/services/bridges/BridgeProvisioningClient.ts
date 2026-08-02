import * as z from "zod";
import { bridgesConfig, type EnabledBridgeNetwork } from "../../config/bridges";
import {
  isBridgeLoginStepType,
  type BridgeLoginStepType,
} from "../../models/BridgeLinkSession";
import { logger } from "../../utils/logger";

/**
 * The client for a bridgev2 provisioning API (docs/matrix/bridges.md §6.1).
 *
 * ## The app never gets to be here
 *
 * Every call carries `Authorization: Bearer <shared_secret>` and
 * `?user_id=<mxid>`. That combination lets its holder act as ANY user of the
 * bridge — the middleware compares the header against the secret and then
 * believes the query string without further checks (§5.1). So the secret cannot
 * leave the server, and the MXID is always derived from the authenticated Oxy
 * identity by the caller, never taken from a request.
 *
 * ## Everything the bridge sends is foreign data
 *
 * These responses come from a separate project on its own release schedule —
 * CalVer, monthly, and §10.1 records that v26.06 removed the entire `/v1`
 * provisioning API. So responses are PARSED, not cast: a shape that has moved
 * produces a typed error naming the bridge, rather than an `undefined` surfacing
 * three layers away as a broken login screen.
 */

export class BridgeProvisioningError extends Error {
  constructor(
    message: string,
    readonly network: string,
  ) {
    super(message);
    this.name = "BridgeProvisioningError";
  }
}

/** The bridge could not be reached, or did not answer in time. */
export class BridgeUnreachableError extends BridgeProvisioningError {
  constructor(network: string, cause: string) {
    super(`bridge for ${network} is unreachable: ${cause}`, network);
    this.name = "BridgeUnreachableError";
  }
}

/** The bridge answered, and said no. */
export class BridgeRejectedError extends BridgeProvisioningError {
  constructor(
    network: string,
    readonly status: number,
    /** The bridge's own code, e.g. `FI.MAU.TELEGRAM.PHONE_CODE_INVALID`. */
    readonly errorCode: string | undefined,
    readonly bridgeMessage: string | undefined,
  ) {
    super(`bridge for ${network} refused the request with ${status}`, network);
    this.name = "BridgeRejectedError";
  }
}

/** The bridge answered with something this version does not understand. */
export class BridgeProtocolError extends BridgeProvisioningError {
  constructor(network: string, detail: string) {
    super(`bridge for ${network} answered in an unexpected shape: ${detail}`, network);
    this.name = "BridgeProtocolError";
  }
}

/**
 * A login step, in the bridge's own vocabulary.
 *
 * Only the fields Allo reads are required. Unknown keys are ignored rather than
 * rejected: a bridge release adding a field must not break a login, and zod
 * strips what is not declared.
 */
const loginUserInputFieldSchema = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  pattern: z.string().optional(),
});

const loginStepSchema = z.object({
  type: z.string(),
  step_id: z.string(),
  instructions: z.string().optional(),
  user_input: z
    .object({ fields: z.array(loginUserInputFieldSchema).default([]) })
    .optional(),
  display_and_wait: z
    .object({
      type: z.string(),
      data: z.string().optional(),
      image_url: z.string().optional(),
    })
    .optional(),
  complete: z
    .object({
      login_id: z.string().optional(),
      user_login_id: z.string().optional(),
    })
    .optional(),
});

const loginStartSchema = loginStepSchema.and(
  z.object({ login_id: z.string().optional() }),
);

const loginFlowSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const loginFlowsSchema = z.object({ flows: z.array(loginFlowSchema).default([]) });

const whoamiLoginSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string().optional(),
  space_room: z.string().optional(),
  profile: z
    .object({
      name: z.string().optional(),
      username: z.string().optional(),
      phone: z.string().optional(),
      avatar_url: z.string().optional(),
    })
    .optional(),
});

const whoamiSchema = z.object({ logins: z.array(whoamiLoginSchema).default([]) });

export type BridgeLoginFlow = z.infer<typeof loginFlowSchema>;
export type BridgeWhoamiLogin = z.infer<typeof whoamiLoginSchema>;
export type BridgeLoginStep = z.infer<typeof loginStepSchema>;

/** The step's type, narrowed to the closed set, or `undefined` for anything else. */
export function loginStepType(step: BridgeLoginStep): BridgeLoginStepType | undefined {
  return isBridgeLoginStepType(step.type) ? step.type : undefined;
}

export interface BridgeLoginStartResult {
  readonly loginProcessId: string;
  readonly step: BridgeLoginStep;
}

export interface BridgeProvisioningClient {
  loginFlows(): Promise<readonly BridgeLoginFlow[]>;
  startLogin(matrixUserId: string, flowId: string): Promise<BridgeLoginStartResult>;
  submitStep(
    matrixUserId: string,
    loginProcessId: string,
    stepId: string,
    stepType: BridgeLoginStepType,
    body: Record<string, unknown>,
  ): Promise<BridgeLoginStep>;
  /**
   * The BLOCKING call behind a `display_and_wait` step (§5.2).
   *
   * It does not return until the bridge has a new step — a scanned QR, a typed
   * code, or a refreshed QR when the old one expired. The backend holds this
   * open; a phone never does.
   */
  awaitDisplayStep(
    matrixUserId: string,
    loginProcessId: string,
    stepId: string,
    timeoutMs: number,
  ): Promise<BridgeLoginStep>;
  cancelLogin(matrixUserId: string, loginProcessId: string): Promise<void>;
  logout(matrixUserId: string, loginId: string): Promise<void>;
  whoami(matrixUserId: string): Promise<readonly BridgeWhoamiLogin[]>;
}

const PROVISION_PREFIX = "/_matrix/provision/v3";

export function createBridgeProvisioningClient(
  network: EnabledBridgeNetwork,
): BridgeProvisioningClient {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    options: { matrixUserId?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(`${network.baseUrl}${PROVISION_PREFIX}${path}`);
    if (options.matrixUserId) url.searchParams.set("user_id", options.matrixUserId);

    const timeoutMs = options.timeoutMs ?? bridgesConfig().httpTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${network.sharedSecret}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      /**
       * The URL is deliberately absent from this message and from the log below.
       * It carries `user_id`, and the caught error's own text can carry the
       * request too — neither an exception surface nor an operational log is a
       * place to accumulate which user linked which account.
       */
      throw new BridgeUnreachableError(
        network.id,
        error instanceof Error ? error.name : "request failed",
      );
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text();

    if (!response.ok) {
      const { errorCode, message } = readBridgeError(rawBody);
      logger.warn("[Bridges] provisioning call refused", {
        network: network.id,
        status: response.status,
        errorCode,
      });
      throw new BridgeRejectedError(network.id, response.status, errorCode, message);
    }

    let payload: unknown;
    try {
      payload = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      throw new BridgeProtocolError(network.id, "response was not JSON");
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      /**
       * A shape change in the bridge, not a bug in the caller. Named as such,
       * because §10.1 rates "rotura por actualización de bridge" as near-certain
       * and the first question is always which side moved.
       */
      throw new BridgeProtocolError(
        network.id,
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      );
    }
    return parsed.data;
  }

  return {
    async loginFlows() {
      const { flows } = await call("GET", "/login/flows", loginFlowsSchema);
      return flows;
    },

    async startLogin(matrixUserId, flowId) {
      const started = await call(
        "POST",
        `/login/start/${encodeURIComponent(flowId)}`,
        loginStartSchema,
        { matrixUserId },
      );
      const loginProcessId = started.login_id;
      if (!loginProcessId) {
        throw new BridgeProtocolError(
          network.id,
          "login/start did not return a login process id",
        );
      }
      return { loginProcessId, step: started };
    },

    async submitStep(matrixUserId, loginProcessId, stepId, stepType, body) {
      return await call(
        "POST",
        `/login/step/${encodeURIComponent(loginProcessId)}/${encodeURIComponent(stepId)}/${encodeURIComponent(stepType)}`,
        loginStepSchema,
        { matrixUserId, body },
      );
    },

    async awaitDisplayStep(matrixUserId, loginProcessId, stepId, timeoutMs) {
      return await call(
        "POST",
        `/login/step/${encodeURIComponent(loginProcessId)}/${encodeURIComponent(stepId)}/display_and_wait`,
        loginStepSchema,
        { matrixUserId, body: {}, timeoutMs },
      );
    },

    async cancelLogin(matrixUserId, loginProcessId) {
      await call(
        "POST",
        `/login/cancel/${encodeURIComponent(loginProcessId)}`,
        z.unknown(),
        { matrixUserId, body: {} },
      );
    },

    async logout(matrixUserId, loginId) {
      await call("POST", `/logout/${encodeURIComponent(loginId)}`, z.unknown(), {
        matrixUserId,
        body: {},
      });
    },

    async whoami(matrixUserId) {
      const { logins } = await call("GET", "/whoami", whoamiSchema, { matrixUserId });
      return logins;
    },
  };
}

/**
 * A bridge's error code and message, read defensively.
 *
 * The body of a refusal is not a shape this deployment controls, so anything
 * that is not a string is treated as absent. `FI.MAU.TELEGRAM.PHONE_CODE_INVALID`
 * and friends (§6.2) are worth surfacing precisely because the app can act on
 * them; a body that does not carry one is not an error in itself.
 */
function readBridgeError(rawBody: string): {
  errorCode?: string;
  message?: string;
} {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null) return {};
    const errorCode: unknown = Reflect.get(parsed, "errcode");
    const message: unknown = Reflect.get(parsed, "error");
    return {
      ...(typeof errorCode === "string" ? { errorCode } : {}),
      ...(typeof message === "string" ? { message } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Login flows that must never reach a user (§5.2).
 *
 * Telegram declares `bot` (a BotFather token) and `manual` — whose own
 * description reads "Log in using existing session credentials (advanced, do not
 * use)". Neither is something to put in front of somebody linking their phone,
 * and a flow the UI cannot render must not arrive at the UI at all.
 */
const HIDDEN_LOGIN_FLOW_IDS: ReadonlySet<string> = new Set(["bot", "manual"]);

export function isUserFacingLoginFlow(flow: BridgeLoginFlow): boolean {
  return !HIDDEN_LOGIN_FLOW_IDS.has(flow.id);
}
