import {
  MatrixMediaEncryptionUnknownError,
  MatrixMediaUnreadableError,
} from '@/lib/matrix/errors';
import {
  decodeMediaRef,
  encodeMediaRef,
  encryptionInfoOf,
  mxcUriOf,
  resolveAttachmentSource,
  toAttachmentContent,
  toMediaContent,
  type AttachmentBytes,
  type AttachmentSource,
} from '@/lib/matrix/web/attachments';
import type { AlloOutgoingAttachment } from '@/lib/matrix/types';

/**
 * The web half's attachments, and above all the one property that has to hold:
 * **a picture sent to an encrypted room does not reach the homeserver in the
 * clear.**
 *
 * That property is worth this much test code because of how it fails. Nothing
 * throws, nothing logs, the event body is still encrypted and the bubble looks
 * exactly the same; the only difference is that the bytes on the server are
 * readable by anyone with the mxc URI. Allo has had a silent fall-back to
 * plaintext before and it took a long time to find.
 *
 * So the assertions below are about the **bytes handed to the uploader**, not
 * about which function was called. A test that checked "encrypt() was called"
 * would pass on an implementation that called it and then uploaded the
 * plaintext anyway.
 */

/** A plaintext that is easy to spot if it ever escapes. */
const PLAINTEXT = new TextEncoder().encode('the photograph nobody else may see');

const PHOTO: AlloOutgoingAttachment = {
  kind: 'image',
  filename: 'holiday.jpg',
  mimetype: 'image/jpeg',
  uri: 'blob:https://allo.you/1',
  width: 3024,
  height: 4032,
  size: PLAINTEXT.byteLength,
};

/** What a real upload does, remembered rather than done. */
class FakeUploader {
  readonly uploads: AttachmentBytes[] = [];

  readonly upload = async (payload: AttachmentBytes): Promise<string> => {
    this.uploads.push(payload);
    return `mxc://allo.you/${this.uploads.length}`;
  };

  /** Every byte string that reached the media repository. */
  bytes(): Uint8Array[] {
    return this.uploads.map((upload) => upload.bytes);
  }
}

/**
 * A stand-in for the crypto machine: XOR, which is reversible so a round trip
 * can be asserted, and unmistakably not the input.
 *
 * Its `info` is a real `EncryptedFile` key block short of the URL, because the
 * production code validates that shape field by field and a loose fake would
 * hide it.
 */
const CIPHER_BYTE = 0x5a;

function fakeEncrypt(plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  info: string;
} {
  return {
    ciphertext: plaintext.map((byte) => byte ^ CIPHER_BYTE),
    info: JSON.stringify({
      v: 'v2',
      iv: 'aWFtYW5pdgAAAAAA',
      hashes: { sha256: 'c2hhMjU2' },
      key: {
        alg: 'A256CTR',
        ext: true,
        k: 'dGhpcy1pcy1hLWtleQ',
        key_ops: ['encrypt', 'decrypt'],
        kty: 'oct',
      },
    }),
  };
}

function payloadOf(bytes: Uint8Array = PLAINTEXT): AttachmentBytes {
  return { bytes, mimetype: 'image/jpeg', filename: 'holiday.jpg' };
}

function deps(uploader: FakeUploader) {
  return { upload: uploader.upload, encrypt: fakeEncrypt };
}

