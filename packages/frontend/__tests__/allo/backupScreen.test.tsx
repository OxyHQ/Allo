import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient, type TimelineItemView } from '@allo/core';
import { AlloProvider } from '@allo/react';

import { BackupPanel } from '@/components/backup/BackupPanel';

/**
 * The backup panel, against a REAL `@allo/core` client over the in-memory
 * fake server — the same harness as `enrollmentGate.test.tsx` — so what it
 * draws is what the SDK actually does:
 *
 *  - "Turn on" shows the 12 words once, and the words are the phrase the SDK
 *    minted; "Done" is refused until "I wrote them down" is ticked, and the
 *    words are gone once it is. The phrase is nowhere in the client's storage.
 *  - A fresh device of the same account (every other device lost) is offered a
 *    restore because the server holds a backup; a wrong phrase draws the
 *    friendly message and downloads nothing; the right phrase fills the
 *    conversation and the timeline, and the panel then reads "Backup is on".
 *
 * Bloom's components, the confirm dialog, the theme hook and the translations
 * are replaced with the plainest thing that renders: the panel reads colours
 * and strings from them, and presses and types through them, and nothing else.
 */

jest.mock('@oxy.so/bloom/theme', () => ({
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
      success: '#080',
    },
  }),
}));

/** The English bundle, interpolated: what a person reading English sees. */
jest.mock('react-i18next', () => {
  const en = jest.requireActual<Record<string, string>>('@/locales/en.json');
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        (en[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
    }),
  };
});

jest.mock('@oxy.so/bloom/typography', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return { Text: ReactNative.Text, Muted: ReactNative.Text };
});

jest.mock('@oxy.so/bloom/settings-list', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const text = (value?: string) => (value ? ReactModule.createElement(ReactNative.Text, null, value) : null);
  return {
    SettingsListGroup: ({ title, children }: { title?: string; children: React.ReactNode }) =>
      ReactModule.createElement(ReactNative.View, null, text(title), children),
    SettingsListItem: ({ title, description, value }: { title: string; description?: string; value?: string }) =>
      ReactModule.createElement(ReactNative.View, null, text(title), text(description), text(value)),
  };
});

jest.mock('@oxy.so/bloom/button', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ children, onPress, disabled }: { children?: React.ReactNode; onPress?: () => void; disabled?: boolean }) =>
      ReactModule.createElement(ReactNative.Pressable, { onPress, disabled }, ReactModule.createElement(ReactNative.Text, null, children)),
  };
});

jest.mock('@oxy.so/bloom/textarea', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    Textarea: (props: import('react-native').TextInputProps) => ReactModule.createElement(ReactNative.TextInput, props),
  };
});

jest.mock('@oxy.so/bloom/icons', () => {
  const none = () => null;
  return {
    RiCheckboxBlankCircleLine: none,
    RiCheckboxCircleFill: none,
    RiFileCopyLine: none,
    RiShieldCheckLine: none,
    RiShieldLine: none,
  };
});

const mockToasts: string[] = [];
jest.mock('@oxy.so/bloom/toast', () => ({
  toast: {
    success: (message: string) => mockToasts.push(`success:${message}`),
    error: (message: string) => mockToasts.push(`error:${message}`),
  },
}));

// This suite needs BOTH answers, so it doubles Bloom's surfaces itself rather
// than taking the always-confirm stand-in the runner maps in.
let mockConfirmAnswer = true;
jest.mock('@oxy.so/bloom/surfaces', () => ({
  confirm: async () => mockConfirmAnswer,
  alert: () => undefined,
}));

const { createFakeAlloServer, FakeSession, MemorySecrets, MemoryStorage, until } = testing;
type FakeServer = ReturnType<typeof createFakeAlloServer>;

interface TestClient {
  client: AlloClient;
  storage: InstanceType<typeof MemoryStorage>;
}

async function makeClient(server: FakeServer, accountId: string, name: string, platform: 'ios' | 'web' = 'ios'): Promise<TestClient> {
  const storage = new MemoryStorage();
  const client = createAlloClient({
    baseUrl: server.baseUrl,
    appId: 'allo',
    platform,
    displayName: name,
    session: FakeSession.for(accountId),
    storage,
    secrets: new MemorySecrets(),
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
    keyPackageTarget: 4,
  });
  await client.start();
  return { client, storage };
}

