/**
 * WHERE A PERSON LIVES IN THE URL, AND HOW TO GET BACK OUT.
 *
 * A profile in Allo is one path segment: `/@alice`. The `@` is part of the
 * SEGMENT VALUE, not a separator — the route file is `app/(chat)/[username].tsx`
 * and what reaches `useLocalSearchParams()` is the literal string `@alice`. That
 * is the same mechanism Mention uses, deliberately: the two apps share an
 * identity namespace, so a link copied out of one has to mean the same thing in
 * the other, and a scheme where the `@` were dropped from the URL would make
 * `/alice` collide with every static route the app will ever add.
 *
 * It also gives the segment a shape the router can check. `[username]` is the
 * app's catch-all for unknown single-segment paths, so `/nonsense` lands here
 * too; requiring the leading `@` is what lets the screen tell "a profile nobody
 * holds" apart from "not a profile URL at all" without asking the network.
 *
 * Every function is syntactic. Nothing here fetches anything, and nothing here
 * decides whether an account exists — that is `oxyServices.getProfileByUsername`,
 * which takes a HANDLE and not an id. Handing it an id 404s, quietly, once per
 * render; see the comment in `hooks/useSenderInfo.ts` for the production
 * incident that rule is written from.
 */

/**
 * A character that cannot survive inside one path segment.
 *
 * `/` would split the segment in two, `?` and `#` would start a query or a
 * fragment, and whitespace produces a URL that no client agrees how to encode.
 * A handle carrying any of them yields no destination at all, so the caller
 * renders inert text instead of a link that silently goes somewhere else.
 */
const ROUTE_HOSTILE_HANDLE = /[/?#\s]/;

/** The prefix that marks a single-segment path as naming a person. */
const PROFILE_PREFIX = '@';

/**
 * A profile URL, as a template type rather than a bare `string`.
 *
 * Expo Router's `Href` is a union of literal path shapes, and `string` is not in
 * it. Returning `/@${string}` is what lets `router.push(profileHref(h))` typecheck
 * against the generated route table — which is the whole point of the exercise:
 * these navigations were `router.push('/@' + name)` to a route that did not
 * exist, and the app has no generated route types in CI to catch it.
 */
export type ProfileHref = `/@${string}`;

/**
 * The handle a value names, with any leading `@`s and surrounding space removed,
 * or `null` when it names nothing usable.
 *
 * Leading `@`s are stripped repeatedly rather than once because both `@alice`
 * (typed by a person) and `@@alice` (a handle that already carried its own `@`
 * being prefixed again by a caller) arrive in practice, and both mean alice.
 * An `@` in the MIDDLE is left alone: `alice@example.org` is a federated handle,
 * and truncating it would resolve a different account.
 */
function normalizeHandle(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().replace(/^@+/, '').trim();
  if (handle.length === 0) return null;
  if (ROUTE_HOSTILE_HANDLE.test(handle)) return null;
  return handle;
}

/**
 * Where to send a reader who tapped a person's name, or `null` when the handle
 * cannot address one.
 *
 * `null` rather than a best-effort path: a caller that gets one renders plain
 * text, which is honest. A path built from a handle containing a `/` would open
 * some other screen entirely, and that failure is invisible until a user reports
 * it.
 */
export function profileHref(handle: string | null | undefined): ProfileHref | null {
  const normalized = normalizeHandle(handle);
  if (normalized === null) return null;
  return `/@${normalized}`;
}

/**
 * The handle the `[username]` segment names, or `null` when the segment is not a
 * profile URL at all.
 *
 * The `null` case is not an error path, it is the catch-all doing its job: the
 * segment matches any unknown single-segment path, so `/nonsense` and `/@alice`
 * both arrive here and only the second one is a person. The screen renders the
 * 404 for the first without a request.
 */
export function handleFromProfileSegment(
  segment: string | string[] | null | undefined,
): string | null {
  if (typeof segment !== 'string') return null;
  if (!segment.startsWith(PROFILE_PREFIX)) return null;
  return normalizeHandle(segment);
}

/**
 * The handle a whole pathname names, or `null` when the path is not a profile.
 *
 * Needed because on a wide window `app/(chat)/_layout.tsx` chooses what fills
 * each pane from the pathname rather than letting the navigator do it, so the
 * profile has to be recognised there the same way the route file recognises its
 * own segment. Reading it in two places with two regexes is how the sidebar ends
 * up opening a screen the layout then paints "select a conversation" over.
 *
 * The optional `(group)` prefixes are matched because `usePathname()` returns
 * the grouped form (`/(chat)/@alice`) in some navigation states and the flat one
 * (`/@alice`) in others.
 */
const PROFILE_PATHNAME = /^(?:\/\([^)/]*\))*\/@([^/?#]+)$/;

export function profileHandleFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (typeof pathname !== 'string') return null;
  const match = PROFILE_PATHNAME.exec(pathname);
  if (match === null) return null;
  return normalizeHandle(match[1]);
}
