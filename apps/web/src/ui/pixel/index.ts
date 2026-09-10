/**
 * The pixel overlay kit.
 *
 * Panels drawn into the game's own buffer instead of on top of it. Start at
 * `panel.ts` — its header is the wiring instructions, including the part the
 * canvas cannot do and the DOM has to.
 *
 * Nothing in here draws an overlay by itself and nothing in here imports one.
 * The dependency runs one way: `Passport.tsx`, `Settings.tsx`, `Scan.tsx`,
 * `Terminal.tsx` and the survey in `Hud.tsx` are content, `ui/PixelPanel.tsx`
 * is the wiring, and this is the material. All five are converted now — the
 * warning this note used to carry, that a half-converted overlay in the tree
 * would be worse than none, was earned twice and is finally spent.
 */

export * from './palette.js';
export * from './surface.js';
export * from './dither.js';
export * from './photo.js';
export * from './chrome.js';
export * from './layout.js';
export * from './panel.js';
