import type { AlloClient } from '@allo/core';

export interface NativeCallEvent {
  eventId: string;
  action: 'ring' | 'answer' | 'end' | 'active';
  callId: string;
  accountId: string;
  instanceId: string;
  expiresAt: string;
}
export interface NativeCallBridge {
  bind(accountId: string, instanceId: string): Promise<void>;
  clear(instanceId?: string): Promise<void>;
  snapshot(): Promise<{ token: string; events: NativeCallEvent[]; audioActive: boolean }>;
  acknowledge(event: string, success: boolean, terminal: boolean): Promise<void>;
  end(id: string): Promise<void>;
  audio?(active: boolean): Promise<void>;
}

// A token belongs to one installation but accounts have different signers.
// Serialize registration/retirement across controllers so a late old-account
// registration cannot steal a token back after the new account claimed it.
let tokenWrites: Promise<void> = Promise.resolve();
function writeToken(action: () => Promise<void>): Promise<void> {
  const write = tokenWrites.then(action, action);
  tokenWrites = write.catch(() => {});
  return write;
}

/** Native UI can ring without JS. Authority and all media still belong to the SDK. */
export function startNativeCalls(options: {
  client: AlloClient;
  bridge: NativeCallBridge;
  provider: 'apns' | 'fcm';
  open: (conversationId: string, callId: string) => void;
  report: (error: unknown) => void;
}) {
  const { client, bridge } = options;
  const instance = client.instance.current();
  if (!instance || client.instance.state() !== 'active') return () => {};
  const { accountId, id: instanceId } = instance;
  let stopped = false;
  let busy = false;
  let registeredToken: string | null = null;
  let audioActive = false;
  const opened = new Set<string>();
  const bound = bridge.bind(accountId, instanceId);
  // A bind that fails will fail the same way on every tick: report it once and
  // stop polling rather than logging it every second for the life of the app.
  bound.catch((error: unknown) => {
    if (stopped) return;
    clearInterval(timer);
    options.report(error);
  });
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      try {
        await bound;
      } catch {
        return; // reported once by the handler above
      }
      if (stopped) return;
      const snapshot = await bridge.snapshot();
      if (stopped) return;
      if (snapshot.audioActive !== audioActive) {
        audioActive = snapshot.audioActive;
        await bridge.audio?.(audioActive);
      }
      if (snapshot.token !== registeredToken) {
        await writeToken(async () => {
          if (stopped) return;
          if (snapshot.token)
            await client.instance.setCallPushToken(options.provider, snapshot.token);
          else await client.instance.clearCallPushToken();
        });
        if (stopped) return;
        registeredToken = snapshot.token;
      }
      for (const event of snapshot.events) {
        if (stopped) return;
        if (event.accountId !== accountId || event.instanceId !== instanceId) {
          await bridge.end(event.callId);
          continue;
        }
        const ringDeadline = Date.parse(event.expiresAt);
        if (!Number.isFinite(ringDeadline) || ringDeadline + 86_400_000 < Date.now()) {
          await bridge.end(event.callId);
          continue;
        }
        let call: Awaited<ReturnType<AlloClient['calls']['restoreIncoming']>>;
        try {
          call = await client.calls.restoreIncoming(event.callId);
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
          if (code === 'not_found' || code === 'forbidden' || code === 'instance_revoked') {
            await bridge.acknowledge(event.eventId, false, true);
            continue;
          }
          throw error; // network failure retains the durable action for retry
        }
        if (stopped) return;
        if (!call) {
          await bridge.acknowledge(event.eventId, false, true);
          continue;
        }
        if (event.action === 'end') {
          if (call.phase === 'ringing') await client.calls.decline();
          else await client.calls.end();
          if (!stopped) await bridge.acknowledge(event.eventId, true, true);
          continue;
        }
        if (event.action === 'answer') {
          if (call.phase === 'ringing') await client.calls.answer();
          if (stopped) return;
          await bridge.acknowledge(event.eventId, true, false);
        }
        if (!opened.has(event.callId)) {
          opened.add(event.callId);
          options.open(call.conversationId, call.id);
          await client.sync.now();
        }
      }
    } catch (error) {
      if (!stopped) options.report(error);
    } finally {
      busy = false;
    }
  }
  void tick();
  const timer = setInterval(() => void tick(), 1_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    void bridge.audio?.(false).catch(options.report);
    // Clear the local binding immediately, even if the old bearer has gone.
    // Registering the token for the next instance also atomically retires the
    // previous server binding; a session gap never destroys identity keys.
    void bound.then(() => bridge.clear(instanceId)).catch(options.report);
    void writeToken(() => client.instance.clearCallPushToken()).catch(options.report);
  };
}
