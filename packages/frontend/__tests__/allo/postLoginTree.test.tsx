import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient, type MediaView } from '@allo/core';
import { AlloProvider, useConversation, useOwnInstances, useTimeline } from '@allo/react';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import type { MessageListItem } from '@oxy.so/bloom/message-bubble';

import { EnrollmentGate } from '@/lib/allo/EnrollmentGate';
import { RestoreHistoryPrompt } from '@/lib/allo/RestoreHistoryPrompt';
import { useMediaUri } from '@/lib/allo/useMediaUri';
import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { useChatContext } from '@/hooks/useChatContext';
import { useChatSummaries } from '@/hooks/useChatSummaries';
import { transcriptItems } from '@/lib/chat/model';

/**
 * THE POST-LOGIN TREE, the way `AlloRoot` composes it, against a REAL
 * `@allo/core` client over the in-memory fake server.
 *
 * `AlloRoot` mounts `<AlloProvider client>` the moment the client is BUILT and
 * only then awaits `client.start()`, so every hook in the tree renders at
 * least once against a client that has not opened its store yet. This test
 * does the same, in that order, and then lets the client start, create a DM
 * with a second device, receive a text and a picture with a thumbnail, and
 * draw a conversation view over it.
 *
 * What it asserts is only that React never reports a render loop: neither
 * the thrown "Maximum update depth exceeded" nor the logged "The result of
 * getSnapshot should be cached" that precedes it. Either is what production
 * sees as minified React error #185 after signing in.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

// The people layer asks Oxy through this singleton; the answer is a fixture.
const mockDirectory: Record<string, { id: string; username: string; name: { displayName: string }; avatar?: string }> = {
  'acc-tree-alice': { id: 'acc-tree-alice', username: 'alice', name: { displayName: 'Alice' }, avatar: 'file-alice' },
  'acc-tree-bob': { id: 'acc-tree-bob', username: 'bob', name: { displayName: 'Bob' } },
};
jest.mock('@oxy.so/core', () => ({
  oxyClient: {
    getUsersByIds: async (ids: string[]) => ids.map((id) => mockDirectory[id]).filter(Boolean),
  },
}));

jest.mock('@oxy.so/services', () => ({
  useOxy: () => ({
    user: { id: 'acc-tree-alice', username: 'alice', name: { displayName: 'Alice' } },
    oxyServices: { getFileDownloadUrl: (fileId: string, variant?: string) => `https://files.test/${fileId}/${variant ?? 'full'}` },
    isLoading: false,
    logout: jest.fn(),
  }),
}));

jest.mock('@/lib/allo/mediaSink', () => ({
  createMediaUri: (bytes: Uint8Array, mime: string, blobId: string) => ({ uri: `mem://${blobId}?${mime}&${bytes.length}`, release: () => undefined }),
}));

const { createFakeAlloServer, FakeSession, MemorySecrets, MemoryStorage, until } = testing;
type FakeServer = ReturnType<typeof createFakeAlloServer>;

function makeClient(server: FakeServer, accountId: string, name: string): AlloClient {
  return createAlloClient({
    baseUrl: server.baseUrl,
    appId: 'allo',
    platform: 'web',
    displayName: name,
    session: FakeSession.for(accountId),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
    keyPackageTarget: 4,
  });
}

/** The conversation list's data path: the summaries hook, the banner, and a row per conversation. */
function ConversationList() {
  const summaries = useChatSummaries();
  const { instances } = useOwnInstances();
  return (
    <View>
      <HistoryTransferBanner />
      <Text testID="device-count">{String(instances.length)}</Text>
      {summaries.map((chat) => (
        <View key={chat.id} testID={`row-${chat.id}`}>
          <Text testID={`row-name-${chat.id}`}>{chat.name}</Text>
          <Text testID={`row-preview-${chat.id}`}>{chat.preview?.text ?? chat.preview?.attachment?.label ?? ''}</Text>
        </View>
      ))}
    </View>
  );
}

/** The conversation screen's data path: the timeline projected into rows through the people layer, media through `useMediaUri`. */
function ConversationScreen({ conversationId }: { conversationId: string }) {
  const view = useConversation(conversationId);
  const { items, typing } = useTimeline(conversationId);
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const rows = React.useMemo(() => transcriptItems(items, ctx, { isGroup: false }), [items, ctx]);
  const sources = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  return (
    <View testID={`conversation-${conversationId}`}>
      <Text>{typing ? 'typing' : ''}</Text>
      {rows.map((row) => {
        const content = sources.get(row.id)?.content;
        return <MessageRow key={row.id} row={row} media={content?.kind === 'media' ? content.media : undefined} />;
      })}
    </View>
  );
}

function MessageRow({ row, media }: { row: MessageListItem; media?: MediaView }) {
  const thumb = useMediaUri(media?.thumbnail?.ref ?? media?.ref, media?.mime ?? 'application/octet-stream', media !== undefined);
  return (
    <View testID={`message-${row.id}`}>
      <Text testID={`sender-${row.id}`}>{row.senderId ?? ''}</Text>
      <Text testID={`text-${row.id}`}>{row.text ?? ''}</Text>
      <Text testID={`media-${row.id}`}>{thumb.uri}</Text>
    </View>
  );
}

