/**
 * THE MEDIA CONFIGURATION HAS TO BE READ AT BOOT, and this is the test that
 * says so, because the first time round nothing read it at all.
 *
 * `iceRuntime.ts` promised in its own comment that `setIceConfig` was "called
 * once from server.ts, so a half-configured relay fails the boot". Nothing
 * called it. `getIceConfig()` therefore fell through to its lazy default,
 * which parses an EMPTY environment, and the consequences were not subtle:
 *
 *   - `TURN_URLS` and `TURN_SHARED_SECRET` were dead configuration;
 *   - every deployment served Google's STUN and nothing else;
 *   - and a call that anybody had hidden their address in — or any group call,
 *     which is always relayed — was told `relayOnly: true` with no relay in
 *     the list, which is not a degraded call but an impossible one.
 *
 * So "Hide my IP address in calls" would have shipped as "your calls stop
 * working". The wiring is now in `createRuntimeApp`, and this holds it there.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearIceConfig, getIceConfig } from "../../config/iceRuntime";
import { clearLiveKitConfig, getLiveKitConfig } from "../../config/sfuRuntime";
import { createRuntimeApp } from "../../runtimeApp";

const KEYS = ["TURN_URLS", "TURN_SHARED_SECRET", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  clearIceConfig();
  clearLiveKitConfig();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearIceConfig();
  clearLiveKitConfig();
});

describe("booting the app", () => {
  it("reads the relay and the SFU out of the ENVIRONMENT, not out of an empty object", () => {
    process.env.TURN_URLS = "turns:relay.allo.test:443?transport=tcp";
    process.env.TURN_SHARED_SECRET = "a-shared-secret";
    process.env.LIVEKIT_URL = "wss://livekit.oxy.so";
    process.env.LIVEKIT_API_KEY = "APIboot";
    process.env.LIVEKIT_API_SECRET = "boot-secret";

    createRuntimeApp();

    const ice = getIceConfig();
    expect(ice.turn).not.toBeNull();
    expect(ice.turn?.urls).toEqual(["turns:relay.allo.test:443?transport=tcp"]);
    expect(getLiveKitConfig()).toMatchObject({ url: "wss://livekit.oxy.so", apiKey: "APIboot" });
  });

  it("boots with neither configured — 1:1 calls need no relay and no SFU", () => {
    for (const key of KEYS) delete process.env[key];
    createRuntimeApp();
    expect(getIceConfig().turn).toBeNull();
    expect(getLiveKitConfig()).toBeNull();
  });

  it("refuses to boot on a half-configured relay rather than failing the first call", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.TURN_URLS = "turns:relay.allo.test:443";
    expect(() => createRuntimeApp()).toThrow(/TURN_SHARED_SECRET/);
  });

  it("refuses to boot on a half-configured SFU for the same reason", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.LIVEKIT_API_KEY = "APIboot";
    expect(() => createRuntimeApp()).toThrow(/together or not at all/);
  });
});
