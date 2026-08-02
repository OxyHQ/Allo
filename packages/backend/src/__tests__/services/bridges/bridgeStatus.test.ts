import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBridgesConfig, resetBridgesConfigForTests } from "../../../config/bridges";
import BridgeAccount, {
  BRIDGE_STATE_EVENTS,
  type BridgeAccountState,
  type BridgeStateEvent,
} from "../../../models/BridgeAccount";
import {
  accountStateForBridgeState,
  bridgeStateTtlSeconds,
} from "../../../services/bridges/bridgeStateMapping";
import {
  applyBridgeState,
  sweepStaleBridgeAccounts,
} from "../../../services/bridges/BridgeStatusService";

/**
 * Collapsing bridge states, and noticing silence (docs/matrix/bridges.md §5.3, §5.4).
 */

const SECRET = "a-shared-secret-that-is-long-enough-32";
const AS_TOKEN = "an-as-token-that-is-also-long-enough-32";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaa";

const TELEGRAM = loadBridgesConfig({
  ALLO_BRIDGES_ENABLED: "telegram",
  ALLO_MATRIX_SERVER_NAME: "allo.you",
  ALLO_BRIDGE_TELEGRAM_BASE_URL: "http://bridge-telegram:29317",
  ALLO_BRIDGE_TELEGRAM_SHARED_SECRET: SECRET,
  ALLO_BRIDGE_TELEGRAM_AS_TOKEN: AS_TOKEN,
}).networks.get("telegram");

if (!TELEGRAM) throw new Error("the telegram fixture failed to build");

describe("collapsing the bridge's eleven states into six", () => {
  /**
   * §5.3's table, written out. Asserting the WHOLE mapping rather than a few
   * interesting rows, because the rows nobody thinks about are the ones that get
   * classified wrongly — and a state meaning "banned" filed under `connected`
   * shows the user a green dot.
   */
  const TABLE: Readonly<Record<BridgeStateEvent, BridgeAccountState>> = {
    STARTING: "connecting",
    CONNECTING: "connecting",
    BACKFILLING: "connecting",
    CONNECTED: "connected",
    RUNNING: "connected",
    TRANSIENT_DISCONNECT: "degraded",
    BAD_CREDENTIALS: "action_required",
    LOGGED_OUT: "action_required",
    UNKNOWN_ERROR: "failed",
    UNCONFIGURED: "failed",
    BRIDGE_UNREACHABLE: "failed",
  };

  it.each(Object.entries(TABLE))("maps %s to %s", (event, expected) => {
    expect(accountStateForBridgeState(event)).toBe(expected);
  });

  it("covers every state the bridge can send, with none left over", () => {
    /**
     * The guard that keeps the table above honest. If a bridge release adds a
     * state and somebody extends `BRIDGE_STATE_EVENTS` without classifying it,
     * this fails here — rather than in production, as a new state quietly
     * treated as unknown.
     */
    expect(Object.keys(TABLE).sort()).toEqual([...BRIDGE_STATE_EVENTS].sort());
  });

  it("treats a state it has never heard of as a problem, never as healthy", () => {
    /**
     * A bridge that invents a state is a deployment that can say nothing true
     * about the account. The honest rendering of "we do not know" is something
     * the user can act on — never a green dot.
     */
    expect(accountStateForBridgeState("QUANTUM_ENTANGLED")).toBe("failed");
  });

  it("falls back to the bridge's own TTL defaults when none is reported", () => {
    /**
     * §5.4: `BridgeState.Fill` uses 3600 on error and 21600 otherwise. Without a
     * fallback, "stale" would have no definition for a report carrying no TTL —
     * and a dead process would stay green forever.
     */
    expect(bridgeStateTtlSeconds(900, "connected")).toBe(900);
    expect(bridgeStateTtlSeconds(undefined, "connected")).toBe(21_600);
    expect(bridgeStateTtlSeconds(undefined, "action_required")).toBe(3_600);
    expect(bridgeStateTtlSeconds(0, "failed")).toBe(3_600);
  });
});

