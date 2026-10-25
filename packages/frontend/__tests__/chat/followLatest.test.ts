import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useFollowLatest } from '@/components/chat/transcript/useFollowLatest';

/** A scroll event `fromEnd` pixels short of the end of a 2000px transcript in a 800px viewport. */
function scrolled(fromEnd: number) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: 1200 - fromEnd },
      contentSize: { width: 400, height: 2000 },
      layoutMeasurement: { width: 400, height: 800 },
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

type Newest = { id: string; own: boolean };
type Follow = ReturnType<typeof useFollowLatest>;

/** Mounts the hook in a probe; `rerender` hands it a new newest message. */
function setup(newest: Newest = { id: 'm1', own: false }) {
  const scrollToEnd = jest.fn();
  const result: { current: Follow } = { current: undefined as unknown as Follow };
  function Probe({ newest: current }: { newest: Newest }) {
    result.current = useFollowLatest({ newest: current, scrollToEnd });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe, { newest }));
  });
  const hook = {
    result,
    rerender: ({ newest: next }: { newest: Newest }) =>
      act(() => renderer.update(createElement(Probe, { newest: next }))),
  };
  return { hook, scrollToEnd };
}

describe('following the newest message', () => {
  it('ignores a scroll event the reader did not make', () => {
    // Android reports one when the keyboard or the reply banner shrinks the
    // viewport; it used to unpin the end, and a message just sent stayed hidden.
    const { hook, scrollToEnd } = setup();
    act(() => hook.result.current.onScroll(scrolled(400)));
    expect(hook.result.current.isFollowing()).toBe(true);
    act(() => hook.result.current.scrollProps.onLayout());
    expect(scrollToEnd).toHaveBeenCalledWith(false);
  });

  it('stops following when the reader scrolls away, and pins nothing then', () => {
    const { hook, scrollToEnd } = setup();
    act(() => {
      hook.result.current.scrollProps.onScrollBeginDrag();
      hook.result.current.onScroll(scrolled(400));
      hook.result.current.scrollProps.onScrollEndDrag();
    });
    expect(hook.result.current.isFollowing()).toBe(false);
    act(() => hook.result.current.scrollProps.onContentSizeChange());
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('brings a message this account sent into view even from further up', () => {
    const { hook, scrollToEnd } = setup();
    act(() => {
      hook.result.current.scrollProps.onScrollBeginDrag();
      hook.result.current.onScroll(scrolled(400));
      hook.result.current.scrollProps.onScrollEndDrag();
    });
    hook.rerender({ newest: { id: 'm2', own: true } });
    expect(hook.result.current.isFollowing()).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledWith(false);
  });

  it('leaves a reader who scrolled up where they are when somebody else writes', () => {
    const { hook, scrollToEnd } = setup();
    act(() => {
      hook.result.current.scrollProps.onScrollBeginDrag();
      hook.result.current.onScroll(scrolled(400));
      hook.result.current.scrollProps.onScrollEndDrag();
    });
    hook.rerender({ newest: { id: 'm2', own: false } });
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('follows again once the reader scrolls back to the end or jumps there', () => {
    const { hook, scrollToEnd } = setup();
    act(() => {
      hook.result.current.scrollProps.onScrollBeginDrag();
      hook.result.current.onScroll(scrolled(400));
      hook.result.current.onScroll(scrolled(10));
      hook.result.current.scrollProps.onScrollEndDrag();
    });
    expect(hook.result.current.isFollowing()).toBe(true);
    act(() => hook.result.current.jumpToEnd());
    expect(scrollToEnd).toHaveBeenLastCalledWith(true);
  });
});
