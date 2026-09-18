import type { PlaceView } from '@allo/core';

import { formatCoordinates, placeLabel, placeUrl } from '@/lib/chat/place';

/**
 * WHERE A PRESS ON A PLACE GOES.
 *
 * The three platforms want three different URLs and a wrong one fails SILENTLY
 * — `Linking.openURL` rejects and the tap looks like it did nothing — so the
 * strings are asserted rather than eyeballed on the one device to hand.
 */

const BARCELONA: PlaceView = {
  latitude: 41.3887901,
  longitude: 2.1899379,
  label: 'Casa del Puerto',
  address: 'Carrer de la Marina 118',
};

describe('formatCoordinates', () => {
  it('writes five decimals, which is about a metre and finer than a phone knows', () => {
    expect(formatCoordinates(BARCELONA)).toBe('41.38879, 2.18994');
  });

  it('keeps the sign of a southern, western place', () => {
    expect(formatCoordinates({ latitude: -33.86882, longitude: -151.20929 })).toBe('-33.86882, -151.20929');
  });

  it('pads a whole number rather than dropping to one digit', () => {
    expect(formatCoordinates({ latitude: 0, longitude: 7 })).toBe('0.00000, 7.00000');
  });
});

describe('placeLabel', () => {
  it('prefers the name the sender gave it', () => {
    expect(placeLabel(BARCELONA)).toBe('Casa del Puerto');
  });

  it('falls back to the address, then to the numbers — a place is never nameless', () => {
    expect(placeLabel({ ...BARCELONA, label: undefined })).toBe('Carrer de la Marina 118');
    expect(placeLabel({ latitude: 41.3887901, longitude: 2.1899379 })).toBe('41.38879, 2.18994');
  });
});

describe('placeUrl', () => {
  it('gives Android a geo: URI whose q= names the pin', () => {
    expect(placeUrl(BARCELONA, 'android')).toBe(
      'geo:41.38879,2.18994?q=41.38879,2.18994(Casa%20del%20Puerto)',
    );
  });

  it('gives iOS maps.apple.com, because nothing on iOS answers geo:', () => {
    const url = placeUrl(BARCELONA, 'ios');
    expect(url).toBe('https://maps.apple.com/?ll=41.38879,2.18994&q=Casa%20del%20Puerto');
    expect(url.startsWith('geo:')).toBe(false);
  });

  it('gives a browser OpenStreetMap, with the marker AND the hash so it opens on the pin', () => {
    expect(placeUrl(BARCELONA, 'web')).toBe(
      'https://www.openstreetmap.org/?mlat=41.38879&mlon=2.18994#map=17/41.38879/2.18994',
    );
  });

  it('escapes a label rather than letting it break the URL', () => {
    const url = placeUrl({ ...BARCELONA, label: 'Bar 100% & Co' }, 'android');
    expect(url).toContain('(Bar%20100%25%20%26%20Co)');
  });

  it('names the pin with the coordinates when there is nothing else to call it', () => {
    expect(placeUrl({ latitude: 0, longitude: 0 }, 'ios')).toBe(
      'https://maps.apple.com/?ll=0.00000,0.00000&q=0.00000%2C%200.00000',
    );
  });
});
