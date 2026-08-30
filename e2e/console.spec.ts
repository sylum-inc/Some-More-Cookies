/**
 * The live-ops console, driven the way a person drives it.
 *
 * The whole justification for this screen is that `curl` is fine for an
 * engineer and not fine for the person scheduling a meteor-shower weekend
 * (README, Blocker 15). That is a claim about *usability*, which is not
 * something a unit test can check — so this walks the actual launch-night
 * sequence in a real browser and screenshots every step:
 *
 *   connect → author → validate (and fail, and read why) → validate (and pass)
 *   → draft → stage → publish → see it live in the manifest → roll back
 *
 * ...plus a print run: open it, mint it, read the "this is the only copy"
 * warning, retire it.
 *
 * It also checks the state that is easiest to get wrong and worst to get
 * wrong: a service with no `LIVE_OPS_TOKEN` must look *unconfigured*, not
 * broken, and must say which variable is missing.
 *
 * The console runs on its own origin and talks to the API cross-origin, which
 * is exactly how it is deployed — so this exercises the CORS path too. Both
 * services and the console are started by `liveops-fixture.ts` on ports it asks
 * the OS for, so nothing here collides with another project or another run.
 */

import { expect, test, type Page } from '@playwright/test';
import { SHOTS } from './helpers.js';
import { OPS_TOKEN, startApi, startConsole, type RunningService } from './liveops-fixture.js';

let console_: RunningService;
let api: RunningService;
/** The same binary with nothing configured. See `liveops-fixture.ts`. */
let bare: RunningService;

test.beforeAll(async () => {
  console_ = await startConsole();
  [api, bare] = await Promise.all([
    startApi({ configured: true, corsOrigin: console_.baseUrl }),
    startApi({ configured: false, corsOrigin: console_.baseUrl }),
  ]);
});

test.afterAll(() => {
  api?.stop();
  bare?.stop();
  console_?.stop();
});

const EVENT = {
  id: 'console_weekend',
  name: 'Console Weekend',
  tagline: 'A sky event, scheduled from a screen instead of from curl.',
  kind: 'sky-event',
  environments: ['*'],
  skyEvent: 'aurora',
  intensity: 0.8,
  rewardCodes: [],
  stations: [],
  performanceCost: 'light',
  note: 'Authored end to end through the console.',
};

/**
 * One operator, signing in once, working across a shift.
 *
 * The bootstrap token appoints the *first* operator on a deployment and then
 * refuses — that is the whole difference between a bootstrap and a standing
 * permission (README, Blocker 9). So the first connection here appoints an
 * account and every later one reuses that account's bearer, which is what an
 * operator actually does. Signing in as a brand new anonymous person each time
 * and expecting to still be an administrator was only ever going to work while
 * the shared secret *was* the permission.
 */
let shiftBearer: string | null = null;

async function connect(page: Page, options: { api?: string } = {}): Promise<void> {
  await page.goto(console_.baseUrl);
  await page.getByTestId('cred-base-url').fill(options.api ?? api.baseUrl);
  await page.getByTestId('cred-ops').fill(OPS_TOKEN);

  if (shiftBearer === null || options.api !== undefined) {
    await page.getByTestId('sign-in').click();
    // Named, not matched loosely: the banner has a code-signing line as well,
    // and `/…|not configured/` over the whole panel was satisfied by that line
    // alone — so it went on passing no matter what the authoring line said.
    // This asserts the capability the account actually holds.
    await expect(page.getByTestId('configuration-banner')).toContainText(/Authoring as .*content:draft/i, {
      timeout: 20_000,
    });
    if (options.api === undefined) {
      shiftBearer = await page.getByTestId('cred-bearer').inputValue();
      expect(shiftBearer, 'signing in produced no bearer token').not.toBe('');
    }
    return;
  }

  await page.getByTestId('cred-bearer').fill(shiftBearer);
  await expect(page.getByTestId('configuration-banner')).toContainText(/Authoring as .*content:draft/i, {
    timeout: 20_000,
  });
}

