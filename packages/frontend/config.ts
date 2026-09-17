// Base URLs (prod first → env → fallback)
// Local dev ports are assigned per app across the Oxy ecosystem so two apps can
// run side by side: Allo owns backend 4140 / Metro 8140. Production is unaffected
// (ECS injects PORT explicitly).
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.allo.you/api'
    : (process.env.API_URL ?? 'http://localhost:4140/api');

/**
 * The origin the Allo platform SDK (`@allo/core`) talks to. The SDK mounts its
 * own `/v1/*` routes and its own Socket.IO namespace under this origin, so it
 * takes the backend's ORIGIN and not the `/api` prefix the legacy REST helper
 * still uses for profile, directory and reports.
 */
export const ALLO_PLATFORM_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.allo.you'
    : (process.env.EXPO_PUBLIC_ALLO_PLATFORM_URL ?? API_URL.replace(/\/api\/?$/, ''));

// Oxy is ALWAYS the production identity provider — deliberately no dev branch.
// Oxy owns the account, and a build pointing identity at a local port nothing is
// listening on does not fail loudly: it renders a signed-out app.
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL || 'https://api.oxy.so';

export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ||
  'oxy_dk_7b2fab6623e0ac753b38319664d4f0c6bb164e5fc219f60f';

// Stripe Payment Links (open in browser)
export const STRIPE_LINK_PLUS = process.env.EXPO_PUBLIC_STRIPE_LINK_PLUS || '';
export const STRIPE_LINK_FILE = process.env.EXPO_PUBLIC_STRIPE_LINK_FILE || '';

// KLIPY API
export const KLIPY_APP_KEY = process.env.EXPO_PUBLIC_KLIPY_APP_KEY || '';
