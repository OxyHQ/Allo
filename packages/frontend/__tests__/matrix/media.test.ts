import { MessageType } from '@unomed/react-native-matrix-sdk';
import type { MediaSourceLike } from '@unomed/react-native-matrix-sdk';

import {
  decodeMediaRef,
  encodeMediaRef,
  toFilesystemPath,
  toMediaContent,
  toThumbnailInfo,
  toUploadParameters,
} from '@/lib/matrix/native/media';
import type { AlloOutgoingAttachment } from '@/lib/matrix/types';

/**
 * The native half's attachments.
 *
 * Nothing here tests encryption, and that is the point rather than a gap: on
 * iOS and Android `Timeline.sendImage` reads the room's encryption state inside
 * Rust and encrypts before it uploads, so there is no argument this file could
 * pass wrong and no plaintext path to guard. What *can* go wrong here is the
 * translation — a filename read from the wrong field, a `u64` that becomes
 * `NaN`, a percent-encoded path handed to Rust — and that is what is pinned
 * down below. The web half's equivalent, where the encryption decision really
 * is Allo's, is `web/attachments.test.ts`.
 */

/** A `MediaSource` is an FFI object; only `toJson()` is ever read. */
function source(json: string): MediaSourceLike {
  return {
    toJson: () => json,
    url: () => 'mxc://allo.you/1',
  };
}

describe('a media ref', () => {
  it('carries what the download needs and nothing else', () => {
    const ref = encodeMediaRef(source('{"Plain":"mxc://allo.you/1"}'), 'image/jpeg', 'a.jpg');

    expect(decodeMediaRef(ref)).toEqual({
      source: '{"Plain":"mxc://allo.you/1"}',
      mimetype: 'image/jpeg',
      filename: 'a.jpg',
    });
  });

  it('falls back to a MIME type that claims nothing', () => {
    const ref = encodeMediaRef(source('{}'), undefined, 'a.bin');

    // Not `image/jpeg`. The SDK names the file it writes from this, and a
    // wrong claim is worse than an honest absence of one.
    expect(decodeMediaRef(ref).mimetype).toBe('application/octet-stream');
  });

  it('refuses one it did not write', () => {
    // A ref outlives the render that made it — it is a React key — so one from
    // an older build, or from the web half, turns up here eventually.
    expect(() => decodeMediaRef('mxc://allo.you/1')).toThrow(/not a media reference/);
    expect(() => decodeMediaRef('{"source":"x"}')).toThrow(/missing the fields/);
  });
});

