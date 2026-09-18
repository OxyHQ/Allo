/**
 * STORIES, HELD ON THIS DEVICE — NOTHING HERE REACHES THE NETWORK.
 *
 * A story is a broadcast to an audience, and Allo has neither the audience nor
 * the broadcast: `@allo/core` encrypts to a conversation's MLS group and
 * nothing else, so there is no envelope a status update could travel in and no
 * server that would keep one for twenty-four hours. This module is the seam a
 * transport replaces. To do that it has to supply four things: an upload that
 * turns a picked file into an encrypted blob and an author-signed slide
 * (`addSlides` becomes the OPTIMISTIC half of it, and the returned id replaces
 * the local one); a fetch of other people's slides, pushed in through
 * `setAuthor`; a media reader that turns a slide's ref into something drawable,
 * the way `lib/allo/useMediaUri.ts` does for a message; and a seen-state
 * receipt, because `markSeen` is currently a fact known only to this device and
 * everybody else's "who viewed" would be empty. Expiry is the app's decision
 * and stays here (`STORY_LIFETIME_MS`). Nothing in this module uploads,
 * downloads or persists anything: what is added lives in memory for as long as
 * the tab does, `DEMO_STORIES` is sample data that a transport deletes, and a
 * slide added from the picker is a local `file://` or `blob:` URI that is never
 * sent anywhere.
 */
import { create } from 'zustand';
import type { StoryRingState } from '@oxy.so/bloom/chat-indicators';

import type { AlloOutgoingAttachment } from '@/lib/chat/attachments';
import { SEED_DEMO_DATA } from './demo';

export type { StoryRingState };

/** Wording is the caller's; this file only decides which sentence to ask for. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One picture or clip in somebody's story. */
export interface StorySlide {
  readonly id: string;
  /**
   * Where the bytes are NOW: a `file://` path on a phone, a `blob:` URL in a
   * browser, or nothing at all for a sample slide that has no picture. Never a
   * remote URL — nothing here has uploaded anything.
   */
  readonly uri?: string;
  readonly kind: 'image' | 'video';
  readonly createdAt: number;
  /** How long the viewer holds on it. Bloom's default is 5 s. */
  readonly durationMs?: number;
  /** For a placeholder slide with no picture: one line drawn in its place. */
  readonly caption?: string;
}

/** Everything one account has posted, and what this device has watched. */
export interface StoryAuthor {
  readonly accountId: string;
  /** Oldest first, the order a viewer plays them in. */
  readonly slides: readonly StorySlide[];
  /** The ids this device has watched. Local only until a receipt exists. */
  readonly seen: readonly string[];
}

