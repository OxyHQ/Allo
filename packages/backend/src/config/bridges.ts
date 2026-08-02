import * as z from "zod";

/**
 * Multi-network bridge orchestration configuration (docs/matrix/bridges.md §9).
 *
 * Same shape as `config/crowdsource.ts` — a focused module, validated with zod
 * ONCE at boot, memoised and frozen — for the same reason: these variables decide
 * which remote networks exist, and a typo that reads as `undefined` at the point
 * of use is a network that silently stops existing (or, worse, one that silently
 * starts).
 *
 * ## The catalogue is not the flag
 *
 * `BRIDGE_NETWORK_CATALOG` is a static list of the networks Allo KNOWS ABOUT.
 * Adding a row to it enables nothing. A network is reachable only if it appears
 * in `ALLO_BRIDGES_ENABLED` *and* carries a complete set of connection
 * variables *and* satisfies the preconditions its own row declares. §9.2:
 *
 * 1. Half a configuration is worse than none — it shows up in production as an
 *    endpoint returning 502 rather than as a boot failure.
 * 2. A network whose row says `requiresProxy` additionally requires a configured
 *    proxy provider. Turning WhatsApp on without one is precisely the failure
 *    this flag exists to prevent: every user egressing from one datacentre IP,
 *    perfectly correlated. It has to be impossible by construction.
 * 3. A disabled network answers **404, not 403** — see `routes/bridges.ts`.
 *
 * Both preconditions are checked in `superRefine`, so a deployment that asks for
 * a network it cannot serve does not boot. That is the whole mechanism: there is
 * no runtime path that produces an enabled proxy-requiring network without a
 * proxy provider, because the process holding that configuration never started.
 */

export const BRIDGE_NETWORK_IDS = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "instagram",
  "messenger",
] as const;

export type BridgeNetworkId = (typeof BRIDGE_NETWORK_IDS)[number];

/**
 * Which provisioning protocol a bridge speaks.
 *
 * `bridgev2` is the modern mautrix framework and its `/_matrix/provision/v3/*`
 * API (§6.1). `legacy` is `mautrix-discord`, which exposes an entirely different
 * `/_matrix/provision/v1/*` surface (§3.2) and needs its own adapter.
 */
export type BridgeArchitecture = "bridgev2" | "legacy";

export interface BridgeNetworkCatalogEntry {
  readonly displayName: string;
  readonly architecture: BridgeArchitecture;
  /**
   * Whether the network's anti-fraud makes a shared datacentre egress
   * unacceptable, and therefore whether it needs a per-user proxy (§8).
   *
   * Because the proxy is configured PER PROCESS and not per user (§1.2), this
   * flag is also what decides the deployment topology: `false` means one shared
   * process for all users (§4.1), `true` means one process per user (§4.3).
   */
  readonly requiresProxy: boolean;
}

/**
 * Every network Allo knows about. Adding a row here does NOT turn one on.
 *
 * `requiresProxy` is a property of the remote network's tolerance for shared
 * egress, not a preference: WhatsApp and Meta ban on IP correlation, so they
 * cannot share an exit address between users.
 */
export const BRIDGE_NETWORK_CATALOG: Readonly<
  Record<BridgeNetworkId, BridgeNetworkCatalogEntry>
> = Object.freeze({
  telegram: { displayName: "Telegram", architecture: "bridgev2", requiresProxy: false },
  slack: { displayName: "Slack", architecture: "bridgev2", requiresProxy: false },
  discord: { displayName: "Discord", architecture: "legacy", requiresProxy: false },
  whatsapp: { displayName: "WhatsApp", architecture: "bridgev2", requiresProxy: true },
  instagram: { displayName: "Instagram", architecture: "bridgev2", requiresProxy: true },
  messenger: { displayName: "Messenger", architecture: "bridgev2", requiresProxy: true },
});

export function isBridgeNetworkId(value: string): value is BridgeNetworkId {
  return (BRIDGE_NETWORK_IDS as readonly string[]).includes(value);
}

/** `telegram` → `ALLO_BRIDGE_TELEGRAM_`. */
function networkEnvPrefix(network: BridgeNetworkId): string {
  return `ALLO_BRIDGE_${network.toUpperCase()}_`;
}

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(minimumLength).optional());

