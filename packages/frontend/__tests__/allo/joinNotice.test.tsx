import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { useTranslation } from 'react-i18next';
import { createAlloClient, testing, type AlloClient } from '@allo/core';
import { AlloProvider, useConversation, useTimeline } from '@allo/react';

import { useChatContext } from '@/hooks/useChatContext';
import { composerNotice, transcriptItems } from '@/lib/chat/model';

/**
 * WHAT A DEVICE THAT HOLDS NO LEAF YET READS IN PLACE OF THE COMPOSER, drawn
 * over a REAL `@allo/core` client and the in-memory fake server.
 *
 * Bob's second device is approved while Bob's first device and Alice are both
 * switched off. Nobody can add it, and nobody has to: the SDK fetches the
 * GroupInfo the last committer stored and joins by external commit
 * (`crypto.md` section 5). The screen says "Joining the conversation…" with a
 * spinner for exactly as long as that takes, then draws the messages. The GET
 * on `group-info` is held behind a gate here so the joining state is on screen
 * for certain before the join lands, rather than by luck of timing.
 *
 * With `server.keepGroupInfo = false` — every conversation behaves as one whose
 * commits predate the field — the same device reads instead that it is being
 * added and that another device has to be online for that, and the elector's
 * Add is what clears it.
 *
 * The third case is the join that must NOT work. Somebody with Bob's Oxy
 * session gets a second unapproved "root" instance onto his account (here: a
 * real client whose pending instance the fake server is made to list as
 * active with no approver) and it joins itself from the GroupInfo, which the
 * server accepts. Alice's device refuses the commit, the conversation reports
 * `integrity: 'refused_commit'`, and her screen says it cannot continue
 * securely, with the composer replaced by that and nothing else — no retry, no
 * dismiss. What she had already typed stays held, labelled as waiting for the
 * conversation to catch up, and never reaches the server.
 *
 * `ConversationScreen` itself is not mounted (FlashList, Reanimated and the
 * router); the data path it draws from is.
 */

jest.mock('react-i18next', () => {
  const en: Record<string, string> = jest.requireActual('@/locales/en.json');
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        (en[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
      i18n: { language: 'en-US' },
    }),
  };
});

const ALICE = 'acc-join-alice';
const BOB = 'acc-join-bob';

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
    user: { id: 'acc-join-bob', username: 'bob', name: { displayName: 'Bob Example' } },
    oxyServices: { getFileDownloadUrl: (fileId: string, variant?: string) => `https://files.test/${fileId}/${variant ?? 'full'}` },
    isLoading: false,
    logout: jest.fn(),
  }),
}));

const { createFakeAlloServer, FakeSession, MemorySecrets, MemoryStorage, until } = testing;
type FakeServer = ReturnType<typeof createFakeAlloServer>;
type Persisted = { storage: InstanceType<typeof MemoryStorage>; secrets: InstanceType<typeof MemorySecrets> };

/** A promise somebody else resolves. */
function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