export interface StoriesState {
  readonly byAccountId: Readonly<Record<string, StoryAuthor>>;
  /** Insertion order of the authors, so a re-render does not reshuffle the row. */
  readonly order: readonly string[];
  /** Appends to an author's story, creating it when this is their first. */
  addSlides: (accountId: string, slides: readonly StorySlide[]) => void;
  /** Replaces one author wholesale — what a transport's fetch would do. */
  setAuthor: (author: StoryAuthor) => void;
  markSeen: (accountId: string, slideId: string) => void;
  markAllSeen: (accountId: string) => void;
  /** Removes one of your own slides. Removing the last one removes the author. */
  removeSlide: (accountId: string, slideId: string) => void;
  clear: () => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long a story is meant to live. Nothing enforces it yet; the screen says so. */
export const STORY_LIFETIME_MS = 24 * HOUR;

/**
 * SAMPLE DATA. The ids are the local harness's fake accounts
 * (`harness/oxy-services.tsx`), and no slide carries a picture — there is
 * nothing to carry one, and inventing a photograph for a person who posted none
 * is the one thing a placeholder must not do. A transport deletes this and the
 * store starts empty.
 */
export const DEMO_STORIES: readonly StoryAuthor[] = Object.freeze([
  {
    accountId: '6700000000000000000000a2',
    slides: [
      { id: 'demo-a2-1', kind: 'image', createdAt: Date.now() - 40 * MINUTE },
      { id: 'demo-a2-2', kind: 'image', createdAt: Date.now() - 25 * MINUTE },
    ],
    seen: [],
  },
  {
    accountId: '6700000000000000000000a4',
    slides: [{ id: 'demo-a4-1', kind: 'image', createdAt: Date.now() - 3 * HOUR }],
    seen: [],
  },
  {
    accountId: '6700000000000000000000a3',
    slides: [{ id: 'demo-a3-1', kind: 'image', createdAt: Date.now() - 9 * HOUR }],
    seen: ['demo-a3-1'],
  },
]);

let counter = 0;

/** A local id. The slide never leaves the device, so it only has to be unique here. */
function localId(): string {
  counter += 1;
  return `local-${Date.now().toString(36)}-${counter}`;
}

/** What the picker chose, as slides. `lib/chat/attachments.ts` owns the picking. */
export function slidesFromAttachments(
  attachments: readonly AlloOutgoingAttachment[],
  now = Date.now(),
): StorySlide[] {
  return attachments
    .filter((attachment) => attachment.kind === 'image' || attachment.kind === 'video')
    .map((attachment) => ({
      id: localId(),
      uri: attachment.uri,
      kind: attachment.kind === 'video' ? ('video' as const) : ('image' as const),
      createdAt: now,
      durationMs: attachment.kind === 'video' ? attachment.durationMs : undefined,
    }));
}

const demoRecord: Record<string, StoryAuthor> = {};
for (const author of DEMO_STORIES) demoRecord[author.accountId] = author;

export const useStoriesStore = create<StoriesState>((set) => ({
  byAccountId: SEED_DEMO_DATA ? { ...demoRecord } : {},
  order: SEED_DEMO_DATA ? DEMO_STORIES.map((author) => author.accountId) : [],

  addSlides: (accountId, slides) =>
    set((state) => {
      if (slides.length === 0) return state;
      const existing = state.byAccountId[accountId];
      const author: StoryAuthor = {
        accountId,
        slides: [...(existing?.slides ?? []), ...slides],
        seen: existing?.seen ?? [],
      };
      return {
        byAccountId: { ...state.byAccountId, [accountId]: author },
        order: state.order.includes(accountId) ? state.order : [...state.order, accountId],
      };
    }),

  setAuthor: (author) =>
    set((state) => ({
      byAccountId: { ...state.byAccountId, [author.accountId]: author },
      order: state.order.includes(author.accountId)
        ? state.order
        : [...state.order, author.accountId],
    })),

  markSeen: (accountId, slideId) =>
    set((state) => {
      const author = state.byAccountId[accountId];
      if (!author || author.seen.includes(slideId)) return state;
      return {
        byAccountId: {
          ...state.byAccountId,
          [accountId]: { ...author, seen: [...author.seen, slideId] },
        },
      };
    }),

  markAllSeen: (accountId) =>
    set((state) => {
      const author = state.byAccountId[accountId];
      if (!author) return state;
      const seen = author.slides.map((slide) => slide.id);
      if (seen.length === author.seen.length) return state;
      return { byAccountId: { ...state.byAccountId, [accountId]: { ...author, seen } } };
    }),

  removeSlide: (accountId, slideId) =>
    set((state) => {
      const author = state.byAccountId[accountId];
      if (!author) return state;
      const slides = author.slides.filter((slide) => slide.id !== slideId);
      if (slides.length === author.slides.length) return state;
      if (slides.length === 0) {
        const byAccountId = { ...state.byAccountId };
        delete byAccountId[accountId];
        return { byAccountId, order: state.order.filter((id) => id !== accountId) };
      }
      return {
        byAccountId: {
          ...state.byAccountId,
          [accountId]: { ...author, slides, seen: author.seen.filter((id) => id !== slideId) },
        },
      };
    }),

  clear: () => set({ byAccountId: {}, order: [] }),
}));

/** Every author, by id. A stable reference: derive with `useMemo` in a screen. */
export function useStoryAuthors(): Readonly<Record<string, StoryAuthor>> {
  return useStoriesStore((state) => state.byAccountId);
}

/** The order authors arrived in. Stable; `sortStories` in Bloom reorders the row. */
export function useStoryOrder(): readonly string[] {
  return useStoriesStore((state) => state.order);
}

/** One author's story, or `undefined` when they have none. */
export function useStoryAuthor(accountId: string | undefined): StoryAuthor | undefined {
  return useStoriesStore((state) => (accountId ? state.byAccountId[accountId] : undefined));
}

/**
 * The ring around an avatar.
 *
 * `'none'` is not "no ring drawn somewhere else" — Bloom keeps the footprint,
 * so a row where one person has posted nothing does not shift by 8px.
 */
export function ringState(author: StoryAuthor | undefined): StoryRingState {
  if (!author || author.slides.length === 0) return 'none';
  return author.slides.some((slide) => !author.seen.includes(slide.id)) ? 'unseen' : 'seen';
}

/**
 * Where a viewer opens: the first slide this device has not watched, or the
 * first one when they have all been watched. Opening a re-watched story at the
 * end would show the last frame and close itself.
 */
export function firstUnseenIndex(author: StoryAuthor | undefined): number {
  if (!author || author.slides.length === 0) return 0;
  const index = author.slides.findIndex((slide) => !author.seen.includes(slide.id));
  return index === -1 ? 0 : index;
}

/** When the newest slide was posted, for ordering the row. `0` for nobody. */
export function latestAt(author: StoryAuthor | undefined): number {
  if (!author || author.slides.length === 0) return 0;
  return Math.max(...author.slides.map((slide) => slide.createdAt));
}

/** Authors with something to show, newest first. */
export function activeAuthors(
  byAccountId: Readonly<Record<string, StoryAuthor>>,
  order: readonly string[],
): StoryAuthor[] {
  return order
    .map((accountId) => byAccountId[accountId])
    .filter((author): author is StoryAuthor => author !== undefined && author.slides.length > 0)
    .sort((a, b) => latestAt(b) - latestAt(a));
}

/**
 * How old a slide is, in the short form a story viewer wears — `"now"`,
 * `"12 min"`, `"3 h"`, `"1 d"`.
 *
 * Pure, and takes `now`, so a test can hold the clock still.
 */
export function storyAgeLabel(createdAt: number, now: number, t: Translate): string {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < MINUTE) return t('stories.age.now');
  if (elapsed < HOUR) return t('stories.age.minutes', { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < 24 * HOUR) return t('stories.age.hours', { count: Math.floor(elapsed / HOUR) });
  return t('stories.age.days', { count: Math.floor(elapsed / (24 * HOUR)) });
}
