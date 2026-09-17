/**
 * The bytes of something a picker chose, in a browser: a `blob:` URL (or a
 * `data:` URL) the picker minted, read back through `fetch`.
 */
export async function readAttachmentBytes(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`the attachment could not be read (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