const integerFromEnv = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

/**
 * A bridge's HTTP origin, with no path, query, fragment or credentials.
 *
 * Same rule as CrowdSource's `httpOrigin`, and it matters more here: this value
 * is concatenated with provisioning paths, and an origin carrying a stray path
 * would produce URLs like `http://bridge:29317/foo/_matrix/provision/v3/whoami`
 * — a 404 from the bridge, read by everyone as "the bridge is down".
 */
const httpOrigin = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "must use http:// or https://")
  .refine((value) => {
    const url = new URL(value);
    return (
      /^\/*$/.test(url.pathname) &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "must be an origin without credentials, path, query or fragment")
  .transform((value) => value.replace(/\/+$/, ""));

/**
 * A Matrix server name, as it appears after the colon in an MXID.
 *
 * Deliberately not a URL: `allo.you` is a server NAME, and accepting
 * `https://allo.you/` here would produce MXIDs like `@abc:https://allo.you/`
 * that no homeserver would ever resolve.
 */
const matrixServerName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9.-]+(:[0-9]{1,5})?$/,
    "must be a Matrix server name such as allo.you, not a URL",
  );

const countryCodeList = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string().regex(/^[A-Z]{2}$/, "must be ISO 3166-1 alpha-2")).min(1))
    .optional(),
);

const enabledNetworkList = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string()))
    .default([]),
);

/**
 * The subset of `ALLO_BRIDGES_ENABLED` this build can actually provision.
 *
 * `bridgev2` speaks the `/v3` provisioning protocol described in §6.1, whose
 * step types, field types and route shapes are pinned by the design. `legacy`
 * (Discord) speaks `/v1` — a different protocol whose wire format is NOT
 * specified in the design, and which §3.2 says needs "un adaptador específico".
 *
 * Listing Discord in `ALLO_BRIDGES_ENABLED` therefore fails at boot instead of
 * producing a catalogue entry whose login flow 502s on first contact. Removing
 * this gate is exactly what writing that adapter looks like.
 */
const PROVISIONABLE_ARCHITECTURES: readonly BridgeArchitecture[] = ["bridgev2"];

/**
 * How long a login attempt stays valid, by default.
 *
 * §5.2 is explicit that this must reflect the real window rather than a generic
 * ten minutes: WhatsApp's QR gives about 2m40s in total, and a session that
 * claims to live longer than the code inside it teaches users to wait for
 * something that will never happen. `bridgeLinkExpiry` narrows this per step.
 */
const DEFAULT_LINK_TTL_SECONDS = 600;
const DEFAULT_DISPLAY_STEP_TTL_SECONDS = 170;

/**
 * The schema, built around the raw environment rather than declared at module
 * scope.
 *
 * The per-network variables are named after the network — `ALLO_BRIDGE_
 * TELEGRAM_BASE_URL` and five more triples — so they cannot be listed as fixed
 * keys without eighteen entries that all say the same thing. A `z.object` strips
 * keys it does not declare, which means `superRefine` would see `undefined` for
 * every one of them and report a perfectly configured deployment as broken.
 *
 * Closing over `raw` keeps ONE error path: every problem — an unknown network, a
 * missing token, a proxy-requiring network without a provider — arrives as
 * issues on a single `ZodError`, so a misconfigured deployment learns everything
 * that is wrong with it at once instead of one boot at a time.
 */
