/**
 * How bright the heads-up display is allowed to be, as one number.
 *
 * The HUD was the brightest thing on the screen in a game about a campfire.
 * Measured across the contact sheet, the reach plate's marshmallow sprite peaks
 * at luminance 241.1 — exactly `cream4`, `#fbf1d8`, the top of the sprite
 * ramp — and the fire peaks at 237 to 246 on a clear night and 209 to 218 in
 * fog, rain, storm and snow. So in every weather frame in the sheet, and in
 * most of the clear ones, the thing a player's eye went to first was an
 * inventory chip. An art director on the panel put it exactly: "the brightest,
 * hottest thing in a game about a campfire is an inventory chip".
 *
 * The chrome is drawn by the browser, not by the renderer, so nothing in the
 * lighting ever touched it: it was at full brightness at noon, at midnight and
 * under a snow sky alike. This is the one place it is told what the light is.
 *
 * A ceiling rather than a scale, stated as the luminance the brightest ink in
 * the HUD may reach, because the thing being protected is a comparison — the
 * fire has to win it — and a ceiling is what that comparison needs. The day
 * ceiling sits nineteen steps under the dimmest fire the sheet recorded (snow,
 * 209.4) and fifty under a clear night's; the night one is lower again,
 * because a HUD that is the same grey at every hour "outranks everything
 * except the fire" on a dark frame. See `e2e/hud.spec.ts` for the measurement
 * that holds it.
 *
 * Deliberately a function of the hour and nothing finer. The weather dims the
 * fire far more than the hour does, and the obvious refinement is to chase it
 * — but that couples the interface to fog density and flame size, and the day
 * ceiling already clears the worst weather in the sheet. If the lighting pass
 * brings the weathered fire up, the margin grows; it does not need retuning.
 */

import type { ActivityWindow } from '@somemore/sim';

/**
 * The brightest ink any HUD element carries: `cream4`, the top of the sprite
 * ramp in `tools/sprites/canvas.mjs`, which is the marshmallow's highlight and
 * every icon's lit edge. Rec. 601 luma of `#fbf1d8`.
 */
export const HUD_BRIGHTEST_INK = 0.299 * 0xfb + 0.587 * 0xf1 + 0.114 * 0xd8;

export type LightRegime = 'day' | 'twilight' | 'night';

/** Display luminance, 0-255, that the brightest HUD ink may reach. */
export const HUD_CEILING: Readonly<Record<LightRegime, number>> = {
  day: 190,
  twilight: 182,
  night: 170,
};

export function lightRegime(window: ActivityWindow): LightRegime {
  switch (window) {
    case 'morning':
    case 'midday':
    case 'afternoon':
      return 'day';
    case 'dawn':
    case 'dusk':
    case 'pre-dawn':
      return 'twilight';
    case 'early-night':
    case 'deep-night':
      return 'night';
  }
}

/**
 * The brightness multiplier for the HUD's chrome at this hour.
 *
 * High contrast is exempt, and not as a courtesy. That mode exists for a player
 * who needs the interface to win against the picture, which is the opposite
 * of what this is for, and §12 decides that argument before art direction
 * gets a vote.
 */
export function hudKey(window: ActivityWindow, highContrast: boolean): number {
  if (highContrast) return 1;
  return HUD_CEILING[lightRegime(window)] / HUD_BRIGHTEST_INK;
}
