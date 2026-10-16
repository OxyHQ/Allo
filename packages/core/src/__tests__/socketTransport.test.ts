import { describe, expect, it, mock } from 'bun:test';

/**
 * The production socket must never use HTTP long-polling: the API runs on
 * several tasks behind one load balancer without sticky sessions, and a
 * polling `sid` bound to one task is answered 400 by the other. Measured on
 * allo.you on 2026-09-18 (`/socket.io/?EIO=4&transport=polling&sid=…` → 400).
 */
const captured: Array<{ url: string; options: Record<string, unknown> }> = [];
const handlers = new Map<string, (...args: unknown[]) => void>();
let connects = 0;
mock.module('socket.io-client', () => ({
  io: (url: string, options: Record<string, unknown>) => {
    captured.push({ url, options });
    return {
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
      },
      off() {},
      emit() {},
      connect() {
        connects += 1;
      },
      disconnect() {},
      connected: false,
      active: false,
    };
  },
}));
const auth = async () => ({ token: 't', instanceId: 'i', timestamp: 1, signature: 's' });

describe('defaultSocketFactory', () => {
  it('opens a WebSocket-only socket that never falls back to polling', async () => {
    const { defaultSocketFactory } = await import('../transport/socket');
    defaultSocketFactory('https://api.example/v1', auth);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.options.transports).toEqual(['websocket']);
    expect(captured[0]!.options.upgrade).toBe(false);
    expect(captured[0]!.options.autoConnect).toBe(false);
  });

  it('connects again after the server drops it, until it is disconnected on purpose', async () => {
    const { defaultSocketFactory } = await import('../transport/socket');
    const socket = defaultSocketFactory('https://api.example/v1', auth);
    socket.connect();
    expect(connects).toBe(1);
    handlers.get('disconnect')?.('io server disconnect');
    await Bun.sleep(1100);
    expect(connects).toBe(2);
    socket.disconnect();
    handlers.get('connect_error')?.(new Error('refused'));
    await Bun.sleep(2100);
    expect(connects).toBe(2);
  });
});
