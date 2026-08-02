import type { EphemeralPoliciesLike } from '@/lib/chat/ephemeralPolicies';
import { EphemeralSweeper, type SweepableTimeline } from '@/lib/chat/ephemeralSweep';
import type {
  AlloEphemeralPolicy,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * Taking this device's own expired messages off the homeserver.
 *
 * The half of the tier that is not a courtesy: a redaction removes the content
 * for everybody, and afterwards no key opens it because there is nothing left to
 * open. So the assertions here are about a promise rather than about a
 * behaviour, and the important ones are the negatives — that it does not ask for
 * a message twice, that it does not ask for somebody else's, and that it lets go
 * of a conversation that stops being ephemeral.
 */

const ROOM = '!room:allo.you';
const OTHER = '!other:allo.you';
const POLICY: AlloEphemeralPolicy = { lifetimeMs: 3_600_000 };

class FakePolicies implements EphemeralPoliciesLike {
  #policies: ReadonlyMap<string, AlloEphemeralPolicy> = new Map();
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): AlloUnsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): ReadonlyMap<string, AlloEphemeralPolicy> {
    return this.#policies;
  }

  set(policies: readonly [string, AlloEphemeralPolicy][]): void {
    this.#policies = new Map(policies);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

class FakeTimeline implements SweepableTimeline {
  readonly redactions: string[] = [];
  subscribers = 0;
  /** Set to make every redaction fail, as an unreachable homeserver would. */
  failRedactions = false;

  #items: readonly AlloTimelineItem[] = [];
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): AlloUnsubscribe {
    this.subscribers += 1;
    this.#listeners.add(listener);
    return () => {
      this.subscribers -= 1;
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): { readonly items: readonly AlloTimelineItem[] } {
    return { items: this.#items };
  }

  async redact(key: string): Promise<void> {
    this.redactions.push(key);
    if (this.failRedactions) {
      throw new Error('the homeserver is unreachable');
    }
  }

  publish(items: readonly AlloTimelineItem[]): void {
    this.#items = items;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function item(overrides: Partial<AlloTimelineItem> = {}): AlloTimelineItem {
  return {
    key: 'row-1',
    id: { kind: 'remote', eventId: '$one' },
    sender: '@me:allo.you',
    senderDisplayName: 'Me',
    // Long enough ago that it is expired against any real clock.
    sentAt: Date.now() - 10 * POLICY.lifetimeMs,
    isOwn: true,
    sendState: 'sent',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    isReadByOthers: false,
    ...overrides,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sweeperWith(): {
  policies: FakePolicies;
  timelines: Map<string, FakeTimeline>;
  sweeper: EphemeralSweeper;
} {
  const policies = new FakePolicies();
  const timelines = new Map<string, FakeTimeline>();
  const sweeper = new EphemeralSweeper(policies, (roomId) => {
    const existing = timelines.get(roomId);
    if (existing !== undefined) {
      return existing;
    }
    const timeline = new FakeTimeline();
    timelines.set(roomId, timeline);
    return timeline;
  });
  return { policies, timelines, sweeper };
}

describe('EphemeralSweeper', () => {
  it('holds nothing open until something watches it', () => {
    const { policies, timelines } = sweeperWith();
    policies.set([[ROOM, POLICY]]);

    expect(timelines.size).toBe(0);
  });

  it('opens a timeline for every ephemeral conversation', () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});

    policies.set([
      [ROOM, POLICY],
      [OTHER, POLICY],
    ]);

    expect([...timelines.keys()].sort()).toEqual([OTHER, ROOM].sort());
    expect(timelines.get(ROOM)?.subscribers).toBe(1);
  });

  it('opens nothing for an account with no ephemeral conversations', () => {
    // Which is most accounts. The cost of this whole mechanism has to be zero
    // for somebody who has not asked for it.
    const { timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});

    expect(timelines.size).toBe(0);
  });

  it("redacts the viewer's own expired message", async () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);

    timelines.get(ROOM)?.publish([item({ key: 'mine' })]);
    await settle();

    expect(timelines.get(ROOM)?.redactions).toEqual(['mine']);
  });

  it("does not redact somebody else's", async () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);

    timelines.get(ROOM)?.publish([item({ isOwn: false })]);
    await settle();

    expect(timelines.get(ROOM)?.redactions).toEqual([]);
  });

  it('does not redact one that has not expired', async () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);

    timelines.get(ROOM)?.publish([item({ sentAt: Date.now() })]);
    await settle();

    expect(timelines.get(ROOM)?.redactions).toEqual([]);
  });

  it('asks once, however many times the timeline moves', async () => {
    // A redacted row keeps its place in the timeline, and the request is in
    // flight for as long as the homeserver takes. Without the memory this would
    // ask again on every wake-up, for ever.
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);
    const timeline = timelines.get(ROOM);

    timeline?.publish([item({ key: 'mine' })]);
    await settle();
    timeline?.publish([item({ key: 'mine' })]);
    await settle();

    expect(timeline?.redactions).toEqual(['mine']);
  });

  it('asks again after a redaction that did not go through', async () => {
    // A message left on the homeserver because one request failed is exactly the
    // failure this tier is about.
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);
    const timeline = timelines.get(ROOM);
    if (timeline === undefined) {
      throw new Error('the sweeper opened no timeline');
    }

    timeline.failRedactions = true;
    timeline.publish([item({ key: 'mine' })]);
    await settle();

    timeline.failRedactions = false;
    timeline.publish([item({ key: 'mine' })]);
    await settle();

    expect(timeline.redactions).toEqual(['mine', 'mine']);
  });

  it('sweeps what expired while the app was closed, without waiting for a change', async () => {
    // The case the whole thing exists for: a conversation nobody has opened
    // since yesterday. Nothing is going to publish a timeline change for it.
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    const timeline = new FakeTimeline();
    timeline.publish([item({ key: 'yesterday' })]);
    timelines.set(ROOM, timeline);

    policies.set([[ROOM, POLICY]]);
    await settle();

    expect(timeline.redactions).toEqual(['yesterday']);
  });

  it('lets go of a conversation that stops being ephemeral', () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);

    policies.set([]);

    expect(timelines.get(ROOM)?.subscribers).toBe(0);
  });

  it('stops redacting once a conversation stops being ephemeral', async () => {
    // A redaction cannot be undone, so what has gone is gone — but nothing more
    // is taken away.
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);
    const timeline = timelines.get(ROOM);

    policies.set([]);
    timeline?.publish([item({ key: 'later' })]);
    await settle();

    expect(timeline?.redactions).toEqual([]);
  });

  it('reports which conversations it is keeping on a timer', () => {
    const { policies, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});

    policies.set([
      [OTHER, POLICY],
      [ROOM, POLICY],
    ]);

    expect(sweeper.getSnapshot()).toEqual([OTHER, ROOM].sort());
  });

  it('answers the same list when nothing changed', () => {
    // `useSyncExternalStore` compares by identity and throws on a snapshot that
    // keeps changing.
    const { sweeper } = sweeperWith();
    sweeper.subscribe(() => {});

    expect(sweeper.getSnapshot()).toBe(sweeper.getSnapshot());
  });

  it('releases everything when it is stopped', () => {
    const { policies, timelines, sweeper } = sweeperWith();
    sweeper.subscribe(() => {});
    policies.set([[ROOM, POLICY]]);

    sweeper.stop();

    expect(timelines.get(ROOM)?.subscribers).toBe(0);
    expect(sweeper.getSnapshot()).toEqual([]);
  });
});
