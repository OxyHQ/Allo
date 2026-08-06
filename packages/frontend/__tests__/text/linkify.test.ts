import { linkifyTokens } from '@/lib/text/linkify';
import { profileHref } from '@/lib/profile/handle';

/**
 * WHAT A MESSAGE BODY TURNS INTO.
 *
 * The mention case is the one that matters most: `[@Display Name](handle)` has
 * two capture groups that both look like a name, and reading the wrong one
 * produces a link to the display name. That routes to a profile nobody holds and
 * shows a 404 — with no error anywhere, because the link was drawn correctly and
 * the route resolved to the catch-all.
 */

describe('linkifyTokens', () => {
  it('reads the handle out of a mention, not the display name', () => {
    expect(linkifyTokens('hi [@Alice Smith](alice) there')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', label: 'Alice Smith', handle: 'alice' },
      { kind: 'text', text: ' there' },
    ]);
  });

  it('sends a mention to the profile route', () => {
    const [token] = linkifyTokens('[@Alice](alice)');
    expect(token).toEqual({ kind: 'mention', label: 'Alice', handle: 'alice' });
    expect(token.kind === 'mention' ? profileHref(token.handle) : null).toBe('/@alice');
  });

  it('leaves a mention whose target could not address a profile unroutable', () => {
    // A sender writes the target. This is the shape that would otherwise
    // navigate somewhere other than the person the mention names.
    const [token] = linkifyTokens('[@Alice](../settings/privacy)');
    expect(token).toEqual({
      kind: 'mention',
      label: 'Alice',
      handle: '../settings/privacy',
    });
    expect(token.kind === 'mention' ? profileHref(token.handle) : 'unset').toBeNull();
  });

  it('handles several mentions in one body', () => {
    expect(linkifyTokens('[@A](a) and [@B](b)')).toEqual([
      { kind: 'mention', label: 'A', handle: 'a' },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', label: 'B', handle: 'b' },
    ]);
  });

  it('finds a URL and gives it a scheme when it had none', () => {
    expect(linkifyTokens('see www.example.org now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'url', label: 'www.example.org', href: 'https://www.example.org' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('leaves the sentence punctuation out of the link', () => {
    expect(linkifyTokens('see https://example.org.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'url', label: 'https://example.org', href: 'https://example.org' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('does not swallow a closing bracket', () => {
    expect(linkifyTokens('(https://example.org)')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'url', label: 'https://example.org', href: 'https://example.org' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('draws a hashtag as ordinary text', () => {
    // It used to link to `/search/<query>`, a screen Allo has never had. Allo
    // searches its conversation list and nothing else, so a hashtag is a word.
    expect(linkifyTokens('about #privacy today')).toEqual([
      { kind: 'text', text: 'about #privacy today' },
    ]);
  });

  it('draws a cashtag as ordinary text', () => {
    expect(linkifyTokens('holding $AAPL')).toEqual([{ kind: 'text', text: 'holding $AAPL' }]);
  });

  it('loses nothing: every character comes back', () => {
    const bodies = [
      'hi [@Alice Smith](alice) — see www.example.org, and #privacy $AAPL @nobody',
      '[@A](a)[@B](b)',
      'no entities at all',
      '#tag at the very start',
      'ends with a url https://example.org',
    ];

    for (const body of bodies) {
      const rebuilt = linkifyTokens(body)
        .map((token) => {
          if (token.kind === 'text') return token.text;
          if (token.kind === 'url') return token.label;
          return `[@${token.label}](${token.handle})`;
        })
        .join('');
      expect(rebuilt).toBe(body);
    }
  });

  it('answers with nothing for an empty body', () => {
    expect(linkifyTokens('')).toEqual([]);
  });
});