function makeClient(
  server: FakeServer,
  accountId: string,
  name: string,
  platform: 'web' | 'ios' | 'desktop' = 'web',
  persisted: Persisted = { storage: new MemoryStorage(), secrets: new MemorySecrets() },
  /** Runs before a request goes out; the group-info gate above. */
  before?: (method: string, url: string) => Promise<void>,
): { client: AlloClient } & Persisted {
  const fetch: typeof server.fetch = async (url, init) => {
    if (before) await before(String(init?.method ?? 'GET').toUpperCase(), String(url));
    return server.fetch(url, init);
  };
  const client = createAlloClient({
    baseUrl: server.baseUrl,
    appId: 'allo',
    platform,
    displayName: name,
    session: FakeSession.for(accountId),
    storage: persisted.storage,
    secrets: persisted.secrets,
    transport: { fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
    keyPackageTarget: 4,
  });
  return { client, ...persisted };
}

/** The composer's notice and the transcript, as `ConversationScreen` projects them. */
function Screen({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const view = useConversation(conversationId);
  const { items } = useTimeline(conversationId);
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const notice = view ? composerNotice(view, t) : null;
  const rows = React.useMemo(
    () => transcriptItems(items, ctx, { isGroup: false, stalledLabel: t('chat.hold.stalled') }),
    [items, ctx, t],
  );
  return (
    <View>
      {rows.map((row) => (
        <View key={row.id}>
          <Text>{row.text ?? ''}</Text>
          {row.labels?.pending ? <View testID="message-status-held" accessibilityLabel={row.labels.pending} /> : null}
        </View>
      ))}
      {notice ? (
        <View testID="composer-notice" accessibilityState={{ busy: notice.busy }} accessibilityRole={notice.error ? 'alert' : undefined}>
          <Text>{notice.text}</Text>
        </View>
      ) : null}
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

function notice(renderer: TestRenderer.ReactTestRenderer): { text: string; busy: boolean; error: boolean } | null {
  const node = renderer.root.findAll((n) => n.props.testID === 'composer-notice' && n.type === View)[0];
  if (!node) return null;
  return {
    text: node.findAllByType(Text).map((n) => String(React.Children.toArray(n.props.children).join(''))).join(''),
    busy: node.props.accessibilityState?.busy === true,
    error: node.props.accessibilityRole === 'alert',
  };
}

function heldLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAll((n) => n.props.testID === 'message-status-held' && n.type === View).map((n) => String(n.props.accessibilityLabel));
}

function mount(client: AlloClient, conversationId: string): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<App client={client} conversationId={conversationId} />);
  });
  if (!renderer) throw new Error('did not mount');
  return renderer;
}

async function waitUntil(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
  await until(fn, timeoutMs, 15);
  await act(async () => {
    await Promise.resolve();
  });
}

const commitsBy = (server: FakeServer, conversationId: string, instanceId: string | null | undefined) =>
  server.eventsOf(conversationId).filter((e) => e.kind === 'mls_commit' && e.senderInstanceId === instanceId);

const JOINING = 'Joining the conversation…';
const WAITING = 'This device is still being added to the conversation. Another device in the conversation has to be online.';
const REFUSED = 'This conversation cannot continue securely: a device that could not be verified was added.';
const STALLED = 'Waiting for the conversation to catch up';

// MLS group operations through the fake server take seconds under Babel-transformed jest.
jest.setTimeout(180_000);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const LOOP_SIGNATURES = [/Maximum update depth/i, /getSnapshot should be cached/i, /infinite loop/i];
const isLoopReport = (value: unknown): boolean => LOOP_SIGNATURES.some((re) => re.test(String(value instanceof Error ? value.message : value)));

