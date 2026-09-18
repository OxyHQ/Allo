/**
 * A SHARED PLACE, AND THE MAP THAT IS NOT IN THIS APP.
 *
 * Allo draws no map. Bloom ships no map engine on purpose — a tile provider is
 * a dependency, a key and a licence — and Allo has none of the three, so a
 * `location` message shows Bloom's own neutral frame and hands the coordinates
 * to whatever the device already uses for maps.
 *
 * Everything here is pure except {@link openPlace}, so the URL a press produces
 * can be asserted without a device: getting a scheme wrong is a link that
 * silently does nothing on one platform and nobody notices until somebody
 * shares a restaurant.
 */
import { Linking, Platform } from 'react-native';
import type { PlaceView } from '@allo/core';

/** Just the two numbers — a draft and a received place both satisfy it. */
export type Coordinates = Pick<PlaceView, 'latitude' | 'longitude'>;

/**
 * How many decimals a coordinate is written with.
 *
 * Five is about a metre at the equator, which is finer than a phone's GPS is
 * honest about. More digits would claim a precision the fix does not have, and
 * they are read by people: "41.38879, 2.18994" is a place, sixteen digits is a
 * float.
 */
const COORDINATE_DECIMALS = 5;

/**
 * The zoom an opened map starts at. 17 is a street with its building numbers —
 * close enough to see which corner, wide enough to see which street.
 */
const MAP_ZOOM = 17;

/** `"41.38879, 2.18994"`. Fixed decimals, never a locale's separators: it goes into a URL as often as onto a screen. */
export function formatCoordinates(place: Coordinates): string {
  return `${place.latitude.toFixed(COORDINATE_DECIMALS)}, ${place.longitude.toFixed(COORDINATE_DECIMALS)}`;
}

/** The words under the frame when the sender named the place, and the coordinates when nobody did. */
export function placeLabel(place: PlaceView): string {
  return place.label ?? place.address ?? formatCoordinates(place);
}

/** The platforms `Platform.OS` can report; only the three Allo ships on are distinguished. */
export type PlatformName = typeof Platform.OS;

/**
 * Where a press on a place goes.
 *
 * Three answers, because the three platforms genuinely disagree:
 *
 * - **Android** takes the RFC 5870 `geo:` URI, and the `q=lat,lng(Label)`
 *   parameter is what puts a named pin on it rather than just centring there.
 * - **iOS does NOT handle `geo:`.** Nothing is registered for that scheme, so
 *   `Linking.openURL` rejects and the press does nothing at all. `maps.apple.com`
 *   is the documented entry point and iOS routes it straight into Maps without
 *   leaving the app in a browser first.
 * - **Everything else is a browser**, so it gets OpenStreetMap: no key, no
 *   account, and a `mlat`/`mlon` marker plus a `#map=` hash that opens on the
 *   pin instead of on the whole world.
 *
 * The label is never trusted into a URL raw — a place called "Bar 100%" is a
 * malformed escape otherwise.
 */
export function placeUrl(place: PlaceView, os: PlatformName): string {
  const latitude = place.latitude.toFixed(COORDINATE_DECIMALS);
  const longitude = place.longitude.toFixed(COORDINATE_DECIMALS);
  const label = encodeURIComponent(placeLabel(place));
  if (os === 'android') {
    return `geo:${latitude},${longitude}?q=${latitude},${longitude}(${label})`;
  }
  if (os === 'ios') {
    return `https://maps.apple.com/?ll=${latitude},${longitude}&q=${label}`;
  }
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${MAP_ZOOM}/${latitude}/${longitude}`;
}

/**
 * Opens a place in whatever the device uses for maps.
 *
 * `false` means the press did not land — no maps app, or a browser that refused
 * the navigation — so the screen can say so rather than leaving the tap looking
 * like it worked.
 */
export async function openPlace(place: PlaceView): Promise<boolean> {
  try {
    await Linking.openURL(placeUrl(place, Platform.OS));
    return true;
  } catch {
    return false;
  }
}
