/**
 * WHICH PARTS OF A MESSAGE ARE MORE THAN TEXT.
 *
 * Message bodies arrive as a single string and are drawn as a single string; the
 * only reason to look inside one is to find the spans a reader can act on. There
 * are exactly two:
 *
 *   - a MENTION, which the backend writes as `[@Display Name](handle)`, and
 *   - a URL, which the sender typed.
 *
 * Split out of `components/common/LinkifiedText.tsx` so the parsing can be
 * tested without a renderer. It is the parsing that goes wrong — a mention whose
 * handle is read out of the wrong capture group produces a link to the display
 * name, which routes to a profile nobody holds and shows a 404. That failure is
 * silent in a component test that only checks something coloured was rendered.
 *
 * ## Hashtags and cashtags are deliberately NOT here
 *
 * They used to be, linking to `/search/<query>`. That screen has never existed
 * in Allo, so every `#tag` in every message was a tap that landed on "This screen
 * does not exist". Allo has one search field, on the home screen, and it filters
 * the conversation list — routing a hashtag into it would claim a search across
 * messages that this app does not perform and, being encrypted end to end, mostly
 * cannot. So a `#tag` is ordinary text, drawn like the words around it, until
 * there is something real to search. Adding it back means adding the search
 * first.
 */

/** A span of a message body, in the order it appears. */
export type LinkifiedToken =
  | { readonly kind: 'text'; readonly text: string }
  | {
      /** `[@Display Name](handle)` — drawn as the display name, opens the profile. */
      readonly kind: 'mention';
      /** What the reader sees. The `@` is not repeated; the styling carries it. */
      readonly label: string;
      /** Who it points at. A handle, never an account id. */
      readonly handle: string;
    }
  | {
      readonly kind: 'url';
      /** What the reader sees — the URL as typed, trailing prose punctuation removed. */
      readonly label: string;
      /** Where it opens. Always carries a scheme, so a bare `www.` form still opens. */
      readonly href: string;
    };

/**
 * The two shapes, in one pass, in priority order.
 *
 * The mention alternative comes first so that a URL inside a mention's target —
 * `[@Alice](https://example.org)`, which a malicious sender can write — is
 * consumed as the mention it is spelled as rather than half-matched as a link.
 * The handle it yields is then rejected downstream by `profileHref`, because a
 * handle cannot contain `/`.
 */
const ENTITY = /(\[@([^\]]+)\]\(([^)]+)\))|(https?:\/\/[^\s]+|www\.[^\s]+)/g;

/**
 * Punctuation that ends a sentence rather than a URL.
 *
 * `See https://example.org.` links to `example.org`, not to `example.org.`, and
 * `(https://example.org)` does not swallow the closing bracket. Stripped from the
 * right one character at a time so `https://example.org/a.b.` loses only the
 * final stop.
 */
const TRAILING_PUNCTUATION = /[.,!?):;\]]$/;

function splitTrailingPunctuation(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  while (TRAILING_PUNCTUATION.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

/**
 * The scheme a bare `www.` form omits.
 *
 * `https`, not `http`: the sender wrote no scheme, so neither did they ask for an
 * unencrypted one, and every host that answers `www.x` on 80 answers on 443.
 */
function toOpenableUrl(url: string): string {
  return url.startsWith('http') ? url : `https://${url}`;
}

/**
 * A message body as the spans that draw it.
 *
 * Always covers the whole input: concatenating every token's visible text
 * reproduces the original, minus nothing. Empty text runs are dropped rather
 * than emitted, so a body that is one URL yields one token.
 */
export function linkifyTokens(text: string): LinkifiedToken[] {
  if (!text) return [];

  const tokens: LinkifiedToken[] = [];
  const pushText = (value: string): void => {
    if (value.length === 0) return;
    tokens.push({ kind: 'text', text: value });
  };

  // A fresh matcher per call. `ENTITY` is global, so it carries a `lastIndex`,
  // and the loop below only leaves it at zero because it always runs to the
  // match that returns null. That is not a property worth depending on — the day
  // somebody adds an early exit (a cap on entities, a `break` on a malformed
  // body) a shared matcher would start the NEXT message part-way through and
  // silently drop its first mention. No test can catch that today, because there
  // is no early exit today; this is here so there is nothing to catch when one
  // arrives.
  const pattern = new RegExp(ENTITY.source, ENTITY.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);

  while (match !== null) {
    const [full, mentionFull, mentionLabel, mentionHandle, urlCandidate] = match;
    pushText(text.slice(lastIndex, match.index));

    if (mentionFull !== undefined) {
      tokens.push({ kind: 'mention', label: mentionLabel, handle: mentionHandle });
    } else if (urlCandidate !== undefined) {
      const { url, trailing } = splitTrailingPunctuation(urlCandidate);
      // A "URL" that was nothing but punctuation is not one. Emitting it as a
      // link with an empty label would render an invisible tappable span.
      if (url.length === 0) {
        pushText(urlCandidate);
      } else {
        tokens.push({ kind: 'url', label: url, href: toOpenableUrl(url) });
        pushText(trailing);
      }
    }

    lastIndex = match.index + full.length;
    match = pattern.exec(text);
  }

  pushText(text.slice(lastIndex));
  return tokens;
}
