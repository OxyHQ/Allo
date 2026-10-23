import { describe, expect, it } from 'bun:test';
import { canAuthenticateAsOxyService } from '../../config/oxyService';

describe('Allo workload identity', () => {
  it('recognizes an attestable workload without application credentials', () => {
    expect(
      canAuthenticateAsOxyService({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x' }),
    ).toBe(true);
  });
  it('does not promote a customer key or an anonymous process to Allo', () => {
    expect(canAuthenticateAsOxyService({})).toBe(false);
    expect(
      canAuthenticateAsOxyService({
        ALLO_OXY_SERVICE_API_KEY: 'oxy_dk_example',
        ALLO_OXY_SERVICE_API_SECRET: 'retired',
      }),
    ).toBe(false);
  });
});
