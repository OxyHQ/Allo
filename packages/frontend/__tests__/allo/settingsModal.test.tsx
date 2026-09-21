import React from 'react';
import type { SettingsModalProps } from '@oxy.so/bloom/settings-modal';
import TestRenderer, { act } from 'react-test-renderer';
import { AlloSettingsProvider } from '@/components/settings/AlloSettingsProvider';
import { useAlloSettings, type AlloSettingsControl } from '@/components/settings/context';

const mockControl = { open: jest.fn(), close: jest.fn() };
let mockModal: SettingsModalProps;
const mockToast = jest.fn();
const mockTranslate = (key: string) => key;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockTranslate }) }));
jest.mock('@oxy.so/bloom/dialog', () => ({ useDialogControl: () => mockControl }));
jest.mock('@oxy.so/bloom/settings-modal', () => ({
  SettingsModal: (props: SettingsModalProps) => {
    mockModal = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: (...args: unknown[]) => mockToast(...args) } }));
jest.mock('@/components/settings/GeneralSettings', () => ({ GeneralSettings: () => null }));
jest.mock('@/components/settings/pages/appearance', () => () => null);
jest.mock('@/components/settings/pages/language', () => () => null);
jest.mock('@/components/settings/pages/privacy', () => () => null);
jest.mock('@/components/settings/pages/devices', () => () => null);
jest.mock('@/components/settings/pages/backup', () => () => null);
jest.mock('@/components/settings/pages/privacy/blocked', () => () => null);
jest.mock('@/components/settings/pages/privacy/restricted', () => () => null);
jest.mock('@/components/settings/pages/privacy/hidden-words', () => () => null);
jest.mock('@/components/settings/pages/privacy/profile-visibility', () => () => null);

let settings: AlloSettingsControl;
function Consumer() {
  settings = useAlloSettings();
  return null;
}

describe('Allo settings modal', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.resetAllMocks();
    act(() => {
      tree = TestRenderer.create(
        <AlloSettingsProvider>
          <Consumer />
        </AlloSettingsProvider>,
      );
    });
  });
  afterEach(() => act(() => tree.unmount()));

  it('opens a deep-linked page in the modal and keeps the existing navigator mounted', () => {
    act(() => settings.open('appearance'));
    expect(mockModal.page).toBe('appearance');
    expect(mockModal.initialView).toBe('page');
    expect(mockControl.open).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType(Consumer)).toBeDefined();
    act(() => mockModal.onPageChange?.('privacy'));
    expect(mockModal.page).toBe('privacy');
  });

  it('commits the compact destination before every open, including reopening the same page', () => {
    const observed: Array<[string | undefined, string | undefined]> = [];
    mockControl.open.mockImplementation(() => observed.push([mockModal.page, mockModal.initialView]));
    act(() => settings.open());
    act(() => settings.open('appearance'));
    act(() => settings.close());
    act(() => settings.open('appearance'));
    act(() => settings.open());
    expect(observed).toEqual([
      ['general', 'navigation'],
      ['appearance', 'page'],
      ['appearance', 'page'],
      ['general', 'navigation'],
    ]);
  });

  it('retains the recovery page until the phrase has been confirmed', () => {
    act(() => settings.open('backup'));
    act(() => settings.setPhrasePending(true));
    act(() => {
      settings.open('devices');
      settings.close();
      mockModal.onPageChange?.('general');
    });
    expect(mockModal.page).toBe('backup');
    for (const reason of ['close', 'navigation', 'page'] as const) {
      expect(mockModal.onBeforeLeave?.(reason)).toBe(false);
    }
    expect(mockControl.close).not.toHaveBeenCalled();
    expect(mockControl.open).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith('backup.phrase.mustConfirm');
    act(() => settings.setPhrasePending(false));
    expect(mockModal.onBeforeLeave?.('close')).toBe(true);
    const after = jest.fn();
    act(() => settings.close(after));
    expect(mockControl.close).toHaveBeenCalledWith(after);
  });
});