function buildBridgesEnvSchema(raw: BridgesEnvironment) {
  return z
    .object({
      ALLO_BRIDGES_ENABLED: enabledNetworkList,
      ALLO_MATRIX_SERVER_NAME: z.preprocess(emptyAsUndefined, matrixServerName.optional()),

      ALLO_BRIDGES_MAX_ACCOUNTS_PER_NETWORK: integerFromEnv(2, 1, 10),
      ALLO_BRIDGES_LINK_TTL_SECONDS: integerFromEnv(DEFAULT_LINK_TTL_SECONDS, 30, 3_600),
      ALLO_BRIDGES_DISPLAY_STEP_TTL_SECONDS: integerFromEnv(
        DEFAULT_DISPLAY_STEP_TTL_SECONDS,
        15,
        600,
      ),
      /**
       * How far past a reported state's own TTL a bridge may go silent before the
       * sweep calls the account failed (§5.4). The bridge re-sends an unchanged
       * state when its TTL expires, so silence past TTL + margin means the process
       * is gone — the one failure no webhook can ever report.
       */
      ALLO_BRIDGES_STALE_MARGIN_SECONDS: integerFromEnv(300, 30, 86_400),
      ALLO_BRIDGES_HTTP_TIMEOUT_MS: integerFromEnv(15_000, 1_000, 120_000),

      /**
       * The proxy provider's identifier — never the vendor's brand name in code
       * (§8.2). Its PRESENCE is what "a proxy provider is configured" means, and
       * therefore what decides whether the proxy-requiring networks can exist.
       */
      ALLO_BRIDGE_PROXY_PROVIDER: optionalString(),
      ALLO_BRIDGE_PROXY_GATEWAY: optionalString(),
      /**
       * How the provider encodes country and session into the proxy username.
       *
       * Templated rather than hardcoded because §8.2 and §12.2 both say the exact
       * syntax varies by provider and must be confirmed against the documentation
       * of whichever one is contracted. `{country}` and `{session}` are required:
       * a template missing either would compose a URL that silently egresses from
       * the wrong country or shares one session across users.
       */
      ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE: optionalString(),
      ALLO_BRIDGE_PROXY_PASSWORD: optionalString(),
      ALLO_BRIDGE_PROXY_COUNTRIES: countryCodeList,
      /**
       * Where the exit-verification echo lives (§8.3 rule 5). Fetched THROUGH the
       * proxy; its answer is compared against the lease's frozen country.
       */
      ALLO_BRIDGE_PROXY_ECHO_URL: z.preprocess(emptyAsUndefined, z.string().trim().url().optional()),
      /**
       * The `?t=` secret on `GET /internal/bridges/proxy` (§4.3).
       *
       * Distinct from any bridge's provisioning `shared_secret` and rotatable on
       * its own. Without it, anyone who reached the endpoint could enumerate which
       * user egresses through which geography.
       */
      ALLO_BRIDGE_PROXY_ENDPOINT_TOKEN: optionalString(32),
    })
    .superRefine((environment, context) => {
      const requested = environment.ALLO_BRIDGES_ENABLED;
      if (requested.length === 0) return;

      const proxyProviderConfigured = isProxyProviderComplete(raw);

      for (const candidate of requested) {
        if (!isBridgeNetworkId(candidate)) {
          context.addIssue({
            code: "custom",
            path: ["ALLO_BRIDGES_ENABLED"],
            message: `unknown network "${candidate}" — known networks are: ${BRIDGE_NETWORK_IDS.join(", ")}`,
          });
          continue;
        }

        const entry = BRIDGE_NETWORK_CATALOG[candidate];
        const prefix = networkEnvPrefix(candidate);

        /**
         * §9.2 rule 1. All three together or the network is not enabled: a base
         * URL without a shared secret cannot provision anything, and a shared
         * secret without an as_token means the status webhook cannot authenticate
         * anything the bridge sends back — a bridge that appears healthy forever
         * because nothing it says is ever believed.
         */
        for (const suffix of ["BASE_URL", "SHARED_SECRET", "AS_TOKEN"] as const) {
          const value = raw[`${prefix}${suffix}`];
          if (typeof value !== "string" || value.trim().length === 0) {
            context.addIssue({
              code: "custom",
              path: [`${prefix}${suffix}`],
              message: `is required when "${candidate}" is listed in ALLO_BRIDGES_ENABLED`,
            });
          }
        }

        /**
         * §9.2 rule 2. The one precondition that exists to stop a specific
         * accident rather than a class of typos.
         */
        if (entry.requiresProxy && !proxyProviderConfigured) {
          context.addIssue({
            code: "custom",
            path: ["ALLO_BRIDGE_PROXY_PROVIDER"],
            message:
              `is required to enable "${candidate}": it needs a per-user proxy (bridges.md §8), and ` +
              "without one every user would egress from the same datacentre address, correlated for banning",
          });
        }

        if (!PROVISIONABLE_ARCHITECTURES.includes(entry.architecture)) {
          context.addIssue({
            code: "custom",
            path: ["ALLO_BRIDGES_ENABLED"],
            message:
              `"${candidate}" speaks the ${entry.architecture} provisioning protocol, which this build has no client for ` +
              "(bridges.md §3.2 and §6.1 — it needs its own adapter). Enabling it would publish a network whose login flow cannot start",
          });
        }
      }

      if (!environment.ALLO_MATRIX_SERVER_NAME) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_MATRIX_SERVER_NAME"],
          message:
            "is required when any bridge network is enabled — every provisioning call is made as a specific MXID, " +
            "and the MXID cannot be built without the server name",
        });
      }
    });
}