function mount(client: AlloClient, onPhrasePending?: (pending: boolean) => void) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <AlloProvider client={client}>
        <BackupPanel onPhrasePending={onPhrasePending} />
      </AlloProvider>,
    );
  });
  if (!renderer) throw new Error('did not mount');
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(React.Children.toArray(node.props.children).join('')));
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string): TestRenderer.ReactTestInstance | undefined {
  return renderer.root.findAll((node) => node.props.testID === testID && typeof node.type !== 'string')[0];
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = byTestId(renderer, testID);
  if (!node) throw new Error(`no node with testID ${testID}`);
  if (node.props.disabled) throw new Error(`${testID} is disabled`);
  await act(async () => {
    node.props.onPress();
  });
}

async function type(renderer: TestRenderer.ReactTestRenderer, testID: string, value: string): Promise<void> {
  const input = renderer.root.findAllByType(TextInput).find((node) => node.props.testID === testID);
  if (!input) throw new Error(`no input with testID ${testID}`);
  await act(async () => {
    input.props.onChangeText(value);
  });
}

function timelineTexts(items: TimelineItemView[]): string[] {
  return items.filter((i) => i.content.kind === 'text').map((i) => (i.content as { body: string }).body);
}

/** Polls OUTSIDE `act`, then flushes React inside one (see `enrollmentGate.test.tsx`). */
async function waitUntil(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
  await until(fn, timeoutMs, 15);
  await act(async () => {
    await Promise.resolve();
  });
}

// MLS group operations through the fake server take seconds under Babel-transformed jest.
jest.setTimeout(180_000);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

