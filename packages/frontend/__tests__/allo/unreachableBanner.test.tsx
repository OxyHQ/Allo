import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient } from '@allo/core';
import { AlloProvider, useTimeline } from '@allo/react';

import { UnreachableMembersBanner } from '@/components/conversation/UnreachableMembersBanner';
import { MessageBubble } from '@/components/messages/MessageBubble';
import { useConversation } from '@/hooks/useConversation';
import { useUnreachableMembers } from '@/hooks/useUnreachableMembers';
import { messagesFromItems } from '@/lib/chat/model';

/**
 * CHATTING WITH SOMEBODY WHO HAS NOT INSTALLED ALLO, drawn over a REAL
 * `@allo/core` client and the in-memory fake server.
 *
 * Alice opens a DM with Bob, whom the server has never seen. The SDK creates
 * it anyway, names Bob in `unreachableMemberAccountIds`, and holds what Alice
 * sends with `holdReason` until Bob's first device is added. This mounts the
 * pieces `ConversationView` composes for that — the banner above the
 * composer, and a bubble whose clock carries the hold as its accessible name
 * — the way `postLoginTree.test.tsx` mounts the list, and checks the words on
 * screen at both ends: Bob's name and never his id while he is unreachable,
 * and nothing at all once his device joins and the echo is released.
 *
 * `ConversationView` itself is not mounted: it pulls in FlashList, Reanimated,
 * the router and the bottom sheet, none of which this asserts anything about.
 * What it does assert is the same data path that component draws from.
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
      info: '#00a',
      border: '#ccc',
      error: '#c00',
      shadow: '#000',
      messageBubbleSent: '#dfd',
      messageBubbleReceived: '#fff',
      messageBubbleSentText: '#000',
      messageBubbleReceivedText: '#000',
    },
  }),
}));

// The bubble reads the text-size preference from the app's store index, which
// drags in `zustand/middleware/immer` — ESM that jest does not transform. The
// bubble needs one number from it.
jest.mock('@/stores', () => ({
  useMessagePreferencesStore: (selector: (state: { messageTextSize: number }) => unknown) => selector({ messageTextSize: 16 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  }),
}));

const ALICE = 'acc-reach-alice';
const BOB = 'acc-reach-bob';

// The people layer asks Oxy through this singleton; Bob is an Oxy user whether or not he has Allo.
const mockDirectory: Record<string, { id: string; username: string; name: { displayName: string } }> = {
  [ALICE]: { id: ALICE, username: 'alice', name: { displayName: 'Alice' } },
  [BOB]: { id: BOB, username: 'bob', name: { displayName: 'Bob Example' } },
};
jest.mock('@oxy.so/core', () => ({
  oxyClient: {
    getUsersByIds: async (ids: string[]) => ids.map((id) => mockDirectory[id]).filter(Boolean),
  },
}));

jest.mock('@oxy.so/services', () => ({
  useOxy: () => ({
    user: { id: 'acc-reach-alice', username: 'alice', name: { displayName: 'Alice' } },
    oxyServices: { getFileDownloadUrl: (fileId: string, variant?: string) => `https://files.test/${fileId}/${variant ?? 'full'}` },
    isLoading: false,
    logout: jest.fn(),
  }),
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

/** The composer's surroundings and the timeline, as `ConversationView` draws them. */
function Screen({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);
  const { hold } = useUnreachableMembers(conversation);
  const { items } = useTimeline(conversationId);
  const messages = React.useMemo(() => messagesFromItems(items), [items]);
  return (
    <View>
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          id={message.id}
          text={message.text}
          timestamp={message.timestamp}
          isSent={message.isSent}
          showSenderName={false}
          showTimestamp
          messageType="user"
          readStatus={message.readStatus}
          holdReason={message.holdReason}
          holdLabel={hold ?? undefined}
        />
      ))}
      <UnreachableMembersBanner conversation={conversation} />
    </View>
  );
}