type BridgesEnvironment = Record<string, string | undefined>;

/**
 * Whether a usable proxy provider is configured.
 *
 * All five parts or none. A gateway without a password composes a URL the
 * provider refuses; a username template without a country placeholder composes
 * one it ACCEPTS, and then egresses from whichever country the provider felt
 * like — which is the failure that shows up three weeks later as a wave of bans
 * with no apparent cause (§8.3 rule 5).
 */
function isProxyProviderComplete(environment: BridgesEnvironment): boolean {
  const template = environment.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE;
  return (
    typeof environment.ALLO_BRIDGE_PROXY_PROVIDER === "string" &&
    environment.ALLO_BRIDGE_PROXY_PROVIDER.trim().length > 0 &&
    typeof environment.ALLO_BRIDGE_PROXY_GATEWAY === "string" &&
    environment.ALLO_BRIDGE_PROXY_GATEWAY.trim().length > 0 &&
    typeof environment.ALLO_BRIDGE_PROXY_PASSWORD === "string" &&
    environment.ALLO_BRIDGE_PROXY_PASSWORD.trim().length > 0 &&
    typeof template === "string" &&
    template.includes("{country}") &&
    template.includes("{session}")
  );
}

/** A bridge Allo can actually talk to. Only ever produced by `loadBridgesConfig`. */
export interface EnabledBridgeNetwork {
  readonly id: BridgeNetworkId;
  readonly displayName: string;
  readonly architecture: BridgeArchitecture;
  readonly requiresProxy: boolean;
  /** Origin of the bridge's appservice listener, no trailing slash. */
  readonly baseUrl: string;
  /**
   * The provisioning `shared_secret` (§6.1 auth mode 1).
   *
   * This value lets its holder act as ANY user of that bridge: the middleware
   * compares the header against the secret and then believes `?user_id=` without
   * further checks (§5.1). It must never leave the server, never be logged and
   * never reach a client.
   */
  readonly sharedSecret: string;
  /** The registration's `as_token`, used to authenticate the status webhook (§5.4). */
  readonly asToken: string;
}

export interface BridgeProxyProviderConfig {
  readonly providerId: string;
  readonly gateway: string;
  readonly usernameTemplate: string;
  readonly password: string;
  /** Countries the provider sells. A lease is refused for anything outside it. */
  readonly countries?: readonly string[];
  readonly echoUrl?: string;
  readonly endpointToken?: string;
}

export interface BridgesConfig {
  readonly enabled: boolean;
  readonly matrixServerName?: string;
  readonly networks: ReadonlyMap<BridgeNetworkId, EnabledBridgeNetwork>;
  readonly proxy?: BridgeProxyProviderConfig;
  readonly maxAccountsPerNetwork: number;
  readonly linkTtlSeconds: number;
  readonly displayStepTtlSeconds: number;
  readonly staleMarginSeconds: number;
  readonly httpTimeoutMs: number;
}