test.describe('the live-ops console', () => {
  test('says honestly that a deployment cannot author, naming the variable', async ({ page }) => {
    await page.goto(console_.baseUrl);
    await page.getByTestId('cred-base-url').fill(bare.baseUrl);
    await page.getByTestId('sign-in').click();

    const banner = page.getByTestId('configuration-banner');
    await expect(banner).toContainText('LIVE_OPS_TOKEN', { timeout: 20_000 });
    // Not an error, not a spinner, not a blank screen: a standing statement of
    // fact about this deployment.
    await expect(banner).not.toContainText('undefined');
    // And the authoring controls are off rather than firing doomed requests.
    await expect(page.getByTestId('draft')).toBeDisabled();
    await expect(page.getByTestId('validate')).toBeDisabled();

    await page.screenshot({ path: `${SHOTS}/console-not-configured.png`, fullPage: true });
  });

  test('gives an author the surfaces they hold, and greys out the ones they do not', async ({ page, request }) => {
    /*
     * The point of the operator model, seen from the screen (README, Blocker 9).
     *
     * Before it, one shared string enabled every control on this console, so a
     * person brought in to write copy was one mis-click from minting a hundred
     * thousand wrappers. `content:draft` alone should light up drafting and
     * leave publishing and printing dark — and it should do so *before* the
     * click, not as a 403 afterwards.
     */
    await connect(page);
    const admin = shiftBearer;
    expect(admin, 'no administrator to grant from').not.toBeNull();

    // A second person, granted exactly one capability by the administrator.
    const signUp = await request.post(`${api.baseUrl}/v1/auth/anonymous`, {
      data: {
        device: {
          deviceId: `console-author-${Date.now().toString(36)}`,
          platform: 'web',
          appVersion: '0.1.0',
        },
        displayName: 'Author',
      },
    });
    expect(signUp.status()).toBe(201);
    const author = await signUp.json();

    const granted = await request.post(`${api.baseUrl}/v1/operators/grants`, {
      headers: { authorization: `Bearer ${admin}` },
      data: {
        idempotencyKey: `console-grant-${Date.now().toString(36)}`,
        accountId: author.account.id,
        capabilities: ['content:draft'],
      },
    });
    const grantBody = await granted.text();
    expect(granted.status(), grantBody).toBe(201);

    // Signed in as that person, with no bootstrap token anywhere in the tab.
    await page.goto(console_.baseUrl);
    await page.getByTestId('cred-base-url').fill(api.baseUrl);
    await page.getByTestId('cred-ops').fill('');
    await page.getByTestId('cred-bearer').fill(author.auth.token);
    // Reload rather than trusting the keystroke: credentials are persisted per
    // tab, so a fresh boot is what an operator opening the console actually
    // gets, and it removes any doubt about which bearer the screen asked with.
    await page.reload();

    const banner = page.getByTestId('configuration-banner');
    await expect(banner).toContainText('Authoring as content:draft', { timeout: 20_000 });
    // Named capabilities, not a secret: nobody is told to go find a string.
    await expect(banner).not.toContainText('LIVE_OPS_TOKEN');

    await expect(page.getByTestId('draft')).toBeEnabled();
    await expect(page.getByTestId('validate')).toBeEnabled();

    // Printing is somebody else's job, and the screen says so by being dark.
    await page.getByTestId('tab-codes').click();
    await expect(page.getByTestId('create-batch')).toBeDisabled();

    await page.screenshot({ path: `${SHOTS}/console-partial-capabilities.png`, fullPage: true });
  });

  test('shows a validation failure as dotted paths the author can act on', async ({ page }) => {
    await connect(page);

    // `exclusive` is rejected by name: seasonal content may never gate
    // anything (spec §5.5, §8). This is the single most useful error in the
    // system and it has to land next to the editor.
    await page.getByTestId('doc-body').fill(JSON.stringify({ ...EVENT, exclusive: true }, null, 2));
    await page.getByTestId('validate').click();

    const issues = page.getByTestId('validate-issues');
    await expect(issues).toBeVisible({ timeout: 20_000 });
    await expect(issues).toContainText('console_weekend.');
    await expect(issues).toContainText('gate');

    await page.screenshot({ path: `${SHOTS}/console-validation-issues.png`, fullPage: true });
  });

  test('authors, publishes, sees it live, and rolls it back', async ({ page }) => {
    await connect(page);

    const slug = `console_weekend_${Date.now().toString(36)}`;
    const body = { ...EVENT, id: slug };
    await page.getByTestId('doc-slug').fill(slug);
    await page.getByTestId('doc-title').fill('Console Weekend');
    await page.getByTestId('doc-body').fill(JSON.stringify(body, null, 2));

    // 1. Validate. A clean dry run before anything is stored.
    await page.getByTestId('validate').click();
    await expect(page.getByTestId('validate-ok')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/console-authoring.png`, fullPage: true });

    // 2. Draft.
    await page.getByTestId('draft').click();
    await expect(page.getByTestId('banner')).toContainText('Drafted', { timeout: 20_000 });

    // 3. Stage, then publish. The lifecycle is the lifecycle; there is no
    //    shortcut, and the console does not invent one.
    await page.getByTestId(`transition-${slug}-staged`).click();
    await expect(page.getByTestId('banner')).toContainText('is now staged', { timeout: 20_000 });
    await page.getByTestId(`transition-${slug}-published`).click();
    await expect(page.getByTestId('banner')).toContainText('is now published', { timeout: 20_000 });

    // 4. It is live, and the manifest says so — the same payload a phone gets.
    const manifestRow = page.getByTestId(`manifest-${slug}`);
    await expect(manifestRow).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`manifest-active-${slug}`)).toHaveText('ACTIVE');
    await page.screenshot({ path: `${SHOTS}/console-published.png`, fullPage: true });

    // 5. Take it down, then put it back — the actual launch-night sequence.
    //    Retiring is a release of its own, not an un-publish; rolling back is
    //    a *new* release that reproduces an earlier one, forward-only, so the
    //    audit trail never loses a step.
    const liveRelease = Number(await page.getByTestId('manifest-release-version').innerText());

    await page.getByTestId(`transition-${slug}-retired`).click();
    await expect(page.getByTestId('banner')).toContainText('is now retired', { timeout: 20_000 });
    // A phone polling now gets its compiled-in world back.
    await expect(page.getByTestId(`manifest-${slug}`)).toHaveCount(0, { timeout: 20_000 });

    await page.getByTestId('tab-releases').click();
    const releases = page.getByTestId('releases');
    await expect(releases).toBeVisible({ timeout: 20_000 });
    await expect(releases.locator('tbody tr')).toHaveCount(2, { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/console-releases.png`, fullPage: true });

    await page.getByTestId('rollback-note').fill('taken down by mistake before the weekend');
    await page.getByTestId(`rollback-${liveRelease}`).click();
    await expect(page.getByTestId('banner')).toContainText(`reproduces release ${liveRelease}`, {
      timeout: 20_000,
    });
    await page.screenshot({ path: `${SHOTS}/console-rolled-back.png`, fullPage: true });

    // Forward-only: three releases now, and the newest says which it reproduces.
    await expect(releases.locator('tbody tr')).toHaveCount(3, { timeout: 20_000 });
    await expect(releases.locator('tbody tr').first()).toContainText(`reproduces ${liveRelease}`);

    // ...and the event is live again, on a *new* document version.
    await page.getByTestId('tab-content').click();
    await expect(page.getByTestId(`manifest-active-${slug}`)).toHaveText('ACTIVE', { timeout: 20_000 });
  });

  test('opens a print run, mints it, and says the response is the only copy', async ({ page }) => {
    await connect(page);
    await page.getByTestId('tab-codes').click();

    await page.getByTestId('batch-label').fill('E2E print order 4471');
    await page.getByTestId('batch-size').fill('50');
    await page.getByTestId('batch-reward').fill('free_kit');
    await page.getByTestId('create-batch').click();
    await expect(page.getByTestId('banner')).toContainText('Opened', { timeout: 20_000 });

    const batches = page.getByTestId('batches');
    await expect(batches).toBeVisible();
    const firstRow = batches.locator('tbody tr').first();
    const batchId = (await firstRow.locator('code').first().innerText()).trim();

    await page.getByTestId(`mint-count-${batchId}`).fill('5');
    await page.getByTestId(`mint-${batchId}`).click();

    const codes = page.getByTestId('minted-codes');
    await expect(codes).toBeVisible({ timeout: 20_000 });
    const text = await codes.inputValue();
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toContain('somemore://c/SM1.');
    // The sentence that has to be on the screen: there is no second copy.
    await expect(page.getByText('only copy that exists')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/console-minted.png`, fullPage: true });

    // Retire it. One run, not every run.
    page.once('dialog', (dialog) => void dialog.accept('a pallet turned up on eBay'));
    await page.getByTestId(`retire-${batchId}`).click();
    await expect(page.getByTestId('banner')).toContainText('Every other run keeps working', { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/console-retired.png`, fullPage: true });
  });

  test('never ships from the player build', async ({ page }) => {
    // The security posture in one assertion: the console is a different build.
    // Nothing about live ops, the ops header, or the authoring routes is in
    // anything the player's origin serves.
    const sources: string[] = [];
    page.on('response', async (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('javascript')) return;
      try {
        sources.push(await response.text());
      } catch {
        /* a response body that went away is not evidence of anything */
      }
    });

    await page.goto('/?camp=camp-console-check&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore));
    await page.waitForTimeout(2000);

    const bundle = sources.join('\n');
    expect(bundle.length).toBeGreaterThan(10_000);
    for (const forbidden of ['x-somemore-ops-token', '/v1/live-ops/', 'LIVE_OPS_TOKEN']) {
      expect(bundle, `player build must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
