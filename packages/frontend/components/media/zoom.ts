/**
 * The arithmetic behind pinch-zoom, pan and swipe-to-dismiss.
 *
 * Separate from the gestures that call it because it is the part that can be
 * wrong in ways nobody sees: a pan bound that is half what it should be lets a
 * photograph be dragged off the screen, and a focal formula that is subtly off
 * makes a pinch drift away from the fingers doing it. Neither shows up in a
 * screenshot and both are ordinary arithmetic, so they are tested as arithmetic.
 *
 * **Every function here is a worklet.** They run on the UI thread inside
 * `react-native-gesture-handler` callbacks and `useAnimatedStyle`, where a plain
 * JavaScript function cannot be called. The directive is what makes them
 * shareable; they stay ordinary callable functions everywhere else, which is why
 * a test can call them directly.
 *
 * The coordinate system throughout: **offsets are measured from the centre of
 * the viewport**, positive right and down, in the same points as the gestures
 * report. Content is centred at rest, so translation zero is the picture
 * centred and scale one is the picture fitted.
 */

/** Fitted. A picture is never allowed to be smaller than the screen shows it. */
export const MIN_ZOOM = 1;

/**
 * As far in as a pinch goes.
 *
 * Past this a phone photograph is drawing one source pixel across eight, which
 * is a blur nobody asked for, and the pan bounds grow faster than a thumb can
 * usefully cross them.
 */
export const MAX_ZOOM = 5;

/** Where a double tap lands. Enough to read a face or a sign, and to fit back. */
export const DOUBLE_TAP_ZOOM = 2.5;

/**
 * Scale, kept inside what the viewer allows.
 *
 * A pinch reports a continuous ratio and will happily go to 0.02 or 400; both
 * ends have to be caught before they reach a transform, because a scale of zero
 * makes the picture vanish with no gesture that brings it back.
 */
export function clampZoom(scale: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  'worklet';
  if (!Number.isFinite(scale)) {
    // A pinch that reports NaN — two touches landing on the same pixel — would
    // otherwise poison the shared value and freeze the picture until dismissal.
    return min;
  }
  return scale < min ? min : scale > max ? max : scale;
}

/**
 * How far the content may be dragged along one axis before its edge would come
 * inside the viewport.
 *
 * Half the overflow, because the content is centred: at scale 1 with content
 * exactly the size of the viewport it is zero, and nothing moves.
 */
export function panBound(contentExtent: number, scale: number, viewportExtent: number): number {
  'worklet';
  const overflow = contentExtent * scale - viewportExtent;
  return overflow > 0 ? overflow / 2 : 0;
}

/** A translation, kept within {@link panBound}. */
export function clampPan(translation: number, bound: number): number {
  'worklet';
  if (!Number.isFinite(translation)) {
    return 0;
  }
  return translation < -bound ? -bound : translation > bound ? bound : translation;
}

/**
 * Where the content has to move so the point under the fingers stays under
 * them.
 *
 * A pinch that scales about the centre of the screen slides whatever is being
 * looked at out from under the gesture, which reads as the picture fighting
 * back. Keeping the focal point fixed is one line of algebra: a content point
 * `p` sits at `translation + scale · p`, so holding that sum constant across a
 * change of scale gives
 *
 *     translation' = focal − (scale' / scale) · (focal − translation)
 */
export function focalTranslation(
  translation: number,
  focalOffset: number,
  previousScale: number,
  nextScale: number,
): number {
  'worklet';
  if (previousScale <= 0) {
    return translation;
  }
  return focalOffset - (nextScale / previousScale) * (focalOffset - translation);
}

/**
 * The scale a double tap goes to.
 *
 * A toggle, and it treats anything above the resting scale as "zoomed in": a
 * double tap on a picture the user has pinched to 1.4 fits it back rather than
 * jumping further in, which is the only reading of the gesture that always
 * offers a way out.
 */
export function doubleTapZoom(
  currentScale: number,
  min = MIN_ZOOM,
  target = DOUBLE_TAP_ZOOM,
): number {
  'worklet';
  return currentScale > min ? min : target;
}

/** Whether a scale counts as zoomed in, allowing for floating-point drift. */
export function isZoomedIn(scale: number, min = MIN_ZOOM): boolean {
  'worklet';
  return scale > min + 0.01;
}

/** Past this many points of vertical drag, letting go closes the viewer. */
export const DISMISS_DISTANCE = 120;

/**
 * Or past this speed, in points per second.
 *
 * A flick is a short, fast drag and never reaches the distance; without this it
 * would spring back, which reads as the viewer refusing to close.
 */
export const DISMISS_VELOCITY = 900;

/** How far the drag has to go for the backdrop to reach its faintest. */
export const DISMISS_FADE_DISTANCE = 300;

/** The backdrop never goes fully clear: the picture stays readable on the way out. */
const MIN_BACKDROP_OPACITY = 0.35;

/**
 * Whether letting go here closes the viewer.
 *
 * Distance **or** speed, and both as magnitudes, so a drag upwards dismisses
 * exactly as one downwards does. Requiring a direction would leave a user who
 * swiped the wrong way with a picture that springs back for no visible reason.
 */
export function shouldDismiss(
  translationY: number,
  velocityY: number,
  distance = DISMISS_DISTANCE,
  velocity = DISMISS_VELOCITY,
): boolean {
  'worklet';
  return Math.abs(translationY) > distance || Math.abs(velocityY) > velocity;
}

/** How opaque the backdrop is at this point in a dismissal drag. */
export function backdropOpacity(
  translationY: number,
  fadeDistance = DISMISS_FADE_DISTANCE,
): number {
  'worklet';
  if (fadeDistance <= 0) {
    return 1;
  }
  const faded = 1 - Math.abs(translationY) / fadeDistance;
  return faded < MIN_BACKDROP_OPACITY ? MIN_BACKDROP_OPACITY : faded > 1 ? 1 : faded;
}
