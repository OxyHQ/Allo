import {
  IDLE_RUNTIME_STATE,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import { TimelineSource, timelineSource } from '@/lib/chat/timelineSource';
import type {
  AlloChatClient,
  AlloEncryptionState,
  AlloOidcLoginRequest,
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

function event(key: string): AlloTimelineItem {
  return {
    key,
    id: { kind: 'remote', eventId: `$${key}` },
    sender: '@alice:allo.you',
    senderDisplayName: 'Alice',
    sentAt: 1_700_000_000_000,
    isOwn: false,
    sendState: 'sent',
    content: { kind: 'text', body: key, isEdited: false },
  };
}

class FakeTimeline implements AlloTimelineHandle {
  closes = 0;
  paginateCalls: number[] = [];
  sent: string[] = [];
  outcome: AlloPaginationOutcome = 'more-available';
  /** When set, `paginateBackwards` waits for {@link releasePagination}. */
  #pendingPagination: (() => void) | undefined;
  #holdPagination = false;
  #items: readonly AlloTimelineItem[] = [];

  constructor(private readonly onChange: (items: readonly AlloTimelineItem[]) => void) {}

  items(): readonly AlloTimelineItem[] {
    return this.#items;
  }

  publish(items: readonly AlloTimelineItem[]): void {
    this.#items = items;
    this.onChange(items);
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
