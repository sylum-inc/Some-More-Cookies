/**
 * Runs the visual suite in calibration mode.
 *
 * A thin wrapper rather than an inline `VISUAL_MEASURE=1 playwright test ...`
 * in package.json, so the script works the same on a shell that does not
 * understand leading environment assignments, and so no dependency has to be
 * added for that.
 *
 * Run: `npm run visual:measure`
 */

import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from '../lib/io.mjs';

const result = spawnSync('npx', ['playwright', 'test', '--project=visual', ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, VISUAL_MEASURE: '1' },
});

process.exit(result.status ?? 1);
