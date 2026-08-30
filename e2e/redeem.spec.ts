/**
 * Scanning a code, in a real browser, against the real service.
 *
 * The suite already proves the redeem path in node (`test/integration/
 * code-redemption.test.ts`). What that cannot answer is the question this repo
 * keeps finding defects with: **what does it look like?** A panel that
 * technically works and reads as an error, or refuses a real code because the
 * browser has no Ed25519, or asks for a camera nobody pressed a button for, is
 * a broken feature with a green test.
 *
 * So this drives the actual UI — open the Passport, press the button, type a
 * code, read what it says — and screenshots every state for a person to look
 * at. The Ed25519 verification here is the *browser's* WebCrypto, not node's,
 * which is the one part of the offline story a node test cannot cover.
 *
 * The service is started by this file, on a port it asked the OS for — the same
 * pattern `campfire.spec.ts` uses, and for the same reason: every other project
 * is written against exactly one deployment (a campsite with no signal), and a
 * globally-started API would quietly change what those tests measure.
 */

import { expect, test, type Page } from '@playwright/test';
import { SHOTS } from './helpers.js';
import { mintCodes, startApi, type RunningService } from './liveops-fixture.js';

let api: RunningService;

test.beforeAll(async () => {
  api = await startApi({ configured: true });
});

test.afterAll(() => {
  api?.stop();
});

/**
 * Stand in for the reverse proxy a deployment puts in front of both halves.
 *
 * The client is same-origin by design (`VITE_API_URL` is empty), so `/v1/**`
 * off the preview server is forwarded to the real service. Routing only: every
 * byte on both sides is real, including the Ed25519 signature the browser
 * checks with its own WebCrypto.
 */
async function proxyApi(page: Page): Promise<void> {
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    try {
      const response = await fetch(`${api.baseUrl}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: request.headers(),
        ...(request.method() === 'GET' || request.method() === 'HEAD'
          ? {}
          : { body: request.postData() ?? undefined }),
      });
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        // Re-encoding happened on the way through, so the original transfer
        // headers would describe a body that no longer exists.
        if (name === 'content-encoding' || name === 'content-length') return;
        headers[name] = value;
      });
      await route.fulfill({ status: response.status, headers, body });
    } catch {
      await route.abort('failed');
    }
  });
}

/** Open a run and mint one code, exactly as the console does. */
async function mintOne(
  overrides: Record<string, unknown> = {},
): Promise<{ token: string; uri: string; batchId: string }> {
  const run = await mintCodes(api.baseUrl, 1, overrides);
  const code = run.codes[0];
  if (code === undefined) throw new Error('no code minted');
  return { token: code.token, uri: code.uri, batchId: run.batchId };
}

/** Walk in, open the Passport, open the code panel. */
async function openScanPanel(page: Page): Promise<void> {
  await page.goto('/?camp=camp-redeem&env=pine_hollow');
  await page.waitForFunction(() => Boolean(window.__someMore));
  // The account bootstrap and the key fetch are background work; the panel is
  // reachable either way, but the redeem needs the session to have landed.
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: /passport/i }).first().click();
  await expect(page.getByRole('dialog', { name: 'Campfire Passport' })).toBeVisible();
  await page.getByTestId('passport-add-code').click();
  await expect(page.getByRole('dialog', { name: 'Add a code' })).toBeVisible();
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('scan-input').fill(code);
  await page.getByTestId('scan-submit').click();
}

test.describe('adding a code from a wrapper', () => {
  test('refuses a forged code on the device, with no request', async ({ page }) => {
    // A real code, then one character of its signature changed. This is what a
    // mistyped code and a forged one both look like from here.
    const real = await mintOne();
    const parts = real.token.split('.');
    const signature = parts[2] as string;
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    const forged = `${parts[0]}.${parts[1]}.${flipped}`;

    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/v1/codes/redeem')) requests.push(r.url());
    });

    await proxyApi(page);
    await openScanPanel(page);
    await submitCode(page, forged);

    const result = page.getByTestId('scan-result');
    await expect(result).toHaveAttribute('data-stage', 'rejected');
    await expect(result).toContainText('did not check out');
    // The claim the whole format exists for: the browser said no by itself.
    await expect(result).toContainText('CHECKED ON THIS DEVICE');
    expect(requests).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/redeem-forged.png` });
  });

  test('refuses something that is not a code at all, plainly', async ({ page }) => {
    await proxyApi(page);
    await openScanPanel(page);
    await submitCode(page, 'https://example.com/not-a-code');

    const result = page.getByTestId('scan-result');
    await expect(result).toHaveAttribute('data-stage', 'rejected');
    await expect(result).toContainText('SM1');
    await page.screenshot({ path: `${SHOTS}/redeem-malformed.png` });
  });

  test('redeems a real code once and files it in the Passport', async ({ page }) => {
    const real = await mintOne();

    await proxyApi(page);
    await openScanPanel(page);
    // The `somemore://c/` form is what a camera hands over, so use it.
    await submitCode(page, real.uri);

    const result = page.getByTestId('scan-result');
    await expect(result).toHaveAttribute('data-stage', 'redeemed', { timeout: 15_000 });
    // The reward's written name, not its database key: `awarded` is what the
    // panel prints, and a campground booklet does not print `free_kit`.
    await expect(result).toContainText(/added to your Passport/i);
    await expect(result).not.toContainText('free_kit');
    await page.screenshot({ path: `${SHOTS}/redeem-accepted.png` });

    // A replay of the same code is refused — by the database, not by the phone.
    await submitCode(page, real.uri);
    await expect(result).toHaveAttribute('data-stage', 'rejected', { timeout: 15_000 });
    await expect(result).toContainText(/already/i);
    await page.screenshot({ path: `${SHOTS}/redeem-replay.png` });

    // And the stub is in the Passport, where rewards live.
    // `aria-label` is the accessible name, so this is "Close", not "×".
    await page.getByRole('dialog', { name: 'Add a code' }).getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: /passport/i }).first().click();
    const stub = page.getByTestId('passport-stub').first();
    await expect(stub).toBeVisible();
    await expect(stub).toContainText(/added to your Passport/i);
    await page.screenshot({ path: `${SHOTS}/redeem-passport.png` });
  });

  test('refuses an expired wrapper on the device, by the date printed on it', async ({ page }) => {
    // A run whose codes live for one day, submitted with the browser's clock
    // wound two days forward. The refusal is local: the expiry is inside the
    // signed body, so no round trip is needed to know it has passed.
    const expiring = await mintOne({ codeTtlDays: 1 });

    await proxyApi(page);
    await page.addInitScript(() => {
      const realNow = Date.now;
      const offset = 2 * 86_400_000;
      Date.now = () => realNow() + offset;
    });
    await openScanPanel(page);
    await submitCode(page, expiring.token);

    const result = page.getByTestId('scan-result');
    await expect(result).toHaveAttribute('data-stage', 'rejected');
    await expect(result).toContainText('expired');
    await page.screenshot({ path: `${SHOTS}/redeem-expired.png` });
  });

  test('is reachable, and is never in the way of the campfire', async ({ page }) => {
    await proxyApi(page);
    await page.goto('/?camp=camp-redeem-quiet&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore));
    await page.waitForTimeout(1500);

    // Nothing about codes is on screen until somebody opens the Passport and
    // asks. A campfire does not advertise.
    await expect(page.getByTestId('scan-input')).toHaveCount(0);
    await expect(page.getByTestId('passport-add-code')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/redeem-not-in-the-way.png` });
  });
});
