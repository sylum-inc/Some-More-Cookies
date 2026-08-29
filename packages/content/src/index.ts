/**
 * `@somemore/content` — the environment catalogue and its schema.
 *
 * Content is data (architecture §1.3): adding an environment is a new manifest
 * in `src/environments/` and an entry in `ENVIRONMENTS`, with no engine change
 * anywhere. This package depends only on `@somemore/sim` types and has no DOM,
 * no renderer and no network.
 */

export * from './schema.js';
export * from './validate.js';
export * from './selection.js';
export * from './catalogue.js';
export * from './environments/index.js';
