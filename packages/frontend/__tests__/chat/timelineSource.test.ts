import {
  IDLE_RUNTIME_STATE,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import { TimelineSource, timelineSource } from '@/lib/chat/timelineSource';
import type {
  AlloChatClient,
  AlloEncryptionState,
  AlloMediaFile,
  AlloOidcLoginRequest,
  AlloOutgoingAttachment,
  AlloRecoveryState,
  AlloPaginationOutcome,
  AlloRoomListHandle,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * One conversation's timeline behind `useSyncExternalStore`, plus the two things
 * only it can do: ask for older messages, and send.
 *
 * The pagination guards are the part with teeth. A list calls its "load more"
 * handler as the user scrolls, which is to say often, and without the guards
 * every frame near the top of the conversation would be another request to the
 * homeserver.
 */

const ROOM = '!room:allo.you';

function event(key: string, overrides: Partial<AlloTimelineItem> = {}): AlloTimelineItem {
  return {
    key,
    id: { kind: 'remote', eventId: `$${key}` },
    sender: '@alice:allo.you',
    senderDisplayName: 'Alice',
    sentAt: 1_700_000_000_000,
    isOwn: false,
    sendState: 'sent',
    content: { kind: 'text', body: key, isEdited: false },
    reactions: [],
    isReadByOthers: false,
    ...overrides,
  };
}

/** A row the homeserver has not accepted yet: addressable only by transaction id. */
function localEcho(key: string): AlloTimelineItem {
  return event(key, {
    id: { kind: 'local', transactionId: `txn-${key}` },
    sendState: 'pending',
    isOwn: true,
  });
}

class FakeTimeline implements AlloTimelineHandle {
  closes = 0;
  paginateCalls: number[] = [];
  sent: string[] = [];
  attachments: AlloOutgoingAttachment[] = [];
  reacted: { eventId: string; key: string }[] = [];
  edited: { eventId: string; body: string }[] = [];
  redacted: { eventId: string; reason: string | undefined }[] = [];
  receipted: string[] = [];
  typingNotices: boolean[] = [];
  typingUnsubscribes = 0;
  outcome: AlloPaginationOutcome = 'more-available';
  /** When set, `paginateBackwards` waits for {@link releasePagination}. */
  #pendingPagination: (() => void) | undefined;
  #holdPagination = false;
  #items: readonly AlloTimelineItem[] = [];
  #typingListeners = new Set<(userIds: readonly string[]) => void>();

  constructor(private readonly onChange: (items: readonly AlloTimelineItem[]) => void) {}

  items(): readonly AlloTimelineItem[] {
    return this.#items;
  }

  publish(items: readonly AlloTimelineItem[]): void {
    this.#items = items;
    this.onChange(items);
  }

  publishTyping(userIds: readonly string[]): void {
    for (const listener of this.#typingListeners) {
      listener(userIds);
    }
  }

  holdPagination(): void {
    this.#holdPagination = true;
  }

  releasePagination(): void {
    const pending = this.#pendingPagination;
    this.#pendingPagination = undefined;
    pending?.();
  }

  async paginateBackwards(count: number): Promise<AlloPaginationOutcome> {
    this.paginateCalls.push(count);
    if (this.#holdPagination) {
      await new Promise<void>((resolve) => {
        this.#pendingPagination = resolve;
      });
    }
    return this.outcome;
  }

  async sendText(body: string): Promise<void> {
    this.sent.push(body);
  }

  async sendAttachment(attachment: AlloOutgoingAttachment): Promise<void> {
    this.attachments.push(attachment);
  }

  async toggleReaction(eventId: string, key: string): Promise<void> {
    this.reacted.push({ eventId, key });
  }

  async edit(eventId: string, body: string): Promise<void> {
    this.edited.push({ eventId, body });
  }

  async redact(eventId: string, reason: string | undefined): Promise<void> {
    this.redacted.push({ eventId, reason });
  }

  async sendReadReceipt(eventId: string): Promise<void> {
    this.receipted.push(eventId);
  }

  async sendTypingNotice(isTyping: boolean): Promise<void> {
    this.typingNotices.push(isTyping);
  }

  observeTyping(onChange: (userIds: readonly string[]) => void): AlloUnsubscribe {
    this.#typingListeners.add(onChange);
    return () => {
      this.#typingListeners.delete(onChange);
      this.typingUnsubscribes += 1;
    };
  }

  close(): void {
    this.closes += 1;
  }
}

/** A client that can open timelines and nothing else. */
class FakeChatClient implements AlloChatClient {
  readonly timelines: FakeTimeline[] = [];
  openTimelineCalls: string[] = [];
  #pendingOpen: (() => void) | undefined;
  #holdOpen = false;

  holdOpen(): void {
    this.#holdOpen = true;
  }

  releaseOpen(): void {
    const pending = this.#pendingOpen;
    this.#pendingOpen = undefined;
    pending?.();
  }

  async openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle> {
    this.openTimelineCalls.push(roomId);
    const timeline = new FakeTimeline(onChange);
    this.timelines.push(timeline);
    if (this.#holdOpen) {
      await new Promise<void>((resolve) => {
        this.#pendingOpen = resolve;
      });
    }
    return timeline;
  }

  async downloadMedia(): Promise<AlloMediaFile> {
    throw new Error('not used by these tests');
  }

  async beginOidcLogin(): Promise<AlloOidcLoginRequest> {
    throw new Error('not used by these tests');
  }

  async restoreSession(): Promise<void> {
    throw new Error('not used by these tests');
  }

  session(): AlloSession {
    throw new Error('not used by these tests');
  }

  observeSession(): AlloUnsubscribe {
    throw new Error('not used by these tests');
  }

  async logout(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async startSync(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async stopSync(): Promise<void> {
    throw new Error('not used by these tests');
  }

  observeSyncState(_onChange: (state: AlloSyncState) => void): AlloUnsubscribe {
    throw new Error('not used by these tests');
  }

  async observeRooms(): Promise<AlloRoomListHandle> {
    throw new Error('not used by these tests');
  }

  async createRoom(): Promise<string> {
    throw new Error('not used by these tests');
  }

  async roomEncryption(): Promise<AlloEncryptionState> {
    throw new Error('not used by these tests');
  }

  async recoveryState(): Promise<AlloRecoveryState> {
    throw new Error('not used by these tests');
  }

  async enableRecovery(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async recoverWithPassphrase(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async close(): Promise<void> {
    throw new Error('not used by these tests');
  }
}

class FakeRuntime implements MatrixRuntimeLike {
  readonly chatClient = new FakeChatClient();

  #state: MatrixRuntimeState = IDLE_RUNTIME_STATE;
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): AlloUnsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getState(): MatrixRuntimeState {
    return this.#state;
  }

  become(phase: MatrixRuntimeState['phase']): void {
    this.#state = { ...this.#state, phase };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  client(): AlloChatClient {
    return this.chatClient;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function readyTimeline(): { runtime: FakeRuntime; source: TimelineSource } {
  const runtime = new FakeRuntime();
  runtime.become('ready');
  return { runtime, source: new TimelineSource(runtime, ROOM, () => {}) };
}

describe('TimelineSource opening', () => {
  it('opens nothing until something watches it', async () => {
    const { runtime } = readyTimeline();
    await settle();

    expect(runtime.chatClient.openTimelineCalls).toEqual([]);
  });

  it('opens the room the moment it is watched', async () => {
    const { runtime, source } = readyTimeline();

    source.subscribe(() => {});
    await settle();

    expect(runtime.chatClient.openTimelineCalls).toEqual([ROOM]);
  });

  it('says it is opening before the timeline arrives', async () => {
    const { runtime, source } = readyTimeline();
    runtime.chatClient.holdOpen();

    source.subscribe(() => {});
    await settle();

    // The difference between "this conversation is empty" and "Allo has not
    // read it yet", which the screen draws differently.
    expect(source.getSnapshot().isOpening).toBe(true);
    expect(source.getSnapshot().items).toEqual([]);
  });

  it('stops saying it is opening once the timeline is there', async () => {
    const { source } = readyTimeline();

    source.subscribe(() => {});
    await settle();

    expect(source.getSnapshot().isOpening).toBe(false);
  });

  it('publishes the rows the port reports', async () => {
    const { runtime, source } = readyTimeline();
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    await settle();
    notifications = 0;

    const items = [event('one'), event('two')];
    runtime.chatClient.timelines[0].publish(items);

    expect(source.getSnapshot().items).toBe(items);
    expect(notifications).toBe(1);
  });

  it('closes the timeline when the last watcher goes away', async () => {
    // Unlike the conversation list, a timeline is per room: keeping every
    // conversation the user has visited subscribed would keep a listener per
    // room for the life of the app.
    const { runtime, source } = readyTimeline();
    const unsubscribe = source.subscribe(() => {});
    await settle();

    unsubscribe();

    expect(runtime.chatClient.timelines[0].closes).toBe(1);
  });

  it('keeps the timeline open while another watcher remains', async () => {
    const { runtime, source } = readyTimeline();
    const first = source.subscribe(() => {});
    source.subscribe(() => {});
    await settle();

    first();

    expect(runtime.chatClient.timelines[0].closes).toBe(0);
  });

  it('closes the timeline when the session goes away', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    runtime.become('signed-out');

    expect(runtime.chatClient.timelines[0].closes).toBe(1);
    expect(source.getSnapshot().items).toEqual([]);
  });

  it('closes a timeline that arrives after the session went away', async () => {
    const { runtime, source } = readyTimeline();
    runtime.chatClient.holdOpen();
    source.subscribe(() => {});
    await settle();

    runtime.become('signed-out');
    runtime.chatClient.releaseOpen();
    await settle();

    expect(runtime.chatClient.timelines[0].closes).toBe(1);
  });
});

describe('TimelineSource pagination', () => {
  it('asks the port for older messages', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    await source.paginateBackwards(30);

    expect(runtime.chatClient.timelines[0].paginateCalls).toEqual([30]);
  });

  it('says so while a pagination is running', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.timelines[0].holdPagination();

    const running = source.paginateBackwards(30);
    await settle();
    expect(source.getSnapshot().isPaginating).toBe(true);

    runtime.chatClient.timelines[0].releasePagination();
    await running;
    expect(source.getSnapshot().isPaginating).toBe(false);
  });

  it('does not ask twice while one request is still in flight', async () => {
    // A list fires "load more" as the user scrolls. Without this the top of a
    // conversation would send a request per frame.
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.timelines[0].holdPagination();

    const first = source.paginateBackwards(30);
    await settle();
    await source.paginateBackwards(30);

    expect(runtime.chatClient.timelines[0].paginateCalls).toEqual([30]);

    runtime.chatClient.timelines[0].releasePagination();
    await first;
  });

  it('remembers that the conversation has no more history', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.timelines[0].outcome = 'reached-start';

    await source.paginateBackwards(30);

    expect(source.getSnapshot().reachedStart).toBe(true);
  });

  it('stops asking once the start of the conversation has been reached', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.timelines[0].outcome = 'reached-start';
    await source.paginateBackwards(30);

    await source.paginateBackwards(30);
    await source.paginateBackwards(30);

    expect(runtime.chatClient.timelines[0].paginateCalls).toEqual([30]);
  });

  it('stops saying it is paginating when the request fails', async () => {
    // Otherwise one failure leaves the spinner up and the guard latched, and the
    // conversation can never load its history again.
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    const timeline = runtime.chatClient.timelines[0];
    timeline.paginateBackwards = async () => {
      throw new Error('the homeserver said no');
    };

    await expect(source.paginateBackwards(30)).rejects.toThrow('the homeserver said no');

    expect(source.getSnapshot().isPaginating).toBe(false);
  });

  it('refuses to paginate a conversation nothing is watching', async () => {
    const { source } = readyTimeline();

    await expect(source.paginateBackwards(30)).rejects.toThrow(ROOM);
  });
});

describe('TimelineSource sending', () => {
  it('sends the body verbatim through the port', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    await source.sendText('*not* markdown');

    expect(runtime.chatClient.timelines[0].sent).toEqual(['*not* markdown']);
  });

  it('adds nothing to the timeline of its own accord', async () => {
    // The port puts the local echo in the timeline itself. An optimistic row
    // added here would be a second copy of the same message.
    const { source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    await source.sendText('hello');

    expect(source.getSnapshot().items).toEqual([]);
  });

  it('refuses to send to a conversation nothing is watching', async () => {
    const { source } = readyTimeline();

    await expect(source.sendText('hello')).rejects.toThrow(ROOM);
  });
});

describe('TimelineSource message operations', () => {
  async function watching(): Promise<{ runtime: FakeRuntime; source: TimelineSource }> {
    const ready = readyTimeline();
    ready.source.subscribe(() => {});
    await settle();
    return ready;
  }

  it('resolves the key the UI draws with into the event id the port wants', async () => {
    // The UI holds `Message.id`, which is the row key. Handing that to the
    // homeserver would address an event that does not exist.
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);

    await source.toggleReaction('row-1', '👍');

    expect(runtime.chatClient.timelines[0].reacted).toEqual([{ eventId: '$row-1', key: '👍' }]);
  });

  it('edits by event id', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);

    await source.edit('row-1', 'fixed');

    expect(runtime.chatClient.timelines[0].edited).toEqual([
      { eventId: '$row-1', body: 'fixed' },
    ]);
  });

  it('redacts by event id, with no reason unless one is given', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);

    await source.redact('row-1');

    expect(runtime.chatClient.timelines[0].redacted).toEqual([
      { eventId: '$row-1', reason: undefined },
    ]);
  });

  it('leaves the redacted row in the timeline', async () => {
    // The mistake this holds down. A redaction is not a deletion: the event keeps
    // its place, its sender and its time on every client in the room, and the
    // port reports it with a `redacted` content kind. Dropping the row here would
    // renumber the conversation under the reader and disagree with every other
    // device until the next sync — and then disagree with itself.
    const { runtime, source } = await watching();
    const rows = [event('row-1'), event('row-2')];
    runtime.chatClient.timelines[0].publish(rows);

    await source.redact('row-1');

    expect(source.getSnapshot().items).toBe(rows);
    expect(source.getSnapshot().items.map((item) => item.key)).toEqual(['row-1', 'row-2']);
  });

  it('refuses to act on a message the homeserver has not accepted', async () => {
    // A local echo has no event id at all. Sending its transaction id would
    // address nothing, and the native SDK's ability to do slightly better is not
    // worth two platforms disagreeing about which taps work.
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([localEcho('row-1')]);

    await expect(source.toggleReaction('row-1', '👍')).rejects.toThrow('has not been accepted');
    expect(runtime.chatClient.timelines[0].reacted).toEqual([]);
  });

  it('says which message it could not find when the row is gone', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);

    await expect(source.edit('row-9', 'fixed')).rejects.toThrow('row-9');
  });
});

