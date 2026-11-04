/**
 * Allo's Oxy application, and the audience other Oxy services address this
 * backend by.
 *
 * `@oxy.so/allo-sdk/server` (`alloTeamForOxyService`, what Homiio calls) mints
 * its service token for `oxy-service:<this id>` — its `SERVICE_AUDIENCE` — so
 * that is the one audience this process accepts service tokens for.
 * `__tests__/config/oxyApplication.test.ts` holds the two together: the runtime
 * image carries no SDK workspace, so the backend cannot import the SDK's copy.
 */
export const ALLO_APPLICATION_ID = '6a2f851751b784a86fd0e92b';

export const ALLO_SERVICE_AUDIENCE = `oxy-service:${ALLO_APPLICATION_ID}`;
