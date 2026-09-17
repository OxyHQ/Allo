import type { LoadOlderResult, SendOptions, TimelineItemView, UploadMediaMeta } from "@allo/core";
import { useCallback, useMemo, useState } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export const DEFAULT_TIMELINE_PAGE_SIZE = 50;

export interface TimelineOptions {
  /** Items shown before the first `loadOlder()`. Default 50. */
  pageSize?: number;
}

export interface Timeline {
  /** Oldest first. The newest `pageSize` items until `loadOlder()` widens the window. */
  items: TimelineItemView[];
  /** True when nothing older can be shown: history before this device joined is not decryptable. */
  reachedStart: boolean;
  loadOlder(): Promise<LoadOlderResult>;
  /** Resolves to the local key of the echo; the item turns `accepted` once the server has it. */
  send(text: string, options?: SendOptions): Promise<string>;
  /** Encrypts and uploads, then sends the `media` message. Resolves to the local key. */
  sendMedia(bytes: Uint8Array, meta: UploadMediaMeta): Promise<string>;
  edit(targetId: string, body: string): Promise<void>;
  remove(targetId: string): Promise<void>;
  /** Toggles: reacting with a key this account already set removes it. */
  react(targetId: string, key: string): Promise<void>;
  markRead(): Promise<void>;
  setTyping(on: boolean): Promise<void>;
  /** Whether another member is typing. */
  typing: boolean;
}

/**
 * The timeline of one conversation plus its actions. Subscribes to
 * `timeline:<id>` and `typing:<id>`. The window is anchored at its oldest
 * shown item, so new messages extend it at the new end rather than pushing
 * older ones out; `loadOlder()` moves the anchor back a page.
 */
export function useTimeline(conversationId: string, options?: TimelineOptions): Timeline {
  const { client } = useAlloContext();
  const pageSize = options?.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE;
  const timeline = useClientSnapshot(client, `timeline:${conversationId}`, () => client.messages.timeline(conversationId));
  const typing = useClientSnapshot(client, `typing:${conversationId}`, () => client.messages.isTyping(conversationId));

  // The oldest item shown, per conversation, so switching conversations resets the window.
  const [anchor, setAnchor] = useState<{ conversationId: string; id: string } | null>(null);
  const anchorId = anchor?.conversationId === conversationId ? anchor.id : null;

  const items = useMemo(() => {
    if (anchorId !== null) {
      const index = timeline.findIndex((i) => i.id === anchorId || i.localKey === anchorId);
      if (index <= 0) return timeline;
      return timeline.slice(index);
    }
    return timeline.length <= pageSize ? timeline : timeline.slice(timeline.length - pageSize);
  }, [timeline, anchorId, pageSize]);
  const reachedStart = items.length >= timeline.length;

  // Core's `loadOlder` takes no limit and answers with up to its own page (50); the hook keeps the newest `pageSize` of it.
  const loadOlder = useCallback(async (): Promise<LoadOlderResult> => {
    const oldest = items[0];
    const result = await client.messages.loadOlder(conversationId, oldest ? (oldest.localKey ?? oldest.id) : undefined);
    const page = result.items.length > pageSize ? result.items.slice(result.items.length - pageSize) : result.items;
    const first = page[0] ?? oldest;
    if (first) setAnchor({ conversationId, id: first.localKey ?? first.id });
    return { items: page, reachedStart: result.reachedStart && page.length === result.items.length };
  }, [client, conversationId, items, pageSize]);

  const send = useCallback((text: string, sendOptions?: SendOptions) => client.messages.send(conversationId, text, sendOptions), [client, conversationId]);
  const sendMedia = useCallback((bytes: Uint8Array, meta: UploadMediaMeta) => client.media.upload(conversationId, bytes, meta), [client, conversationId]);
  const edit = useCallback((targetId: string, body: string) => client.messages.edit(conversationId, targetId, body), [client, conversationId]);
  const remove = useCallback((targetId: string) => client.messages.remove(conversationId, targetId), [client, conversationId]);
  const react = useCallback((targetId: string, key: string) => client.messages.react(conversationId, targetId, key), [client, conversationId]);
  const markRead = useCallback(() => client.messages.markRead(conversationId), [client, conversationId]);
  const setTyping = useCallback((on: boolean) => client.messages.setTyping(conversationId, on), [client, conversationId]);

  return useMemo(
    () => ({ items, reachedStart, loadOlder, send, sendMedia, edit, remove, react, markRead, setTyping, typing }),
    [items, reachedStart, loadOlder, send, sendMedia, edit, remove, react, markRead, setTyping, typing],
  );
}
