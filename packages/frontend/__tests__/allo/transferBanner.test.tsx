import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { HistoryProgress, InstanceView } from '@allo/react';

import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';

/**
 * The transfer banner, state by state.
 *
 * What the SDK reports is a `HistoryProgress` and the account's instance list;
 * the banner's job is to turn those into one line, or nothing. The hooks are
 * replaced here because a real client cannot be held in a given phase — a
 * transfer runs to completion on its own — and every state below is one the
 * SDK does produce (see `packages/react/src/__tests__/history.test.tsx`).
 */

let mockProgress: HistoryProgress = { phase: 'idle', done: 0, total: 0 };
let mockInstances: InstanceView[] = [];

jest.mock('@allo/react', () => ({
  useHistoryTransfer: () => ({ progress: mockProgress, pendingOffers: [], accept: jest.fn(), refresh: jest.fn() }),
  useOwnInstances: () => ({ instances: mockInstances, revoke: jest.fn(), refresh: jest.fn() }),
}));

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    colors: { backgroundSecondary: '#eee', textSecondary: '#444' },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  }),
}));

function instance(id: string, displayName: string): InstanceView {
  return {
    id,
    displayName,
    platform: 'ios',
    status: 'active',
    isThis: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
  } as unknown as InstanceView;
}

function render(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<HistoryTransferBanner />);
  });
  if (!renderer) throw new Error('did not mount');
  return renderer;
}

function text(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text).map((node) => String(React.Children.toArray(node.props.children).join(''))).join(' ');
}

describe('HistoryTransferBanner', () => {
  beforeEach(() => {
    mockProgress = { phase: 'idle', done: 0, total: 0 };
    mockInstances = [instance('inst-phone', 'Bob iOS'), instance('inst-desk', 'Bob desktop')];
  });

  it('draws nothing while idle', () => {
    const renderer = render();
    expect(renderer.toJSON()).toBeNull();
  });

  it('names the donor while receiving, with the fraction once the total is known', () => {
    mockProgress = { phase: 'downloading', done: 3, total: 10, fromInstanceId: 'inst-phone' };
    const renderer = render();
    expect(text(renderer)).toBe('Receiving history from Bob iOS · 3 of 10');
  });

  it('leaves the fraction out while the total is unknown', () => {
    mockProgress = { phase: 'importing', done: 0, total: 0, fromInstanceId: 'inst-phone' };
    const renderer = render();
    expect(text(renderer)).toBe('Receiving history from Bob iOS');
  });

  it('falls back to a generic line for a donor the instance list does not know', () => {
    mockProgress = { phase: 'downloading', done: 1, total: 4, fromInstanceId: 'inst-unknown' };
    const renderer = render();
    expect(text(renderer)).toBe('Receiving history from another device · 1 of 4');
    expect(text(renderer)).not.toContain('inst-unknown');
  });

  it('names the recipient while sending', () => {
    mockProgress = { phase: 'uploading', done: 2, total: 2, toInstanceId: 'inst-desk' };
    const renderer = render();
    expect(text(renderer)).toBe('Sending history to Bob desktop · 2 of 2');
  });

  it('goes away again once the transfer is over', () => {
    mockProgress = { phase: 'exporting', done: 0, total: 0, toInstanceId: 'inst-desk' };
    const renderer = render();
    expect(text(renderer)).toBe('Sending history to Bob desktop');
    mockProgress = { phase: 'idle', done: 0, total: 0 };
    act(() => {
      renderer.update(<HistoryTransferBanner />);
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