describe('resolveAttachmentSource, in an encrypted room', () => {
  it('never hands the plaintext to the uploader', async () => {
    const uploader = new FakeUploader();

    await resolveAttachmentSource(payloadOf(), 'encrypted', '!room:allo.you', deps(uploader));

    expect(uploader.uploads).toHaveLength(1);
    for (const uploaded of uploader.bytes()) {
      // The assertion that matters. Not "encrypt was called": an
      // implementation that encrypts and then uploads the original passes that
      // one and leaks the photograph.
      expect([...uploaded]).not.toEqual([...PLAINTEXT]);
    }
  });

  it('uploads exactly the ciphertext', async () => {
    const uploader = new FakeUploader();

    await resolveAttachmentSource(payloadOf(), 'encrypted', '!room:allo.you', deps(uploader));

    expect([...uploader.bytes()[0]]).toEqual([...fakeEncrypt(PLAINTEXT).ciphertext]);
  });

  it('points the event at an encrypted file and not at a URL', async () => {
    const uploader = new FakeUploader();

    const source = await resolveAttachmentSource(
      payloadOf(),
      'encrypted',
      '!room:allo.you',
      deps(uploader),
    );

    expect(source).not.toHaveProperty('url');
    expect(source).toHaveProperty('file');
    expect(mxcUriOf(source)).toBe('mxc://allo.you/1');
  });

  it('carries the key material the receiver needs to open it', async () => {
    const uploader = new FakeUploader();

    const source = await resolveAttachmentSource(
      payloadOf(),
      'encrypted',
      '!room:allo.you',
      deps(uploader),
    );

    const info: unknown = JSON.parse(encryptionInfoOf(source) ?? '{}');
    expect(info).toEqual(JSON.parse(fakeEncrypt(PLAINTEXT).info));
  });

  it('does not tell the homeserver the blob is a JPEG', async () => {
    const uploader = new FakeUploader();

    await resolveAttachmentSource(payloadOf(), 'encrypted', '!room:allo.you', deps(uploader));

    // A server told it has an image will thumbnail, transcode or sniff
    // something that is not one.
    expect(uploader.uploads[0].mimetype).toBe('application/octet-stream');
  });

  it('refuses key material the crypto machine did not fill in', async () => {
    const uploader = new FakeUploader();
    const broken = { upload: uploader.upload, encrypt: () => ({
      ciphertext: PLAINTEXT.map((byte) => byte ^ CIPHER_BYTE),
      info: JSON.stringify({ v: 'v2', iv: 'aXY' }),
    }) };

    await expect(
      resolveAttachmentSource(payloadOf(), 'encrypted', '!room:allo.you', broken),
    ).rejects.toThrow(MatrixMediaUnreadableError);
  });
});

describe('resolveAttachmentSource, in an unencrypted room', () => {
  it('uploads the bytes as they are', async () => {
    const uploader = new FakeUploader();

    const source = await resolveAttachmentSource(
      payloadOf(),
      'unencrypted',
      '!room:allo.you',
      deps(uploader),
    );

    expect([...uploader.bytes()[0]]).toEqual([...PLAINTEXT]);
    expect(source).toEqual({ url: 'mxc://allo.you/1' });
  });
});

describe('resolveAttachmentSource, when the room has not synced', () => {
  it('refuses rather than guessing', async () => {
    const uploader = new FakeUploader();

    await expect(
      resolveAttachmentSource(payloadOf(), 'unknown', '!room:allo.you', deps(uploader)),
    ).rejects.toThrow(MatrixMediaEncryptionUnknownError);
  });

  it('uploads nothing at all', async () => {
    const uploader = new FakeUploader();

    await resolveAttachmentSource(
      payloadOf(),
      'unknown',
      '!room:allo.you',
      deps(uploader),
    ).catch(() => undefined);

    // The refusal has to come *before* the upload. One that threw afterwards
    // would leave the photograph on the homeserver and only look safe.
    expect(uploader.uploads).toEqual([]);
  });

  it('names the conversation, because the user can retry', async () => {
    const uploader = new FakeUploader();

    await expect(
      resolveAttachmentSource(payloadOf(), 'unknown', '!room:allo.you', deps(uploader)),
    ).rejects.toThrow(/!room:allo\.you/);
  });
});

