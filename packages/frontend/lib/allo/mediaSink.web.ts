/**
 * Decrypted bytes → something an `<img>`, `<video>` or `<audio>` can open, in
 * a browser: an object URL over an in-memory Blob. Nothing touches disk, and
 * `release()` revokes the URL so the bytes can be collected once the component
 * that asked is gone.
 */
export interface MediaUri {
  uri: string;
  release(): void;
}

export function createMediaUri(bytes: Uint8Array, mime: string, _blobId: string): MediaUri {
  // A copy into a fresh ArrayBuffer: a `Uint8Array` over a shared or offset
  // buffer is not what `Blob` accepts on every browser, and the cache keeps the
  // original for the next consumer.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  let released = false;
  return {
    uri: url,
    release() {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}
