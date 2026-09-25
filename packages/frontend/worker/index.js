import { observeEdgeRequest } from '@oxy.so/telemetry/edge';

import { handleWellKnown } from './appAssociation.js';

const assetWorker = { fetch(request, env) { return env.ASSETS.fetch(request); } };

/**
 * `/.well-known/*` is answered here (App Links and Universal Links documents, a
 * JSON 404 for anything else) and never reaches the assets binding, whose
 * single-page-application fallback would answer it with `index.html` and 200.
 */
function route(request, env, ctx) {
  return handleWellKnown(request, env) ?? assetWorker.fetch(request, env, ctx);
}

export default {
  fetch(request, env, ctx) {
    return observeEdgeRequest({ service: 'allo', request, env, ctx, next: () => route(request, env, ctx) });
  },
};
