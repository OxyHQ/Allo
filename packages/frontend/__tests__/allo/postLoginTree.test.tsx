import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient } from '@allo/core';
import { AlloProvider, useOwnInstances, useTimeline } from '@allo/react';

import { EnrollmentGate } from '@/lib/allo/EnrollmentGate';
import { RestoreHistoryPrompt } from '@/lib/allo/RestoreHistoryPrompt';
import { useMediaUri } from '@/lib/allo/useMediaUri';
import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { useChatConversations } from '@/hooks/useChatConversations';
import { usePerson } from '@/hooks/usePerson';
import { messagesFromItems, type Conversation, type Message } from '@/lib/chat/model';
import { useConversationAvatar, useConversationDisplayName } from '@/utils/conversationUtils';

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

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    colors: {
      background: '#fff',
      backgroundSecondary: '#eee',
      card: '#fff',
      text: '#000',
      textSecondary: '#444',
      textTertiary: '#888',
      primary: '#0a0',
      border: '#ccc',
      error: '#c00',
      shadow: '#000',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
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

/** The conversation list's data path: the list hook, the banner, and a row per conversation drawn through the people layer. */
function ConversationList({ currentUserId, onOpen }: { currentUserId: string; onOpen?: (conversation: Conversation) => void }) {
  const conversations = useChatConversations();
  const { instances } = useOwnInstances();
  return (
    <View>
      <HistoryTransferBanner />
      <Text testID="device-count">{String(instances.length)}</Text>
      {conversations.map((conversation) => (
        <ConversationRow key={conversation.id} conversation={conversation} currentUserId={currentUserId} onOpen={onOpen} />
      ))}
    </View>
  );
}

function ConversationRow({ conversation, currentUserId, onOpen }: { conversation: Conversation; currentUserId: string; onOpen?: (conversation: Conversation) => void }) {
  const name = useConversationDisplayName(conversation, currentUserId);
  const avatar = useConversationAvatar(conversation, currentUserId);
  React.useEffect(() => {
    onOpen?.(conversation);
  }, [conversation, onOpen]);
  return (
    <View testID={`row-${conversation.id}`}>
      <Text testID={`row-name-${conversation.id}`}>{name}</Text>
      <Text testID={`row-avatar-${conversation.id}`}>{avatar ?? ''}</Text>
      <Text testID={`row-preview-${conversation.id}`}>{conversation.lastMessage}</Text>
    </View>
  );
}

/** The conversation view's data path: the timeline projected into messages, each sender drawn through the people layer, media through `useMediaUri`. */
function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { items, typing } = useTimeline(conversationId);
  const messages = React.useMemo(() => messagesFromItems(items), [items]);
  return (
    <View testID={`conversation-${conversationId}`}>
      <Text>{typing ? 'typing' : ''}</Text>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </View>
  );
}

function MessageRow({ message }: { message: Message }) {
  const sender = usePerson(message.senderId);
  const media = message.media?.[0];
  const thumb = useMediaUri(media?.thumbnailRef ?? media?.ref, media?.mime ?? 'application/octet-stream', media !== undefined);
  return (
    <View testID={`message-${message.id}`}>
      <Text testID={`sender-${message.id}`}>{sender?.displayName ?? ''}</Text>
      <Text testID={`text-${message.id}`}>{message.text}</Text>
      <Text testID={`media-${message.id}`}>{thumb.uri}</Text>
    </View>
  );
}

function App({ client, currentUserId, openConversationId }: { client: AlloClient; currentUserId: string; openConversationId?: string }) {
  return (
    <AlloProvider client={client}>
      <EnrollmentGate>
        <ConversationList currentUserId={currentUserId} />
        {openConversationId ? <ConversationScreen conversationId={openConversationId} /> : null}
        <RestoreHistoryPrompt />
      </EnrollmentGate>
    </AlloProvider>
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
        renderer = TestRenderer.create(<App client={alice} currentUserId="acc-tree-alice" />);
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
      renderer!.update(<App client={alice} currentUserId="acc-tree-alice" openConversationId={conversationId} />);
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
    expect(senders).toContain('Bob');
    expect(text(renderer, `row-preview-${conversationId}`)).not.toBe('');
    expect(reported.filter(isLoopReport)).toEqual([]);

    // 5. Signing out resets the client under the tree, as AlloRoot's sign-out path does.
    await act(async () => {
      await alice.reset();
    });
    expect(reported.filter(isLoopReport)).toEqual([]);
  });
});
