/**
 * The native shell's configuration.
 *
 * This file, `package.json`, `scripts/` and `README.md` are the whole of
 * `apps/mobile` in version control. The `ios/` and `android/` projects
 * Capacitor generates are deliberately not committed — see the README for why,
 * and for what has to be true before that changes.
 *
 * Everything here is chosen so the native shell is the same product rather
 * than a browser with the chrome painted out.
 */

import type { CapacitorConfig } from '@capacitor/cli';

/** The night from `apps/web/src/ui/styles.ts`, and from the web manifest. */
const NIGHT = '#0a0d12';

const config: CapacitorConfig = {
  appId: 'com.somemore.campfire',
  appName: 'Some More',

  /**
   * The same build the web ships.
   *
   * Not a separate mobile build and not a copy: `npx cap sync` takes
   * `apps/web/dist` exactly as it is, so a native release is by construction
   * the web release. The service worker in that directory is inert inside a
   * `capacitor://` WebView — there is no network to be offline from — and does
   * no harm; the offline behaviour it provides on the web is what the native
   * bundle provides for free.
   */
  webDir: '../web/dist',

  /**
   * Dark, everywhere, from the first frame.
   *
   * A white flash before a product that opens on a night trail is the one
   * thing worth configuring here above all others.
   */
  backgroundColor: NIGHT,

  android: {
    backgroundColor: NIGHT,
    // The world is drawn on a WebGL canvas at a low internal resolution and
    // upscaled (ADR-0003). Letting the WebView mix in its own scaling would
    // undo the whole point.
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },

  ios: {
    backgroundColor: NIGHT,
    // The page draws under the status bar and the home indicator; the HUD's
    // safe-area insets are what keep controls out from under them, exactly as
    // on the web.
    contentInset: 'never',
    scrollEnabled: false,
  },

  server: {
    // `https` rather than the default `http` on Android: a secure context is
    // what WebCrypto needs, and `net/codes.ts` verifies wrapper signatures
    // with it offline (ADR-0008).
    androidScheme: 'https',
  },

  plugins: {
    /*
     * Deliberately empty.
     *
     * Every Capacitor plugin is a runtime dependency of the web bundle, and
     * this repository does not add those to the app (see ARCHITECTURE and the
     * working agreements). The shell is a shell: it hosts the same code, and
     * the moment it needs to do something the web cannot, that is a decision
     * to argue rather than a package to install.
     */
  },
};

export default config;
