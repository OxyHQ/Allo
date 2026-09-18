/**
 * Stories, held on this device.
 *
 * What is pinned here is the part a transport inherits: what a ring means, where
 * a viewer opens, how the picker's output becomes slides, and the seen state
 * that is currently a fact only this device knows. Rendering is checked in a
 * browser — a Bloom chat surface under jest dies in reanimated's worklets.
 */
import {
  activeAuthors,
  firstUnseenIndex,
  latestAt,
  ringState,
  slidesFromAttachments,
  storyAgeLabel,
  useStoriesStore,
  type StoryAuthor,
} from '@/lib/phase2/stories';
import type { AlloOutgoingAttachment } from '@/lib/chat/attachments';
import en from '@/locales/en.json';

const ANA = '6700000000000000000000a2';
const TEODOR = '6700000000000000000000a3';
const ME = '6700000000000000000000a1';

const store = () => useStoriesStore.getState();

function author(overrides: Partial<StoryAuthor> = {}): StoryAuthor {
  return {
    accountId: ANA,
    slides: [
      { id: 's1', kind: 'image', createdAt: 1_000 },
      { id: 's2', kind: 'image', createdAt: 2_000 },
    ],
    seen: [],
    ...overrides,
  };
}

beforeEach(() => {
  useStoriesStore.setState({ byAccountId: {}, order: [] });
});

describe('ringState', () => {
  it('keeps "nothing posted" apart from "everything watched"', () => {
    // Bloom draws `none` with the same footprint as a ring, so a row does not
    // shift when somebody posts — but it must not look watched either.
    expect(ringState(undefined)).toBe('none');
    expect(ringState(author({ slides: [] }))).toBe('none');
    expect(ringState(author())).toBe('unseen');
    expect(ringState(author({ seen: ['s1'] }))).toBe('unseen');
    expect(ringState(author({ seen: ['s1', 's2'] }))).toBe('seen');
  });
});

describe('firstUnseenIndex', () => {
  it('opens at the first unwatched slide', () => {
    expect(firstUnseenIndex(author({ seen: ['s1'] }))).toBe(1);
  });

  it('reopens a fully watched story at the beginning, not past the end', () => {
    // Opening at the end would show the last frame and close itself.
    expect(firstUnseenIndex(author({ seen: ['s1', 's2'] }))).toBe(0);
    expect(firstUnseenIndex(author({ slides: [] }))).toBe(0);
    expect(firstUnseenIndex(undefined)).toBe(0);
  });
});

describe('activeAuthors', () => {
  it('drops anyone with nothing to show and orders by the newest slide', () => {
    const byAccountId = {
      [ANA]: author({ accountId: ANA, slides: [{ id: 'a', kind: 'image' as const, createdAt: 10 }] }),
      [TEODOR]: author({
        accountId: TEODOR,
        slides: [{ id: 'b', kind: 'image' as const, createdAt: 50 }],
      }),
      [ME]: author({ accountId: ME, slides: [] }),
    };

    expect(activeAuthors(byAccountId, [ANA, TEODOR, ME]).map((one) => one.accountId)).toEqual([
      TEODOR,
      ANA,
    ]);
  });

  it('ignores an id in the order that has no author', () => {
    expect(activeAuthors({}, [ANA])).toEqual([]);
  });
});

describe('latestAt', () => {
  it('is the newest slide, whatever order they are in', () => {
    expect(latestAt(author())).toBe(2_000);
    expect(latestAt(author({ slides: [] }))).toBe(0);
    expect(latestAt(undefined)).toBe(0);
  });
});

