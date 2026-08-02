import {
  backdropOpacity,
  clampPan,
  clampZoom,
  doubleTapZoom,
  focalTranslation,
  isZoomedIn,
  panBound,
  shouldDismiss,
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
} from '@/components/media/zoom';

/**
 * The arithmetic the viewer's gestures run on.
 *
 * It is tested rather than looked at because every one of these can be wrong in
 * a way that is invisible in a screenshot and obvious in the hand: a pan bound
 * that is twice what it should be lets a photograph be dragged off the screen
 * and left there, a focal formula that is off makes a pinch crawl away from the
 * fingers, and a dismissal threshold that never triggers makes the viewer feel
 * stuck.
 */

describe('how far in a pinch goes', () => {
  it('leaves a scale inside the range alone', () => {
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it('will not let a picture be smaller than the screen shows it', () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
  });

  it('stops at the far end rather than drawing one pixel across the screen', () => {
    expect(clampZoom(400)).toBe(MAX_ZOOM);
  });

  it('refuses a scale that is not a number', () => {
    // Two touches landing on the same pixel report a ratio of NaN. Left alone
    // it poisons the shared value and the picture freezes until dismissal.
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('honours a range the caller gives it', () => {
    expect(clampZoom(6, 2, 4)).toBe(4);
  });
});

describe('how far a magnified picture may be dragged', () => {
  it('is nothing at all when the content fits', () => {
    // At rest there is no overflow, and a picture that can be dragged at rest
    // slides out from under the finger with nothing to bring it back.
    expect(panBound(400, 1, 400)).toBe(0);
  });

  it('is half the overflow, because the content is centred', () => {
    // 400 points of content at 2× is 800 across a 400-point viewport: 400 of
    // overflow, 200 either side.
    expect(panBound(400, 2, 400)).toBe(200);
  });

  it('is nothing when the content is smaller than the viewport', () => {
    expect(panBound(200, 1, 400)).toBe(0);
  });

  it('holds a translation inside the bound', () => {
    expect(clampPan(500, 200)).toBe(200);
    expect(clampPan(-500, 200)).toBe(-200);
  });

  it('leaves a translation inside the bound alone', () => {
    expect(clampPan(-73, 200)).toBe(-73);
  });

  it('recentres a translation that is not a number', () => {
    expect(clampPan(Number.NaN, 200)).toBe(0);
  });
});

describe('keeping the point under the fingers under the fingers', () => {
  it('does not move the content when the scale does not change', () => {
    expect(focalTranslation(30, 100, 2, 2)).toBe(30);
  });

  it('holds the pinched point still while the scale doubles', () => {
    // A content point sits on screen at `translation + scale · p`. Pinching
    // from 1× to 2× about the screen centre, with the content centred, the
    // point at the centre is the content's own centre and must not move.
    expect(focalTranslation(0, 0, 1, 2)).toBe(0);
  });

  it('moves the content away from a focal point that is off-centre', () => {
    // Focal 100 points right of centre, doubling: the content point under it
    // was at 100, and at 2× it would land at 200, so the content slides left by
    // 100 to leave it where it was.
    expect(focalTranslation(0, 100, 1, 2)).toBe(-100);
  });

  it('is its own inverse: zooming back out puts it where it started', () => {
    const zoomedIn = focalTranslation(0, 137, 1, 3);

    expect(focalTranslation(zoomedIn, 137, 3, 1)).toBeCloseTo(0, 10);
  });

  it('refuses to divide by a scale of zero', () => {
    expect(focalTranslation(42, 100, 0, 2)).toBe(42);
  });
});

describe('a double tap', () => {
  it('zooms in from rest', () => {
    expect(doubleTapZoom(MIN_ZOOM)).toBe(DOUBLE_TAP_ZOOM);
  });

  it('fits back from anywhere zoomed in', () => {
    expect(doubleTapZoom(4)).toBe(MIN_ZOOM);
  });

  it('fits back rather than going further in from a small pinch', () => {
    // The only reading of the gesture that always offers a way out. Treating
    // 1.4 as "not zoomed yet" would strand a user who pinched slightly.
    expect(doubleTapZoom(1.4)).toBe(MIN_ZOOM);
  });
});

describe('whether the picture counts as zoomed in', () => {
  it('is false at rest', () => {
    expect(isZoomedIn(MIN_ZOOM)).toBe(false);
  });

  it('is false for floating-point dust left by a pinch that ended at rest', () => {
    // This decides whether a drag turns the page or moves the picture. A
    // residue of 1.000001 would silently disable paging for the whole gallery.
    expect(isZoomedIn(1.000001)).toBe(false);
  });

  it('is true once the picture is actually bigger', () => {
    expect(isZoomedIn(1.5)).toBe(true);
  });
});

describe('letting go of a drag towards dismissal', () => {
  it('holds on for a short slow drag', () => {
    expect(shouldDismiss(40, 100)).toBe(false);
  });

  it('closes on a long drag', () => {
    expect(shouldDismiss(DISMISS_DISTANCE + 1, 0)).toBe(true);
  });

  it('closes on a flick that never travelled far', () => {
    // A flick is short and fast. Distance alone would spring it back, which
    // reads as the viewer refusing to close.
    expect(shouldDismiss(30, DISMISS_VELOCITY + 1)).toBe(true);
  });

  it('closes upwards exactly as it closes downwards', () => {
    // Requiring a direction leaves a user who swiped the wrong way with a
    // picture that springs back for no visible reason.
    expect(shouldDismiss(-(DISMISS_DISTANCE + 1), 0)).toBe(true);
    expect(shouldDismiss(-30, -(DISMISS_VELOCITY + 1))).toBe(true);
  });
});

describe('the backdrop during a dismissal', () => {
  it('is opaque before the drag starts', () => {
    expect(backdropOpacity(0)).toBe(1);
  });

  it('fades as the drag goes on', () => {
    expect(backdropOpacity(150)).toBeLessThan(1);
  });

  it('fades the same amount in either direction', () => {
    expect(backdropOpacity(-150)).toBe(backdropOpacity(150));
  });

  it('never goes clear, so the picture stays readable on the way out', () => {
    expect(backdropOpacity(10_000)).toBeGreaterThan(0.3);
  });

  it('stays opaque rather than dividing by a fade distance of zero', () => {
    expect(backdropOpacity(50, 0)).toBe(1);
  });
});
