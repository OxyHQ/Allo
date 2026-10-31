import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockLocales: Record<string, Record<string, string>> = {
  en: require('../../locales/en.json'),
  es: require('../../locales/es.json'),
  it: require('../../locales/it.json'),
};
let mockLocale = 'en';
const mockOpen = jest.fn();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockLocales[mockLocale][key] ?? key }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ showBottomSheet: mockOpen }) }));
jest.mock('@oxy.so/bloom/chat-screen', () => ({
  ChatEmptyState: ({ title, description }: { title: string; description: string }) => {
    const React = require('react');
    const { Text } = require('react-native');
    return React.createElement(Text, { testID: 'message' }, [title, ' ', description]);
  },
}));
jest.mock('@oxy.so/bloom/icon-circle', () => ({ IconCircle: () => null }));
jest.mock('@oxy.so/bloom/icons/RiShieldLine', () => ({ RiShieldLine: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));

const { ConversationAccessState } =
  require('@/lib/allo/ConversationAccessState') as typeof import('@/lib/allo/ConversationAccessState');

it.each(['en', 'es', 'it'])(
  'announces the localized explanation without offering an unverified action (%s)',
  async (locale) => {
    mockLocale = locale;
    mockOpen.mockClear();
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<ConversationAccessState state="session-unverified" />);
    });
    const alert = tree!.root.findByProps({ accessibilityRole: 'alert' });
    expect(alert.props.accessibilityState).toEqual({ busy: false });
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
    const text = tree!.root.findByProps({ testID: 'message' }).props.children.join('');
    expect(text).toContain(mockLocales[locale]['session.unverified.title']);
    expect(text).toContain(mockLocales[locale]['session.unverified.body']);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(tree!.root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(0);
    await act(async () => tree!.unmount());
  },
);

it('resolves both explanation keys through i18next in every bundled language', async () => {
  const i18next = require('i18next') as typeof import('i18next');
  for (const locale of ['en', 'es', 'it']) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale,
      resources: { [locale]: { translation: mockLocales[locale] } },
    });
    expect(instance.t('session.unverified.title')).toBe(
      mockLocales[locale]['session.unverified.title'],
    );
    expect(instance.t('session.unverified.body')).toBe(
      mockLocales[locale]['session.unverified.body'],
    );
  }
});
