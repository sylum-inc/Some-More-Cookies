import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * The app served from a subdirectory (`BASE_PATH`).
 *
 * Its own project because it fails on its own thing: not "the ritual stopped
 * working" but "the ritual works everywhere except where it is published". A
 * GitHub project page serves this repository at
 * `https://<account>.github.io/Some-More-Cookies/`, and a build that assumes
 * the origin root does not degrade there — it does not start. The shell loads,
 * asks for `/assets/index-….js`, and gets the host's 404 page.
 *
 * Worse than not starting: it can half-start. A service worker registered with
 * a scope of `/` from a script inside a subdirectory is refused outright; a
 * precache list of root paths installs the *other* site at that origin as this
 * app's offline shell. Both are invisible until somebody deploys.
 *
 * So this builds with a base, serves it under that base, and asserts three
 * things nothing else can: that the world boots, that **no request is ever made
 * outside the base**, and that it still boots with the network cut — which is
 * the whole claim the service worker exists to make.
 */

const REPO = resolve(new URL('..', import.meta.url).pathname);
const BASE = '/some-more-subpath/';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

let server: Server;
let dist: string;
let origin: string;

test.beforeAll(async () => {
  dist = join(mkdtempSync(join(tmpdir(), 'some-more-subpath-')), 'dist');

  /*
   * Built here rather than depending on `apps/web/dist`, because the thing
   * under test *is* the build configuration. A prebuilt artifact would prove
   * that whatever produced it worked, which is the question being asked.
   */
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: join(REPO, 'apps/web'),
    /*
     * `VITE_API_URL` deliberately present and empty, because that is what the
     * Pages workflow bakes in when its `api_url` input is left blank — and an
     * empty string is not `undefined`, so a `??` fallback keeps it. The first
     * deploy asked `github.io` for `/v1/auth/anonymous` at the account's root
     * for exactly that reason, which is the request this test exists to
     * refuse. Building the way the deploy builds is the only way to see it.
     */
    env: { ...process.env, BASE_PATH: BASE, VITE_API_URL: '' },
    stdio: 'pipe',
    timeout: 300_000,
  });

  expect(existsSync(join(dist, 'sw.js')), 'the subpath build produced no service worker').toBe(true);

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    /*
     * Anything outside the base is a 404, exactly as the real host answers.
     * A server tolerant enough to serve `/assets/…` from the root would make
     * this suite pass against a build that only works because the test was
     * lenient — which is the failure this file exists to prevent.
     */
    if (!path.startsWith(BASE)) {
      res.statusCode = 404;
      res.end('not found — outside the base');
      return;
    }

    const withinBase = path.slice(BASE.length - 1);
    const relative = normalize(withinBase === '/' ? '/index.html' : withinBase).replace(
      /^(\.\.[/\\])+/,
      '',
    );
    const file = join(dist, relative);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  // Guarded: if the build in `beforeAll` failed there is no server, and an
  // unguarded teardown replaces the real error with a TypeError about `close`.
  if (!server) return;
  await new Promise<void>((done) => server.close(() => done()));
});

/** Waits for the worker to be not merely registered but in charge. */
async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active) && navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 60_000 },
  );
}

