/**
 * The web app manifest, as data.
 *
 * Written here rather than as a static file in `public/` because the icon list
 * has to agree with what the build actually emits (`icon.ts`), and two lists
 * that must agree should be one list.
 */

import { ICON_SPECS, NIGHT_HEX } from './icon.js';

export interface WebManifest {
  [key: string]: unknown;
}

export function buildManifest(): WebManifest {
  return {
    id: '/',
    name: 'Some More',
    short_name: 'Some More',
    description:
      'Arrive at a campsite. Tend the fire. Roast a marshmallow. Run the SM-01, and take out an ice cream sandwich.',
    start_url: '/',
    scope: '/',
    /*
     * `fullscreen` first, `standalone` behind it.
     *
     * The product boots straight into the world with no title screen (spec
     * §6.2); a status bar across the top of a night sky is the same kind of
     * intrusion a title screen would be. Platforms that will not do fullscreen
     * fall back to standalone, and the notch is handled either way by
     * `viewport-fit=cover` and the safe-area insets the HUD already reads.
     */
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    /*
     * Not locked. You can hold a campfire either way up, the HUD is anchored
     * to the safe area rather than to a fixed layout, and locking orientation
     * takes a choice away from anyone who props a phone on its side.
     */
    orientation: 'any',
    background_color: NIGHT_HEX,
    theme_color: NIGHT_HEX,
    lang: 'en',
    dir: 'ltr',
    categories: ['games', 'entertainment'],
    icons: ICON_SPECS.filter((spec) => !spec.file.includes('apple-touch')).map((spec) => ({
      src: `/${spec.file}`,
      sizes: `${spec.size}x${spec.size}`,
      type: 'image/png',
      purpose: spec.purpose,
    })),
  };
}