function App({ client, openConversationId }: { client: AlloClient; openConversationId?: string }) {
  return (
    <BloomThemeProvider mode="light" fonts={false}>
      <AlloProvider client={client}>
        <EnrollmentGate>
          <ConversationList />
          {openConversationId ? <ConversationScreen conversationId={openConversationId} /> : null}
          <RestoreHistoryPrompt />
        </EnrollmentGate>
      </AlloProvider>
    </BloomThemeProvider>
  );
}

const LOOP_SIGNATURES = [/Maximum update depth/i, /getSnapshot should be cached/i, /infinite loop/i];
const isLoopReport = (value: unknown): boolean => LOOP_SIGNATURES.some((re) => re.test(String(value instanceof Error ? value.message : value)));

function text(renderer: TestRenderer.ReactTestRenderer, testID: string): string {
  const node = renderer.root.findAll((n) => n.props.testID === testID && n.type === Text)[0];
  if (!node) throw new Error(`no node with testID ${testID}`);
  return String(React.Children.toArray(node.props.children).join(''));
}

async function waitUntil(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
  await until(fn, timeoutMs, 15);
  await act(async () => {
    await Promise.resolve();
  });
}

// MLS group operations through the fake server take seconds under Babel-transformed jest.
jest.setTimeout(120_000);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

describe('the post-login tree', () => {
  const started: AlloClient[] = [];
  const reported: unknown[] = [];
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    reported.length = 0;
    consoleError = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reported.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  });
  afterEach(async () => {
    consoleError.mockRestore();
    for (const client of started.splice(0)) await client.stop();
  });

  it('never loops: mounted before start() like AlloRoot, then through enrollment, a DM, a text and a picture', async () => {
    const server = createFakeAlloServer();
    const alice = makeClient(server, 'acc-tree-alice', 'Alice web');
    started.push(alice);

    // 1. Mounted the way AlloRoot does it: the provider first, the client not yet started.
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    let thrown: unknown;
    try {
      act(() => {
        renderer = TestRenderer.create(<App client={alice} />);
      });
    } catch (error) {
      thrown = error;
    }
    expect({ thrown: thrown instanceof Error ? thrown.message : thrown, logged: reported.filter(isLoopReport) }).toEqual({ thrown: undefined, logged: [] });
    if (!renderer) throw new Error('did not mount');

    // 2. The client starts underneath the mounted tree.
    await act(async () => {
      await alice.start();
    });
    await waitUntil(() => alice.instance.state() === 'active');
    expect(text(renderer, 'device-count')).toBe('1');
    expect(reported.filter(isLoopReport)).toEqual([]);

    // 3. A DM with Bob, whose device joins the group; the row names him through the people layer.
    const bob = makeClient(server, 'acc-tree-bob', 'Bob iOS');
    started.push(bob);
    await bob.start();
    let conversationId = '';
    await act(async () => {
      const conversation = await alice.conversations.createDirect('acc-tree-bob');
      conversationId = conversation.id;
    });
    await waitUntil(() => bob.conversations.get(conversationId)?.joined === true);
    await waitUntil(() => renderer!.root.findAll((n) => n.props.testID === `row-name-${conversationId}` && n.type === Text).length > 0);
    await waitUntil(() => text(renderer!, `row-name-${conversationId}`) === 'Bob', 10_000);
    expect(reported.filter(isLoopReport)).toEqual([]);

    // 4. The conversation view opens on it; Bob sends a text and a picture with a thumbnail.
    act(() => {
      renderer!.update(<App client={alice} openConversationId={conversationId} />);
    });
    await act(async () => {
      await bob.messages.send(conversationId, 'hello from bob');
      await bob.sync.flush();
    });
    await act(async () => {
      await bob.media.upload(conversationId, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        kind: 'image',
        mime: 'image/png',
        filename: 'pic.png',
        width: 4,
        height: 2,
        thumbnail: { bytes: new Uint8Array([9, 9, 9]), mime: 'image/jpeg', width: 2, height: 1 },
      });
      await bob.sync.flush();
    });
    await act(async () => {
      await alice.sync.now();
    });
    await waitUntil(() => alice.messages.timeline(conversationId).length >= 2, 20_000);
    await waitUntil(() => renderer!.root.findAll((n) => n.props.testID?.startsWith('media-') && n.type === Text && String(React.Children.toArray(n.props.children).join('')).startsWith('mem://')).length > 0, 20_000);

    const messageTexts = renderer.root.findAll((n) => n.props.testID?.startsWith('text-') && n.type === Text).map((n) => String(React.Children.toArray(n.props.children).join('')));
    expect(messageTexts).toContain('hello from bob');
    const senders = renderer.root.findAll((n) => n.props.testID?.startsWith('sender-') && n.type === Text).map((n) => String(React.Children.toArray(n.props.children).join('')));
    expect(senders).toContain('acc-tree-bob');
    expect(text(renderer, `row-preview-${conversationId}`)).not.toBe('');
    expect(reported.filter(isLoopReport)).toEqual([]);

    // 5. Signing out resets the client under the tree, as AlloRoot's sign-out path does.
    await act(async () => {
      await alice.reset();
    });
    expect(reported.filter(isLoopReport)).toEqual([]);
  });
});
