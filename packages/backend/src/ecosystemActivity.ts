import { createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { oxyClient } from '@oxy.so/core';

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
  if (!process.env.ALLO_OXY_SERVICE_API_KEY?.trim() || !process.env.ALLO_OXY_SERVICE_API_SECRET?.trim()) {
    throw new Error('Ecosystem activity requires ALLO_OXY_SERVICE_API_KEY and ALLO_OXY_SERVICE_API_SECRET');
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
