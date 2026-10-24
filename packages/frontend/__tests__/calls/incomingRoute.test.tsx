import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
const mockCalls = {
  start: jest.fn().mockResolvedValue(undefined),
  answer: jest.fn(),
  decline: jest.fn(),
  end: jest.fn(),
  setMuted: jest.fn(),
  setCameraEnabled: jest.fn(),
};
let mockParams: { id: string; incomingCallId?: string } = {
  id: 'conversation',
  incomingCallId: 'expired-call',
};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@allo/react', () => ({
  useCallActions: () => mockCalls,
  useConversation: () => ({ memberAccountIds: ['self', 'peer'] }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ user: { id: 'self' } }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/call-ui', () => ({
  CallScreen: () => null,
  IncomingCallScreen: () => null,
  GroupCallGrid: () => null,
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/typography', () => ({ Muted: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { background: 'transparent' } }),
}));
jest.mock('@/components/phase2/NotConnectedNotice', () => ({ NotConnectedNotice: () => null }));
jest.mock('@/components/calls/CallVideo', () => ({ CallVideo: () => null }));
jest.mock('@/lib/allo/callMedia', () => ({ useCallMedia: () => ({ local: null, remote: [] }) }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@/hooks/useChatContext', () => ({
  useChatContext: () => ({ person: () => undefined }),
}));
jest.mock('@/lib/calls/session', () => ({
  reportCallError: jest.fn(),
  useCallDuration: () => '',
  useCallSession: () => null,
  useCallUi: (select: (state: unknown) => unknown) =>
    select({ setMinimised: jest.fn(), setPipCorner: jest.fn() }),
}));
const CallRoute = require('@/app/(chat)/c/[id]/call').default;
it('mounting a cancelled or expired incoming route with no session never creates an outgoing call', async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<CallRoute />);
  });
  await act(async () => {
    tree.update(<CallRoute />);
  });
  expect(mockCalls.start).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
it('the explicit outgoing route still places exactly one call across rerenders', async () => {
  mockParams = { id: 'conversation' };
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<CallRoute />);
  });
  await act(async () => {
    tree.update(<CallRoute />);
  });
  expect(mockCalls.start).toHaveBeenCalledTimes(1);
  expect(mockCalls.start).toHaveBeenCalledWith('conversation', 'voice');
  await act(async () => tree.unmount());
});