describe('storyAgeLabel', () => {
  /**
   * The REAL English from the shipped bundle, interpolated.
   *
   * Reading `locales/en.json` rather than inlining the copy means a key this
   * module asks for that the bundle does not carry fails HERE — loudly — instead
   * of reaching a screen as a raw dotted key.
   */
  const t = (key: string, options: Record<string, unknown> = {}): string => {
    const template = (en as Record<string, string>)[key];
    if (template === undefined) throw new Error(`missing i18n key: ${key}`);
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
  };

  it('walks the units up as it ages', () => {
    const now = 1_000_000_000;
    expect(storyAgeLabel(now - 5_000, now, t)).toBe('now');
    expect(storyAgeLabel(now - 12 * 60_000, now, t)).toBe('12 min');
    expect(storyAgeLabel(now - 3 * 3_600_000, now, t)).toBe('3 h');
    expect(storyAgeLabel(now - 50 * 3_600_000, now, t)).toBe('2 d');
  });

  it('does not go negative for a clock that has slipped', () => {
    expect(storyAgeLabel(2_000, 1_000, t)).toBe('now');
  });
});

describe('slidesFromAttachments', () => {
  const attachment = (overrides: Partial<AlloOutgoingAttachment>): AlloOutgoingAttachment => ({
    kind: 'image',
    filename: 'a.jpg',
    mimetype: 'image/jpeg',
    uri: 'file:///a.jpg',
    ...overrides,
  });

  it('takes pictures and clips and leaves everything else', () => {
    const slides = slidesFromAttachments(
      [
        attachment({ kind: 'image', uri: 'file:///a.jpg' }),
        attachment({ kind: 'video', uri: 'file:///b.mp4', durationMs: 4_000 }),
        attachment({ kind: 'file', uri: 'file:///c.pdf' }),
        attachment({ kind: 'voice', uri: 'file:///d.m4a' }),
      ],
      5_000,
    );

    expect(slides.map((slide) => slide.kind)).toEqual(['image', 'video']);
    expect(slides[0].uri).toBe('file:///a.jpg');
    expect(slides[1].durationMs).toBe(4_000);
    expect(slides.every((slide) => slide.createdAt === 5_000)).toBe(true);
  });

  it('gives every slide its own id', () => {
    const slides = slidesFromAttachments([
      attachment({ uri: 'file:///a.jpg' }),
      attachment({ uri: 'file:///b.jpg' }),
    ]);
    expect(new Set(slides.map((slide) => slide.id)).size).toBe(2);
  });
});

describe('the store', () => {
  const slide = (id: string, createdAt = 1_000) => ({ id, kind: 'image' as const, createdAt });

  it('creates an author on their first slide and appends to it afterwards', () => {
    store().addSlides(ANA, [slide('s1')]);
    store().addSlides(ANA, [slide('s2', 2_000)]);

    expect(store().byAccountId[ANA].slides.map((one) => one.id)).toEqual(['s1', 's2']);
    expect(store().order).toEqual([ANA]);
  });

  it('adds nothing for an empty pick', () => {
    store().addSlides(ANA, []);
    expect(store().order).toEqual([]);
  });

  it('marks one slide seen, and says so only once', () => {
    store().addSlides(ANA, [slide('s1'), slide('s2')]);
    store().markSeen(ANA, 's1');
    store().markSeen(ANA, 's1');
    expect(store().byAccountId[ANA].seen).toEqual(['s1']);
    expect(ringState(store().byAccountId[ANA])).toBe('unseen');

    store().markAllSeen(ANA);
    expect(ringState(store().byAccountId[ANA])).toBe('seen');
  });

  it('ignores seen state for somebody it does not know', () => {
    store().markSeen(ANA, 's1');
    store().markAllSeen(ANA);
    expect(store().byAccountId[ANA]).toBeUndefined();
  });

  it('removing the last slide removes the author from the row', () => {
    store().addSlides(ANA, [slide('s1'), slide('s2')]);
    store().removeSlide(ANA, 's1');
    expect(store().byAccountId[ANA].slides.map((one) => one.id)).toEqual(['s2']);

    store().removeSlide(ANA, 's2');
    expect(store().byAccountId[ANA]).toBeUndefined();
    expect(store().order).toEqual([]);
  });

  it('replaces an author wholesale, which is what a fetch would do', () => {
    store().addSlides(ANA, [slide('s1')]);
    store().setAuthor({ accountId: ANA, slides: [slide('fresh', 9_000)], seen: ['fresh'] });

    expect(store().byAccountId[ANA].slides.map((one) => one.id)).toEqual(['fresh']);
    expect(store().order).toEqual([ANA]);
  });
});