describe('toMediaContent', () => {
  it('reads a picture, its dimensions and its thumbnail', () => {
    const media = toMediaContent(
      new MessageType.Image({
        content: {
          filename: 'holiday.jpg',
          caption: 'look at this',
          source: source('{"Plain":"mxc://allo.you/1"}'),
          info: {
            mimetype: 'image/jpeg',
            width: 3024n,
            height: 4032n,
            size: 2_400_000n,
            thumbnailSource: source('{"Plain":"mxc://allo.you/2"}'),
            thumbnailInfo: { mimetype: 'image/jpeg', width: 1024n, height: 1365n },
          },
        },
      }),
    );

    expect(media).toMatchObject({
      kind: 'image',
      filename: 'holiday.jpg',
      caption: 'look at this',
      width: 3024,
      height: 4032,
      size: 2_400_000,
    });
    expect(decodeMediaRef(media?.thumbnail ?? '').source).toBe('{"Plain":"mxc://allo.you/2"}');
  });

  it('keeps the filename separate from the caption', () => {
    const media = toMediaContent(
      new MessageType.Image({
        content: {
          // The binding has already resolved the spec's two spellings. Reading
          // `body` here instead would print the caption as the filename.
          filename: 'holiday.jpg',
          caption: 'look at this',
          source: source('{}'),
        },
      }),
    );

    expect(media?.filename).toBe('holiday.jpg');
    expect(media?.caption).toBe('look at this');
  });

  it('reports a video duration in milliseconds', () => {
    const media = toMediaContent(
      new MessageType.Video({
        content: {
          filename: 'clip.mp4',
          source: source('{}'),
          info: { mimetype: 'video/mp4', duration: 12_500, width: 1920n, height: 1080n },
        },
      }),
    );

    expect(media).toMatchObject({ kind: 'video', durationMs: 12_500 });
  });

  it('tells a voice note from an audio file by the marker alone', () => {
    const content = {
      filename: 'voice.m4a',
      source: source('{}'),
      info: { mimetype: 'audio/mp4', duration: 4_200 },
    };

    expect(toMediaContent(new MessageType.Audio({ content }))?.kind).toBe('audio');
    expect(
      toMediaContent(new MessageType.Audio({ content: { ...content, voice: {} } }))?.kind,
    ).toBe('voice');
  });

  it('treats a zero dimension as nothing measured', () => {
    const media = toMediaContent(
      new MessageType.Image({
        content: {
          filename: 'a.jpg',
          source: source('{}'),
          info: { mimetype: 'image/jpeg', width: 0n, height: 0n },
        },
      }),
    );

    // Zero is a field some client filled in with a default. A bubble laid out
    // against it is a bubble laid out against a default.
    expect(media?.width).toBeUndefined();
    expect(media?.height).toBeUndefined();
  });

  it('has no thumbnail when the sender made none', () => {
    const media = toMediaContent(
      new MessageType.Image({
        content: { filename: 'a.jpg', source: source('{}'), info: { mimetype: 'image/jpeg' } },
      }),
    );

    expect(media?.thumbnail).toBeUndefined();
  });

  it('is not an attachment for text', () => {
    expect(
      toMediaContent(new MessageType.Text({ content: { body: 'hello' } })),
    ).toBeUndefined();
  });

  it.each([
    ['a notice', new MessageType.Notice({ content: { body: 'the bridge went down' } })],
    ['an emote', new MessageType.Emote({ content: { body: 'waves' } })],
  ])('reports nothing for %s, so the row says it cannot draw it', (_name, message) => {
    // Not a failure and not silence: `toEventContent` turns `undefined` here
    // into `unsupported`, which the bubble draws as "Allo cannot show this
    // yet". A gap in a conversation has to be visible.
    expect(toMediaContent(message)).toBeUndefined();
  });
});

describe('an outgoing attachment', () => {
  const PHOTO: AlloOutgoingAttachment = {
    kind: 'image',
    filename: 'holiday.jpg',
    mimetype: 'image/jpeg',
    uri: 'file:///var/mobile/Media/holiday%20%232.jpg',
    width: 3024,
    height: 4032,
  };

  it('hands the SDK a path and not a URI', () => {
    const parameters = toUploadParameters(PHOTO);

    // Rust takes filesystem paths. A `file://` URI passed through fails inside
    // the SDK with an error about a file that does not exist, naming a path
    // that visibly does.
    expect(parameters.source.inner).toEqual({
      filename: '/var/mobile/Media/holiday #2.jpg',
    });
  });

  it('sends the caption the user wrote', () => {
    expect(toUploadParameters({ ...PHOTO, caption: 'look' }).caption).toBe('look');
  });

  it('describes the thumbnail in the units the binding wants', () => {
    expect(
      toThumbnailInfo({ uri: 'file:///t.jpg', mimetype: 'image/jpeg', width: 1024, height: 1365 }),
    ).toEqual({ width: 1024n, height: 1365n, mimetype: 'image/jpeg' });
  });

  it('has no thumbnail info when there is no thumbnail', () => {
    expect(toThumbnailInfo(undefined)).toBeUndefined();
  });
});

describe('toFilesystemPath', () => {
  it('decodes what a URI encoded', () => {
    expect(toFilesystemPath('file:///tmp/a%20b%23c.jpg')).toBe('/tmp/a b#c.jpg');
  });

  it('leaves a path that is already one alone', () => {
    expect(toFilesystemPath('/tmp/a.jpg')).toBe('/tmp/a.jpg');
  });
});