describe('BackupPanel', () => {
  const started: AlloClient[] = [];
  afterEach(async () => {
    for (const client of started.splice(0)) await client.stop();
    mockToasts.length = 0;
    mockConfirmAnswer = true;
  });

  it('turns the backup on, shows the phrase once behind a confirm gate, and a fresh device restores with it', async () => {
    const server = createFakeAlloServer();
    const alice = await makeClient(server, 'acc-backup-a', 'Alice web', 'web');
    const bob = await makeClient(server, 'acc-backup-b', 'Bob iOS');
    started.push(bob.client);
    const conv = await alice.client.conversations.createDirect('acc-backup-b');
    await until(() => bob.client.conversations.get(conv.id)?.joined === true, 20_000, 15);
    await alice.client.messages.send(conv.id, 'one');
    await bob.client.messages.send(conv.id, 'two');
    await until(() => timelineTexts(alice.client.messages.timeline(conv.id)).length === 2, 20_000, 15);
    await alice.client.conversations.rename(conv.id, 'A and B');

    // --- the first device: off, nothing on the server, "Turn on" ---
    const pending: boolean[] = [];
    const first = mount(alice.client, (value) => pending.push(value));
    expect(texts(first)).toContain('Backup is off');
    await waitUntil(() => alice.client.backup.status().remote !== null);
    expect(texts(first)).toContain('No backup on the server');
    expect(byTestId(first, 'backup-restore-section')).toBeUndefined();
    expect(byTestId(first, 'backup-phrase')).toBeUndefined();

    await press(first, 'backup-enable');
    await waitUntil(() => alice.client.backup.status().enabled);

    // The twelve words, numbered, and the SDK's own phrase.
    const words = Array.from({ length: 12 }, (_, i) => {
      const cell = first.root.findAll((node) => node.props.testID === `backup-word-${i + 1}` && node.type === Text)[0];
      return String(React.Children.toArray(cell.props.children).join(''));
    });
    const phrase = words.join(' ');
    expect(new Set(words).size).toBeGreaterThan(1);
    expect(words.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    expect(texts(first)).toContain('Backup is on');
    expect(texts(first)).toContain('A backup for this account is on the server');
    // The app holds the phrase in screen state only: it is nowhere in the client's storage.
    expect(new TextDecoder().decode(alice.storage.dump()).includes(phrase)).toBe(false);
    // Leaving is blocked while the words are on screen.
    expect(pending.at(-1)).toBe(true);

    // "Done" is refused until "I wrote them down" is ticked.
    expect(byTestId(first, 'backup-done')?.props.disabled).toBe(true);
    await expect(press(first, 'backup-done')).rejects.toThrow(/disabled/);
    expect(byTestId(first, 'backup-phrase')).toBeDefined();
    await press(first, 'backup-confirm');
    expect(byTestId(first, 'backup-done')?.props.disabled).toBe(false);
    await press(first, 'backup-done');
    expect(byTestId(first, 'backup-phrase')).toBeUndefined();
    expect(texts(first).join(' ')).not.toContain(words[0]);
    expect(pending.at(-1)).toBe(false);

    // The panel's "Back up now" is the SDK's refresh.
    await press(first, 'backup-refresh');
    await waitUntil(() => mockToasts.includes('success:Backed up'));
    expect(server.backups.get('acc-backup-a')?.instanceId).toBe(alice.client.instanceId);

    // --- every device lost: revoke and forget; a fresh install of the same account ---
    await alice.client.instance.revoke(alice.client.instanceId!);
    await alice.client.stop();
    first.unmount();
    const fresh = await makeClient(server, 'acc-backup-a', 'Alice new phone');
    started.push(fresh.client);
    expect(fresh.client.instance.state()).toBe('active');
    // The server lists the DM for the account, but the fresh device holds none of its content.
    expect(fresh.client.conversations.list().map((c) => c.id)).toEqual([conv.id]);
    expect(fresh.client.messages.timeline(conv.id)).toEqual([]);

    const second = mount(fresh.client);
    expect(texts(second)).toContain('Backup is off');
    // The restore section keys on the server's answer, never on the empty list.
    expect(byTestId(second, 'backup-restore-section')).toBeUndefined();
    await waitUntil(() => fresh.client.backup.status().remote?.exists === true);
    expect(byTestId(second, 'backup-restore-section')).toBeDefined();
    expect(byTestId(second, 'backup-restore')?.props.disabled).toBe(true);

    // A wrong phrase: the friendly message, nothing downloaded, nothing restored.
    server.requestLog.length = 0;
    const wrong = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await type(second, 'backup-restore-input', wrong);
    expect(texts(second)).toContain('12 of 12 words');
    await press(second, 'backup-restore');
    await waitUntil(() => byTestId(second, 'backup-restore-error') !== undefined);
    expect(texts(second)).toContain('That is not the recovery phrase for this backup. Check the words and their order.');
    expect(server.requestLog.some((r) => r.path.startsWith('/v1/blobs/'))).toBe(false);
    expect(fresh.client.messages.timeline(conv.id)).toEqual([]);

    // The right phrase, pasted with capitals and stray whitespace: the SDK normalises it.
    await type(second, 'backup-restore-input', `  ${phrase.toUpperCase().replace(/ /g, '\n  ')}  `);
    expect(byTestId(second, 'backup-restore-error')).toBeUndefined();
    await press(second, 'backup-restore');
    await waitUntil(() => timelineTexts(fresh.client.messages.timeline(conv.id)).length === 2, 30_000);
    expect(timelineTexts(fresh.client.messages.timeline(conv.id))).toEqual(['one', 'two']);
    expect(fresh.client.conversations.get(conv.id)?.title).toBe('A and B');
    await waitUntil(() => fresh.client.backup.status().enabled);
    expect(texts(second)).toContain('Backup is on');
    expect(byTestId(second, 'backup-restore-section')).toBeUndefined();
    expect(mockToasts).toContain('success:History restored');

    // "Turn off" asks first, then deletes and forgets.
    mockConfirmAnswer = false;
    await press(second, 'backup-disable');
    expect(fresh.client.backup.status().enabled).toBe(true);
    mockConfirmAnswer = true;
    await press(second, 'backup-disable');
    await waitUntil(() => !fresh.client.backup.status().enabled);
    expect(texts(second)).toContain('Backup is off');
    expect(fresh.client.backup.status().remote).toMatchObject({ exists: false });
  });
});
