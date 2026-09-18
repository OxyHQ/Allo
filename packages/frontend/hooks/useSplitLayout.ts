import { useWindowDimensions } from 'react-native';

/**
 * Where the chat shell stops being one screen at a time and becomes a list
 * beside a conversation. The same number as `AppShell`'s `splitFrom` (`md`), so
 * the route layout and the shell never disagree about which layout is showing.
 */
export const SPLIT_FROM = 768;

/** `true` when the list and the detail are on screen together. */
export function useSplitLayout(): boolean {
  return useWindowDimensions().width >= SPLIT_FROM;
}
