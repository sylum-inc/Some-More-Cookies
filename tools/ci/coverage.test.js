import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every Playwright project is run by CI.
 *
 * This exists because the comment above the suites matrix in `ci.yml` — "a
 * suite nothing enforces is a suite that is already broken and has not been
 * told yet" — turned out to be true about that very matrix. It listed nine
 * projects; the config defines fifteen. `acceptance`, `access`, `perf` and
 * `visual` have jobs of their own, which left `fire` and `place` enforced by
 * nobody. `fire` was later found red on main by somebody running it by hand.
 *
 * Counting by eye is what failed the first time, so this counts instead. It
 * reads both files as text rather than importing them: `playwright.config.ts`
 * pulls in the whole Playwright runtime for what is a list of names, and the
 * workflow is YAML that nothing else in the repo has a parser for.
 */

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

/** Project names, from the `{ name: '…'` that opens each entry in the projects array. */
function playwrightProjects() {
  const config = read('playwright.config.ts');
  return [...config.matchAll(/\{ name: '([a-z-]+)'/g)].map((match) => match[1]);
}

/**
 * Projects CI runs.
 *
 * Three routes reach a project and all three have to be followed, because the
 * gap this test exists to close was created by only looking at one of them:
 * the suites matrix, a literal `--project=` in a step, and — the one that is
 * easy to miss — an `npm run` of a script that carries the flag. `perf` and
 * `visual` are only ever reached that way.
 */
function projectsCiRuns() {
  const workflow = read('.github/workflows/ci.yml');
  const scripts = JSON.parse(read('package.json')).scripts ?? {};

  const projectsIn = (text) => [...text.matchAll(/--project[= ]([a-z-]+)/g)].map((match) => match[1]);

  const found = new Set([
    ...[...workflow.matchAll(/^\s+- ([a-z-]+)\s+#/gm)].map((match) => match[1]),
    ...projectsIn(workflow),
  ]);

  // `npm run perf` is `npm run perf:sim && npm run perf:render && ...`, so a
  // script may name another script. One extra pass covers every case here and
  // stops well short of writing a shell parser.
  for (const invoked of [...workflow.matchAll(/npm run ([a-z0-9:-]+)/g)].map((match) => match[1])) {
    const command = scripts[invoked];
    if (command === undefined) continue;
    for (const project of projectsIn(command)) found.add(project);
    for (const nested of [...command.matchAll(/npm run ([a-z0-9:-]+)/g)].map((match) => match[1])) {
      for (const project of projectsIn(scripts[nested] ?? '')) found.add(project);
    }
  }
  return found;
}

describe('the suites CI actually runs', () => {
  it('covers every Playwright project the config defines', () => {
    const defined = playwrightProjects();
    // A guard on the guard: if the regex stops matching, this test would pass
    // by finding nothing to check, which is the failure mode it exists to stop.
    expect(defined.length).toBeGreaterThanOrEqual(15);

    /*
     * The one project that is deliberately not a gate.
     *
     * `gallery` asserts nothing — it is a contact sheet, sixty-one frames and
     * five motion strips produced for a person to grade — so there is no
     * failure for CI to catch and a job running it would burn four minutes to
     * report success unconditionally. It is exempt by name rather than by the
     * regex quietly missing it, so that the exemption is a decision somebody
     * made and can be argued with.
     */
    const notAGate = new Set(['gallery']);

    const run = projectsCiRuns();
    const unenforced = defined.filter((project) => !run.has(project) && !notAGate.has(project));
    expect(unenforced, `no CI job runs: ${unenforced.join(', ')}`).toEqual([]);
  });

  it('names a failure sentence beside each project in the matrix', () => {
    /*
     * The matrix entries carry a comment saying what it means when that
     * project goes red — "the campsite is no longer shared" — because the
     * projects are split by what they fail on rather than by what they touch.
     * A project added without one is a project whose red tells you nothing.
     */
    const workflow = read('.github/workflows/ci.yml');
    const block = workflow.slice(workflow.indexOf('        project:'));
    const entries = [...block.matchAll(/^\s+- ([a-z-]+)(\s+#\s*(.*))?$/gm)].slice(0, 32);
    const silent = entries.filter((entry) => (entry[3] ?? '').trim().length < 12).map((entry) => entry[1]);
    expect(silent, `matrix entries with no failure sentence: ${silent.join(', ')}`).toEqual([]);
  });
});
