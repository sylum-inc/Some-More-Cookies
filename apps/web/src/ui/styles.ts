/**
 * Shared UI tokens.
 *
 * The interface is a field journal and a campground booklet, not a dashboard
 * (spec §6.2). Warm paper, stamped ink, monospaced machine text.
 */

export const TOKENS = {
  paper: '#e8e0cd',
  paperEdge: '#d6cbb1',
  ink: '#2a2620',
  inkSoft: '#5c554a',
  stamp: '#8f3b2a',
  night: '#0a0d12',
  amber: '#ffa42c',
  ice: '#8fd4ff',
  ember: '#ff6a1f',
} as const;

export const FONT_STACK = {
  hand: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", ui-monospace, monospace',
  sans: '"Helvetica Neue", Arial, sans-serif',
} as const;

/** Injects the global stylesheet. */
export const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; padding: 0; background: ${TOKENS.night}; overflow: hidden; }
  body { font-family: ${FONT_STACK.sans}; color: ${TOKENS.paper}; -webkit-font-smoothing: antialiased; overscroll-behavior: none; }
  /* The low internal resolution is upscaled with nearest, which is the whole
     point of ADR-0003 — never let the browser smooth it. */
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; touch-action: none; display: block; }
  button { font: inherit; color: inherit; cursor: pointer; }
  .sm-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4vmin; z-index: 40; background: rgba(6, 8, 11, 0.72); backdrop-filter: blur(2px); }
  .sm-panel { background: ${TOKENS.paper}; color: ${TOKENS.ink}; max-width: min(860px, 94vw); max-height: 88vh; overflow-y: auto; border-radius: 3px; box-shadow: 0 18px 60px rgba(0,0,0,0.6); position: relative; }
  .sm-focus:focus-visible { outline: 3px solid ${TOKENS.amber}; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
