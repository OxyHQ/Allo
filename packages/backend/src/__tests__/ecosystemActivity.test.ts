import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as coreServer from '@oxy.so/core/server';
import { stubEnv, unstubAllEnvs } from './testDoubles';

const publisher = {
  observeHttp: mock((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: mock(),
  observeSocket: mock(),
  stop: mock(async () => {}),
};
const create = mock((_options: unknown) => publisher);
/**
 * A PARTIAL mock, and it has to be.
 *
 * This suite is about the publisher's lifecycle. `canAttestWorkloadIdentity` also
 * lives in `@oxy.so/core/server`, and replacing the module wholesale made this
 * file decide whether the process has an Oxy identity — which it does not know
 * and must not answer. It reads two environment variables; the tests below stub
 * those instead.
 *
 * `mock.module` patches the live bindings of a module that is already loaded,
 * so `../ecosystemActivity` (imported below, evaluated first) sees the mock.
 */
mock.module('@oxy.so/core/server', () => ({
  ...coreServer,
  createEcosystemTraffic: create,
}));
import {
  ecosystemActivityMiddleware,
  observeEcosystemSocket,
  startEcosystemActivity,
  stopEcosystemActivity,
} from '../ecosystemActivity';

/** Shaped the way `config/oxyService.ts` insists on: `oxy_dk_<hex>` and 32+ bytes. */
const API_KEY = 'oxy_dk_0123456789abcdef0123456789abcdef0123456789abcdef';
const API_SECRET = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928';

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'true');
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/fixture');
    stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', undefined);
    stubEnv('ALLO_OXY_SERVICE_API_KEY', API_KEY);
    stubEnv('ALLO_OXY_SERVICE_API_SECRET', API_SECRET);
    spyOn(console, 'warn').mockImplementation(() => {});
    mock.clearAllMocks();
  });
  afterEach(async () => {
    await stopEcosystemActivity();
    unstubAllEnvs();
    mock.restore();
  });

  it('does not start or publish when explicitly disabled', () => {
    stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'false');
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    const next = mock();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('makes missing activation visible without starting a publisher', () => {
    stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a misspelled activation instead of silently losing coverage', () => {
    stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'tru');
    expect(() => startEcosystemActivity(() => true)).toThrow('must be true or false');
  });

  it('fails boot when the shared collector rejects its configuration', () => {
    create.mockImplementationOnce(() => {
      throw new Error('Invalid infrastructure region');
    });
    expect(() => startEcosystemActivity(() => true)).toThrow('Invalid infrastructure region');
    expect(publisher.installFetch).not.toHaveBeenCalled();
  });

  it('does not use a customer credential as workload identity', () => {
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
    expect(() => startEcosystemActivity(() => true)).toThrow('attested Oxy workload identity');
    expect(create).not.toHaveBeenCalled();
  });

  it('publishes from a task that attests, carrying no credential at all', () => {
    /**
     * The deployment this change is for. `serviceToken()` mints from the task
     * role (oxy ADR 0026), so demanding the key pair here would have refused to
     * boot the one deployment whose identity is the strongest — and the failure
     * would have read as a missing secret rather than as a check asking the wrong
     * question.
     */
    stubEnv('ALLO_OXY_SERVICE_API_KEY', undefined);
    stubEnv('ALLO_OXY_SERVICE_API_SECRET', undefined);
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/ecs');

    startEcosystemActivity(() => true);

    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to publish without workload identity', () => {
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
    stubEnv('ALLO_OXY_SERVICE_API_KEY', undefined);
    stubEnv('ALLO_OXY_SERVICE_API_SECRET', undefined);
    expect(() => startEcosystemActivity(() => true)).toThrow('attested Oxy workload identity');
    expect(create).not.toHaveBeenCalled();
  });

  it('installs once and supplies live readiness without retaining request bodies', async () => {
    let ready = false;
    startEcosystemActivity(() => ready);
    startEcosystemActivity(() => ready);
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    const socket = {} as never;
    observeEcosystemSocket(socket);
    expect(publisher.observeSocket).toHaveBeenCalledWith(socket);
    const options = create.mock.calls[0]?.[0] as unknown as { service: string; ready(): boolean };
    expect(options.service).toBe('allo');
    expect(options.ready()).toBe(false);
    ready = true;
    expect(options.ready()).toBe(true);
    const next = mock();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    expect(publisher.observeHttp).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});
