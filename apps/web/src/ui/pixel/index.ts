/**
 * The pixel overlay kit.
 *
 * Panels drawn into the game's own buffer instead of on top of it. Start at
 * `panel.ts` — its header is the wiring instructions, including the part the
 * canvas cannot do and the DOM has to.
 *
 * Nothing in here draws an overlay by itself and nothing in here imports one.
 * The existing `Passport.tsx`, `Settings.tsx` and `Hud.tsx` are untouched: the
 * conversion is a separate change, and a half-converted overlay in the tree
 * would be worse than none.
 */

export * from './palette.js';
export * from './surface.js';
export * from './dither.js';
export * from './photo.js';
export * from './chrome.js';
export * from './layout.js';
export * from './panel.js';
