import { OxyServices } from '@oxy.so/core';

import { OXY_BASE_URL } from '@/config';

/**
 * The app's one Oxy client. `OxyProvider` is handed this instance, so the
 * session it signs in, restores and refreshes is the one every module outside
 * React (the backend's linked client, the people directory, start-up) reads.
 *
 * `enableCache: false`: React Query owns caching, as it does for the client
 * `OxyProvider` would otherwise build itself.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL, enableCache: false });
