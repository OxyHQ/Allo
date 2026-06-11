import {
  applyAccept,
  applyCancel,
  applyDecline,
  applyEnd,
  applyRingTimeout,
  resolveAnsweredElsewhereRooms,
  shouldAutoDeclineBusy,
  RING_TIMEOUT_MS,
  type CallSnapshot,
} from "../utils/callState";

const CALLER = "caller-1";
const CALLEE = "callee-1";

function snapshot(overrides: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    callerId: CALLER,
    calleeId: CALLEE,
    status: "ringing",
    type: "audio",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("callState — applyAccept", () => {
  const now = new Date("2026-01-01T00:00:05Z");

  it("connects a ringing call accepted by the callee, stamping connectedAt", () => {
    const result = applyAccept(snapshot(), CALLEE, now);
    expect(result).toEqual({ ok: true, mutation: { status: "connected", connectedAt: now } });
  });

  it("connects an initiated call too", () => {
    const result = applyAccept(snapshot({ status: "initiated" }), CALLEE, now);
    expect(result.ok).toBe(true);
    expect(result.ok && result.mutation.status).toBe("connected");
  });

  it("rejects acceptance by the caller", () => {
    const result = applyAccept(snapshot(), CALLER, now);
    expect(result).toEqual({ ok: false, error: "Only callee can accept" });
  });

  it("is idempotent on an already-connected call (no mutation, no error)", () => {
    const result = applyAccept(snapshot({ status: "connected" }), CALLEE, now);
    expect(result).toEqual({ ok: true, mutation: {} });
  });

  it("rejects acceptance of a terminal call", () => {
    for (const status of ["completed", "declined", "canceled", "missed", "failed"] as const) {
      const result = applyAccept(snapshot({ status }), CALLEE, now);
      expect(result.ok).toBe(false);
    }
  });
});

describe("callState — applyDecline", () => {
  const now = new Date("2026-01-01T00:00:03Z");

  it("declines a ringing call by the callee", () => {
    const result = applyDecline(snapshot(), CALLEE, now);
    expect(result).toEqual({
      ok: true,
      mutation: { status: "declined", endedAt: now, endedBy: CALLEE },
    });
  });

  it("rejects decline by the caller", () => {
    expect(applyDecline(snapshot(), CALLER, now)).toEqual({
      ok: false,
      error: "Only callee can decline",
    });
  });

  it("rejects declining a connected call (must use end)", () => {
    expect(applyDecline(snapshot({ status: "connected" }), CALLEE, now)).toEqual({
      ok: false,
      error: "Use call:end for connected calls",
    });
  });

  it("is idempotent on a terminal call", () => {
    expect(applyDecline(snapshot({ status: "canceled" }), CALLEE, now)).toEqual({
      ok: true,
      mutation: {},
    });
  });
});

describe("callState — applyCancel", () => {
  const now = new Date("2026-01-01T00:00:02Z");

  it("cancels a ringing call by the caller", () => {
    expect(applyCancel(snapshot(), CALLER, now)).toEqual({
      ok: true,
      mutation: { status: "canceled", endedAt: now, endedBy: CALLER },
    });
  });

  it("rejects cancel by the callee", () => {
    expect(applyCancel(snapshot(), CALLEE, now)).toEqual({
      ok: false,
      error: "Only caller can cancel",
    });
  });

  it("rejects cancelling a connected call", () => {
    expect(applyCancel(snapshot({ status: "connected" }), CALLER, now)).toEqual({
      ok: false,
      error: "Use call:end for connected calls",
    });
  });

  it("is idempotent on a terminal call", () => {
    expect(applyCancel(snapshot({ status: "missed" }), CALLER, now)).toEqual({
      ok: true,
      mutation: {},
    });
  });
});

describe("callState — applyEnd", () => {
  it("completes a connected call and computes duration from connectedAt", () => {
    const connectedAt = new Date("2026-01-01T00:00:05Z");
    const now = new Date("2026-01-01T00:01:35Z"); // +90s
    const result = applyEnd(
      snapshot({ status: "connected", connectedAt }),
      CALLER,
      now
    );
    expect(result).toEqual({
      ok: true,
      mutation: { status: "completed", endedAt: now, endedBy: CALLER, durationSec: 90 },
    });
  });

  it("treats ending a ringing call by the caller as canceled", () => {
    const now = new Date("2026-01-01T00:00:04Z");
    const result = applyEnd(snapshot({ status: "ringing" }), CALLER, now);
    expect(result.ok).toBe(true);
    expect(result.ok && result.mutation.status).toBe("canceled");
  });

  it("treats ending a ringing call by the callee as declined", () => {
    const now = new Date("2026-01-01T00:00:04Z");
    const result = applyEnd(snapshot({ status: "ringing" }), CALLEE, now);
    expect(result.ok).toBe(true);
    expect(result.ok && result.mutation.status).toBe("declined");
  });

  it("rejects ending by a non-participant", () => {
    expect(applyEnd(snapshot(), "stranger", new Date())).toEqual({
      ok: false,
      error: "Not a participant",
    });
  });

  it("never produces a negative duration", () => {
    // connectedAt slightly after now (clock skew) → clamp to 0.
    const connectedAt = new Date("2026-01-01T00:00:10Z");
    const now = new Date("2026-01-01T00:00:05Z");
    const result = applyEnd(snapshot({ status: "connected", connectedAt }), CALLEE, now);
    expect(result.ok && result.mutation.durationSec).toBe(0);
  });

  it("is idempotent on a terminal call", () => {
    expect(applyEnd(snapshot({ status: "completed" }), CALLER, new Date())).toEqual({
      ok: true,
      mutation: {},
    });
  });
});

describe("callState — applyRingTimeout", () => {
  it("marks a still-ringing call as missed", () => {
    const now = new Date("2026-01-01T00:00:30Z");
    expect(applyRingTimeout(snapshot({ status: "ringing" }), now)).toEqual({
      status: "missed",
      endedAt: now,
    });
  });

  it("is a no-op once the call left the ringing state", () => {
    for (const status of ["connected", "completed", "declined", "canceled"] as const) {
      expect(applyRingTimeout(snapshot({ status }), new Date())).toBeNull();
    }
  });

  it("uses a 30 second timeout", () => {
    expect(RING_TIMEOUT_MS).toBe(30_000);
  });
});

describe("callState — shouldAutoDeclineBusy", () => {
  it("auto-declines when the callee already has an active call", () => {
    expect(shouldAutoDeclineBusy(true)).toBe(true);
  });
  it("allows the call when the callee is free", () => {
    expect(shouldAutoDeclineBusy(false)).toBe(false);
  });
});

describe("callState — resolveAnsweredElsewhereRooms", () => {
  it("targets every callee device room except the one that accepted", () => {
    const rooms = resolveAnsweredElsewhereRooms(CALLEE, [1, 2, 3], 2);
    expect(rooms.sort()).toEqual([`device:${CALLEE}:1`, `device:${CALLEE}:3`].sort());
  });

  it("returns no rooms when the accepting device id is unknown (legacy)", () => {
    expect(resolveAnsweredElsewhereRooms(CALLEE, [1, 2, 3], undefined)).toEqual([]);
  });

  it("returns no rooms when the accepting device is the only one", () => {
    expect(resolveAnsweredElsewhereRooms(CALLEE, [5], 5)).toEqual([]);
  });
});
