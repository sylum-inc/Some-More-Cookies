/**
 * The web app manifest, as data.
 *
 * Written here rather than as a static file in `public/` because the icon list
 * has to agree with what the build actually emits (`icon.ts`), and two lists
 * that must agree should be one list.
 */

import { withBase } from './base.js';
import { ICON_SPECS, NIGHT_HEX } from './icon.js';

export interface WebManifest {
  [key: string]: unknown;
}

export function buildManifest(base = '/'): WebManifest {
  return {
    /*
     * The identity of the installed app, and it must carry the base.
     *
     * On `*.github.io` every project page on an account shares one origin, so
     * an `id` of `/` is not "this app at the root" — it is a name every other
     * project this account publishes would also claim. Two apps with one id is
     * one app as far as an install is concerned.
     */
    id: base,
    name: 'Some More',
    short_name: 'Some More',
    description:
      'Arrive at a campsite. Tend the fire. Roast a marshmallow. Run the SM-01, and take out an ice cream sandwich.',
    start_url: base,
    /*
     * The scope is what the launcher will and will not open in the installed
     * window, and what the service worker is allowed to control. Under a
     * project page it must be the subdirectory: a scope of `/` would be
     * refused by the browser for a worker served from a subdirectory, and
     * would try to swallow the whole account's other pages if it were not.
     */
    scope: base,
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
      src: withBase(base, spec.file),
      sizes: `${spec.size}x${spec.size}`,
      type: 'image/png',
      purpose: spec.purpose,
    })),
  };
}
