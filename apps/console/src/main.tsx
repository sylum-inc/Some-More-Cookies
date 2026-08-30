/**
 * Console entry point.
 *
 * Separate app, separate build, separate port. Nothing here is reachable from
 * the player client and nothing here is bundled into it — see `ops.ts` for why
 * that is a build-time property rather than a runtime one.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CONSOLE_CSS } from './theme.js';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.appendChild(style);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
