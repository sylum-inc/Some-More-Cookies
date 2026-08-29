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
  reporter: [['list']],
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview --workspace @somemore/web',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
