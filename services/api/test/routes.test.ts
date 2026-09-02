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
      // The Ed25519 public keys. Public by definition and by design: shipping
      // them is what lets a phone refuse a forged wrapper with no signal at
      // all, and there is no path from a public key to the private half.
      'GET /v1/codes/keys',
      'GET /v1/commerce/products',
      'GET /v1/commerce/products/:productId',
      // The content overlay is public and cacheable on purpose: it is the same
      // data that ships compiled into the client, and a campsite must be able
      // to pick it up before anyone signs in.
      'GET /v1/content/documents/:kind/:slug',
      'GET /v1/content/manifest',
      /*
       * The three media reads are `optional`, not `none`, and the difference
       * matters. A `public` or `link` photo is readable signed out, because
       * that is what sharing an image means; everything else still requires
       * being the owner or a member of the campsite it belongs to, and a
       * private photo answers a stranger with 404 rather than 403. The bytes
       * route is covered by `test/media.test.ts`, which asserts exactly that.
       */
      'GET /v1/media/:photoId',
      'GET /v1/media/:photoId/meta',
      // Whether this deployment can store a photograph at all, the same
      // deployment fact `/v1/meta` reports and for the same reason: the client
      // asks rather than assuming, before it has an account.
      'GET /v1/media/status',
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

/**
 * Cross-origin access.
 *
 * There was none until the live-ops console needed it, which makes this the
 * newest and therefore the most worth pinning: the difference between "public
 * data anybody may read" and "a bearer token and a shared staff secret" is
 * exactly the difference between `*` and a named origin, and getting it
 * backwards is the kind of mistake that is invisible until it is not.
 */
describe('cross-origin access', () => {
  const CONSOLE = 'http://127.0.0.1:4174';

  it('answers `*` for the public read routes, so a client anywhere can verify offline', async () => {
    for (const path of ['/health', '/v1/meta', '/v1/content/manifest', '/v1/codes/keys']) {
      const response = await fetch(`${api.baseUrl}${path}`, { headers: { origin: 'https://anywhere.example' } });
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*');
      // `*` and credentials are mutually exclusive, and these carry none.
      expect(response.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
  });

  it('refuses an unnamed origin on a credentialed route, by saying nothing', async () => {
    const bare = await startTestApi();
    try {
      const response = await fetch(`${bare.baseUrl}/v1/passport`, {
        headers: { origin: CONSOLE },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await bare.close();
    }
  });

  it('echoes a named origin, and only that one', async () => {
    const configured = await startTestApi({ CORS_ALLOWED_ORIGINS: CONSOLE });
    try {
      const allowed = await fetch(`${configured.baseUrl}/v1/passport`, { headers: { origin: CONSOLE } });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(CONSOLE);
      expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
      expect(allowed.headers.get('vary')).toContain('origin');

      const stranger = await fetch(`${configured.baseUrl}/v1/passport`, {
        headers: { origin: 'https://not-us.example' },
      });
      expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await configured.close();
    }
  });

  it('answers a preflight without a token, because a preflight cannot carry one', async () => {
    const configured = await startTestApi({ CORS_ALLOWED_ORIGINS: CONSOLE });
    try {
      const preflight = await fetch(`${configured.baseUrl}/v1/live-ops/documents`, {
        method: 'OPTIONS',
        headers: {
          origin: CONSOLE,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, x-somemore-ops-token',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(CONSOLE);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('x-somemore-ops-token');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    } finally {
      await configured.close();
    }
  });

  it('puts the headers on errors too, or a console cannot read why it failed', async () => {
    const configured = await startTestApi({ CORS_ALLOWED_ORIGINS: CONSOLE });
    try {
      const refused = await fetch(`${configured.baseUrl}/v1/live-ops/documents`, {
        method: 'POST',
        headers: { origin: CONSOLE, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('access-control-allow-origin')).toBe(CONSOLE);
      // Without this, "LIVE_OPS_TOKEN is not set" reaches the operator as an
      // opaque network error, which is the failure the console exists to avoid.
      expect(refused.headers.get('access-control-expose-headers')).toContain('x-request-id');
    } finally {
      await configured.close();
    }
  });

  it('leaves same-origin requests completely alone', async () => {
    const response = await fetch(`${api.baseUrl}/v1/meta`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
