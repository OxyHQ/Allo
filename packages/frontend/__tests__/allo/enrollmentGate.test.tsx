import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient } from '@allo/core';
import { AlloProvider } from '@allo/react';

import { EnrollmentGate } from '@/lib/allo/EnrollmentGate';

/**
 * The enrollment gate, against a REAL `@allo/core` client over the in-memory
 * fake server, so the states it renders are the states the SDK actually
 * produces: a first device is `active` and sees the app; a second device is
 * `pending-approval` and sees the approval screen, then the app once the
 * first approves it; a revoked device sees the start-over screen.
 *
 * The screens are rendered with the theme hook mocked (they read colours
 * from it and nothing else) and translations answering their defaults.
 */

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    colors: {
      background: '#fff',
      backgroundSecondary: '#eee',
      text: '#000',
      textSecondary: '#444',
      primary: '#0a0',
      border: '#ccc',
      error: '#c00',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const { createFakeAlloServer, FakeSession, MemorySecrets, MemoryStorage, until } = testing;
type FakeServer = ReturnType<typeof createFakeAlloServer>;

async function makeClient(server: FakeServer, accountId: string, name: string, start = true): Promise<AlloClient> {
  const client = createAlloClient({
    baseUrl: server.baseUrl,
    appId: 'allo',
    platform: 'ios',
    displayName: name,
    session: FakeSession.for(accountId),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
    keyPackageTarget: 4,
  });
  if (start) await client.start();
  return client;
}

function mount(client: AlloClient) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <AlloProvider client={client}>
        <EnrollmentGate>
          <Text>THE APP</Text>
        </EnrollmentGate>
      </AlloProvider>,
    );
  });
  if (!renderer) throw new Error('did not mount');
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(React.Children.toArray(node.props.children).join('')));
}

/**
 * Polls OUTSIDE `act`, then flushes React inside one. The SDK's subscriptions
 * fire from its own async work; wrapping the whole wait in `act` would
 * overlap with the acts the approvals below run in.
 */
async function waitUntil(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
  await until(fn, timeoutMs, 15);
  await act(async () => {
    await Promise.resolve();
  });
}

// MLS group operations through the fake server take seconds under Babel-transformed jest.
jest.setTimeout(120_000);

// Every state change here comes from the SDK's own async work, observed by
// polling; React's "wrap in act" warning would fire on each and say nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

describe('EnrollmentGate', () => {
  const started: AlloClient[] = [];
  afterEach(async () => {
    for (const client of started.splice(0)) await client.stop();
  });

  it('renders the app for an active first device', async () => {
    const server = createFakeAlloServer();
    const first = await makeClient(server, 'acc-gate-1', 'Phone');
    started.push(first);

    const renderer = mount(first);

    expect(texts(renderer)).toContain('THE APP');
    expect(texts(renderer).join(' ')).not.toMatch(/Approve this device/);
  });

  it('holds a second device on the approval screen until the first approves it, then shows the app', async () => {
    const server = createFakeAlloServer();
    const first = await makeClient(server, 'acc-gate-2', 'Phone');
    started.push(first);
    const second = await makeClient(server, 'acc-gate-2', 'Laptop', false);
    started.push(second);

    const renderer = mount(second);
    await act(async () => {
      await second.start();
    });
    await waitUntil(() => second.instance.state() === 'pending-approval');

    expect(texts(renderer).join(' ')).toMatch(/Approve this device/);
    expect(texts(renderer)).toContain('Laptop');
    expect(texts(renderer)).not.toContain('THE APP');

    // The first device approves it, comparing the challenge it was shown.
    await act(async () => {
      await first.instance.refreshPending();
    });
    const enrollment = first.instance.pending().find((p) => p.instance.id === second.instanceId);
    expect(enrollment?.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    await act(async () => {
      await first.instance.approve(enrollment!.instance.id, enrollment!.challenge);
    });
    await waitUntil(() => second.instance.state() === 'active', 10_000);

    expect(texts(renderer)).toContain('THE APP');
  });

  it('shows the start-over screen for a revoked device', async () => {
    const server = createFakeAlloServer();
    const first = await makeClient(server, 'acc-gate-3', 'Phone');
    started.push(first);
    const second = await makeClient(server, 'acc-gate-3', 'Tablet', false);
    started.push(second);
    const renderer = mount(second);
    await act(async () => {
      await second.start();
    });
    await waitUntil(() => second.instance.state() === 'pending-approval');
    await act(async () => {
      await first.instance.refreshPending();
    });
    const enrollment = first.instance.pending().find((p) => p.instance.id === second.instanceId)!;
    await act(async () => {
      await first.instance.approve(enrollment.instance.id, enrollment.challenge);
    });
    await waitUntil(() => second.instance.state() === 'active', 10_000);
    expect(texts(renderer)).toContain('THE APP');

    await act(async () => {
      await first.instance.revoke(second.instanceId!);
    });
    await waitUntil(() => second.instance.state() === 'revoked', 10_000);

    expect(texts(renderer).join(' ')).toMatch(/This device was removed/);
    expect(texts(renderer)).toContain('Start over');
    expect(texts(renderer)).not.toContain('THE APP');
  });
});