function App({ client, conversationId }: { client: AlloClient; conversationId: string }) {
  return (
    <AlloProvider client={client}>
      <Screen conversationId={conversationId} />
    </AlloProvider>
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map((node) => String(React.Children.toArray(node.props.children).join('')))
    .join(' | ');
}

function bannerText(renderer: TestRenderer.ReactTestRenderer): string | null {
  const banner = renderer.root.findAll((n) => n.props.testID === 'unreachable-members-banner' && n.type === View)[0];
  if (!banner) return null;
  return banner.findAllByType(Text).map((node) => String(React.Children.toArray(node.props.children).join(''))).join('');
}

function heldLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAll((n) => n.props.testID === 'message-status-held' && n.type === View).map((n) => String(n.props.accessibilityLabel));
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

const LOOP_SIGNATURES = [/Maximum update depth/i, /getSnapshot should be cached/i, /infinite loop/i];
const isLoopReport = (value: unknown): boolean => LOOP_SIGNATURES.some((re) => re.test(String(value instanceof Error ? value.message : value)));

describe('a conversation with somebody who has not set up Allo', () => {
  const started: AlloClient[] = [];
  const reported: unknown[] = [];
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    reported.length = 0;
    // The SDK emits outside act() on purpose (the environment says so above);
    // what matters is that nothing it emits sends React into a loop.
    consoleError = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reported.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  });
  afterEach(async () => {
    consoleError.mockRestore();
    for (const client of started.splice(0)) await client.stop();
  });

  it('shows the banner and labels the held echo while Bob has no device, and clears both once his device joins', async () => {
    const server = createFakeAlloServer();
    const alice = makeClient(server, ALICE, 'Alice web');
    started.push(alice);
    await alice.start();
    await waitUntil(() => alice.instance.state() === 'active');

    // Bob has never registered: the create still succeeds and names him as unreachable.
    expect(server.instancesOf(BOB)).toHaveLength(0);
    const conversation = await alice.conversations.createDirect(BOB);
    expect(conversation.unreachableMemberAccountIds).toEqual([BOB]);

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(<App client={alice} conversationId={conversation.id} />);
    });
    if (!renderer) throw new Error('did not mount');

    // The banner names Bob through the people layer, and never by id.
    await waitUntil(() => bannerText(renderer!) === "Bob Example hasn't set up Allo yet. Your messages will be delivered when they join.", 10_000);
    expect(allText(renderer)).not.toContain(BOB);

    // A text sent now is a held echo: pending, and its clock says who it waits for.
    await act(async () => {
      await alice.messages.send(conversation.id, 'hello before you arrive');
      await alice.sync.flush();
    });
    await waitUntil(() => heldLabels(renderer!).length === 1, 10_000);
    expect(heldLabels(renderer)).toEqual(['Waiting for Bob Example to join']);
    expect(alice.messages.timeline(conversation.id).map((i) => [i.sendState, i.holdReason])).toEqual([['pending', 'no_reachable_member']]);
    expect(allText(renderer)).toContain('hello before you arrive');
    expect(allText(renderer)).not.toContain(BOB);

    // Bob installs Allo. The server nudges Alice's leaf, her elector adds his device, the hold lifts.
    const bob = makeClient(server, BOB, 'Bob iOS');
    started.push(bob);
    await act(async () => {
      await bob.start();
    });
    await waitUntil(() => bob.conversations.get(conversation.id)?.joined === true, 30_000);
    await waitUntil(() => alice.conversations.get(conversation.id)?.unreachableMemberAccountIds.length === 0, 30_000);
    await waitUntil(() => alice.messages.timeline(conversation.id).every((i) => i.sendState !== 'pending' && i.holdReason === undefined), 30_000);
    await waitUntil(() => bannerText(renderer!) === null && heldLabels(renderer!).length === 0, 10_000);

    expect(bannerText(renderer)).toBeNull();
    expect(heldLabels(renderer)).toEqual([]);
    expect(allText(renderer)).toContain('hello before you arrive');
    // and Bob got it
    await waitUntil(() => bob.messages.timeline(conversation.id).some((i) => i.content.kind === 'text' && i.content.body === 'hello before you arrive'), 30_000);
    expect(reported.filter(isLoopReport)).toEqual([]);
  });
});
