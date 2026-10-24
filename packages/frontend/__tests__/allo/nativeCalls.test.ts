import type { AlloClient } from '@allo/core';
import {
  startNativeCalls,
  type NativeCallBridge,
  type NativeCallEvent,
} from '@/lib/allo/nativeCalls';

const event: NativeCallEvent = {
  eventId: 'event',
  action: 'answer',
  callId: 'call',
  accountId: 'account',
  instanceId: 'instance',
  expiresAt: new Date(Date.now() + 45_000).toISOString(),
};
function fixture(
  events: NativeCallEvent[] = [event],
  bind = jest.fn().mockResolvedValue(undefined),
) {
  const calls = {
    restoreIncoming: jest
      .fn()
      .mockResolvedValue({ id: 'call', conversationId: 'conversation', phase: 'ringing' }),
    answer: jest.fn().mockResolvedValue(undefined),
    decline: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    current: jest.fn().mockReturnValue(null),
  };
  const client = {
    instance: {
      current: () => ({ id: 'instance', accountId: 'account' }),
      state: () => 'active',
      setCallPushToken: jest.fn().mockResolvedValue(undefined),
      clearCallPushToken: jest.fn().mockResolvedValue(undefined),
    },
    calls,
    sync: { now: jest.fn().mockResolvedValue(undefined) },
  };
  const bridge = {
    bind,
    clear: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn().mockResolvedValue({ token: 'token', events, audioActive: false }),
    acknowledge: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
  } satisfies NativeCallBridge;
  const open = jest.fn();
  const report = jest.fn();
  const stop = startNativeCalls({
    client: client as unknown as AlloClient,
    bridge,
    provider: 'apns',
    open,
    report,
  });
  return { client, calls, bridge, open, report, stop };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const settle = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
it('answers only after authoritative restoration and uses an incoming route handoff', async () => {
  const f = fixture();
  await settle();
  expect(f.calls.restoreIncoming).toHaveBeenCalledWith('call');
  expect(f.calls.answer).toHaveBeenCalledTimes(1);
  expect(f.bridge.acknowledge).toHaveBeenCalledWith('event', true, false);
  expect(f.open).toHaveBeenCalledWith('conversation', 'call');
  f.stop();
  await settle();
  expect(f.bridge.clear).toHaveBeenCalledWith('instance');
});
it('does not answer or route another account, an expired ring, or a cancelled server call', async () => {
  const f = fixture([
    { ...event, accountId: 'other' },
    { ...event, callId: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() },
    { ...event, callId: 'cancelled' },
  ]);
  f.calls.restoreIncoming.mockResolvedValue(null);
  await settle();
  expect(f.calls.restoreIncoming).toHaveBeenCalledTimes(2);
  expect(f.calls.answer).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.bridge.acknowledge).toHaveBeenCalledWith('event', false, true);
  f.stop();
});
it('retains a lost reply for retry and recovers an already answered call without a second answer', async () => {
  const f = fixture();
  f.calls.answer.mockRejectedValueOnce(new Error('reply lost'));
  await settle();
  expect(f.bridge.acknowledge).not.toHaveBeenCalled();
  f.calls.restoreIncoming.mockResolvedValue({
    id: 'call',
    conversationId: 'conversation',
    phase: 'active',
  });
  await jest.advanceTimersByTimeAsync(1000);
  await settle();
  expect(f.calls.answer).toHaveBeenCalledTimes(1);
  expect(f.bridge.acknowledge).toHaveBeenCalledWith('event', true, false);
  f.stop();
});
it('retires a controller during an in-flight restore without answering from the switched account', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.calls.restoreIncoming.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await settle();
  f.stop();
  resolve({ id: 'call', conversationId: 'conversation', phase: 'ringing' });
  await settle();
  expect(f.calls.answer).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
it('declines a ring and ends an active call, acknowledging only after the server reply', async () => {
  const f = fixture([{ ...event, action: 'end' }]);
  await settle();
  expect(f.calls.decline).toHaveBeenCalledTimes(1);
  expect(f.bridge.acknowledge).toHaveBeenCalledWith('event', true, true);
  f.stop();
});
it('serializes a late previous-account token claim, retirement, and the new account claim', async () => {
  const first = fixture([]);
  const order: string[] = [];
  let release!: () => void;
  first.client.instance.setCallPushToken.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  first.client.instance.clearCallPushToken.mockImplementation(async () => {
    order.push('retire old');
  });
  await settle();
  first.stop();
  const second = fixture([]);
  second.client.instance.setCallPushToken.mockImplementation(async () => {
    order.push('register new');
  });
  await settle();
  expect(second.client.instance.setCallPushToken).not.toHaveBeenCalled();
  release();
  await settle();
  expect(order).toEqual(['retire old', 'register new']);
  second.stop();
  await settle();
});
it('reports a bind that cannot succeed once, instead of every second', async () => {
  // The shape of a build without Firebase (or a phone without Play services)
  // before the native side learned to bind without it.
  const f = fixture(
    [event],
    jest.fn().mockRejectedValue(new Error('Default FirebaseApp is not initialized')),
  );
  await settle();
  for (let second = 0; second < 5; second++) {
    jest.advanceTimersByTime(1_000);
    await settle();
  }
  expect(f.report).toHaveBeenCalledTimes(1);
  expect(f.bridge.snapshot).not.toHaveBeenCalled();
  f.stop();
});
