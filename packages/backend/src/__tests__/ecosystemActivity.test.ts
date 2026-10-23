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
/** Preserve the real OxyServer export while observing the publisher lifecycle. */
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

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'true');
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/fixture');
    stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', undefined);
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

  it('uses the shared temporary role provider off ECS without accepting customer credentials', () => {
    stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
    stubEnv('ALLO_OXY_SERVICE_API_KEY', 'external-key');
    stubEnv('ALLO_OXY_SERVICE_API_SECRET', 'external-secret');
    startEcosystemActivity(() => true);
    const options = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.workloadCredentials).toBeInstanceOf(Function);
    expect(options.credential).toBeUndefined();
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
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
