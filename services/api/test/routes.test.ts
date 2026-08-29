import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRoutes } from '../src/routes/index.js';
import { startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

describe('the route table', () => {
  it('has no duplicate method+path pairs and documents every route', () => {
    const routes = api.app.router.routes;
    const seen = new Set<string>();
    for (const route of routes) {
      const signature = `${route.method} ${route.path}`;
      expect(seen.has(signature), `duplicate route ${signature}`).toBe(false);
      seen.add(signature);
      expect(route.summary.length, signature).toBeGreaterThan(10);
      expect(route.path.startsWith('/'), signature).toBe(true);
    }
    expect(routes.length).toBeGreaterThan(40);
  });

  it('requires auth everywhere except the deliberately public endpoints', () => {
    const open = api.app.router.routes
      .filter((route) => route.auth !== 'required')
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(open).toEqual([
      'GET /health',
      'GET /v1/commerce/products',
      'GET /v1/commerce/products/:productId',
      // The content overlay is public and cacheable on purpose: it is the same
      // data that ships compiled into the client, and a campsite must be able
      // to pick it up before anyone signs in.
      'GET /v1/content/documents/:kind/:slug',
      'GET /v1/content/manifest',
      'GET /v1/meta',
      'POST /v1/auth/anonymous',
      'POST /v1/auth/magic-link',
      'POST /v1/commerce/webhooks/payments',
      'POST /v1/events',
    ]);
  });

  it('marks every commerce mutation idempotent', () => {
    const commerceMutations = api.app.router.routes.filter(
      (route) =>
        route.path.startsWith('/v1/commerce') &&
        route.method !== 'GET' &&
        !route.path.includes('webhooks') &&
        !route.path.endsWith('/quote') &&
        route.method !== 'DELETE',
    );
    expect(commerceMutations.length).toBeGreaterThan(8);
    for (const route of commerceMutations) {
      expect(route.idempotent, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('renders a readable route table', () => {
    const described = describeRoutes(api.app.router.routes);
    expect(described[0]).toMatch(/^GET\s+\/health\s+auth=none$/);
    expect(described.some((line) => line.includes('idempotent'))).toBe(true);
  });
});