describe('toAttachmentContent', () => {
  async function contentFor(
    attachment: AlloOutgoingAttachment,
    encryption: 'encrypted' | 'unencrypted',
    withThumbnail: boolean,
  ) {
    const uploader = new FakeUploader();
    const source = await resolveAttachmentSource(
      payloadOf(),
      encryption,
      '!room:allo.you',
      deps(uploader),
    );
    const thumbnail = withThumbnail
      ? {
          source: await resolveAttachmentSource(
            payloadOf(new Uint8Array([1, 2, 3])),
            encryption,
            '!room:allo.you',
            deps(uploader),
          ),
          mimetype: 'image/jpeg',
          width: 1024,
          height: 1365,
        }
      : undefined;
    return toAttachmentContent(attachment, source, thumbnail, PLAINTEXT.byteLength);
  }

  it('encrypts the thumbnail too', async () => {
    const content = await contentFor(PHOTO, 'encrypted', true);

    // A thumbnail of a private photograph gives it away as well as the
    // photograph. An encrypted picture beside a plaintext thumbnail of itself
    // is the leak wearing a smaller hat.
    expect(content.info?.thumbnail_url).toBeUndefined();
    expect(content.info?.thumbnail_file).toBeDefined();
  });

  it('uses the plain thumbnail keys in an unencrypted room', async () => {
    const content = await contentFor(PHOTO, 'unencrypted', true);

    expect(content.info?.thumbnail_url).toBe('mxc://allo.you/2');
    expect(content.info?.thumbnail_file).toBeUndefined();
  });

  it('reports the dimensions the sender measured and invents no others', async () => {
    const content = await contentFor(PHOTO, 'encrypted', false);

    expect(content.info).toMatchObject({ w: 3024, h: 4032, mimetype: 'image/jpeg' });
    // Nothing measured a duration for a still, so the field is absent rather
    // than present and meaningless.
    expect(content.info).not.toHaveProperty('duration');
  });

  it('shows the filename when there is no caption', async () => {
    const content = await contentFor(PHOTO, 'encrypted', false);

    expect(content.body).toBe('holiday.jpg');
    expect(content.filename).toBe('holiday.jpg');
  });

  it("shows the sender's words when there are some", async () => {
    const content = await contentFor(
      { ...PHOTO, caption: '  look at this  ' },
      'encrypted',
      false,
    );

    expect(content.body).toBe('look at this');
    expect(content.filename).toBe('holiday.jpg');
  });

  it('marks a recording as a voice message', async () => {
    const content = await contentFor(
      { kind: 'voice', filename: 'voice.m4a', mimetype: 'audio/mp4', uri: 'blob:x', durationMs: 4200 },
      'encrypted',
      false,
    );

    expect(content['org.matrix.msc3245.voice']).toEqual({});
    expect(content.info?.duration).toBe(4200);
  });

  it('leaves an ordinary audio file unmarked', async () => {
    const content = await contentFor(
      { kind: 'audio', filename: 'song.mp3', mimetype: 'audio/mpeg', uri: 'blob:x' },
      'encrypted',
      false,
    );

    expect(content['org.matrix.msc3245.voice']).toBeUndefined();
  });
});

