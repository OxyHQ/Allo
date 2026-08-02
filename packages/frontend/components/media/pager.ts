/**
 * Where a horizontal swipe leaves the gallery, and which pages are worth
 * building.
 *
 * The pager is a row of pages translated by a gesture rather than a native
 * scroll view, and that is a deliberate choice: a native scroll view inside a
 * modal, wrapping a view that also wants pinch and pan, is a gesture
 * negotiation with a different answer on each platform. Owning the translation
 * means the whole thing is one composition of `react-native-gesture-handler`
 * gestures — and it means where a swipe lands is arithmetic, which is here and
 * tested.
 *
 * See `zoom.ts` for the coordinate convention and for why these are worklets.
 */

/** How far across a page a swipe must go before letting go turns it. */
const TURN_FRACTION = 0.28;

/** Or how fast, in points per second. A flick never crosses the distance. */
const TURN_VELOCITY = 500;

/** Where the row of pages sits when `index` is the one on screen. */
export function pageOffset(index: number, pageWidth: number): number {
  'worklet';
  const offset = -index * pageWidth;
  // `-0` is what `-0 * width` produces for the first page, and it compares
  // unequal to `0` under `Object.is` — which is what React's memoisation and
  // every test comparing offsets uses. Normalised here rather than at each
  // reader.
  return offset === 0 ? 0 : offset;
}

/**
 * An index inside the gallery.
 *
 * Declared **before** its caller, and that is not style. The worklets Babel
 * plugin rewrites each of these into a value assigned where it is written, so a
 * function declaration used by a worklet above it is not hoisted the way plain
 * JavaScript would hoist it: the call fails at run time with "is not a
 * function", on the UI thread, where the message is easy to miss.
 */
function clampIndex(index: number, last: number): number {
  'worklet';
  if (index < 0) {
    return 0;
  }
  return index > last ? last : index;
}

/**
 * The page a swipe ends on.
 *
 * **One page at a time, whatever the gesture did.** A fast drag across three
 * page widths still turns one page: a gallery that skips two pictures because
 * the swipe was enthusiastic loses the one the user was looking for, and there
 * is no gesture that goes back by two.
 *
 * Bounded by the gallery, so a swipe at either end springs back rather than
 * turning onto a page that does not exist.
 */
export function nextPageIndex(
  index: number,
  translationX: number,
  velocityX: number,
  pageWidth: number,
  count: number,
): number {
  'worklet';
  if (count <= 0) {
    return 0;
  }
  const last = count - 1;
  if (pageWidth <= 0) {
    return clampIndex(index, last);
  }
  const far = Math.abs(translationX) > pageWidth * TURN_FRACTION;
  const fast = Math.abs(velocityX) > TURN_VELOCITY;
  if (!far && !fast) {
    return clampIndex(index, last);
  }
  // Dragging the content left (negative) moves forward through the gallery.
  const direction = translationX < 0 ? 1 : -1;
  return clampIndex(index + direction, last);
}

/**
 * How many pages either side of the current one are built.
 *
 * One. Enough that the next picture is already there when the swipe lands, and
 * few enough that opening the viewer does not start downloading a
 * conversation's worth of photographs.
 */
export const VIEWER_WINDOW_RADIUS = 1;

/**
 * Whether this page is close enough to the current one to be built.
 *
 * **This is not an optimisation.** Asking the resolver for a page's URL is what
 * starts its download — see `lib/chat/mediaCache.ts` — so a viewer that built
 * every page would fetch and decrypt every attachment in the conversation the
 * moment it opened, over a connection the user did not choose to spend. The
 * window is what keeps a tap on one photograph costing one photograph.
 */
export function isWithinViewerWindow(
  index: number,
  currentIndex: number,
  radius = VIEWER_WINDOW_RADIUS,
): boolean {
  return Math.abs(index - currentIndex) <= radius;
}
