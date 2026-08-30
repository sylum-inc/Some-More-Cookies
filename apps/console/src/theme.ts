/**
 * The console's own visual language.
 *
 * Deliberately not the campfire's. This is an internal tool: it has to show a
 * hundred documents, a dotted validation path and a release number at two in
 * the morning before a launch weekend, and warm paper with a handwriting font
 * would make all three harder to read. What it borrows from the product is
 * exactly one thing — the amber focus ring — because muscle memory is worth
 * more than consistency for its own sake.
 *
 * It does still have to be *good*. The alternative to this screen is `curl`,
 * and the failure mode of a bad internal tool is not that somebody complains,
 * it is that they go back to `curl` and publish something at 2am with a typo
 * in it.
 */

export const C = {
  bg: '#111318',
  panel: '#191d24',
  panelEdge: '#262c36',
  text: '#e6e9ee',
  textSoft: '#98a2b3',
  textFaint: '#6b7480',
  accent: '#ffa42c',
  live: '#4ade80',
  staged: '#60a5fa',
  draft: '#a78bfa',
  retired: '#6b7480',
  danger: '#f87171',
  input: '#0d0f13',
} as const;

export const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace';
export const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const CONSOLE_CSS = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; padding: 0; }
  body {
    background: ${C.bg};
    color: ${C.text};
    font-family: ${SANS};
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  button, input, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: 0.45; }
  a { color: ${C.accent}; }
  code, pre { font-family: ${MONO}; }
  /* One thing borrowed from the campfire: the focus ring. */
  :focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
  ::selection { background: ${C.accent}; color: ${C.bg}; }
  input, select, textarea {
    background: ${C.input};
    border: 1px solid ${C.panelEdge};
    color: ${C.text};
    border-radius: 4px;
    padding: 7px 9px;
    width: 100%;
  }
  textarea { font-family: ${MONO}; font-size: 12.5px; line-height: 1.55; resize: vertical; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th {
    text-align: left;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: ${C.textFaint};
    padding: 6px 10px;
    border-bottom: 1px solid ${C.panelEdge};
    white-space: nowrap;
  }
  td { padding: 8px 10px; border-bottom: 1px solid ${C.panelEdge}; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export const STATUS_COLOUR: Readonly<Record<string, string>> = {
  draft: C.draft,
  staged: C.staged,
  published: C.live,
  retired: C.retired,
  active: C.live,
  paused: C.accent,
};
