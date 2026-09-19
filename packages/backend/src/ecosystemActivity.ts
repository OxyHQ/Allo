import { createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { oxyClient } from '@oxy.so/core';

import { canAuthenticateAsOxyService } from './config/oxyService';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Start only at process bootstrap; constructing a test app starts no publisher. */
export function startEcosystemActivity(ready: () => boolean): void {
  const enabled = process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new Error('OXY_ECOSYSTEM_ACTIVITY_ENABLED must be true or false');
  }
  if (enabled !== 'true') {
    console.warn('Ecosystem activity is disabled for allo');
    return;
  }
  /**
   * An identity, not a key pair.
   *
   * `credential` below is `getServiceToken()`, and since oxy ADR 0026 the SDK
   * mints that from EITHER an `ALLO_OXY_SERVICE_API_KEY`/`_SECRET` pair or an
   * attested ECS task role. Demanding the pair therefore refused to boot exactly
   * the deployment that works — the one whose identity is its task role and which
   * carries no secret at all — while a publisher with no identity of either kind
   * would have posted nothing anyway.
   */
  if (!canAuthenticateAsOxyService()) {
    throw new Error(
      'Ecosystem activity requires an Oxy service identity: an attestable task role, ' +
        'or ALLO_OXY_SERVICE_API_KEY and ALLO_OXY_SERVICE_API_SECRET',
    );
  }
  if (activity) return;
  activity = createEcosystemTraffic({
    service: 'allo',
    credential: () => oxyClient.getServiceToken(),
    ready,
  });
  activity.installFetch();
}

export const ecosystemActivityMiddleware: RequestHandler = (request, response, next) => {
  if (activity) activity.observeHttp(request, response, next);
  else next();
};

export function observeEcosystemSocket(socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0]): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}