describe("applying a state, and telling the user only when it helps", () => {
  const notify = vi.fn(async () => undefined);

  beforeAll(async () => {
    const uri = process.env.ALLO_TEST_MONGODB_URI;
    if (!uri) throw new Error("ALLO_TEST_MONGODB_URI is not set by vitest.globalSetup.ts");
    await mongoose.connect(uri, { dbName: "allo_bridge_status_test" });
    await BridgeAccount.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(() => {
    /**
     * The server name is deployment-wide rather than per network, so the service
     * reads it from the process configuration even though the network is passed
     * in. A deployment with a bridge enabled always has one — the config refuses
     * to parse otherwise — so setting it here is what makes this fixture a
     * deployment rather than half of one.
     */
    process.env.ALLO_MATRIX_SERVER_NAME = "allo.you";
    resetBridgesConfigForTests();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    resetBridgesConfigForTests();
    await BridgeAccount.deleteMany({});
  });

  async function account(overrides: Record<string, unknown> = {}) {
    return await BridgeAccount.create({
      oxyUserId: USER,
      network: "telegram",
      remoteLoginId: "remote-login-1",
      state: "connected",
      linkedAt: new Date(),
      lastStateAt: new Date(),
      ...overrides,
    });
  }

  const report = (stateEvent: string) => ({
    state_event: stateEvent,
    remote_id: "remote-login-1",
    user_id: `@${USER}:allo.you`,
  });

  it("notifies once when credentials go bad, not once per repeat", async () => {
    /**
     * §5.4 step 4. The bridge re-sends `BAD_CREDENTIALS` every time its TTL
     * lapses — hourly by its own defaults — and a push per repeat is a phone
     * buzzing all night about something the user already knows.
     */
    await account();

    await applyBridgeState(TELEGRAM, report("BAD_CREDENTIALS"), notify);
    await applyBridgeState(TELEGRAM, report("BAD_CREDENTIALS"), notify);
    await applyBridgeState(TELEGRAM, report("BAD_CREDENTIALS"), notify);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies again after the account recovered and broke a second time", async () => {
    /**
     * The other half, and the one a naive "notify once" implementation gets
     * wrong: a user who re-links and is logged out again a week later must be
     * told the second time. Recovery is what clears the marker.
     */
    await account();

    await applyBridgeState(TELEGRAM, report("BAD_CREDENTIALS"), notify);
    await applyBridgeState(TELEGRAM, report("CONNECTED"), notify);
    await applyBridgeState(TELEGRAM, report("LOGGED_OUT"), notify);

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("says nothing for states the user cannot act on", async () => {
    /**
     * `degraded` resolves itself — the bridge already debounces
     * `TRANSIENT_DISCONNECT` for about thirty seconds before reporting it at all
     * — and `failed` is ours to fix. Neither is worth waking a phone for.
     */
    await account();

    await applyBridgeState(TELEGRAM, report("TRANSIENT_DISCONNECT"), notify);
    await applyBridgeState(TELEGRAM, report("UNKNOWN_ERROR"), notify);
    await applyBridgeState(TELEGRAM, report("BACKFILLING"), notify);

    expect(notify).not.toHaveBeenCalled();
  });

  it("still records the state when the notification fails", async () => {
    /**
     * A push that cannot be delivered must not fail the webhook: the state
     * change is real and already known, and answering non-2xx would have the
     * bridge redeliver a report that was applied correctly.
     */
    const failing = vi.fn(async () => {
      throw new Error("FCM is down");
    });
    const created = await account();

    await expect(
      applyBridgeState(TELEGRAM, report("BAD_CREDENTIALS"), failing),
    ).resolves.toMatchObject({ matched: true });

    const stored = await BridgeAccount.findById(created._id).lean();
    expect(stored?.state).toBe("action_required");
  });
});

describe("the sweep that notices silence", () => {
  beforeAll(async () => {
    const uri = process.env.ALLO_TEST_MONGODB_URI;
    if (!uri) throw new Error("ALLO_TEST_MONGODB_URI is not set by vitest.globalSetup.ts");
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { dbName: "allo_bridge_status_test" });
    }
    await BridgeAccount.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(() => {
    process.env.ALLO_BRIDGES_STALE_MARGIN_SECONDS = "300";
    resetBridgesConfigForTests();
  });

  afterEach(async () => {
    delete process.env.ALLO_BRIDGES_STALE_MARGIN_SECONDS;
    resetBridgesConfigForTests();
    await BridgeAccount.deleteMany({});
  });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function accountLastHeardFrom(
    minutes: number,
    ttlSeconds: number | undefined,
    state: BridgeAccountState = "connected",
    remoteLoginId = `remote-${minutes}-${ttlSeconds ?? "none"}-${state}`,
  ) {
    return await BridgeAccount.create({
      oxyUserId: USER,
      network: "telegram",
      remoteLoginId,
      state,
      linkedAt: minutesAgo(minutes),
      lastStateAt: minutesAgo(minutes),
      rawState: {
        stateEvent: "CONNECTED",
        ...(ttlSeconds === undefined ? {} : { ttl: ttlSeconds }),
        at: minutesAgo(minutes),
      },
    });
  }

  it("marks an account failed once it outlives its own TTL plus the margin", async () => {
    /**
     * The failure no webhook can report, because reporting it requires being
     * alive. The bridge re-sends an unchanged state when its TTL expires, so
     * silence past that window means the process is gone.
     */
    const silent = await accountLastHeardFrom(120, 3_600);

    const result = await sweepStaleBridgeAccounts();

    expect(result.markedFailed).toBe(1);
    const stored = await BridgeAccount.findById(silent._id).lean();
    expect(stored?.state).toBe("failed");
    expect(stored?.rawState?.reason).toBe("stale");
  });

  it("leaves an account alone while it is still within its TTL", async () => {
    /**
     * The vacuity guard. Without it, a sweep that failed everything — or one
     * whose `$expr` was inverted — would satisfy the test above perfectly.
     */
    const fresh = await accountLastHeardFrom(10, 3_600);

    const result = await sweepStaleBridgeAccounts();

    expect(result.markedFailed).toBe(0);
    const stored = await BridgeAccount.findById(fresh._id).lean();
    expect(stored?.state).toBe("connected");
  });

  it("uses each account's OWN TTL rather than one age for all of them", async () => {
    /**
     * The TTL is per state: one hour when the bridge reported an error, six when
     * it did not. Sweeping on a single fixed age would either declare healthy
     * accounts dead or let broken ones sit green for hours — so both are present
     * at the same age, and exactly one must be swept.
     */
    const shortTtl = await accountLastHeardFrom(120, 3_600, "connected", "remote-short");
    const longTtl = await accountLastHeardFrom(120, 21_600, "connected", "remote-long");

    const result = await sweepStaleBridgeAccounts();

    expect(result.markedFailed).toBe(1);
    expect((await BridgeAccount.findById(shortTtl._id).lean())?.state).toBe("failed");
    expect((await BridgeAccount.findById(longTtl._id).lean())?.state).toBe("connected");
  });

  it("holds an account that never reported a TTL to the healthy default", async () => {
    /**
     * Not to NO budget, which is how a dead process stays green forever.
     * 21600 seconds is the bridge's own healthy default, so 10 hours of silence
     * is stale and 3 hours is not.
     */
    const silent = await accountLastHeardFrom(600, undefined, "connected", "remote-no-ttl-old");
    const recent = await accountLastHeardFrom(180, undefined, "connected", "remote-no-ttl-new");

    await sweepStaleBridgeAccounts();

    expect((await BridgeAccount.findById(silent._id).lean())?.state).toBe("failed");
    expect((await BridgeAccount.findById(recent._id).lean())?.state).toBe("connected");
  });

  it("does not touch an attempt that is still linking", async () => {
    /**
     * A login in progress has no reported state yet, and its own expiry governs
     * it. Sweeping it would fail attempts that are simply waiting for the user
     * to read a code.
     */
    const linking = await accountLastHeardFrom(600, 3_600, "linking", "remote-linking");

    await sweepStaleBridgeAccounts();

    expect((await BridgeAccount.findById(linking._id).lean())?.state).toBe("linking");
  });

  it("does not keep re-marking accounts it already marked", async () => {
    /**
     * The sweep runs on a timer. If it re-marked every already-failed account on
     * every pass it would rewrite `lastStateAt` forever, which destroys the one
     * piece of evidence saying WHEN the account actually went quiet.
     */
    await accountLastHeardFrom(600, 3_600);

    const first = await sweepStaleBridgeAccounts();
    const second = await sweepStaleBridgeAccounts();

    expect(first.markedFailed).toBe(1);
    expect(second.markedFailed).toBe(0);
  });
});
