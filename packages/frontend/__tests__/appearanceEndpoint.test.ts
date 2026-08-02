import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The appearance store asked for `profile/design/:userId`, a route the backend
 * has never had. It 404ed for every user on every render, and the catch around
 * it returned null — which is exactly what "this user has no custom appearance"
 * looks like, so nothing ever surfaced it. It reached production and stayed.
 *
 * A unit test cannot catch that: mock the client and a wrong URL passes. What
 * catches it is comparing the two sides, so this reads the store's calls and the
 * backend's routes and asserts every path the store asks for is one the backend
 * serves.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const STORE = join(REPO_ROOT, 'packages/frontend/stores/appearanceStore.ts');
const ROUTES = join(REPO_ROOT, 'packages/backend/src/routes/profileSettings.ts');

/** Every `api.<verb>('profile/...')` the store performs, as a path. */
function pathsTheStoreCalls(): string[] {
  const source = readFileSync(STORE, 'utf8');
  const calls = source.matchAll(/api\.\w+<[^>]*>\(\s*[`'"]([^`'"]+)[`'"]/g);
  return [...calls].map(([, path]) => path);
}

/** Every path `profileSettings.ts` registers, mounted under `/profile`. */
function pathsTheBackendServes(): string[] {
  const source = readFileSync(ROUTES, 'utf8');
  const routes = source.matchAll(/router\.\w+\(\s*'([^']+)'/g);
  return [...routes].map(([, path]) => `profile${path}`);
}

/** `profile/settings/${userId}` and `profile/settings/:userId` are the same route. */
function normalise(path: string): string {
  return path.replace(/\$\{[^}]+\}/g, ':param').replace(/:[A-Za-z_]\w*/g, ':param');
}

describe('the appearance store only asks for routes that exist', () => {
  it('finds calls and routes to compare', () => {
    // Guards the test itself: a regex that silently matches nothing would make
    // every assertion below vacuously true.
    expect(pathsTheStoreCalls().length).toBeGreaterThanOrEqual(3);
    expect(pathsTheBackendServes().length).toBeGreaterThanOrEqual(5);
  });

  it('has a backend route for every path it requests', () => {
    const served = new Set(pathsTheBackendServes().map(normalise));
    const missing = pathsTheStoreCalls().filter((p) => !served.has(normalise(p)));

    expect(missing).toEqual([]);
  });

  it('reads another user by their id, not by a route that never existed', () => {
    const calls = pathsTheStoreCalls().map(normalise);

    expect(calls).toContain('profile/settings/:param');
    expect(calls.some((p) => p.includes('design'))).toBe(false);
  });
});