describe('a device that holds no leaf in the conversation yet', () => {
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

  it('says it is joining, with a spinner, while it joins by itself with every other device off, then draws the messages', async () => {
    const server = createFakeAlloServer();
    const alice = makeClient(server, ALICE, 'Alice web', 'web');
    const bobIos = makeClient(server, BOB, 'Bob iOS', 'ios');
    started.push(alice.client, bobIos.client);
    await alice.client.start();
    await bobIos.client.start();
    await waitUntil(() => alice.client.instance.state() === 'active' && bobIos.client.instance.state() === 'active');
    const conversation = await alice.client.conversations.createDirect(BOB);
    await waitUntil(() => bobIos.client.conversations.get(conversation.id)?.joined === true);

    // Bob's desktop is approved by his phone; then the phone and Alice both go away.
    const groupInfoGate = gate();
    const bobDesktop = makeClient(server, BOB, 'Bob desktop', 'desktop', undefined, async (method, url) => {
      if (method === 'GET' && url.endsWith('/group-info')) await groupInfoGate.wait;
    });
    started.push(bobDesktop.client);
    await bobDesktop.client.start();
    expect(bobDesktop.client.instance.state()).toBe('pending-approval');
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await bobIos.client.stop();
    await alice.client.stop();

    // `refresh()` awaits the sync that activation starts, and that sync's reconcile is
    // what the gate below holds; so it is awaited only once the gate is open.
    const refreshed = bobDesktop.client.instance.refresh();
    await waitUntil(() => bobDesktop.client.instance.state() === 'active');
    const renderer = mount(bobDesktop.client, conversation.id);

    // The conversation is listed for the desktop before it holds a leaf: joining, nobody needed.
    await waitUntil(() => notice(renderer)?.text === JOINING, 30_000);
    expect(notice(renderer)).toEqual({ text: JOINING, busy: true, error: false });
    expect(bobDesktop.client.conversations.get(conversation.id)?.joinState).toBe('joining');
    expect(commitsBy(server, conversation.id, bobDesktop.client.instanceId)).toHaveLength(0);

    groupInfoGate.open();
    await refreshed;
    await waitUntil(() => bobDesktop.client.conversations.get(conversation.id)?.joined === true, 60_000);
    await waitUntil(() => notice(renderer) === null, 10_000);
    expect(bobDesktop.client.conversations.get(conversation.id)?.joinState).toBe('joined');
    // one external commit by the desktop itself; the phone, being off, added nothing
    expect(commitsBy(server, conversation.id, bobDesktop.client.instanceId)).toHaveLength(1);
    expect(commitsBy(server, conversation.id, bobIos.client.instanceId)).toHaveLength(0);

    // Alice comes back, processes the desktop's commit, and the two read each other.
    const alice2 = makeClient(server, ALICE, 'Alice web', 'web', { storage: alice.storage, secrets: alice.secrets });
    started.push(alice2.client);
    await alice2.client.start();
    await waitUntil(() => alice2.client.conversations.get(conversation.id)?.epoch === bobDesktop.client.conversations.get(conversation.id)?.epoch, 30_000);
    await act(async () => {
      await alice2.client.messages.send(conversation.id, 'hello desktop');
      await alice2.client.sync.flush();
    });
    await waitUntil(() => allText(renderer).includes('hello desktop'), 30_000);
    await act(async () => {
      await bobDesktop.client.messages.send(conversation.id, 'hello from the desktop');
      await bobDesktop.client.sync.flush();
    });
    await waitUntil(() => allText(renderer).includes('hello from the desktop'), 30_000);
    await waitUntil(
      () => alice2.client.messages.timeline(conversation.id).some((i) => i.content.kind === 'text' && i.content.body === 'hello from the desktop'),
      30_000,
    );
    expect(notice(renderer)).toBeNull();
    expect(reported.filter(isLoopReport)).toEqual([]);
  });

  it('says it is being added, and that another device has to be online, when the server holds no GroupInfo', async () => {
    const server = createFakeAlloServer();
    server.keepGroupInfo = false; // every conversation as if its commits predated the field
    const alice = makeClient(server, ALICE, 'Alice web', 'web');
    started.push(alice.client);
    await alice.client.start();
    await waitUntil(() => alice.client.instance.state() === 'active');
    const conversation = await alice.client.conversations.createDirect(BOB);
    expect(conversation.unreachableMemberAccountIds).toEqual([BOB]);
    expect(server.groupInfos.size).toBe(0);

    const bob = makeClient(server, BOB, 'Bob iOS', 'ios');
    started.push(bob.client);
    await bob.client.start();
    const renderer = mount(bob.client, conversation.id);

    // Bob asked for the GroupInfo, found none, and says what has to happen instead.
    await waitUntil(() => notice(renderer)?.text === WAITING, 30_000);
    expect(notice(renderer)).toEqual({ text: WAITING, busy: false, error: false });
    expect(bob.client.conversations.get(conversation.id)?.joinState).toBe('waiting_for_member');

    // Alice is online: the server nudged her, her elector adds him, and the notice goes.
    await waitUntil(() => bob.client.conversations.get(conversation.id)?.joined === true, 60_000);
    await waitUntil(() => notice(renderer) === null, 10_000);
    expect(commitsBy(server, conversation.id, alice.client.instanceId)).toHaveLength(1);
    expect(commitsBy(server, conversation.id, bob.client.instanceId)).toHaveLength(0);
    await act(async () => {
      await alice.client.messages.send(conversation.id, 'welcome aboard');
      await alice.client.sync.flush();
    });
    await waitUntil(() => allText(renderer).includes('welcome aboard'), 30_000);
    expect(reported.filter(isLoopReport)).toEqual([]);
  });

  it('says the conversation cannot continue securely, and holds what was typed, once a joiner this device could not verify was let in by the server', async () => {
    const server = createFakeAlloServer();
    const alice = makeClient(server, ALICE, 'Alice web', 'web');
    const bob = makeClient(server, BOB, 'Bob iOS', 'ios');
    started.push(alice.client, bob.client);
    await alice.client.start();
    await bob.client.start();
    await waitUntil(() => alice.client.instance.state() === 'active' && bob.client.instance.state() === 'active');
    const conversation = await alice.client.conversations.createDirect(BOB);
    await waitUntil(() => bob.client.conversations.get(conversation.id)?.joined === true);
    const renderer = mount(alice.client, conversation.id);
    await act(async () => {
      await alice.client.messages.send(conversation.id, 'before the forgery');
      await alice.client.sync.flush();
    });
    await waitUntil(() => allText(renderer).includes('before the forgery'));
    expect(notice(renderer)).toBeNull();
    const epochBefore = alice.client.conversations.get(conversation.id)!.epoch;

    // Somebody with Bob's Oxy session enrolls a device nobody approves, and the server lists it
    // active anyway — a second unapproved root, which every verified chain refuses.
    const rogue = makeClient(server, BOB, 'Bob ???', 'desktop');
    started.push(rogue.client);
    await rogue.client.start();
    expect(rogue.client.instance.state()).toBe('pending-approval');
    const planted = server.instances.get(rogue.client.instanceId!)!;
    planted.status = 'active';
    planted.approvedByInstanceId = null;
    planted.approvalSignature = null;
    // The server admits its self-join: a joined member row is all it can check.
    await rogue.client.instance.refresh();
    await waitUntil(() => rogue.client.instance.state() === 'active');
    await waitUntil(() => commitsBy(server, conversation.id, rogue.client.instanceId).length === 1, 60_000);
    expect(server.conversations.get(conversation.id)!.epoch).toBe(epochBefore + 1);

    // Alice's device refuses it, and says so in place of the composer: a failure, not a wait.
    await waitUntil(() => alice.client.conversations.get(conversation.id)?.integrity === 'refused_commit', 30_000);
    await waitUntil(() => notice(renderer)?.text === REFUSED, 10_000);
    expect(notice(renderer)).toEqual({ text: REFUSED, busy: false, error: true });
    const view = alice.client.conversations.get(conversation.id)!;
    expect(view.epoch).toBe(epochBefore);
    expect(view.refusedEpoch).toBe(epochBefore);
    expect(view.joined).toBe(true); // joined, and still fail closed: the notice wins over the join state
    expect(allText(renderer)).toContain('before the forgery');

    // What she sends now is held as stalled after the epoch conflicts stop moving her epoch, and never lands.
    const posts = () => server.requestLog.filter((r) => r.method === 'POST' && r.path === `/v1/conversations/${conversation.id}/events` && r.instanceId === alice.client.instanceId);
    const before = posts().length;
    await act(async () => {
      await alice.client.messages.send(conversation.id, 'after the forgery');
    });
    await waitUntil(() => heldLabels(renderer).includes(STALLED), 60_000);
    expect(heldLabels(renderer)).toEqual([STALLED]);
    expect(allText(renderer)).toContain('after the forgery');
    expect(posts().slice(before).every((r) => r.status === 409)).toBe(true);
    expect(server.eventsOf(conversation.id).filter((e) => e.kind === 'app_message' && e.senderInstanceId === alice.client.instanceId)).toHaveLength(1); // the first one only
    expect(notice(renderer)).toEqual({ text: REFUSED, busy: false, error: true });
    expect(reported.filter(isLoopReport)).toEqual([]);
  });
});
