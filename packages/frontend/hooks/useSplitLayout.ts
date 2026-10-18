import { useWindowDimensions } from 'react-native';

/**
 * Where the chat shell stops being one screen at a time and becomes a list
 * beside a conversation. The route uses this decision for both its navigator
 * and the panels it renders, so the two keep the same layout.
 */
export const SPLIT_FROM = 768;

/**
 * Where a third column fits: the list, the conversation and its info. Below
 * this the info is its own route, so the header's press always goes somewhere.
 */
export const INFO_FROM = 1100;

/** `true` when the list and the detail are on screen together. */
export function useSplitLayout(): boolean {
  return useWindowDimensions().width >= SPLIT_FROM;
}

/** `true` when the info pane can sit beside the conversation. */
export function useInfoPane(): boolean {
  return useWindowDimensions().width >= INFO_FROM;
}
