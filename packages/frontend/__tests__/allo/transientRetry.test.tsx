/**
 * "Cannot check access" after ONE failed request, with a Retry button as the
 * only way out, is what a phone changing networks used to get. A transient
 * failure is now asked again by itself; the screen says it failed only once
 * that is spent (or for a failure another attempt cannot change), and it comes
 * back by itself when the device is online again.
 */
import { onlineManager } from '@tanstack/react-query';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  RECOVERY_INTERVAL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  isTransientFailure,
  nextRetryDelay,
  useTransientRetry,
  type CheckFailure,
} from '@/lib/allo/transientRetry';

const network = Object.assign(new Error('Network request failed'), { status: 0 });
const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });

describe('isTransientFailure', () => {
  it('is another attempt worth making', () => {
    expect(isTransientFailure(new TypeError('Network request failed'))).toBe(true);
    expect(isTransientFailure(network)).toBe(true);
    for (const status of [408, 425, 429, 500, 502, 503])
      expect(isTransientFailure({ status })).toBe(true);
    expect(isTransientFailure({ response: { status: 504 } })).toBe(true);
    for (const status of [400, 401, 403, 404]) expect(isTransientFailure({ status })).toBe(false);
  });

  it('stops after the schedule, and at once for a failure that will not change', () => {
    expect(TRANSIENT_RETRY_DELAYS_MS.map((_, attempt) => nextRetryDelay(attempt, network))).toEqual(
      TRANSIENT_RETRY_DELAYS_MS,
    );
    expect(nextRetryDelay(TRANSIENT_RETRY_DELAYS_MS.length, network)).toBeNull();
    expect(nextRetryDelay(0, forbidden)).toBeNull();
  });
});

/** A check the test answers by hand: `useTransientRetry` over a failure that the test sets. */
function harness() {
  let setFailure: (failure: CheckFailure | null) => void = () => undefined;
  const shown: boolean[] = [];
  const retry = jest.fn();
  function Probe() {
    const [failure, set] = React.useState<CheckFailure | null>(null);
    setFailure = set;
    shown.push(useTransientRetry(failure, retry));
    return null;
  }
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
  let at = 0;
  return {
    retry,
    fail: (error: unknown) => act(() => setFailure({ at: ++at, error })),
    succeed: () => act(() => setFailure(null)),
    gaveUp: () => shown[shown.length - 1],
    wait: (ms: number) => act(() => jest.advanceTimersByTime(ms)),
    unmount: () => act(() => tree.unmount()),
  };
}

describe('useTransientRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onlineManager.setOnline(true);
  });
  afterEach(() => {
    jest.useRealTimers();
    onlineManager.setOnline(true);
  });

  it('asks again with backoff and says nothing until the attempts are spent', () => {
    const check = harness();
    check.fail(network);
    for (const [index, delay] of TRANSIENT_RETRY_DELAYS_MS.entries()) {
      expect(check.gaveUp()).toBe(false);
      check.wait(delay - 1);
      expect(check.retry).toHaveBeenCalledTimes(index);
      check.wait(1);
      expect(check.retry).toHaveBeenCalledTimes(index + 1);
      check.fail(network); // that attempt failed too
    }
    expect(check.gaveUp()).toBe(true);
    check.unmount();
  });

  it('never shows the failure when an automatic attempt succeeds', () => {
    const check = harness();
    check.fail(network);
    check.wait(TRANSIENT_RETRY_DELAYS_MS[0]);
    check.succeed();
    expect(check.gaveUp()).toBe(false);
    // A later blip starts the schedule afresh rather than where the last one stopped.
    check.fail(network);
    expect(check.gaveUp()).toBe(false);
    check.wait(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(check.retry).toHaveBeenCalledTimes(2);
    check.unmount();
  });

  it('shows a failure another attempt cannot change at once, and does not poll it', () => {
    const check = harness();
    check.fail(forbidden);
    expect(check.gaveUp()).toBe(true);
    check.wait(RECOVERY_INTERVAL_MS * 3);
    expect(check.retry).not.toHaveBeenCalled();
    check.unmount();
  });

  it('recovers by itself once the failure is on screen: back online, and on a slow clock', () => {
    const check = harness();
    check.fail(network);
    for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
      check.wait(delay);
      check.fail(network);
    }
    expect(check.gaveUp()).toBe(true);
    check.retry.mockClear();

    // Offline: the slow clock does not spend requests that cannot land.
    act(() => onlineManager.setOnline(false));
    check.wait(RECOVERY_INTERVAL_MS);
    expect(check.retry).not.toHaveBeenCalled();
    // Back online: asked at once.
    act(() => onlineManager.setOnline(true));
    expect(check.retry).toHaveBeenCalledTimes(1);
    // A failure the device did not notice (a server that was down) is asked again too.
    check.wait(RECOVERY_INTERVAL_MS);
    expect(check.retry).toHaveBeenCalledTimes(2);

    check.succeed();
    expect(check.gaveUp()).toBe(false);
    check.wait(RECOVERY_INTERVAL_MS * 2);
    expect(check.retry).toHaveBeenCalledTimes(2);
    check.unmount();
  });
});
