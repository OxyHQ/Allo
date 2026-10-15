import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mintTurnCredential, readIceConfig } from '../../config/turn';

const configured = {
  TURN_REQUIRED: 'true',
  TURN_URLS:
    'turn:turn.allo.you:3478?transport=udp,turn:turn.allo.you:3478?transport=tcp,turns:turn.allo.you:443?transport=tcp',
  TURN_SHARED_SECRET: 'a'.repeat(64),
};

describe('relay configuration boundary', () => {
  it('fails closed on missing required relay or malformed opt-in', () => {
    expect(() => readIceConfig({ TURN_REQUIRED: 'true' })).toThrow('configured relay');
    expect(() => readIceConfig({ TURN_REQUIRED: 'yes' })).toThrow('true or false');
    expect(readIceConfig({}).turn).toBeNull();
  });
  it('requires a strong secret and TLS 443 for the provisioned relay', () => {
    expect(() => readIceConfig({ ...configured, TURN_SHARED_SECRET: '-' })).toThrow('32 random');
    expect(() => readIceConfig({ ...configured, TURN_URLS: 'turn:turn.allo.you:3478' })).toThrow(
      'TLS',
    );
    expect(readIceConfig(configured).turn?.urls).toHaveLength(3);
  });
  it('refuses malformed URLs, embedded credentials, paths and fractional TTL', () => {
    for (const url of [
      'https://turn.allo.you',
      'turn:user:password@host:3478',
      'turn:host:0',
      'turn:host:65536',
      'turn:host/path',
      'turns:host:443?transport=udp',
      'turn:host?secret=abc',
    ]) {
      expect(() => readIceConfig({ TURN_URLS: url, TURN_SHARED_SECRET: 'secret' })).toThrow(
        'invalid ICE URL',
      );
    }
    expect(() => readIceConfig({ ...configured, TURN_TTL_SECONDS: '60.5' })).toThrow('between');
  });
  it('issues the coturn REST credential with an integer expiry and account quota identity', () => {
    const config = readIceConfig(configured).turn!;
    const now = new Date('2026-10-15T12:00:00.999Z');
    const result = mintTurnCredential(config, 'account-one', now);
    const expiry = Math.floor(now.getTime() / 1000) + 3600;
    expect(result.username).toBe(`${expiry}:account-one`);
    expect(result.expiresAt.getTime()).toBe(expiry * 1000);
    expect(result.credential).toBe(
      createHmac('sha1', configured.TURN_SHARED_SECRET).update(result.username).digest('base64'),
    );
  });
});
