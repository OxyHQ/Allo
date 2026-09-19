import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publisher = vi.hoisted(() => ({
  observeHttp: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: vi.fn(), observeSocket: vi.fn(), stop: vi.fn(async () => {}),
}));
const create = vi.hoisted(() => vi.fn((_options: unknown) => publisher));
/**
 * A PARTIAL mock, and it has to be.
 *
 * This suite is about the publisher's lifecycle. `canAttestWorkloadIdentity` also
 * lives in `@oxy.so/core/server`, and replacing the module wholesale made this
 * file decide whether the process has an Oxy identity — which it does not know
 * and must not answer. It reads two environment variables; the tests below stub
 * those instead.
 */
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  createEcosystemTraffic: create,
}));
import { ecosystemActivityMiddleware, observeEcosystemSocket, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

/** Shaped the way `config/oxyService.ts` insists on: `oxy_dk_<hex>` and 32+ bytes. */
const API_KEY = 'oxy_dk_0123456789abcdef0123456789abcdef0123456789abcdef';
const API_SECRET = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928';

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'true');
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', undefined);
    vi.stubEnv('ALLO_OXY_SERVICE_API_KEY', API_KEY);
    vi.stubEnv('ALLO_OXY_SERVICE_API_SECRET', API_SECRET);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });
  afterEach(async () => { await stopEcosystemActivity(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('does not start or publish when explicitly disabled', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'false');
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('makes missing activation visible without starting a publisher', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a misspelled activation instead of silently losing coverage', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'tru');
    expect(() => startEcosystemActivity(() => true)).toThrow('must be true or false');
  });

  it('fails boot when the shared collector rejects its configuration', () => {
    create.mockImplementationOnce(() => { throw new Error('Invalid infrastructure region'); });
    expect(() => startEcosystemActivity(() => true)).toThrow('Invalid infrastructure region');
    expect(publisher.installFetch).not.toHaveBeenCalled();
  });

  it('refuses a partially provisioned publishing credential', () => {
    vi.stubEnv('ALLO_OXY_SERVICE_API_SECRET', '');
    expect(() => startEcosystemActivity(() => true)).toThrow('ALLO_OXY_SERVICE_API_SECRET');
    expect(create).not.toHaveBeenCalled();
  });

  it('publishes from a task that attests, carrying no credential at all', () => {
    /**
     * The deployment this change is for. `getServiceToken()` mints from the task
     * role (oxy ADR 0026), so demanding the key pair here would have refused to
     * boot the one deployment whose identity is the strongest — and the failure
     * would have read as a missing secret rather than as a check asking the wrong
     * question.
     */
    vi.stubEnv('ALLO_OXY_SERVICE_API_KEY', undefined);
    vi.stubEnv('ALLO_OXY_SERVICE_API_SECRET', undefined);
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/ecs');

    startEcosystemActivity(() => true);

    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to publish from a process with no identity of either kind', () => {
    vi.stubEnv('ALLO_OXY_SERVICE_API_KEY', undefined);
    vi.stubEnv('ALLO_OXY_SERVICE_API_SECRET', undefined);
    expect(() => startEcosystemActivity(() => true)).toThrow('Oxy service identity');
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
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    expect(publisher.observeHttp).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});
