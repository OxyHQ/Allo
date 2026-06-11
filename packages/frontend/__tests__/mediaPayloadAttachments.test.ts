/**
 * Round-trip tests for the encrypted attachment-body extension (F2.6).
 *
 * `serializeMediaBody` / `parseMessageBody` carry structured location and contact
 * data INSIDE the E2E ciphertext for encrypted conversations. These tests pin:
 *  - location-only and contact-only payloads serialize and parse back exactly
 *  - location + contact + caption + media coexist in one body
 *  - malformed structured fields are dropped (defence against tampered bodies)
 *  - v1 (media-only) payloads still parse (backward compatibility)
 *  - a marked payload with no usable attachment degrades to plain text
 *
 * The module is a leaf (no native deps), so it is imported directly.
 */

import {
  serializeMediaBody,
  parseMessageBody,
  type MediaRef,
  type LocationPayload,
  type ContactPayload,
} from '@/lib/mediaPayload';

const location: LocationPayload = {
  latitude: 41.3851,
  longitude: 2.1734,
  address: 'Plaça de Catalunya, Barcelona',
  label: 'Lunch spot',
};

const contact: ContactPayload = {
  name: 'Ada Lovelace',
  phones: ['+44 20 7946 0958'],
  emails: ['ada@example.com'],
};

const mediaRef: MediaRef = {
  mediaId: 'm1',
  url: 'https://cdn.example/m1.bin',
  key: 'a2V5',
  mime: 'image/gif',
  size: 2048,
  type: 'gif',
};

describe('mediaPayload — encrypted location/contact round-trip', () => {
  it('round-trips a location-only payload', () => {
    const parsed = parseMessageBody(serializeMediaBody({ mediaRefs: [], location }));
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.location).toEqual(location);
    expect(parsed.body.contact).toBeUndefined();
    expect(parsed.body.mediaRefs).toHaveLength(0);
  });

  it('round-trips a contact-only payload', () => {
    const parsed = parseMessageBody(serializeMediaBody({ mediaRefs: [], contact }));
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.contact).toEqual(contact);
    expect(parsed.body.location).toBeUndefined();
  });

  it('round-trips caption + media + location + contact together', () => {
    const body = serializeMediaBody({
      text: 'meet here',
      mediaRefs: [mediaRef],
      location,
      contact,
    });
    const parsed = parseMessageBody(body);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.text).toBe('meet here');
    expect(parsed.body.mediaRefs).toHaveLength(1);
    expect(parsed.body.location).toEqual(location);
    expect(parsed.body.contact).toEqual(contact);
  });

  it('omits empty optional structured fields from the wire form', () => {
    const serialized = serializeMediaBody({ mediaRefs: [mediaRef] });
    expect(serialized).not.toContain('location');
    expect(serialized).not.toContain('contact');
  });

  it('drops a location with non-numeric coordinates (tampered body)', () => {
    const tampered = JSON.stringify({
      __allo: 'allo.media',
      v: 2,
      mediaRefs: [],
      location: { latitude: 'NaN', longitude: 2.1 },
    });
    const parsed = parseMessageBody(tampered);
    // No usable attachment remains → degrades to (empty) plain text.
    expect(parsed.kind).toBe('text');
  });

  it('drops a contact without a name but keeps a valid sibling location', () => {
    const body = JSON.stringify({
      __allo: 'allo.media',
      v: 2,
      mediaRefs: [],
      location,
      contact: { phones: ['123'] },
    });
    const parsed = parseMessageBody(body);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.location).toEqual(location);
    expect(parsed.body.contact).toBeUndefined();
  });

  it('parses a v1 (media-only) payload for backward compatibility', () => {
    const v1Body = JSON.stringify({
      __allo: 'allo.media',
      v: 1,
      mediaRefs: [mediaRef],
      text: 'legacy',
    });
    const parsed = parseMessageBody(v1Body);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.mediaRefs).toHaveLength(1);
    expect(parsed.body.text).toBe('legacy');
    expect(parsed.body.location).toBeUndefined();
  });

  it('treats a marked payload with no usable attachment as plain text', () => {
    const empty = JSON.stringify({ __allo: 'allo.media', v: 2, mediaRefs: [], text: 'hi' });
    const parsed = parseMessageBody(empty);
    expect(parsed.kind).toBe('text');
    if (parsed.kind !== 'text') return;
    expect(parsed.text).toBe('hi');
  });

  it('does not misread ordinary user JSON as an attachment payload', () => {
    const parsed = parseMessageBody('{"latitude":1,"longitude":2}');
    expect(parsed.kind).toBe('text');
  });
});