test.describe('served from a subdirectory', () => {
  test('boots, installs and runs offline, without ever asking outside its base', async ({
    page,
    context,
  }) => {
    /*
     * Every request the page makes, recorded. This is the assertion that
     * catches a path nobody thought of — a splash image, an icon the manifest
     * names, a chunk loaded lazily — rather than only the ones this test
     * remembered to look for.
     */
    const outside: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) return;
      if (!url.pathname.startsWith(BASE)) outside.push(`${request.method()} ${url.pathname}`);
    });

    /*
     * 404s, split in two, because the two mean opposite things here.
     *
     * A missing *asset* is a broken deploy. A missing *service* is the ordinary
     * state of a static host — there is no API behind GitHub Pages, and the
     * whole product is built to shrug at that (ARCHITECTURE §1.5, the campsite
     * with no signal). Asserting "nothing 404s" would have been asserting that
     * this deployment has a backend, which is the one thing it certainly does
     * not.
     */
    const missingAssets: string[] = [];
    const missingService: string[] = [];
    page.on('response', (response) => {
      if (response.status() !== 404) return;
      const path = new URL(response.url()).pathname;
      if (path.startsWith(`${BASE}v1`)) missingService.push(path);
      else missingAssets.push(path);
    });

    await page.goto(`${origin}${BASE}?camp=subpath&env=pine_hollow`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => Boolean(window.__someMore?.three), null, { timeout: 60_000 });

    expect(outside, 'the page asked the origin root for something').toEqual([]);
    expect(missingAssets, 'an asset 404ed: the deploy is broken').toEqual([]);

    /*
     * The service, asked for in the right place and not there — which is both
     * halves of the claim. Under the app's own base, so an app moved to a
     * subdirectory takes its service with it rather than knocking on whatever
     * else lives at the account's root; and 404, because a static host has no
     * service at all.
     */
    expect(
      missingService.length,
      'the client never asked for its service, so this proves nothing about where it asks',
    ).toBeGreaterThan(0);

    // And the campsite does not care. This is the actual product claim.
    await page.evaluate(() => window.__someMore!.actions['arrive']!());
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => ({
      stage: window.__someMore!.store.state.ritual.stage,
      flame: window.__someMore!.store.state.ritual.fire.flame,
      overlay: window.__someMore!.store.state.overlay,
    }));
    expect(state.stage).toBe('at-fire');
    expect(state.flame, 'the fire is not lit under a subpath').toBeGreaterThan(0.1);
    expect(state.overlay, 'a failed service call put something in the way').toBe('none');

    /*
     * The manifest, as the browser resolves it — a relative `src` that looked
     * right in the file can still resolve to the wrong place from the document.
     */
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (!link) return null;
      const response = await fetch(link.href);
      const body = (await response.json()) as Record<string, unknown>;
      return {
        href: new URL(link.href).pathname,
        id: body['id'],
        startUrl: body['start_url'],
        scope: body['scope'],
        firstIcon: (body['icons'] as { src: string }[])[0]?.src,
      };
    });
    expect(manifest).not.toBeNull();
    expect(manifest!.href).toBe(`${BASE}manifest.webmanifest`);
    expect(manifest!.id, 'a root id collides with every other project page on the account').toBe(
      BASE,
    );
    expect(manifest!.startUrl).toBe(BASE);
    expect(manifest!.scope).toBe(BASE);
    expect(manifest!.firstIcon).toContain(BASE);

    // An icon the launcher would actually fetch, fetched.
    const iconStatus = await page.evaluate(async (base) => {
      const response = await fetch(`${base}icons/icon-192.png`);
      return response.status;
    }, BASE);
    expect(iconStatus, 'the launcher icon is not where the manifest says').toBe(200);

    /*
     * The worker: registered, in charge, and scoped to the subdirectory. A
     * scope of `/` from here is refused by the browser, so this failing is the
     * difference between an installable app and a permanently uninstallable
     * one.
     */
    await waitForWorker(page);
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return new URL(registration.scope).pathname;
    });
    expect(scope).toBe(BASE);

    // The claim the whole worker exists to make.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__someMore?.three), null, { timeout: 60_000 });
    const offlineStage = await page.evaluate(() => window.__someMore!.store.state.ritual.stage);
    expect(offlineStage, 'a cold offline boot under a subpath did not reach the campsite').toBe(
      'arriving',
    );
    await context.setOffline(false);
  });

  test('the Jekyll marker is emitted, so a Pages deploy serves what it was given', async () => {
    // Nothing this build emits begins with an underscore today. The marker is
    // here for the day something does, because Jekyll would drop it silently
    // and the symptom would be a blank page on a host with no logs.
    expect(existsSync(join(dist, '.nojekyll'))).toBe(true);
  });
});
