import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { BottomChromeProvider, useBottomChrome } from '@/context/BottomChromeContext';

jest.mock('@oxy.so/bloom/tab-bar', () => ({
  useTabBarFootprint: () => 82,
}));

function Probe() {
  const chrome = useBottomChrome();
  return <Text>{`${chrome.visible}:${chrome.contentClearance}`}</Text>;
}

describe('BottomChromeProvider', () => {
  it('removes the same bar footprint when bottom chrome is hidden', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BottomChromeProvider visible>
          <Probe />
        </BottomChromeProvider>,
      );
    });
    const mounted = renderer;
    if (mounted === undefined) throw new Error('renderer did not mount');
    expect(mounted.root.findByType(Text).props.children).toBe('true:94');

    act(() => {
      mounted.update(
        <BottomChromeProvider visible={false}>
          <Probe />
        </BottomChromeProvider>,
      );
    });
    expect(mounted.root.findByType(Text).props.children).toBe('false:0');
  });
});
