/**
 * ESM resolve hook. Used in development, in every test, and in production.
 *
 * The source uses TypeScript's ESM convention of importing `./thing.js` from
 * `./thing.ts` (which is what `tsc` emits and what the bundler resolves).
 * Node's type stripping runs the `.ts` files directly but does not perform that
 * rewrite, so this hook retries a failed relative `.js` specifier as `.ts`.
 *
 * ---
 *
 * This file used to live in `dev/` and its comment used to end: "a production
 * build goes through `tsc`, so neither path loads this file." That was not
 * true, and nothing had ever checked it. `tsc -b` does emit JavaScript for this
 * service, and that JavaScript **does not run**: the workspace packages declare
 * `"exports": "./src/index.ts"`, so the moment the compiled service imports
 * `@somemore/protocol`, Node resolves it to TypeScript source and dies on the
 * first `./version.js` inside it. There was no working production start path at
 * all, and the artifact that looked like one had never been executed.
 *
 * So the service runs from source, in production as everywhere else. That is a
 * deliberate choice and not a shortcut:
 *
 *  - **One loading path.** What runs in production is exactly what every unit
 *    test, every integration test and every end-to-end spawn already runs.
 *    Pointing the packages at built JavaScript instead would have meant tests
 *    resolving `src` while production resolved `dist` — which is precisely the
 *    shape of defect #18, a well-tested subsystem that nothing actually
 *    reached.
 *  - **It is not experimental any more.** Node enabled type stripping by
 *    default in 22.18; this runs on 22.22 and the flag is gone from the
 *    commands. Stripping erases types and rewrites nothing else, so what
 *    executes is the source with the annotations removed.
 *  - **The cost is a startup cost**, paid once per process, and nothing here
 *    uses the TypeScript features stripping refuses (no enums, no namespaces,
 *    no parameter properties) — which the whole test suite has been proving on
 *    every run for as long as it has existed.
 *
 * `tsc -b` is still what typechecks the service and emits its declarations for
 * the project references. It no longer emits JavaScript, so there is nothing in
 * `dist/` that can be mistaken for something to deploy.
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
