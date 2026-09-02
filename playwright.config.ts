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
   * blown"), visual ("the picture changed"). CI runs them as separate jobs:
   * `acceptance`, `access`, `perf`, `visual` and the audio analysis have one
   * each, and the remaining eight share a matrix job that names the project it
   * is running. Every project here is in one of those — a suite nothing
   * enforces is a suite that is already broken and has not been told yet.
   */
  projects: [
    { name: 'acceptance', testMatch: /ritual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The secondary activities (spec §5.2). Separate from `acceptance` because
     * they fail on a different thing: not "the ritual stopped working" but
     * "you can no longer do anything at this campsite except make a s'more".
     */
    { name: 'activities', testMatch: /activities\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * §12, driven rather than read. Its own project because it fails on its
     * own thing: not "the ritual stopped working" but "the ritual stopped
     * being reachable" — and because it is the one suite forbidden from using
     * the `__someMore.actions` bridge for the stage it is auditing, which is
     * exactly why it can see what `acceptance` cannot.
     */
    { name: 'access', testMatch: /access\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The fire, driven by a finger rather than by the bridge.
     *
     * Its own project because it fails on its own thing: not "the ritual
     * stopped working" but "the wood in the pit is scenery again". Everything
     * in it that matters is a real drag on a real canvas, because the whole
     * defect it exists to catch — a verb that is modelled, tested and
     * unperformable — is invisible to a test that calls the model directly.
     */
    { name: 'fire', testMatch: /[/\\]fire\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * Whether a campsite is the campsite the catalogue describes.
     *
     * Its own project because it fails on its own thing: not "the ritual
     * stopped working" but "every place in this world became the same place
     * again" — which is what happens the moment written content stops being
     * wired to anything, and is invisible to every other suite.
     */
    { name: 'place', testMatch: /place\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'perf', testMatch: /perf\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'visual', testMatch: /visual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * "Can you see anything?" is its own kind of evidence: not that the
     * picture changed, but that there is a picture at all once the fire goes
     * out. It measures the frame rather than comparing it, so it survives the
     * rendering differences a visual baseline cannot.
     */
    { name: 'night', testMatch: /night\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * Two browser contexts at one campfire, against a real service.
     *
     * Its own project because it fails on a different thing again: not "the
     * ritual stopped working" but "the campsite is no longer shared". It
     * starts its own API on its own port from inside the spec rather than
     * adding one to `webServer`, so every other project keeps running against
     * exactly the deployment it was written for — a campsite with no signal.
     */
    { name: 'campfire', testMatch: /campfire\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * "Can a person with aeroplane mode on make a s'more?" The browser context
     * is put genuinely offline and the whole ritual is driven from a cold
     * document. It fails on a different thing again: not that the ritual
     * broke, but that the offline claim in the README was never true.
     */
    { name: 'offline', testMatch: /offline\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The service worker's update path, against a static server the spec
     * starts itself — because "a second build exists now" is not something you
     * can express to a directory that is already built. Separate because a
     * failure here means something worse than a bug: an app that cannot be
     * fixed on the devices that already have it.
     */
    { name: 'pwa-update', testMatch: /pwa-update\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * Real phone sizes, portrait and landscape, with pictures to look at.
     * Viewport, scale factor and touch come from the spec itself rather than
     * from a device preset, so the sizes in the file are the sizes tested.
     */
    { name: 'mobile', testMatch: /mobile\.spec\.ts/ },
    /*
     * Scanning a wrapper, in a real browser, against a service that really
     * mints Ed25519 codes. Its own project because it fails on its own thing:
     * not "the ritual stopped working" but "the physical bridge stopped
     * connecting" — and because the offline signature check here is the
     * browser's WebCrypto, which no node test can stand in for.
     *
     * Like `campfire`, it starts its own service on a port it asks the OS for
     * rather than adding one to `webServer`, so every other project keeps
     * running against exactly the deployment it was written for.
     */
    { name: 'redeem', testMatch: /redeem\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The live-ops console: a second build on a second origin, talking to the
     * API cross-origin the way it is deployed. It fails on "the person
     * scheduling a meteor-shower weekend is back on curl", which is a different
     * failure from every other project here. It starts its own console preview
     * and its own two services — one configured, one deliberately not.
     */
    { name: 'console', testMatch: /console\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    /*
     * The app served from a subdirectory, which is where a GitHub project page
     * puts it. Its own project because it fails on its own thing: not "the
     * ritual stopped working" but "the ritual works everywhere except where it
     * is published". It runs its own `vite build` with a base and serves it
     * under that base, because the thing under test is the build configuration
     * and a prebuilt artifact would beg the question.
     */
    { name: 'subpath', testMatch: /subpath\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  /*
   * Built, then served — and never reused.
   *
   * `vite preview` serves whatever is already in `apps/web/dist` and never
   * rebuilds it, so for a long time eleven of the thirteen projects here ran
   * against whatever the last build happened to be. A source change with no
   * rebuild was tested as the *previous* version, silently, with every
   * assertion still green if it did not happen to touch what changed. That is
   * not hypothetical: it is exactly how a console banner change was tested
   * against the old wording and passed (IMPLEMENTATION_PLAN, defect #48).
   * `subpath` was the only project immune, because it builds its own artifact
   * on purpose — the comment there already says a prebuilt one would beg the
   * question, which was true of every other project too.
   *
   * `reuseExistingServer: false` matters as much as the build. With it on, a
   * preview server left over from an earlier run is adopted silently and the
   * fresh build above is never served. Off, a leftover server is a loud
   * port-in-use error, which is the correct failure: it costs a few seconds of
   * confusion instead of hiding a regression.
   *
   * The build costs a few seconds per invocation. A false green costs however
   * long it takes somebody to notice.
   */
  webServer: {
    command: 'npm run build --workspace @somemore/web && npm run preview --workspace @somemore/web',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
