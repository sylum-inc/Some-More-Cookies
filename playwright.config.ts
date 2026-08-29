import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Finds a pre-provisioned Chromium.
 *
 * CI images here ship a browser build that may not match the version this
 * Playwright release would download, and downloading is disabled. Pointing at
 * the installed binary is the supported way out; falling back to `undefined`
 * lets a normal developer machine use Playwright's own managed browser.
 */
function findChromium(): string | undefined {
  const fromEnv = process.env['SOME_MORE_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (!root || !existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-linux', 'chrome'));
  return candidates.find((candidate) => existsSync(candidate));
}

const chromiumPath = findChromium();

/**
 * End-to-end configuration.
 *
 * The suite drives the real ritual through the real simulation in a real
 * browser and captures a screenshot at every stage, because "does the
 * sandwich look delicious?" is not a question a unit test can answer
 * (spec §16.1).
 */
export default defineConfig({
  testDir: './e2e',
  /**
   * The ritual is not fast, and roasting is driven by real pointer input at
   * real speed. Long simulation waits (the fire burning down, the machine
   * run) are fast-forwarded through the real model rather than waited out —
   * see `advanceSeconds` — but the interactions themselves are not, so the
   * budget still has to be generous.
   */
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  /**
   * `list` for a readable terminal run; `html` because CI uploads the report
   * as an artifact and a failed visual comparison is only useful if you can
   * see the expected/actual/diff triptych.
   */
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  /**
   * Visual baselines live in one obvious, reviewable directory rather than
   * beside each spec, so `e2e/__screenshots__/` is the whole set a reviewer
   * has to look at when a diff is proposed. See `tools/README.md`.
   */
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    launchOptions: {
      // SwiftShader: these runs happen on machines with no GPU.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
  },
  /**
   * One project per kind of evidence, so a red build names the thing that
   * broke: acceptance ("the ritual stopped working"), perf ("a budget was
   * blown"), visual ("the picture changed"). CI runs them as separate jobs.
   */
  projects: [
    { name: 'acceptance', testMatch: /ritual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The secondary activities (spec §5.2). Separate from `acceptance` because
     * they fail on a different thing: not "the ritual stopped working" but
     * "you can no longer do anything at this campsite except make a s'more".
     */
    { name: 'activities', testMatch: /activities\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'perf', testMatch: /perf\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'visual', testMatch: /visual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * "Can you see anything?" is its own kind of evidence: not that the
     * picture changed, but that there is a picture at all once the fire goes
     * out. It measures the frame rather than comparing it, so it survives the
     * rendering differences a visual baseline cannot.
     */
    { name: 'night', testMatch: /night\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run preview --workspace @somemore/web',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
