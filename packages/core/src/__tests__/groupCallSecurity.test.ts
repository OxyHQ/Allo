import { describe, expect, it } from 'bun:test';
import { CallsService } from '../calls/service';
import type { Context } from '../context';
import type { CallMediaAdapter } from '../calls/media';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
function setup(incoming = true) {
  const received: string[] = [],
    joined: string[] = [],
    closed: string[] = [];
  let epoch = 1;
  let conversationsChanged = () => {};
  let ticket: Promise<unknown> | null = null;
  let starting: Promise<unknown> | null = null;
  const prepared: string[] = [];
  const media: CallMediaAdapter = {
    async prepare() {
      prepared.push('prepare');
    },
    async createOffer() {
      return { sdp: '' };
    },
    async acceptOffer() {
      return { sdp: '' };
    },
    async acceptAnswer() {},
    async addCandidates() {},
    onCandidates() {
      return () => {};
    },
    async setMuted() {},
    async setCameraEnabled() {},
    async joinRoom() {
      joined.push('joined');
    },
    async setReceiveKey(id) {
      received.push(id);
    },
    async close() {
      closed.push('closed');
    },
  };
  const call = {
    state: 'active',
    answeredAt: new Date().toISOString(),
    participants: [
      { instanceId: 'self', accountId: 'account-self', state: 'joined' },
      { instanceId: 'peer', accountId: 'account-peer', state: 'joined' },
      { instanceId: 'rung', accountId: 'account-rung', state: 'ringing' },
    ],
  };
  const ctx = {
    instance: { assertActive() {} },
    conversations: { get: () => ({ memberAccountIds: ['account-self', 'account-peer'] }) },
    now: () => Date.now(),
    instanceId: 'self',
    accountId: 'account-self',
    signer: {},
    emitter: {
      subscribe(_name: string, fn: () => void) {
        conversationsChanged = fn;
        return () => {};
      },
      emit() {},
    },
    groups: { get: () => ({}) },
    engine: { epochOf: () => epoch },
    model: { eventsOf: () => [] },
    outbox: { async enqueueMessage() {} },
    log: {},
    http: {
      async request({ path }: { path: string }) {
        if (path === '/v1/calls' && starting) return starting;
        if (path.endsWith('/ice')) return { iceServers: [], relayOnly: true };
        if (path.endsWith('/token'))
          return (
            ticket ?? {
              url: 'wss://sfu.test',
              token: 'ticket',
              room: 'room',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }
          );
        return { call };
      },
    },
  } as unknown as Context;
  const service = new CallsService(ctx, media);
  if (incoming)
    service.onIncoming({
      callId: 'call-00000001',
      conversationId: 'conversation-00000001',
      initiatorAccountId: 'account-peer',
      mode: 'video',
      group: true,
    });
  return {
    service,
    prepared,
    deferStart(value: Promise<unknown>) {
      starting = value;
    },
    received,
    joined,
    closed,
    call,
    advanceEpoch() {
      epoch++;
      conversationsChanged();
    },
    deferTicket(value: Promise<unknown>) {
      ticket = value;
    },
  };
}
describe('group sender authentication and late lifecycle work', () => {
  it('accepts only joined authenticated envelope senders, never an unbound or ringing identity', async () => {
    const s = setup();
    await s.service.answer();
    const message = { callId: 'call-00000001', kind: 'key', key: KEY, generation: 10 };
    await s.service.onCallMessage('conversation-00000001', message);
    await s.service.onCallMessage('conversation-00000001', message, 'forged');
    await s.service.onCallMessage('conversation-00000001', message, 'rung');
    await s.service.onCallMessage('conversation-00000001', message, 'self');
    await s.service.onCallMessage('other-conversation', message, 'peer');
    expect(s.received).toEqual([]);
    await s.service.onCallMessage('conversation-00000001', message, 'peer');
    await s.service.onCallMessage('conversation-00000001', message, 'peer');
    expect(s.received).toEqual(['peer']);
    s.advanceEpoch();
    await s.service.onCallMessage('conversation-00000001', { ...message, generation: 11 }, 'peer');
    expect(s.received).toEqual(['peer']);
    expect(s.service.current()).toMatchObject({ phase: 'ended', endNotice: 'membership_changed' });
    s.service.stop();
  });
  it('an outstanding SFU ticket cannot reopen media after an MLS epoch change', async () => {
    const s = setup();
    let resolve!: (value: unknown) => void;
    s.deferTicket(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const answer = s.service.answer();
    await new Promise((r) => setTimeout(r, 0));
    s.advanceEpoch();
    resolve({
      url: 'wss://sfu.test',
      token: 'old-ticket',
      room: 'room',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(answer).rejects.toThrow('call ended');
    expect(s.joined).toEqual([]);
    expect(s.closed.length).toBeGreaterThan(0);
    expect(s.service.current()?.phase).toBe('ended');
    s.service.stop();
  });
  it('account retirement while creating a call cannot acquire media from the late response', async () => {
    const s = setup(false);
    let resolve!: (value: unknown) => void;
    s.deferStart(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const start = s.service.start('conversation-00000001', 'video');
    s.service.stop();
    resolve({ call: { id: 'late-call-00000001' } });
    await expect(start).rejects.toThrow('call service stopped');
    expect(s.prepared).toEqual([]);
    expect(s.service.current()).toBeNull();
  });
});
