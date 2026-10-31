import type React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { OxyServices } from '@oxy.so/core';

const mockOxy = new OxyServices({ baseURL: 'https://identity.example' });
const mockClients: Array<{ start: jest.Mock; dispose: jest.Mock }> = [];
const mockLogout = jest.fn();
let mockSupervisionReady = true;
let mockAccount = 'alice';
const token = (id: string, sessionId = id) =>
  `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId, exp: 2000000000 })).toString('base64url')}.fixture`;

jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: { id: mockAccount, kind: 'personal' },
    isLoading: false,
    activeSessionId: 'session-alice',
    oxyServices: mockOxy,
    logout: mockLogout,
  }),
  useSupervision: () => ({
    data: mockSupervisionReady ? { self: null } : undefined,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock('@/components/calls/CallNotice', () => ({ CallNotice: () => null }));
jest.mock('@/components/calls/CallAudio', () => ({ CallAudio: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/lib/allo/nativeCallBridge', () => ({ nativeCallBridge: null }));
jest.mock('@/lib/allo/nativeCalls', () => ({ startNativeCalls: () => () => undefined }));
jest.mock('@/lib/allo/push', () => ({
  registerPushToken: async () => false,
  onPushPermissionGranted: () => () => undefined,
}));
jest.mock('@/lib/allo/people', () => ({ configurePeople: jest.fn() }));
jest.mock('@/lib/allo/RestoreHistoryPrompt', () => ({ RestoreHistoryPrompt: () => null }));
jest.mock('@/lib/allo/signOut', () => ({ signOutOfAllo: jest.fn() }));
jest.mock('@/lib/allo/EnrollmentGate', () => ({
  EnrollmentGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/allo/ConversationAccessState', () => ({
  ConversationAccessState: ({ state }: { state: string }) => {
    const React = require('react');
    const { Text } = require('react-native');
    return React.createElement(Text, { testID: 'access-state' }, state);
  },
}));
jest.mock('@allo/react', () => ({
  AlloProvider: ({ children }: { children: React.ReactNode }) => children,
  useAlloClient: () => null,
  useInstanceState: () => ({ state: 'pending' }),
}));
jest.mock('@/lib/allo/client', () => ({
  APP_ID: 'allo',
  createAppAlloClient: async () => {
    const client = {
      start: jest.fn(async () => undefined),
      dispose: jest.fn(async () => undefined),
    };
    mockClients.push(client);
    return client;
  },
}));

const { AlloRoot } = require('@/lib/allo/AlloRoot') as typeof import('@/lib/allo/AlloRoot');

/** Compile the real root in memory using the React Compiler shipped by Expo. */
function compiledAlloRoot(): typeof AlloRoot {
  const { transformSync } = require('@babel/core') as typeof import('@babel/core');
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { Script } = require('node:vm') as typeof import('node:vm');
  const filename = path.resolve(__dirname, '../../lib/allo/AlloRoot.tsx');
  const preset = path.dirname(require.resolve('babel-preset-expo'));
  const compiler = require(require.resolve('babel-plugin-react-compiler', { paths: [preset] }));
  const code = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [
      [compiler, { target: '19' }],
      [require('@babel/plugin-transform-typescript'), { isTSX: true, allExtensions: true }],
      [require('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      require('@babel/plugin-transform-modules-commonjs'),
    ],
  })?.code;
  if (!code || !/function AlloRoot\([^)]*\)\s*\{\s*const \$ =/.test(code)) {
    throw new Error('React Compiler did not compile AlloRoot');
  }
  const compiledModule = { exports: {} as { AlloRoot: typeof AlloRoot } };
  const load = (id: string) => require(id.startsWith('./') ? `@/lib/allo/${id.slice(2)}` : id);
  new Script(`(function(require, module, exports, setTimeout, clearTimeout) { ${code}\n})`, { filename }).runInThisContext()(
    load,
    compiledModule,
    compiledModule.exports,
    (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  );
  return compiledModule.exports.AlloRoot;
}

const CompiledAlloRoot = compiledAlloRoot();
let tree: TestRenderer.ReactTestRenderer;

beforeEach(() => {
  jest.useFakeTimers();
  mockClients.length = 0;
  mockLogout.mockClear();
  mockSupervisionReady = true;
  mockAccount = 'alice';
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  jest.useRealTimers();
  mockOxy.session.clear();
});
afterAll(() => mockOxy.dispose());

it('explains an unverifiable bearer after a delay and recovers when Alice is restored', async () => {
  mockOxy.session.setAccessToken('opaque-token');
  await act(async () => {
    tree = TestRenderer.create(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe('checking');
  await act(async () => {
    jest.advanceTimersByTime(4999);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe('checking');
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
  expect(mockClients).toHaveLength(0);
  expect(mockLogout).not.toHaveBeenCalled();
  await act(async () => {
    mockOxy.session.setAccessToken(token('alice'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(tree.root.findAllByProps({ testID: 'access-state' })).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('private content');
  expect(mockClients).toHaveLength(1);
  expect(mockLogout).not.toHaveBeenCalled();
});

it('cancels an old timer when the bearer changes and does not show stale warning after a refresh', async () => {
  mockOxy.session.setAccessToken(token('bob'));
  await act(async () => {
    tree = TestRenderer.create(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(4000);
    mockOxy.session.setAccessToken(token('alice'));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(5000);
    mockOxy.session.setAccessToken(token('alice'));
    await Promise.resolve();
  });
  expect(tree.root.findAllByProps({ testID: 'access-state' })).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('private content');
});

it('restarts the wait for a new mismatch, including before supervision resolves', async () => {
  mockSupervisionReady = false;
  mockOxy.session.setAccessToken(token('bob'));
  await act(async () => {
    tree = TestRenderer.create(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(4000);
    mockOxy.session.setAccessToken('opaque-token');
  });
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe('checking');
  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
  expect(mockClients).toHaveLength(0);
});

it('does not postpone the explanation when the same opaque bearer is notified again', async () => {
  mockOxy.session.setAccessToken('opaque-token');
  await act(async () => {
    tree = TestRenderer.create(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(4000);
    mockOxy.session.setAccessToken('opaque-token');
  });
  await act(async () => jest.advanceTimersByTime(1000));
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
});

it('the compiled root shows the explanation and recovers when a matching bearer arrives', async () => {
  mockOxy.session.setAccessToken('opaque-token');
  await act(async () => {
    tree = TestRenderer.create(
      <CompiledAlloRoot>
        <Text>private content</Text>
      </CompiledAlloRoot>,
    );
  });
  await act(async () => jest.advanceTimersByTime(5000));
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
  await act(async () => {
    mockOxy.session.setAccessToken(token('alice'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(tree.root.findAllByProps({ testID: 'access-state' })).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('private content');
});

it('starts a fresh wait when the visible account matches and then diverges again', async () => {
  mockOxy.session.setAccessToken(token('bob'));
  await act(async () => {
    tree = TestRenderer.create(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
  await act(async () => {
    mockAccount = 'bob';
    tree.update(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(tree.root.findAllByProps({ testID: 'access-state' })).toHaveLength(0);
  await act(async () => {
    mockAccount = 'alice';
    tree.update(
      <AlloRoot>
        <Text>private content</Text>
      </AlloRoot>,
    );
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe('checking');
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(tree.root.findByProps({ testID: 'access-state' }).props.children).toBe(
    'session-unverified',
  );
});
