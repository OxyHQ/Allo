import { CircuitBreaker } from '@/lib/api/retryLogic';

/**
 * The breaker guards against a backend that is genuinely down. Every case here
 * exists because the opposite behaviour once blocked message sending on a
 * perfectly healthy server: the device-key lookups that encryption depends on
 * go through this class, so an over-eager circuit means "you cannot send".
 */

const THRESHOLD = 5;
const WINDOW_MS = 60_000;
const RESET_MS = 30_000;

function makeBreaker(): CircuitBreaker {
  return new CircuitBreaker(THRESHOLD, WINDOW_MS, RESET_MS, 'test');
}

/** An error shaped like the axios rejections `getHttpStatus` reads. */
function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

async function failWith(breaker: CircuitBreaker, error: Error, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(breaker.execute(() => Promise.reject(error))).rejects.toThrow();
  }
}

describe('CircuitBreaker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('what counts as a service failure', () => {
    it.each([
      ['401 unauthorized', 401],
      ['403 forbidden', 403],
      ['404 not found', 404],
      ['400 bad request', 400],
      ['409 conflict', 409],
    ])('stays closed through repeated %s', async (_label, status) => {
      const breaker = makeBreaker();

      await failWith(breaker, httpError(status), THRESHOLD * 3);

      expect(breaker.getState()).toBe('closed');
      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it.each([
      ['500 server error', 500],
      ['503 unavailable', 503],
      ['429 rate limited', 429],
      ['408 timeout', 408],
    ])('opens after %s repeats past the threshold', async (_label, status) => {
      const breaker = makeBreaker();

      await failWith(breaker, httpError(status), THRESHOLD);

      expect(breaker.getState()).toBe('open');
    });

    it('opens on transport failures that carry no status', async () => {
      const breaker = makeBreaker();

      await failWith(breaker, new Error('Network request failed'), THRESHOLD);

      expect(breaker.getState()).toBe('open');
    });

    it('names itself and the remaining wait when rejecting an open circuit', async () => {
      const breaker = makeBreaker();
      await failWith(breaker, httpError(500), THRESHOLD);

      await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toThrow(
        /open for test .* Retrying in \d+s/
      );
    });
  });

  describe('failures are consecutive, not cumulative', () => {
    it('clears the count after a success while closed', async () => {
      const breaker = makeBreaker();

      await failWith(breaker, httpError(500), THRESHOLD - 1);
      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
      await failWith(breaker, httpError(500), THRESHOLD - 1);

      // Without the reset these 8 failures would have tripped the threshold of 5.
      expect(breaker.getState()).toBe('closed');
    });

    it('discards failures older than the window', async () => {
      jest.useFakeTimers();
      const breaker = makeBreaker();

      await failWith(breaker, httpError(500), THRESHOLD - 1);
      jest.advanceTimersByTime(WINDOW_MS + 1);
      await failWith(breaker, httpError(500), THRESHOLD - 1);

      expect(breaker.getState()).toBe('closed');
    });

    it('opens when the failures fall inside the window', async () => {
      jest.useFakeTimers();
      const breaker = makeBreaker();

      await failWith(breaker, httpError(500), THRESHOLD - 1);
      jest.advanceTimersByTime(WINDOW_MS - 1);
      await failWith(breaker, httpError(500), 1);

      expect(breaker.getState()).toBe('open');
    });
  });

  describe('recovery', () => {
    it('rejects immediately while open, without calling through', async () => {
      const breaker = makeBreaker();
      await failWith(breaker, httpError(500), THRESHOLD);

      const call = jest.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute(call)).rejects.toThrow(/Circuit breaker is open/);

      expect(call).not.toHaveBeenCalled();
    });

    it('probes once the reset window elapses and closes on success', async () => {
      jest.useFakeTimers();
      const breaker = makeBreaker();
      await failWith(breaker, httpError(500), THRESHOLD);

      jest.advanceTimersByTime(RESET_MS + 1);

      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(breaker.getState()).toBe('closed');
    });

    it('reopens if the probe fails again', async () => {
      jest.useFakeTimers();
      const breaker = makeBreaker();
      await failWith(breaker, httpError(500), THRESHOLD);

      jest.advanceTimersByTime(RESET_MS + 1);
      await failWith(breaker, httpError(500), 1);

      expect(breaker.getState()).toBe('open');
    });
  });
});

/**
 * The Oxy client writes the status in two places and not every path writes both.
 * A breaker that cannot read one of them counts an ordinary 404 as an outage —
 * which is exactly what took `profile/design/:id` down in production.
 */
describe('CircuitBreaker against real Oxy client error shapes', () => {
  /** `HttpService` sets both `status` and `response` on the thrown Error. */
  function oxyHttpError(status: number): Error {
    return Object.assign(new Error(`HTTP ${status}: `), {
      status,
      response: { status, statusText: '' },
    });
  }

  /** The XHR upload path carries only `status`; there is no `response` beside it. */
  function oxyStatusOnlyError(status: number): Error {
    return Object.assign(new Error(`HTTP ${status}: `), { status });
  }

  it('stays closed through 404s that carry both status and response', async () => {
    const breaker = makeBreaker();
    await failWith(breaker, oxyHttpError(404), THRESHOLD * 2);
    expect(breaker.getState()).toBe('closed');
  });

  it('stays closed through 404s that carry only status', async () => {
    const breaker = makeBreaker();
    await failWith(breaker, oxyStatusOnlyError(404), THRESHOLD * 2);
    expect(breaker.getState()).toBe('closed');
  });

  it('still opens on a 503 that carries only status', async () => {
    const breaker = makeBreaker();
    await failWith(breaker, oxyStatusOnlyError(503), THRESHOLD);
    expect(breaker.getState()).toBe('open');
  });
});
