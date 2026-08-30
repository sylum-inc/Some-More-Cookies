/**
 * A stale cache must not be permanent.
 *
 * Cache-first is the right answer for a product whose whole content is already
 * on the device, and it is also the classic way to ship an app that can never
 * be fixed again. So this test deploys a second build over the first and
 * insists on the whole chain: the browser notices, the new worker installs and
 * *waits*, the running page keeps serving a consistent old build rather than a
 * half-new one, the person is told, and when they say yes the swap happens and
 * the old cache is deleted.
 *
 * It runs against its own static server rather than the preview server,
 * because "a second build exists now" is not something you can express to a
 * directory that is already built. The server is deliberately hostile: it
 * sends a year of `Cache-Control` on everything, including the worker script.
 * If `updateViaCache: 'none'` were ever dropped from the registration, the
 * browser would keep serving the first `sw.js` from its HTTP cache and this
 * test would hang at step two — which is precisely the failure it is for.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream, cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DIST = resolve(process.cwd(), 'apps/web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

let server: Server;
let root: string;
let origin: string;

test.beforeAll(async () => {
  expect(
    existsSync(join(DIST, 'sw.js')),
    'apps/web/dist must be built before this suite runs (npm run build)',
  ).toBe(true);

  root = mkdtempSync(join(tmpdir(), 'some-more-pwa-'));
  cpSync(DIST, root, { recursive: true });

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, relative);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    // A year. If the worker script is ever taken from here, nothing updates.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    createReadStream(file).pipe(res);
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active) && navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function activeVersion(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((done) => {
        const worker = navigator.serviceWorker.controller;
        if (!worker) {
          done(null);
          return;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(() => done(null), 3000);
        channel.port1.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          done((event.data as { version?: string }).version ?? null);
        };
        worker.postMessage({ type: 'sm-version' }, [channel.port2]);
      }),
  );
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await caches.keys()).filter((name) => name.startsWith('some-more-')).sort(),
  );
}

/** Publishes a second build over the first, in place. */
function deploySecondBuild(): string {
  const swPath = join(root, 'sw.js');
  const source = readFileSync(swPath, 'utf8');
  const match = /const VERSION = "([^"]+)"/.exec(source);
  if (!match) throw new Error('generated worker no longer declares VERSION');
  const nextVersion = `${match[1]}-second`;
  writeFileSync(swPath, source.replace(match[0], `const VERSION = "${nextVersion}"`));

  const htmlPath = join(root, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  writeFileSync(htmlPath, html.replace('</head>', '<meta name="sm-build" content="second"></head>'));

  return nextVersion;
}

test.describe('the service worker update path', () => {
  test('a second build is noticed, waits to be asked, and replaces the first', async ({ page }) => {
    // --- The first build -------------------------------------------------
    await page.goto(`${origin}/`);
    await waitForWorker(page);

    const firstVersion = await activeVersion(page);
    expect(firstVersion, 'the worker should report which build it serves').toBeTruthy();
    expect(await cacheNames(page)).toEqual([`some-more-${firstVersion}`]);
    console.log(`  first build: ${firstVersion}`);

    const before = await page.evaluate(async () => (await (await fetch('/index.html')).text()));
    expect(before).not.toContain('sm-build');

    // --- The second build ------------------------------------------------
    const secondVersion = deploySecondBuild();
    console.log(`  second build: ${secondVersion}`);

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });

    // It installs, and it stops there.
    await expect
      .poll(() => page.evaluate(() => window.__someMorePwa?.getSnapshot().updateReady), {
        timeout: 30_000,
      })
      .toBe(true);

    const waitingState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        waiting: registration.waiting?.state ?? null,
        activeIsStill: navigator.serviceWorker.controller !== null,
      };
    });
    expect(waitingState.waiting, 'the new worker should be installed and waiting').toBe('installed');
    expect(waitingState.activeIsStill).toBe(true);

    // Nothing has changed under the running page: still the first build's
    // shell, still the first build's cache, still the first build's version.
    expect(await activeVersion(page)).toBe(firstVersion);
    const during = await page.evaluate(async () => (await (await fetch('/index.html')).text()));
    expect(during, 'a waiting update must not leak into the running page').not.toContain('sm-build');
    /*
     * Both caches exist while the new worker waits, and that is the point: the
     * second build is already downloaded, so taking it costs a reload and not
     * a download. What must not happen is the old one being *replaced* before
     * anybody agreed to it — hence the two checks above, on the version the
     * page is talking to and on the shell it is being served.
     */
    expect(await cacheNames(page)).toEqual([
      `some-more-${firstVersion}`,
      `some-more-${secondVersion}`,
    ]);

    // --- The person is told, and says yes --------------------------------
    const notice = page.locator('[data-testid="pwa-notice"]');
    await expect(notice, 'a waiting update should be visible, not magic').toHaveCount(1);
    await expect(notice).toContainText('newer campsite');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }),
      page.locator('[data-testid="pwa-notice-confirm"]').click(),
    ]);
    await waitForWorker(page);

    // --- The swap really happened ----------------------------------------
    await expect.poll(() => activeVersion(page), { timeout: 20_000 }).toBe(secondVersion);
    const after = await page.evaluate(async () => (await (await fetch('/index.html')).text()));
    expect(after, 'the new shell should be what is served now').toContain('sm-build');

    // And the old one is gone rather than accumulating.
    expect(await cacheNames(page)).toEqual([`some-more-${secondVersion}`]);
  });

  test('the service is never answered from the cache', async ({ page, context }) => {
    await page.goto(`${origin}/`);
    await waitForWorker(page);

    /*
     * The single most damaging thing a well-meaning worker can do here.
     *
     * `ApiClient` distinguishes `offline` from every other failure and the
     * local-first design depends on that distinction being true. A worker that
     * answered `/v1/*` from a cache — or with a synthesised 200 — would turn
     * "no signal" into "the server said something odd", and the sync queue
     * would drop work it should have kept.
     */
    await context.setOffline(true);
    const result = await page.evaluate(async () => {
      try {
        const response = await fetch(`/v1/meta?t=${Date.now()}`);
        return { failed: false, status: response.status };
      } catch {
        return { failed: true, status: 0 };
      }
    });
    expect(result.failed, 'a /v1 call offline must fail, not be answered').toBe(true);
    await context.setOffline(false);
  });

  test('a cold navigation is served from the cache with the network gone', async ({
    page,
    context,
  }) => {
    await page.goto(`${origin}/`);
    await waitForWorker(page);
    await context.setOffline(true);

    const cold = await context.newPage();
    const response = await cold.goto(`${origin}/?camp=camp-cold`);
    expect(response?.status(), 'the shell should come out of the cache').toBe(200);
    await cold.waitForFunction(() => Boolean(window.__someMore), null, { timeout: 30_000 });

    // A route the build never emitted still lands on the shell, because the
    // app is a single page and a deep link is a navigation like any other.
    const deep = await context.newPage();
    const deepResponse = await deep.goto(`${origin}/some/deep/link`);
    expect(deepResponse?.status()).toBe(200);
    await deep.waitForFunction(() => Boolean(window.__someMore), null, { timeout: 30_000 });

    await context.setOffline(false);
  });
});
