import {
  isWithinViewerWindow,
  nextPageIndex,
  pageOffset,
  VIEWER_WINDOW_RADIUS,
} from '@/components/media/pager';

/**
 * Where a swipe leaves the gallery, and what the gallery builds.
 *
 * The second half is not cosmetic. Asking the resolver for a page's URL is what
 * starts its download — the media cache fetches and decrypts on read — so a
 * viewer that built every page would pull a whole conversation's photographs
 * over the network the moment somebody tapped one of them. The window is the
 * only thing that stops it, so it is tested like a correctness property, because
 * it is one.
 */

const PAGE = 400;

describe('where the row of pages sits', () => {
  it('puts the first page at rest', () => {
    expect(pageOffset(0, PAGE)).toBe(0);
  });

  it('moves left by one page width per page', () => {
    expect(pageOffset(3, PAGE)).toBe(-1200);
  });
});

describe('where a swipe lands', () => {
  it('springs back when the drag was too short and too slow', () => {
    expect(nextPageIndex(1, 40, 50, PAGE, 5)).toBe(1);
  });

  it('goes forward when the drag crossed enough of the page', () => {
    // Dragging the content left moves forward through the gallery.
    expect(nextPageIndex(1, -200, 0, PAGE, 5)).toBe(2);
  });

  it('goes back when the drag went the other way', () => {
    expect(nextPageIndex(1, 200, 0, PAGE, 5)).toBe(0);
  });

  it('turns on a flick that never crossed the page', () => {
    expect(nextPageIndex(1, -30, -1200, PAGE, 5)).toBe(2);
  });

  it('turns one page however enthusiastic the swipe was', () => {
    // Skipping two loses the picture the reader was going for, and there is no
    // gesture that goes back by two.
    expect(nextPageIndex(0, -3 * PAGE, -6000, PAGE, 5)).toBe(1);
  });

  it('springs back at the end of the gallery', () => {
    expect(nextPageIndex(4, -300, -2000, PAGE, 5)).toBe(4);
  });

  it('springs back at the beginning of the gallery', () => {
    expect(nextPageIndex(0, 300, 2000, PAGE, 5)).toBe(0);
  });

  it('stays put before the pager has been measured', () => {
    // `onLayout` has not run yet: with a page width of zero every drag would
    // otherwise read as a full page and the first touch would turn the page.
    expect(nextPageIndex(2, -5, 0, 0, 5)).toBe(2);
  });

  it('answers the first page for an empty gallery', () => {
    expect(nextPageIndex(3, -300, 0, PAGE, 0)).toBe(0);
  });
});

describe('which pages are built', () => {
  it('builds the page on screen', () => {
    expect(isWithinViewerWindow(4, 4)).toBe(true);
  });

  it('builds the neighbours, so a swipe lands on something', () => {
    expect(isWithinViewerWindow(3, 4)).toBe(true);
    expect(isWithinViewerWindow(5, 4)).toBe(true);
  });

  it('does not build the rest of the conversation', () => {
    // The property that keeps a tap on one photograph costing one photograph.
    expect(isWithinViewerWindow(6, 4)).toBe(false);
    expect(isWithinViewerWindow(0, 4)).toBe(false);
  });

  it('keeps the window small', () => {
    // A radius that crept up would download a screenful of originals per tap,
    // and nothing on screen would show it happening.
    expect(VIEWER_WINDOW_RADIUS).toBe(1);
  });

  it('honours a radius the caller gives it', () => {
    expect(isWithinViewerWindow(6, 4, 2)).toBe(true);
  });
});