describe('TimelineSource read receipts', () => {
  async function watching(): Promise<{ runtime: FakeRuntime; source: TimelineSource }> {
    const ready = readyTimeline();
    ready.source.subscribe(() => {});
    await settle();
    return ready;
  }

  it('receipts the newest row', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1'), event('row-2')]);

    await source.markRead();

    expect(runtime.chatClient.timelines[0].receipted).toEqual(['$row-2']);
  });

  it('does not send the same receipt twice', async () => {
    // Called from a render, so it runs whenever anything about the conversation
    // changes: a reaction, a scroll, a redraw. Every one of those would otherwise
    // be a request to the homeserver.
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);

    await source.markRead();
    await source.markRead();
    await source.markRead();

    expect(runtime.chatClient.timelines[0].receipted).toEqual(['$row-1']);
  });

  it('receipts again once a newer message arrives', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1')]);
    await source.markRead();

    runtime.chatClient.timelines[0].publish([event('row-1'), event('row-2')]);
    await source.markRead();

    expect(runtime.chatClient.timelines[0].receipted).toEqual(['$row-1', '$row-2']);
  });

  it('skips over a message of the viewer’s own that has not been sent', async () => {
    // The newest row right after sending is a local echo with no event id.
    // Receipting the newest *remote* one keeps the mark moving.
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([event('row-1'), localEcho('row-2')]);

    await source.markRead();

    expect(runtime.chatClient.timelines[0].receipted).toEqual(['$row-1']);
  });

  it('sends nothing for a conversation with no remote messages', async () => {
    const { runtime, source } = await watching();
    runtime.chatClient.timelines[0].publish([localEcho('row-1')]);

    await source.markRead();

    expect(runtime.chatClient.timelines[0].receipted).toEqual([]);
  });

  it('tries again after a receipt that failed to go out', async () => {
    // Otherwise one refusal from the homeserver leaves the sender's bubble one
    // tick short for the rest of the conversation.
    const { runtime, source } = await watching();
    const timeline = runtime.chatClient.timelines[0];
    timeline.publish([event('row-1')]);
    timeline.sendReadReceipt = async () => {
      throw new Error('the homeserver said no');
    };

    await expect(source.markRead()).rejects.toThrow('the homeserver said no');

    timeline.sendReadReceipt = async (eventId: string) => {
      timeline.receipted.push(eventId);
    };
    await source.markRead();

    expect(timeline.receipted).toEqual(['$row-1']);
  });

  it('sends nothing for a conversation nothing is watching', async () => {
    // Not an error: a screen that unmounted while a render was in flight is
    // ordinary, and there is nothing a reader could do about it either way.
    const { source } = readyTimeline();

    await expect(source.markRead()).resolves.toBeUndefined();
  });
});

