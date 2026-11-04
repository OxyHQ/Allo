import { describe, expect, it } from 'bun:test';
import { SERVICE_AUDIENCE } from '@oxy.so/allo-sdk/server';
import { ALLO_APPLICATION_ID, ALLO_SERVICE_AUDIENCE } from '../../config/oxyApplication';

describe('Allo Oxy application', () => {
  it('accepts service tokens for the audience its own SDK mints them for', () => {
    expect(ALLO_SERVICE_AUDIENCE).toBe(SERVICE_AUDIENCE);
    expect(ALLO_SERVICE_AUDIENCE).toBe(`oxy-service:${ALLO_APPLICATION_ID}`);
  });
});
