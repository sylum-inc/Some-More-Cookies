/**
 * Dev-only ESM resolve hook.
 *
 * The source uses TypeScript's ESM convention of importing `./thing.js` from
 * `./thing.ts` (which is what `tsc` emits and what the bundler resolves). Node's
 * `--experimental-strip-types` runs the .ts files directly but does not perform
 * that rewrite, so this hook retries a failed relative `.js` specifier as `.ts`.
 *
 * Used only by `npm run dev` in this package. Tests go through vitest, and a
 * production build goes through `tsc`, so neither path loads this file.
 */
import { register } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}

register(import.meta.url, import.meta.url);
