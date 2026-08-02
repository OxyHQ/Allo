import { Coalescer } from '@/lib/matrix/web/coalesce';

/**
 * One rebuild per burst.
 *
 * `matrix-js-sdk` reports one event per message, per state change and per unread
 * count, while the port republishes whole arrays. Without this, a single sync
 * response would hand the conversation list a new array a few dozen times.
 */

const flush = (): Promise<void> => Promise.resolve();

describe('Coalescer', () => {
  it('runs once for a burst of requests', async () => {
    let runs = 0;
    const coalescer = new Coalescer(() => {
      runs += 1;
    });

    for (let index = 0; index < 20; index += 1) {
      coalescer.schedule();
    }
    await flush();

    expect(runs).toBe(1);
  });

  it('does not run at all until the burst has finished', async () => {
    // Synchronous would mean rebuilding inside the SDK's own event dispatch,
    // which is where the burst is coming from.
    let runs = 0;
    const coalescer = new Coalescer(() => {
      runs += 1;
    });

    coalescer.schedule();

    expect(runs).toBe(0);
  });

  it('runs again for the next burst', async () => {
    let runs = 0;
    const coalescer = new Coalescer(() => {
      runs += 1;
    });

    coalescer.schedule();
    await flush();
    coalescer.schedule();
    await flush();

    expect(runs).toBe(2);
  });

  it('drops a pending run when it is cancelled', async () => {
    // A handle closes with a rebuild already scheduled; publishing it would
    // report to an observer that has gone away.
    let runs = 0;
    const coalescer = new Coalescer(() => {
      runs += 1;
    });

    coalescer.schedule();
    coalescer.cancel();
    await flush();

    expect(runs).toBe(0);
  });

  it('stays cancelled', async () => {
    let runs = 0;
    const coalescer = new Coalescer(() => {
      runs += 1;
    });

    coalescer.cancel();
    coalescer.schedule();
    await flush();

    expect(runs).toBe(0);
  });
});
