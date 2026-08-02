import {
  HOMESERVER_VARIABLE,
  readHomeserverUrl,
  readOidcMetadata,
  resolveRedirectUri,
} from '@/lib/chat/matrixConfig';

describe('readHomeserverUrl', () => {
  it('returns the configured homeserver', () => {
    expect(readHomeserverUrl('https://matrix.org')).toBe('https://matrix.org');
  });

  it('refuses to invent one, and names the variable to set', () => {
    // A default would have to be somebody's homeserver. A build that quietly
    // talks to a server nobody chose is worse than one that will not start.
    expect(() => readHomeserverUrl(undefined)).toThrow(HOMESERVER_VARIABLE);
    expect(() => readHomeserverUrl('')).toThrow(HOMESERVER_VARIABLE);
  });
});

describe('resolveRedirectUri', () => {
  it('uses the configured redirect URI unchanged', () => {
    // It has to match what was registered with the authorization server exactly,
    // so a deployment that sets one gets that one and no normalisation.
    expect(resolveRedirectUri('https://allo.you/callback')).toBe('https://allo.you/callback');
  });
});

describe('readOidcMetadata', () => {
  it('registers dynamically when no client id is configured', () => {
    const metadata = readOidcMetadata('https://matrix.org', undefined, 'allo://matrix/oidc');

    expect(metadata.staticRegistrations).toBeUndefined();
    expect(metadata.redirectUri).toBe('allo://matrix/oidc');
  });

  it('treats an empty client id as no client id', () => {
    const metadata = readOidcMetadata('https://matrix.org', '', 'allo://matrix/oidc');

    // An empty map would tell the port a registration exists and hand it "",
    // which the authorization server rejects with an error about the client.
    expect(metadata.staticRegistrations).toBeUndefined();
  });

  it('keys a configured client id by homeserver', () => {
    const metadata = readOidcMetadata('https://allo.you', 'allo-web', 'allo://matrix/oidc');

    // By homeserver and not by issuer: the issuer is only known once the client
    // has asked the homeserver for its authorization metadata, and the port
    // accepts either key.
    expect(metadata.staticRegistrations?.get('https://allo.you')).toBe('allo-web');
  });
});
