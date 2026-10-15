// Serve the installed, lock-pinned SDK's worker from the same origin. No CDN,
// eval, inline worker, copied implementation, or native bundle dependency.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const worker = require.resolve('livekit-client/e2ee-worker');
const target = new URL('../packages/frontend/public/', import.meta.url);
mkdirSync(target, { recursive: true });
copyFileSync(worker, new URL('call-encryption.worker.js', target));
