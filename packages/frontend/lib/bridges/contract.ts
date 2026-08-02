import * as z from 'zod';

/**
 * What `/api/bridges/*` is allowed to say, and the parsing that holds it to it
 * (`docs/matrix/bridges.md` §5.2).
 *
 * ## Why this file exists at all
 *
 * The app never talks to a bridge — §5.1 — so everything here arrives from
 * `@allo/backend`, which is code this repository owns. That is exactly the
 * argument for parsing it anyway, not against:
 *
 * 1. **Most of this payload is not ours.** `loginFlows`, `instructions`, the
 *    field ids, the `display.data` behind a QR and the step ids are relayed from
 *    a mautrix bridge — a separate project on a monthly CalVer release schedule
 *    that has already removed an entire provisioning API version once (§10.1).
 *    The backend narrows that shape; it does not author it.
 * 2. **The two sides ship separately.** A phone that has not been updated in six
 *    months talks to today's backend. "Same repository" is not "same build".
 * 3. **The failure has to be legible.** Without this, a renamed field surfaces
 *    three screens away as a login that hangs on a blank step, which is the
 *    single hardest bug class to diagnose from a crash report.
 *
 * ## What is deliberately permissive
 *
 * Unknown keys are stripped rather than rejected, and the network id is a plain
 * string. **The app carries no list of networks** (§9.2): a deployment turning
 * Slack on is an environment variable, and a client that rejected `"slack"`
 * because its build predated it would make that impossible. Presentation for an
 * unrecognised id degrades — see `networkPresentation.ts` — it never throws.
 */

/**
 * The step types the backend will ever relay.
 *
 * §5.2 pins this to three of bridgev2's six. `cookies` and `client_http` are
 * Meta's webview login and `webauthn` is WhatsApp's passkey; `BridgeLinkService`
 * refuses to translate any of them, so a client that drew a case for them would
 * be drawing a case that cannot arrive.
 */
export const bridgeLoginStepTypeSchema = z.enum([
  'user_input',
  'display_and_wait',
  'complete',
]);

export type BridgeLoginStepType = z.infer<typeof bridgeLoginStepTypeSchema>;

/**
 * A field the user has to fill in.
 *
 * `type` stays a plain string: §5.2 lists ten field types the bridge can send
 * (`username`, `password`, `phone_number`, `email`, `2fa_code`, `token`, `url`,
 * `domain`, `select`, `captcha_code`) and that list belongs to the bridge, not to
 * Allo. An enum here would turn a bridge release adding an eleventh into a login
 * that cannot start, when the correct behaviour is a plain text box.
 */
export const bridgeLoginFieldSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  /**
   * The bridge's own validation, e.g. Telegram's `^\+[0-9]+$`.
   *
   * §6.2: the bridge normalises and validates the phone number before sending
   * it, and the app applying the same pattern saves a round trip that would
   * otherwise come back as a refusal. Compiled defensively at the point of use —
   * this is a regular expression from another project, and an invalid one must
   * not take a screen down.
   */
  pattern: z.string().optional(),
});

export type BridgeLoginField = z.infer<typeof bridgeLoginFieldSchema>;

/** What a `display_and_wait` step puts on screen. §5.2: `qr`, `emoji`, `code`, `nothing`. */
export const bridgeLoginDisplaySchema = z.object({
  type: z.string().min(1),
  data: z.string().optional(),
  imageUrl: z.string().optional(),
});

export type BridgeLoginDisplay = z.infer<typeof bridgeLoginDisplaySchema>;

export const bridgeLoginStepSchema = z.object({
  type: bridgeLoginStepTypeSchema,
  stepId: z.string().min(1),
  instructions: z.string().optional(),
  fields: z.array(bridgeLoginFieldSchema).optional(),
  display: bridgeLoginDisplaySchema.optional(),
});

export type BridgeLoginStep = z.infer<typeof bridgeLoginStepSchema>;

export const bridgeLoginFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

export type BridgeLoginFlow = z.infer<typeof bridgeLoginFlowSchema>;

export const bridgeNetworkSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * The server's word for "this network's anti-fraud bans on correlated egress"
   * (§8), and therefore the only honest trigger for the account-ban warning.
   *
   * Defaulted to `false` rather than required so that a phone running against a
   * backend older than this field keeps working. The default is the SAFE
   * direction for availability and the unsafe one for the warning, which is why
   * `requiresBanWarning` in `networkPresentation.ts` is the only reader — one
   * place to change if that trade ever needs revisiting.
   */
  requiresProxy: z.boolean().default(false),
  /**
   * What the network cannot do once linked (§11).
   *
   * `secretChats: false` on Telegram is architectural, not a gap: a bridge
   * authenticates as a new device, and a secret chat's keys are bound to the
   * device that accepted it. The design is explicit that this belongs at the
   * moment of linking rather than in a FAQ.
   */
  capabilities: z.record(z.string(), z.boolean()).default({}),
  loginFlows: z.array(bridgeLoginFlowSchema).min(1),
});

