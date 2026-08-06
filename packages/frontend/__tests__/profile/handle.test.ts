import {
  handleFromProfileSegment,
  profileHandleFromPathname,
  profileHref,
} from '@/lib/profile/handle';

/**
 * THE `@` IN A PROFILE URL, in both directions.
 *
 * This is where a wrong route comes back silently. The three functions have to
 * agree — what `profileHref` writes, `handleFromProfileSegment` has to read back
 * as the same handle, and `profileHandleFromPathname` has to recognise as the
 * same person — because they are used at three different moments by three
 * different screens: the tap, the route file, and the wide-window layout that
 * picks its panes from the pathname. If the layout's reading disagrees with the
 * route file's, the sidebar's own Profile row opens a screen the layout
 * immediately paints "select a conversation" over, and nothing fails loudly.
 */

describe('profileHref', () => {
  it('puts the @ inside the segment, which is what the route matches', () => {
    expect(profileHref('alice')).toBe('/@alice');
  });

  it('does not double an @ the caller already supplied', () => {
    expect(profileHref('@alice')).toBe('/@alice');
    expect(profileHref('@@alice')).toBe('/@alice');
  });

  it('ignores the space around a handle somebody pasted', () => {
    expect(profileHref('  alice  ')).toBe('/@alice');
    expect(profileHref('@ alice')).toBe('/@alice');
  });

  it('keeps a federated handle whole', () => {
    // The `@` in the middle belongs to the handle: `alice@example.org` is a
    // different account from `alice`, and truncating at the first `@` would
    // resolve the wrong one.
    expect(profileHref('alice@example.org')).toBe('/@alice@example.org');
  });

  it('refuses a handle that would break out of its own segment', () => {
    // A mention's target is sender-controlled. `[@Alice](../settings/privacy)`
    // is a link a sender can write, and it must not become a navigation.
    expect(profileHref('alice/../settings')).toBeNull();
    expect(profileHref('alice?next=/settings')).toBeNull();
    expect(profileHref('alice#top')).toBeNull();
    expect(profileHref('alice bob')).toBeNull();
  });

  it('refuses a handle that is nothing at all', () => {
    expect(profileHref('')).toBeNull();
    expect(profileHref('   ')).toBeNull();
    expect(profileHref('@')).toBeNull();
    expect(profileHref(undefined)).toBeNull();
    expect(profileHref(null)).toBeNull();
  });
});

describe('handleFromProfileSegment', () => {
  it('strips the @ the URL carried', () => {
    expect(handleFromProfileSegment('@alice')).toBe('alice');
  });

  it('reads back exactly what profileHref wrote', () => {
    for (const handle of ['alice', 'Alice_99', 'alice@example.org']) {
      const href = profileHref(handle);
      expect(href).not.toBeNull();
      // The segment is everything after the leading slash.
      expect(handleFromProfileSegment(href?.slice(1))).toBe(handle);
    }
  });

  it('answers null for a path that was never a profile', () => {
    // `[username]` is also the catch-all for unknown single-segment paths, so
    // this is the branch that renders the 404 — without a network request.
    expect(handleFromProfileSegment('alice')).toBeNull();
    expect(handleFromProfileSegment('nonsense')).toBeNull();
  });

  it('answers null for a segment that is only the sigil', () => {
    expect(handleFromProfileSegment('@')).toBeNull();
    expect(handleFromProfileSegment('@@')).toBeNull();
  });

  it('answers null when the router gives it something that is not a string', () => {
    expect(handleFromProfileSegment(undefined)).toBeNull();
    expect(handleFromProfileSegment(['@alice'])).toBeNull();
  });
});

describe('profileHandleFromPathname', () => {
  it('recognises a profile path', () => {
    expect(profileHandleFromPathname('/@alice')).toBe('alice');
  });

  it('recognises it through the group segments the router adds', () => {
    // `usePathname()` returns the grouped form in some navigation states and the
    // flat one in others; both name the same person.
    expect(profileHandleFromPathname('/(chat)/@alice')).toBe('alice');
  });

  it('agrees with the route file about every href', () => {
    for (const handle of ['alice', 'alice@example.org']) {
      const href = profileHref(handle);
      expect(href).not.toBeNull();
      expect(profileHandleFromPathname(href)).toBe(handle);
      expect(profileHandleFromPathname(`/(chat)${href}`)).toBe(handle);
    }
  });

  it('does not mistake another screen for a profile', () => {
    expect(profileHandleFromPathname('/settings/privacy')).toBeNull();
    expect(profileHandleFromPathname('/c/abc')).toBeNull();
    expect(profileHandleFromPathname('/')).toBeNull();
    expect(profileHandleFromPathname(null)).toBeNull();
  });

  it('does not treat a deeper path under a profile as the profile', () => {
    // There are no sub-pages under a profile in Allo. If one is ever added, the
    // pane picker must be told about it rather than silently drawing the profile
    // over it.
    expect(profileHandleFromPathname('/@alice/media')).toBeNull();
  });
});
