/**
 * Integration tests for the call-signaling Socket.IO handler.
 *
 * We drive `registerCallSignaling` with a fake namespace that:
 *  - records every `.to(room).emit(event, payload)` call (assertable), and
 *  - lets a test "connect" a fake socket and invoke its registered handlers
 *    with a captured ack — exercising the real handler + the real Call model
 *    against `mongodb-memory-server` (booted in jest.setup.ts).
 *
 * The pure transition rules are covered exhaustively in callState.test.ts; here
 * we assert the persisted status/timestamps and the multi-device emit targets.
 */
import Call from "../models/Call";
import { registerCallSignaling, handleRingTimeout } from "../utils/callSignaling";
import { __resetCallRegistryForTests } from "../utils/callRegistry";

interface RecordedEmit {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

type Handler = (payload: unknown, ack?: (res: unknown) => void) => void;

interface AckResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

/** A fake socket whose registered event handlers can be invoked by tests. */
class FakeSocket {
  user: { id: string };
  signalDeviceId?: number;
  private handlers = new Map<string, Handler>();

  constructor(userId: string, deviceId?: number) {
    this.user = { id: userId };
    this.signalDeviceId = deviceId;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  /** Invoke a registered handler and resolve with its ack payload. */
  emit(event: string, payload: unknown): Promise<AckResult> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler registered for ${event}`);
    }
    return new Promise<AckResult>((resolve) => {
      const maybe = handler(payload, (res) => resolve((res as AckResult) ?? { ok: false }));
      // Handlers are async; if one resolves without ever calling ack, fail fast.
      void Promise.resolve(maybe).then(() => undefined);
    });
  }

  /** Fire the disconnect handler (socket-drop path). */
  disconnect(): void {
    this.handlers.get("disconnect")?.(undefined);
  }
}

/** A fake namespace mirroring the `.to(room).emit()` + `.on('connection')` surface. */
class FakeNamespace {
  emits: RecordedEmit[] = [];
  private connectionHandler: ((socket: FakeSocket) => void) | null = null;

  on(event: string, handler: (socket: FakeSocket) => void): void {
    if (event === "connection") {
      this.connectionHandler = handler;
    }
  }

  to(room: string) {
    return {
      emit: (event: string, payload: unknown) => {
        this.emits.push({ room, event, payload: payload as Record<string, unknown> });
      },
    };
  }

  /** Simulate a socket connecting (runs the registered connection handler). */
  connect(userId: string, deviceId?: number): FakeSocket {
    const socket = new FakeSocket(userId, deviceId);
    this.connectionHandler?.(socket);
    return socket;
  }

  emitsOf(event: string): RecordedEmit[] {
    return this.emits.filter((e) => e.event === event);
  }

  emitsTo(room: string): RecordedEmit[] {
    return this.emits.filter((e) => e.room === room);
  }

  reset(): void {
    this.emits = [];
  }
}

const CALLER = "caller-1";
const CALLEE = "callee-1";

function makeNamespace(): FakeNamespace {
  const nsp = new FakeNamespace();
  // Cast through unknown: FakeNamespace implements only the subset the handler
  // uses (.on('connection'), .to(room).emit()). This is a test double, not a
  // real Socket.IO Namespace.
  registerCallSignaling(nsp as unknown as Parameters<typeof registerCallSignaling>[0]);
  return nsp;
}

beforeEach(() => {
  __resetCallRegistryForTests();
});

describe("call lifecycle — invite → accept → end", () => {
  it("creates a ringing call, rings the callee and echoes to the caller", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);

    const ack = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    expect(ack.ok).toBe(true);
    expect(ack.callId).toBeDefined();

    const call = await Call.findById(ack.callId);
    expect(call?.status).toBe("ringing");
    expect(call?.callerId).toBe(CALLER);
    expect(call?.calleeId).toBe(CALLEE);

    // Callee rang on its user room; caller got the echo.
    expect(nsp.emitsTo(`user:${CALLEE}`).map((e) => e.event)).toContain("call:incoming");
    expect(nsp.emitsTo(`user:${CALLER}`).map((e) => e.event)).toContain("call:ringing");
  });

  it("connects on accept, stamping connectedAt, and notifies both parties", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "video" });
    nsp.reset();

    const ack = await callee.emit("call:accept", { callId });
    expect(ack.ok).toBe(true);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("connected");
    expect(call?.connectedAt).toBeInstanceOf(Date);

    expect(nsp.emitsTo(`user:${CALLER}`).map((e) => e.event)).toContain("call:accepted");
    expect(nsp.emitsTo(`user:${CALLEE}`).map((e) => e.event)).toContain("call:accepted");
  });

  it("completes on end with a duration and endedBy", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    await callee.emit("call:accept", { callId });
    nsp.reset();

    const ack = await caller.emit("call:end", { callId });
    expect(ack.ok).toBe(true);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("completed");
    expect(call?.endedBy).toBe(CALLER);
    expect(call?.endedAt).toBeInstanceOf(Date);
    expect(typeof call?.durationSec).toBe("number");

    const ended = nsp.emitsOf("call:ended");
    expect(ended.map((e) => e.room)).toEqual(
      expect.arrayContaining([`user:${CALLER}`, `user:${CALLEE}`])
    );
    expect(ended[0].payload.status).toBe("completed");
  });
});

describe("call lifecycle — decline / cancel / timeout / busy", () => {
  it("declines a ringing call and notifies both parties", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    const ack = await callee.emit("call:decline", { callId });
    expect(ack.ok).toBe(true);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("declined");
    expect(call?.endedBy).toBe(CALLEE);

    expect(nsp.emitsOf("call:declined").map((e) => e.room)).toEqual(
      expect.arrayContaining([`user:${CALLER}`, `user:${CALLEE}`])
    );
  });

  it("rejects a decline from the caller", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);
    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });

    const ack = await caller.emit("call:decline", { callId });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("Only callee can decline");
  });

  it("cancels a ringing call by the caller", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    const ack = await caller.emit("call:cancel", { callId });
    expect(ack.ok).toBe(true);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("canceled");
    expect(nsp.emitsOf("call:canceled").map((e) => e.room)).toEqual(
      expect.arrayContaining([`user:${CALLER}`, `user:${CALLEE}`])
    );
  });

  it("auto-rejects an invite when the callee is already busy", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);
    const otherCaller = nsp.connect("caller-2", 30);

    // First call leaves the callee busy (ringing).
    await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });

    // A second caller dialing the same callee is rejected with "busy".
    const ack = await otherCaller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("busy");

    // Only the first call doc exists.
    expect(await Call.countDocuments({ calleeId: CALLEE })).toBe(1);
  });

  it("admits exactly one of two CONCURRENT invites for the same callee (race)", async () => {
    const nsp = makeNamespace();
    const callerA = nsp.connect(CALLER, 10);
    const callerB = nsp.connect("caller-2", 30);
    nsp.connect(CALLEE, 20);

    // Fire both invites WITHOUT awaiting in between: both run their synchronous
    // busy/sentinel check before either completes `await Call.create`. The
    // in-progress sentinel must let only one through.
    const [ackA, ackB] = await Promise.all([
      callerA.emit("call:invite", { calleeId: CALLEE, type: "audio" }),
      callerB.emit("call:invite", { calleeId: CALLEE, type: "audio" }),
    ]);

    const oks = [ackA, ackB].filter((a) => a.ok);
    const busies = [ackA, ackB].filter((a) => !a.ok && a.error === "busy");
    expect(oks).toHaveLength(1);
    expect(busies).toHaveLength(1);

    // Exactly one call doc was created for the callee.
    expect(await Call.countDocuments({ calleeId: CALLEE })).toBe(1);
  });

  it("rejects starting a second outgoing call while already in one", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);
    nsp.connect("callee-2", 40);

    await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    const ack = await caller.emit("call:invite", { calleeId: "callee-2", type: "audio" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("already_in_call");
  });
});

describe("call lifecycle — multi-device answered-elsewhere", () => {
  it("targets the callee's OTHER device rooms when one device accepts", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    // Callee has THREE devices online: 20 (accepts), 21 and 22 (must dismiss).
    nsp.connect(CALLEE, 20);
    nsp.connect(CALLEE, 21);
    nsp.connect(CALLEE, 22);
    const acceptingDevice = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    await acceptingDevice.emit("call:accept", { callId });

    const answered = nsp.emitsOf("call:answered-elsewhere");
    const rooms = answered.map((e) => e.room).sort();
    // Device 20 accepted; 21 and 22 are told to stop ringing. (Device 20 was
    // connected twice in this test, but it must never be in the target rooms.)
    expect(rooms).toEqual([`device:${CALLEE}:21`, `device:${CALLEE}:22`].sort());
    expect(rooms).not.toContain(`device:${CALLEE}:20`);
    expect(answered[0].payload.answeringDeviceId).toBe(20);
  });

  it("falls back to the user room when the accepting device id is unknown (legacy)", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const legacyCallee = nsp.connect(CALLEE); // no deviceId

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    await legacyCallee.emit("call:accept", { callId });

    const answered = nsp.emitsOf("call:answered-elsewhere");
    expect(answered).toHaveLength(1);
    expect(answered[0].room).toBe(`user:${CALLEE}`);
    expect(answered[0].payload.answeringDeviceId).toBeUndefined();
  });
});

describe("call lifecycle — socket drop mid-call", () => {
  it("leaves a CONNECTED call untouched when a participant's socket drops", async () => {
    // The media path is peer-to-peer and survives signaling blips; ICE failure
    // (not a signaling drop) is what ends a live call. So the doc must stay
    // `connected` and NO call:ended may be emitted to the peer.
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    await callee.emit("call:accept", { callId });
    nsp.reset();

    // The caller's socket drops.
    caller.disconnect();
    // The disconnect handler does async DB work; wait a tick for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const call = await Call.findById(callId);
    expect(call?.status).toBe("connected");
    expect(call?.endedAt).toBeUndefined();
    expect(nsp.emitsOf("call:ended")).toHaveLength(0);
  });

  it("ends a still-RINGING call when the caller's socket drops", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    caller.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Caller dropping before pickup cancels the call (per applyEnd).
    const call = await Call.findById(callId);
    expect(call?.status).toBe("canceled");
    expect(call?.endedBy).toBe(CALLER);
    expect(nsp.emitsOf("call:ended").map((e) => e.room)).toEqual(
      expect.arrayContaining([`user:${CALLER}`, `user:${CALLEE}`])
    );
  });

  it("ends a still-ringing call as declined when the callee's socket drops", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    callee.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const call = await Call.findById(callId);
    expect(call?.status).toBe("declined");
    expect(call?.endedBy).toBe(CALLEE);
  });

  it("does nothing on a drop with no live call", async () => {
    const nsp = makeNamespace();
    const idle = nsp.connect(CALLER, 10);
    idle.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(nsp.emitsOf("call:ended")).toHaveLength(0);
  });
});

describe("call lifecycle — idempotency & validation", () => {
  it("rejects calling yourself", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const ack = await caller.emit("call:invite", { calleeId: CALLER, type: "audio" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("Cannot call yourself");
  });

  it("rejects an invalid call type", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const ack = await caller.emit("call:invite", { calleeId: CALLEE, type: "screen" });
    expect(ack.ok).toBe(false);
  });

  it("forwards SDP/ICE only to the other participant", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);
    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    const ack = await caller.emit("call:signal", {
      callId,
      to: CALLEE,
      payload: { kind: "offer", sdp: "v=0" },
    });
    expect(ack.ok).toBe(true);
    const forwarded = nsp.emitsOf("call:signal");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].room).toBe(`user:${CALLEE}`);
    expect(forwarded[0].payload.from).toBe(CALLER);
  });

  it("rejects forwarding a signal to yourself", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);
    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });

    const ack = await caller.emit("call:signal", {
      callId,
      to: CALLER,
      payload: { kind: "ice", candidate: {} },
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("Cannot signal self");
  });

  it("is idempotent on a duplicate accept (no error)", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);
    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });

    const first = await callee.emit("call:accept", { callId });
    const second = await callee.emit("call:accept", { callId });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

describe("call lifecycle — ring timeout", () => {
  // We invoke the timeout handler directly rather than driving the 30s timer
  // through fake clocks: the handler awaits real DB work, which a faked clock
  // would stall. The 30s duration itself is asserted in callState.test.ts.
  it("marks an unanswered call as missed and notifies both parties", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    nsp.reset();

    await handleRingTimeout(nsp as unknown as Parameters<typeof handleRingTimeout>[0], callId!);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("missed");
    expect(call?.endedAt).toBeInstanceOf(Date);
    expect(nsp.emitsOf("call:missed").map((e) => e.room)).toEqual(
      expect.arrayContaining([`user:${CALLER}`, `user:${CALLEE}`])
    );
  });

  it("does NOT mark a connected call as missed (timeout is a no-op)", async () => {
    const nsp = makeNamespace();
    const caller = nsp.connect(CALLER, 10);
    const callee = nsp.connect(CALLEE, 20);

    const { callId } = await caller.emit("call:invite", { calleeId: CALLEE, type: "audio" });
    await callee.emit("call:accept", { callId });
    nsp.reset();

    await handleRingTimeout(nsp as unknown as Parameters<typeof handleRingTimeout>[0], callId!);

    const call = await Call.findById(callId);
    expect(call?.status).toBe("connected");
    expect(nsp.emitsOf("call:missed")).toHaveLength(0);
  });
});
