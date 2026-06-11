/**
 * Tests for end-to-end-encrypted media crypto + body serialization (Fase 1D).
 *
 * Covers:
 *  - mediaCrypto round-trip (encrypt → decrypt yields identical bytes)
 *  - wrong key / tampering rejected by the AEAD tag
 *  - MIME + size bound into the AAD (substitution rejected)
 *  - mediaPayload JSON wrapper detection vs plain text, legacy passthrough
 *  - mediaRef round-trip (serialize body → parse → items)
 */

import {
  encryptMediaBlob,
  decryptMediaBlob,
  MEDIA_KEY_LENGTH,
} from '@/lib/mediaCrypto';
import {
  serializeMediaBody,
  parseMessageBody,
  mediaRefsToItems,
  type MediaRef,
} from '@/lib/mediaPayload';

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('mediaCrypto', () => {
  it('round-trips: decrypt(encrypt(bytes)) === bytes', () => {
    const plaintext = bytesOf(0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03);
    const mime = 'image/png';

    const enc = encryptMediaBlob(plaintext, mime);
    expect(enc.keyBase64).toBeTruthy();
    expect(enc.mime).toBe(mime);
    expect(enc.size).toBe(plaintext.length);
    // Ciphertext must differ from plaintext and include nonce(12) + tag(16).
    expect(enc.ciphertext.length).toBe(plaintext.length + 12 + 16);

    const dec = decryptMediaBlob(enc.ciphertext, {
      keyBase64: enc.keyBase64,
      mime: enc.mime,
      size: enc.size,
    });
    expect(Array.from(dec)).toEqual(Array.from(plaintext));
  });

  it('produces a 32-byte key', () => {
    const enc = encryptMediaBlob(bytesOf(1, 2, 3), 'image/jpeg');
    // base64 of 32 bytes decodes to 32 bytes; quick length sanity via atob.
    const raw = Uint8Array.from(atob(enc.keyBase64), (c) => c.charCodeAt(0));
    expect(raw.length).toBe(MEDIA_KEY_LENGTH);
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = encryptMediaBlob(bytesOf(9, 8, 7, 6, 5), 'application/pdf');
    const otherKey = encryptMediaBlob(bytesOf(0), 'application/pdf').keyBase64;
    expect(() =>
      decryptMediaBlob(enc.ciphertext, { keyBase64: otherKey, mime: enc.mime, size: enc.size })
    ).toThrow();
  });

  it('fails to decrypt when the ciphertext is tampered with', () => {
    const enc = encryptMediaBlob(bytesOf(1, 2, 3, 4, 5, 6), 'video/mp4');
    const tampered = enc.ciphertext.slice();
    tampered[tampered.length - 1] ^= 0xff; // flip a tag bit
    expect(() =>
      decryptMediaBlob(tampered, { keyBase64: enc.keyBase64, mime: enc.mime, size: enc.size })
    ).toThrow();
  });

  it('binds MIME into the AAD (wrong MIME on decrypt fails)', () => {
    const enc = encryptMediaBlob(bytesOf(10, 20, 30), 'image/png');
    expect(() =>
      decryptMediaBlob(enc.ciphertext, {
        keyBase64: enc.keyBase64,
        mime: 'image/jpeg', // different MIME → different AAD → tag fails
        size: enc.size,
      })
    ).toThrow();
  });

  it('binds size into the AAD (wrong size on decrypt fails)', () => {
    const enc = encryptMediaBlob(bytesOf(10, 20, 30, 40), 'image/png');
    expect(() =>
      decryptMediaBlob(enc.ciphertext, {
        keyBase64: enc.keyBase64,
        mime: enc.mime,
        size: enc.size + 1,
      })
    ).toThrow();
  });

  it('rejects an empty MIME at encrypt time', () => {
    expect(() => encryptMediaBlob(bytesOf(1), '')).toThrow();
  });
});

describe('mediaPayload serialization', () => {
  const sampleRef: MediaRef = {
    mediaId: 'm1',
    url: 'https://cdn.example/m1.bin',
    key: 'a2V5',
    mime: 'image/png',
    size: 1234,
    type: 'image',
    fileName: 'photo.png',
    width: 800,
    height: 600,
  };

  it('round-trips a media body (serialize → parse)', () => {
    const serialized = serializeMediaBody({ text: 'caption', mediaRefs: [sampleRef] });
    const parsed = parseMessageBody(serialized);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.text).toBe('caption');
    expect(parsed.body.mediaRefs).toHaveLength(1);
    expect(parsed.body.mediaRefs[0]).toMatchObject(sampleRef);
  });

  it('serializes without a caption when text is empty', () => {
    const serialized = serializeMediaBody({ mediaRefs: [sampleRef] });
    const parsed = parseMessageBody(serialized);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    expect(parsed.body.text).toBeUndefined();
  });

  it('treats plain text as plain text', () => {
    const parsed = parseMessageBody('hello world');
    expect(parsed).toEqual({ kind: 'text', text: 'hello world' });
  });

  it('treats user text that merely looks like JSON as plain text', () => {
    const userJson = '{"hello":"world"}';
    const parsed = parseMessageBody(userJson);
    expect(parsed).toEqual({ kind: 'text', text: userJson });
  });

  it('treats a JSON array as plain text (no media marker)', () => {
    const parsed = parseMessageBody('[1,2,3]');
    expect(parsed).toEqual({ kind: 'text', text: '[1,2,3]' });
  });

  it('treats invalid JSON starting with { as plain text', () => {
    const parsed = parseMessageBody('{not valid json');
    expect(parsed).toEqual({ kind: 'text', text: '{not valid json' });
  });

  it('degrades a media payload with no usable refs to its caption text', () => {
    const serialized = JSON.stringify({
      __allo: 'allo.media',
      v: 1,
      text: 'just a caption',
      mediaRefs: [{ bogus: true }],
    });
    const parsed = parseMessageBody(serialized);
    expect(parsed).toEqual({ kind: 'text', text: 'just a caption' });
  });

  it('reconstructs renderable, key-bearing items from refs', () => {
    const items = mediaRefsToItems([sampleRef]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'm1',
      type: 'image',
      url: 'https://cdn.example/m1.bin',
      encrypted: true,
      encryptionKey: 'a2V5',
      mimeType: 'image/png',
      fileSize: 1234,
      fileName: 'photo.png',
      width: 800,
      height: 600,
    });
  });

  it('preserves an end-to-end round trip through crypto + payload', () => {
    // Encrypt bytes, embed the key in the body, parse it back, and decrypt.
    const plaintext = bytesOf(0x11, 0x22, 0x33, 0x44, 0x55);
    const enc = encryptMediaBlob(plaintext, 'audio/mp4');
    const ref: MediaRef = {
      mediaId: 'voice1',
      url: 'https://cdn.example/voice1.bin',
      key: enc.keyBase64,
      mime: enc.mime,
      size: enc.size,
      type: 'audio',
    };
    const body = serializeMediaBody({ mediaRefs: [ref] });
    const parsed = parseMessageBody(body);
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    const recoveredRef = parsed.body.mediaRefs[0];
    const dec = decryptMediaBlob(enc.ciphertext, {
      keyBase64: recoveredRef.key,
      mime: recoveredRef.mime,
      size: recoveredRef.size,
    });
    expect(Array.from(dec)).toEqual(Array.from(plaintext));
  });
});