describe('TimelineSource typing', () => {
  it('reports who else is typing', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    runtime.chatClient.timelines[0].publishTyping(['@bea:allo.you']);

    expect(source.getSnapshot().typingUserIds).toEqual(['@bea:allo.you']);
  });

  it('notifies its watchers when typing changes', async () => {
    const { runtime, source } = readyTimeline();
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    await settle();
    notifications = 0;

    runtime.chatClient.timelines[0].publishTyping(['@bea:allo.you']);

    expect(notifications).toBe(1);
  });

  it('says nobody is typing in a conversation that has just been opened', async () => {
    const { source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    expect(source.getSnapshot().typingUserIds).toEqual([]);
  });

  it('forgets who was typing when the session goes away', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.timelines[0].publishTyping(['@bea:allo.you']);

    runtime.become('signed-out');

    expect(source.getSnapshot().typingUserIds).toEqual([]);
  });

  it('stops listening for typing when the timeline closes', async () => {
    const { runtime, source } = readyTimeline();
    const unsubscribe = source.subscribe(() => {});
    await settle();

    unsubscribe();

    expect(runtime.chatClient.timelines[0].typingUnsubscribes).toBe(1);
  });

  it('passes the viewer’s own typing through to the port', async () => {
    const { runtime, source } = readyTimeline();
    source.subscribe(() => {});
    await settle();

    await source.sendTypingNotice(true);
    await source.sendTypingNotice(false);

    expect(runtime.chatClient.timelines[0].typingNotices).toEqual([true, false]);
  });
});

describe('timelineSource registry', () => {
  it('hands the same source to everything drawing one room', () => {
    // Two panes of the three-panel layout can draw one conversation. Two sources
    // would be two timelines open over one room.
    expect(timelineSource(ROOM)).toBe(timelineSource(ROOM));
  });

  it('keeps separate rooms separate', () => {
    expect(timelineSource(ROOM)).not.toBe(timelineSource('!other:allo.you'));
  });

  it('forgets a room once nothing is watching it', () => {
    const source = timelineSource('!transient:allo.you');
    const unsubscribe = source.subscribe(() => {});

    unsubscribe();

    expect(timelineSource('!transient:allo.you')).not.toBe(source);
  });
});
