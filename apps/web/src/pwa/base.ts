/**
 * Where the app lives on its host.
 *
 * Almost everywhere, that is the root of an origin and this whole module is a
 * no-op returning `'/'`. The exception is a project page — GitHub Pages serves
 * `sylum-inc/Some-More-Cookies` at `https://sylum-inc.github.io/Some-More-Cookies/`
 * — and a build that assumes the root does not merely look wrong there, it
 * fails completely: the shell loads, asks the origin for `/assets/index-….js`,
 * and gets the host's 404 page.
 *
 * It has to be one value threaded through every place a path is written,
 * because the failure mode of missing one is not a broken picture. It is a
 * service worker whose scope does not cover the app, or a manifest whose
 * `start_url` launches the installed icon into somebody else's project. Those
 * are found by deploying, which is the worst place to find anything — so
 * `e2e/subpath.spec.ts` builds under a subpath, serves it there, and asserts
 * that nothing is ever requested outside it.
 */

/**
 * Normalises whatever a person put in `BASE_PATH` into a path with one leading
 * and one trailing slash.
 *
 * Accepts `Some-More-Cookies`, `/Some-More-Cookies` and `/Some-More-Cookies/`,
 * because all three are what somebody types and none of them is wrong.
 */
export function normaliseBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '/';

  /*
   * A full URL is refused rather than half-supported. Vite will take one (for
   * a CDN), but the manifest's `scope`, the worker's registration scope and
   * the precache list are all same-origin path questions, and a base that is
   * a different origin makes two of those three meaningless. Failing here
   * with a sentence is better than deploying something that installs and then
   * cannot be updated.
   */
  if (trimmed.includes('://')) {
    throw new Error(
      `BASE_PATH must be a path, not a URL (got ${trimmed}). ` +
        'The service worker scope and the manifest scope are same-origin by construction.',
    );
  }

  const collapsed = `/${trimmed}/`.replace(/\/{2,}/g, '/');
  return collapsed;
}

/**
 * Joins the base to a build-relative file name.
 *
 * The file names the build deals in (`assets/index-….js`, `icons/icon-192.png`)
 * never start with a slash, so this is deliberately strict about that rather
 * than tolerantly stripping one: a caller passing `/icons/…` has almost
 * certainly written a root-absolute path by hand somewhere it should not have.
 */
export function withBase(base: string, file: string): string {
  return `${base}${file.replace(/^\//, '')}`;
}
