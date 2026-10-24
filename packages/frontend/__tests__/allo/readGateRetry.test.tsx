/**
 * A supervised transcript's access check (`ConversationReadGate`) over a
 * client whose refresh fails transiently: the reader sees "checking" while it
 * is asked again, then the transcript — never "cannot check access" for a blip.
 */
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockRefresh = jest.fn<Promise<void>, []>();
// One client for the provider's life, as `useAlloClient` gives.
const mockClient = { conversations: { refresh: () => mockRefresh() } };
jest.mock('@allo/react', () => ({ useAlloClient: () => mockClient }));
jest.mock('@/lib/allo/ConversationAccessState', () => {
  const { Text: MockText } = require('react-native');
  return {
    ConversationAccessState: ({ state }: { state: string }) => (
      <MockText>{`access:${state}`}</MockText>
    ),
  };
});

const { ConversationReadGate } =
  require('@/lib/allo/ConversationReadGate') as typeof import('@/lib/allo/ConversationReadGate');
const { MessagingSupervisionContext } =
  require('@/lib/allo/MessagingSupervision') as typeof import('@/lib/allo/MessagingSupervision');
const { TRANSIENT_RETRY_DELAYS_MS } =
  require('@/lib/allo/transientRetry') as typeof import('@/lib/allo/transientRetry');

const offline = () => Promise.reject(Object.assign(new Error('offline'), { status: 0 }));

function render() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <MessagingSupervisionContext.Provider value>
        <ConversationReadGate conversationId="conv-1">
          <Text>transcript</Text>
        </ConversationReadGate>
      </MessagingSupervisionContext.Provider>,
    );
  });
  const shown = () =>
    tree.root
      .findAllByType(Text)
      .map((node) => node.props.children)
      .join('');
  return { tree, shown };
}

const flush = () => act(async () => undefined);

describe('ConversationReadGate', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    mockRefresh.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('keeps checking through a transient failure and opens once an automatic retry lands', async () => {
    mockRefresh.mockImplementationOnce(offline).mockImplementationOnce(offline);
    mockRefresh.mockResolvedValue(undefined);
    const { tree, shown } = render();
    await flush();
    expect(shown()).toBe('access:checking');
    await act(async () => jest.advanceTimersByTime(TRANSIENT_RETRY_DELAYS_MS[0]));
    await flush();
    expect(shown()).toBe('access:checking');
    await act(async () => jest.advanceTimersByTime(TRANSIENT_RETRY_DELAYS_MS[1]));
    await flush();
    expect(shown()).toBe('transcript');
    expect(mockRefresh).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('says it cannot check only after the automatic attempts are spent', async () => {
    mockRefresh.mockImplementation(offline);
    const { tree, shown } = render();
    await flush();
    for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
      expect(shown()).toBe('access:checking');
      await act(async () => jest.advanceTimersByTime(delay));
      await flush();
    }
    expect(shown()).toBe('access:unavailable');
    expect(mockRefresh).toHaveBeenCalledTimes(TRANSIENT_RETRY_DELAYS_MS.length + 1);
    act(() => tree.unmount());
  });

  it('says so at once for a refusal another attempt cannot change', async () => {
    mockRefresh.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })),
    );
    const { tree, shown } = render();
    await flush();
    expect(shown()).toBe('access:unavailable');
    act(() => tree.unmount());
  });
});