export type BridgeNetwork = z.infer<typeof bridgeNetworkSchema>;

export const bridgeNetworkListSchema = z.object({
  networks: z.array(bridgeNetworkSchema).default([]),
});

/**
 * The six states a linked account can be in (§5.3).
 *
 * A closed enum, unlike the network id, and for the opposite reason: the app has
 * to SAY something for each one, and there is no sensible rendering of a state
 * nobody has written a sentence for. The backend collapses the bridge's eleven
 * into these six itself, so a new one here would be a deliberate change on both
 * sides.
 */
export const bridgeAccountStateSchema = z.enum([
  'linking',
  'connecting',
  'connected',
  'degraded',
  'action_required',
  'failed',
]);

export type BridgeAccountState = z.infer<typeof bridgeAccountStateSchema>;

export const bridgeRemoteProfileSchema = z.object({
  name: z.string().optional(),
  username: z.string().optional(),
  phone: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export const bridgeAccountSchema = z.object({
  id: z.string().min(1),
  network: z.string().min(1),
  state: bridgeAccountStateSchema,
  remoteName: z.string().optional(),
  remoteProfile: bridgeRemoteProfileSchema.optional(),
  /**
   * The Matrix space the bridge files this account's rooms under.
   *
   * Carried because it is the one identifier that ties a linked account to the
   * conversations it produced. Nothing reads it yet — see
   * `docs/matrix/linked-accounts.md` §6 for why room provenance does not come
   * from here today.
   */
  spaceRoomId: z.string().optional(),
  linkedAt: z.coerce.date().optional(),
  lastStateAt: z.coerce.date().optional(),
  lastConnectedAt: z.coerce.date().optional(),
  /**
   * The bridge's machine-readable code, e.g. `FI.MAU.TELEGRAM.PHONE_CODE_INVALID`.
   * The bridge's free-text message is deliberately not relayed by the backend:
   * it is written for an operator and names internal hosts.
   */
  errorCode: z.string().optional(),
});

export type BridgeAccount = z.infer<typeof bridgeAccountSchema>;

export const bridgeAccountListSchema = z.object({
  accounts: z.array(bridgeAccountSchema).default([]),
});

/** A login attempt that has a step to draw. */
export const bridgeLinkStateSchema = z.object({
  linkId: z.string().min(1),
  network: z.string().min(1),
  expiresAt: z.coerce.date(),
  step: bridgeLoginStepSchema,
  account: bridgeAccountSchema.optional(),
});

export type BridgeLinkState = z.infer<typeof bridgeLinkStateSchema>;

/**
 * What the long-poll returns when nothing moved.
 *
 * **A timeout is not an error here** (§5.2). A phone cannot hold an HTTP request
 * open indefinitely, so the backend answers with the step unchanged and the
 * client asks again; WhatsApp's QR refreshes as a NEW `display_and_wait` step
 * carrying the same id, so the screen repaints without restarting the attempt.
 */
export const bridgeLinkWaitingSchema = z.object({
  linkId: z.string().min(1),
  network: z.string().min(1),
  expiresAt: z.coerce.date(),
  outcome: z.enum(['pending', 'completed', 'cancelled', 'expired', 'failed']).optional(),
  waiting: z.literal(true),
});

export type BridgeLinkWaiting = z.infer<typeof bridgeLinkWaitingSchema>;

/**
 * `GET /api/bridges/links/:linkId` answers with one shape or the other.
 *
 * The failure being guarded against is quiet and real: a delivered step parsed as
 * "nothing happened", which on a QR screen looks like a code that never refreshes
 * and a login that silently expires.
 *
 * **Two independent things prevent it, and either one alone is enough.** Measured
 * rather than assumed — each was mutated on its own and every test stayed green,
 * and only mutating both together made a delivered step parse as waiting:
 *
 * 1. `waiting: z.literal(true)` is required here and `step` is required on the
 *    other side, so neither payload can satisfy the branch it does not belong to.
 * 2. The stricter branch is listed first, so it wins even if both were to match.
 *
 * Keeping both is deliberate. The redundancy is what makes a single careless edit
 * — relaxing the literal, reordering the union — unable to reintroduce the bug on
 * its own.
 */
export const bridgeLinkPollSchema = z.union([
  bridgeLinkStateSchema,
  bridgeLinkWaitingSchema,
]);

export type BridgeLinkPoll = z.infer<typeof bridgeLinkPollSchema>;

export const bridgeUnlinkResultSchema = z.object({
  id: z.string().min(1),
  unlinked: z.literal(true),
});

export const bridgeReconnectResultSchema = z.object({
  id: z.string().min(1),
  state: bridgeAccountStateSchema,
});

export const bridgeCancelResultSchema = z.object({
  linkId: z.string().min(1),
  outcome: z.literal('cancelled'),
});

/** Whether a poll answered with a step or with "still waiting". */
export function isWaitingPoll(poll: BridgeLinkPoll): poll is BridgeLinkWaiting {
  return 'waiting' in poll;
}