export function loadBridgesConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BridgesConfig {
  const parsed = buildBridgesEnvSchema(environment).parse(environment);

  const networks = new Map<BridgeNetworkId, EnabledBridgeNetwork>();
  for (const candidate of parsed.ALLO_BRIDGES_ENABLED) {
    // `superRefine` has already rejected anything that would fail here; this
    // narrowing exists so the map cannot be built from an unvalidated string.
    if (!isBridgeNetworkId(candidate)) continue;
    const entry = BRIDGE_NETWORK_CATALOG[candidate];
    const prefix = networkEnvPrefix(candidate);
    const baseUrl = httpOrigin.parse(environment[`${prefix}BASE_URL`]);
    const sharedSecret = z
      .string()
      .trim()
      .min(32, `${prefix}SHARED_SECRET must be at least 32 characters`)
      .parse(environment[`${prefix}SHARED_SECRET`]);
    const asToken = z
      .string()
      .trim()
      .min(32, `${prefix}AS_TOKEN must be at least 32 characters`)
      .parse(environment[`${prefix}AS_TOKEN`]);

    networks.set(
      candidate,
      Object.freeze({
        id: candidate,
        displayName: entry.displayName,
        architecture: entry.architecture,
        requiresProxy: entry.requiresProxy,
        baseUrl,
        sharedSecret,
        asToken,
      }),
    );
  }

  const proxy = isProxyProviderComplete(environment)
    ? Object.freeze({
        providerId: parsed.ALLO_BRIDGE_PROXY_PROVIDER ?? "",
        gateway: parsed.ALLO_BRIDGE_PROXY_GATEWAY ?? "",
        usernameTemplate: parsed.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE ?? "",
        password: parsed.ALLO_BRIDGE_PROXY_PASSWORD ?? "",
        ...(parsed.ALLO_BRIDGE_PROXY_COUNTRIES
          ? { countries: Object.freeze([...parsed.ALLO_BRIDGE_PROXY_COUNTRIES]) }
          : {}),
        ...(parsed.ALLO_BRIDGE_PROXY_ECHO_URL
          ? { echoUrl: parsed.ALLO_BRIDGE_PROXY_ECHO_URL }
          : {}),
        ...(parsed.ALLO_BRIDGE_PROXY_ENDPOINT_TOKEN
          ? { endpointToken: parsed.ALLO_BRIDGE_PROXY_ENDPOINT_TOKEN }
          : {}),
      })
    : undefined;

  return Object.freeze({
    enabled: networks.size > 0,
    ...(parsed.ALLO_MATRIX_SERVER_NAME
      ? { matrixServerName: parsed.ALLO_MATRIX_SERVER_NAME }
      : {}),
    networks,
    ...(proxy ? { proxy } : {}),
    maxAccountsPerNetwork: parsed.ALLO_BRIDGES_MAX_ACCOUNTS_PER_NETWORK,
    linkTtlSeconds: parsed.ALLO_BRIDGES_LINK_TTL_SECONDS,
    displayStepTtlSeconds: parsed.ALLO_BRIDGES_DISPLAY_STEP_TTL_SECONDS,
    staleMarginSeconds: parsed.ALLO_BRIDGES_STALE_MARGIN_SECONDS,
    httpTimeoutMs: parsed.ALLO_BRIDGES_HTTP_TIMEOUT_MS,
  });
}

let cached: BridgesConfig | undefined;

/**
 * The process-wide bridge configuration, parsed on first use.
 *
 * Lazy for the same reason as CrowdSource's: importing a bridge model or type
 * must not crash a process whose environment has nothing to do with bridges.
 */
export function bridgesConfig(): BridgesConfig {
  if (!cached) cached = loadBridgesConfig();
  return cached;
}

/**
 * The single gate every route goes through.
 *
 * `undefined` means "this network does not exist in this deployment" — whether
 * because it is unknown, unlisted, half-configured or missing its proxy
 * provider. Callers cannot tell those apart, and neither can users: they all
 * produce the same 404 (§9.2 rule 3). One accessor rather than a membership
 * check per route, because the check that gets forgotten is the one that was
 * written eight times.
 */
export function enabledBridgeNetwork(
  network: string,
): EnabledBridgeNetwork | undefined {
  if (!isBridgeNetworkId(network)) return undefined;
  return bridgesConfig().networks.get(network);
}

/** Every enabled network, in catalogue order so the list is stable across boots. */
export function enabledBridgeNetworks(): readonly EnabledBridgeNetwork[] {
  const config = bridgesConfig();
  return BRIDGE_NETWORK_IDS.map((id) => config.networks.get(id)).filter(
    (network): network is EnabledBridgeNetwork => network !== undefined,
  );
}

/** Resets the memoised config. Tests only; there is no runtime reconfiguration. */
export function resetBridgesConfigForTests(): void {
  cached = undefined;
}
