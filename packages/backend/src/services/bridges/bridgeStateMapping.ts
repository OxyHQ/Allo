import {
  isBridgeStateEvent,
  type BridgeAccountState,
  type BridgeStateEvent,
} from "../../models/BridgeAccount";

/**
 * Collapsing the bridge's eleven connection states into the six a user sees
 * (docs/matrix/bridges.md §5.3).
 *
 * The bridge's vocabulary is the right resolution for diagnosing a bridge and
 * the wrong one for a person: nobody should be asked to tell `BACKFILLING` from
 * `CONNECTING`, and both mean "wait". The raw value is stored alongside the
 * collapsed one (`BridgeAccount.rawState`) precisely because the collapse
 * destroys distinctions operations depends on — see `BAD_CREDENTIALS` below.
 */

/**
 * The mapping, as a total record over the bridge's closed set.
 *
 * A `Record<BridgeStateEvent, …>` rather than a switch with a default: if a
 * future bridge release adds a state and somebody adds it to
 * `BRIDGE_STATE_EVENTS`, this file stops compiling until the new state is
 * classified. The alternative — a default arm — would silently file the new
 * state under whatever the default happened to be, which for a state meaning
 * "banned" would show the user a green dot.
 */
const STATE_BY_EVENT: Readonly<Record<BridgeStateEvent, BridgeAccountState>> =
  Object.freeze({
    STARTING: "connecting",
    CONNECTING: "connecting",
    BACKFILLING: "connecting",

    CONNECTED: "connected",
    RUNNING: "connected",

    /**
     * Transient by definition, and NOT debounced here.
     *
     * The bridge already holds `TRANSIENT_DISCONNECT` and `CONNECTING` back for
     * `bridge.transient_state_debounce` (§5.3) and drops them entirely if
     * another state arrives meanwhile, so an ordinary reconnection never reaches
     * this backend at all. A second debounce on our side would delay the states
     * that DID survive the first one — which are the real ones.
     */
    TRANSIENT_DISCONNECT: "degraded",

    /**
     * The two states that mean "the user must re-link", and that must stay
     * distinguishable in `rawState`.
     *
     * `BAD_CREDENTIALS` is "the credentials stopped working"; `LOGGED_OUT` is
     * "the remote network ended the session". Identical to a user, entirely
     * different to us: a rise in `LOGGED_OUT` on one network is the early shape
     * of a ban wave, and it is invisible if both were only ever stored collapsed.
     */
    BAD_CREDENTIALS: "action_required",
    LOGGED_OUT: "action_required",

    UNKNOWN_ERROR: "failed",
    UNCONFIGURED: "failed",
    BRIDGE_UNREACHABLE: "failed",
  });

/**
 * The user-visible state for a reported bridge state.
 *
 * An unrecognised value maps to `failed`, not to `connected`. A bridge release
 * that invents a state this deployment has never heard of is a deployment that
 * cannot say anything true about the account, and the honest rendering of "we do
 * not know" is a problem the user can act on — never a green dot.
 */
export function accountStateForBridgeState(stateEvent: string): BridgeAccountState {
  if (!isBridgeStateEvent(stateEvent)) return "failed";
  return STATE_BY_EVENT[stateEvent];
}

/**
 * The bridge's own TTL for a reported state (§5.4), in seconds.
 *
 * `BridgeState.Fill` sets 3600 when there is an error and 21600 otherwise, and
 * `ShouldDeduplicate` treats a repeat as new once the TTL has passed — so the
 * bridge RE-SENDS an unchanged state on expiry. That is what makes silence
 * meaningful, and these fallbacks exist for the case where a bridge sends no TTL
 * at all: without one, "stale" would have no definition and a dead process would
 * stay green forever.
 */
export const BRIDGE_STATE_TTL_FALLBACK_SECONDS = Object.freeze({
  error: 3_600,
  healthy: 21_600,
});

export function bridgeStateTtlSeconds(
  reportedTtl: number | undefined,
  state: BridgeAccountState,
): number {
  if (typeof reportedTtl === "number" && Number.isFinite(reportedTtl) && reportedTtl > 0) {
    return Math.floor(reportedTtl);
  }
  return state === "connected" || state === "connecting"
    ? BRIDGE_STATE_TTL_FALLBACK_SECONDS.healthy
    : BRIDGE_STATE_TTL_FALLBACK_SECONDS.error;
}

/**
 * Whether a state change is worth waking the user's phone for.
 *
 * Only `action_required`: it is the only state the user can do anything about.
 * `degraded` and `connecting` resolve themselves, and `failed` is ours to fix.
 */
export function shouldNotifyUser(state: BridgeAccountState): boolean {
  return state === "action_required";
}