describe('toMediaContent', () => {
  const ENCRYPTED_FILE = {
    url: 'mxc://allo.you/1',
    v: 'v2',
    iv: 'aWFtYW5pdgAAAAAA',
    hashes: { sha256: 'c2hhMjU2' },
    key: { alg: 'A256CTR', ext: true, k: 'a2V5', key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
  };

  it('reads back an encrypted picture Allo itself sent', () => {
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'holiday.jpg',
      filename: 'holiday.jpg',
      file: ENCRYPTED_FILE,
      info: { mimetype: 'image/jpeg', w: 3024, h: 4032, size: 12 },
    });

    expect(media).toMatchObject({ kind: 'image', filename: 'holiday.jpg', width: 3024 });
    expect(media?.caption).toBeUndefined();
  });

  it('prefers the encrypted file over a URL sitting beside it', () => {
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'holiday.jpg',
      url: 'mxc://allo.you/plaintext',
      file: ENCRYPTED_FILE,
      info: { mimetype: 'image/jpeg' },
    });

    expect(mxcUriOf(decodeMediaRef(media?.source ?? '').source)).toBe('mxc://allo.you/1');
  });

  it('reports nothing for an encrypted picture whose key is malformed', () => {
    // The fall-back that must not exist: reading `url` here would fetch
    // ciphertext and draw it as a broken image, and on an event where the two
    // disagreed it would be the plaintext path reappearing.
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'holiday.jpg',
      url: 'mxc://allo.you/plaintext',
      file: { ...ENCRYPTED_FILE, key: { alg: 'A256CTR' } },
      info: { mimetype: 'image/jpeg' },
    });

    expect(media).toBeUndefined();
  });

  it("takes the sender's caption from body when it differs from the filename", () => {
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'look at this',
      filename: 'holiday.jpg',
      url: 'mxc://allo.you/1',
      info: { mimetype: 'image/jpeg' },
    });

    expect(media?.caption).toBe('look at this');
    expect(media?.filename).toBe('holiday.jpg');
  });

  it('finds the thumbnail the sender uploaded', () => {
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'holiday.jpg',
      file: ENCRYPTED_FILE,
      info: {
        mimetype: 'image/jpeg',
        thumbnail_file: { ...ENCRYPTED_FILE, url: 'mxc://allo.you/2' },
        thumbnail_info: { mimetype: 'image/jpeg', w: 1024, h: 1365 },
      },
    });

    expect(media?.thumbnail).toBeDefined();
    expect(mxcUriOf(decodeMediaRef(media?.thumbnail ?? '').source)).toBe('mxc://allo.you/2');
  });

  it('tells a voice note from an audio file', () => {
    const base = {
      msgtype: 'm.audio',
      body: 'voice.m4a',
      url: 'mxc://allo.you/1',
      info: { mimetype: 'audio/mp4', duration: 4200 },
    };

    expect(toMediaContent(base)?.kind).toBe('audio');
    expect(toMediaContent({ ...base, 'org.matrix.msc3245.voice': {} })?.kind).toBe('voice');
  });

  it('is not a media event without somewhere to fetch the bytes', () => {
    expect(toMediaContent({ msgtype: 'm.image', body: 'holiday.jpg' })).toBeUndefined();
  });

  it('is not a media event at all for text', () => {
    expect(toMediaContent({ msgtype: 'm.text', body: 'hello' })).toBeUndefined();
  });

  it('ignores dimensions a sender reported as nonsense', () => {
    const media = toMediaContent({
      msgtype: 'm.image',
      body: 'holiday.jpg',
      url: 'mxc://allo.you/1',
      info: { mimetype: 'image/jpeg', w: '3024', h: 0, size: -5 },
    });

    // Everything in `info` came from another client over the network. A bubble
    // laid out against `"3024"` is a bubble laid out against a string.
    expect(media?.width).toBeUndefined();
    expect(media?.height).toBeUndefined();
    expect(media?.size).toBeUndefined();
  });
});

describe('a media ref', () => {
  const SOURCE: AttachmentSource = { url: 'mxc://allo.you/1' };

  it('survives a round trip', () => {
    const decoded = decodeMediaRef(encodeMediaRef(SOURCE, 'image/jpeg'));

    expect(decoded).toEqual({ source: SOURCE, mimetype: 'image/jpeg' });
  });

  it('says what the bytes are even when the sender did not', () => {
    expect(decodeMediaRef(encodeMediaRef(SOURCE, undefined)).mimetype).toBe(
      'application/octet-stream',
    );
  });

  it('refuses one written by something else', () => {
    // A ref outlives the render that made it — it is a React key — so one from
    // an older build, or from the native half, turns up here eventually.
    expect(() => decodeMediaRef('mxc://allo.you/1')).toThrow(MatrixMediaUnreadableError);
    expect(() => decodeMediaRef('{"source":{},"mimetype":"image/jpeg"}')).toThrow(
      MatrixMediaUnreadableError,
    );
  });
});
