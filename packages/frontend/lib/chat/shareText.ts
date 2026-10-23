/**
 * The message `/share?text=…` asks to send.
 *
 * Another app writes the link (Mention's "send" button opens
 * `allo://share?text=<post url>` or `https://allo.you/share?text=…`), so the
 * value is somebody else's input and is reduced here to plain text the
 * composer would have accepted: one value, no control characters except line
 * breaks and tabs, no bidirectional overrides (which can make a link read as a
 * different one), trimmed, and cut at {@link SHARE_TEXT_MAX} characters without
 * splitting one in half. Nothing usable is the empty string, which the screen
 * answers with an empty state.
 */

/** Room for a line of text and a link; a share link is not a way to paste a document. */
export const SHARE_TEXT_MAX = 2000;

/**
 * C0 controls except tab and line feed, DEL, C1 controls, and the bidi
 * embedding, override and isolate marks. Compared as code points rather than
 * written as a regex class, which would have to spell the control characters.
 */
function isUnsafe(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function shareTextFromParam(raw: string | readonly string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return '';
  const characters = Array.from(value.replace(/\r\n?/g, '\n').trim()).filter(
    (character) => !isUnsafe(character.codePointAt(0) ?? 0),
  );
  return characters.slice(0, SHARE_TEXT_MAX).join('').trim();
}
