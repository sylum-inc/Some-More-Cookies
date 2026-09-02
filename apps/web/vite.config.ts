import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  ICON_SPECS,
  SPLASH_SPECS,
  renderIcon,
  renderSplash,
  splashLinkAttributes,
  type Bitmap,
} from './src/pwa/icon.ts';
import { normaliseBase, withBase } from './src/pwa/base.ts';
import { buildManifest } from './src/pwa/manifest.ts';
import { encodePng as toPng } from './src/pwa/png.ts';
import { serviceWorkerSource } from './src/pwa/serviceWorkerSource.ts';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The encoder lives in `src/pwa/png.ts` and takes its compressor as an
 * argument, so the same code writes the web icons here and the native launcher
 * icons in `apps/mobile`. Node's `deflateSync` returns a `Buffer`, which is a
 * `Uint8Array`, so nothing needs converting.
 */
const encodePng = (bitmap: Bitmap): Uint8Array =>
  toPng(bitmap, (data) => deflateSync(data, { level: 9 }));

// --- The plugin --------------------------------------------------------------

interface GeneratedAsset {
  fileName: string;
  source: Uint8Array | string;
  /** Whether the service worker should hold a copy for offline boots. */
  precache: boolean;
  mime: string;
}

/**
 * Everything except the service worker, which needs the bundle's own filenames
 * and so is built later.
 */
function staticPwaAssets(base: string): GeneratedAsset[] {
  const assets: GeneratedAsset[] = ICON_SPECS.map((spec) => ({
    fileName: spec.file,
    source: encodePng(renderIcon(spec.size, spec.purpose === 'maskable' ? { scale: 0.78, lift: 0.045 } : {})),
    // Only the sizes something actually asks for on a cold boot: the tab
    // favicon and the two the launcher reads. The rest are fetched once, by
    // the platform, at install time.
    precache: [32, 180, 192, 512].includes(spec.size),
    mime: 'image/png',
  }));

  assets.push({
    fileName: 'manifest.webmanifest',
    source: JSON.stringify(buildManifest(base), null, 2),
    precache: true,
    mime: 'application/manifest+json',
  });

  /*
   * The iOS launch images are deliberately not precached. Safari reads them
   * when a person adds the app to their home screen, not when the app boots,
   * and there are twenty-two of them; putting several megabytes of night sky
   * into the offline cache to save a fetch that never happens offline would be
   * the wrong trade on a phone.
   */
  for (const spec of SPLASH_SPECS) {
    assets.push({
      fileName: spec.file,
      source: encodePng(renderSplash(spec.width, spec.height)),
      precache: false,
      mime: 'image/png',
    });
  }

  return assets;
}

/** The tags the platforms read, derived from the same specs the build emits. */
function headTags(base: string): { tag: string; attrs: Record<string, string> }[] {
  const favicons = ICON_SPECS.filter((spec) => [16, 32, 48, 192].includes(spec.size)).map(
    (spec) => ({
      tag: 'link',
      attrs: {
        rel: 'icon',
        type: 'image/png',
        sizes: `${spec.size}x${spec.size}`,
        href: withBase(base, spec.file),
      },
    }),
  );

  return [
    { tag: 'link', attrs: { rel: 'manifest', href: withBase(base, 'manifest.webmanifest') } },
    ...favicons,
    { tag: 'link', attrs: { rel: 'apple-touch-icon', href: withBase(base, 'icons/apple-touch-icon.png') } },
    // iOS reads these instead of the manifest. `black-translucent` draws the
    // page under the status bar, which is what `viewport-fit=cover` and the
    // HUD's safe-area insets are already arranged for, and is the only value
    // that does not put a light bar across the top of a night sky.
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Some More' } },
    { tag: 'meta', attrs: { name: 'application-name', content: 'Some More' } },
    { tag: 'meta', attrs: { name: 'color-scheme', content: 'dark' } },
    ...SPLASH_SPECS.map((spec) => ({
      tag: 'link',
      attrs: { rel: 'apple-touch-startup-image', ...splashLinkAttributes(spec, base) },
    })),
  ];
}

function pwaPlugin(base: string): Plugin {
  let assets: GeneratedAsset[] = [];

  return {
    name: 'some-more:pwa',

    buildStart() {
      assets = staticPwaAssets(base);
    },

    transformIndexHtml() {
      return headTags(base).map((entry) => ({
        tag: entry.tag,
        attrs: entry.attrs,
        injectTo: 'head' as const,
      }));
    },

    /**
     * Dev serves the same bytes from memory.
     *
     * Not the service worker, though: a worker holding a cache-first copy of
     * an unbundled module graph is the fastest way to spend an afternoon
     * debugging yesterday's code. Dev gets one that tears itself out, so a
     * developer who once loaded a production build on this origin is not left
     * with it.
     */
    configureServer(server) {
      if (assets.length === 0) assets = staticPwaAssets(base);
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        if (path === 'sw.js') {
          res.setHeader('content-type', 'text/javascript');
          res.end(
            "self.addEventListener('install', () => self.skipWaiting());\n" +
              "self.addEventListener('activate', (event) => event.waitUntil((async () => {\n" +
              '  for (const name of await caches.keys()) await caches.delete(name);\n' +
              '  await self.registration.unregister();\n' +
              '})()));\n',
          );
          return;
        }
        const asset = assets.find((candidate) => candidate.fileName === path);
        if (!asset) {
          next();
          return;
        }
        res.setHeader('content-type', asset.mime);
        res.end(typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source));
      });
    },

    generateBundle(_options, bundle) {
      for (const asset of assets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
      }

      /*
       * What the worker holds: the shell, the code, and the handful of images
       * a cold boot asks for. Source maps are excluded on purpose — seven
       * megabytes of them would be the largest thing on the device by an order
       * of magnitude, and nothing offline reads them.
       */
      const emitted = Object.keys(bundle)
        .filter((name) => !name.endsWith('.map'))
        .sort();

      /*
       * `/` and `/index.html` are listed by hand.
       *
       * The HTML is not in `bundle` at this point — it is emitted after this
       * hook by the plugin that builds it — so deriving the whole list from
       * the bundle silently produced a worker with every asset precached and
       * no shell to hang them on. That is an offline boot that fetches the
       * page it cannot fetch, and nothing but actually going offline finds it.
       * Both spellings are listed because a host may serve either.
       *
       * Every entry carries the base. Under a project page a precache list of
       * root paths is not a subtle mistake: install fetches `/index.html` from
       * the account's *other* site, caches whatever that returns, and serves
       * it as this app's shell.
       */
      const precache = [
        base,
        withBase(base, 'index.html'),
        ...emitted.map((name) => withBase(base, name)),
        ...assets.filter((asset) => asset.precache).map((asset) => withBase(base, asset.fileName)),
      ];

      if (!emitted.some((name) => name.endsWith('.js'))) {
        this.error('the PWA precache list contains no JavaScript: the build is not what it seems');
      }

      /*
       * The version is the build's own content.
       *
       * Deriving it from what was emitted rather than from a timestamp means
       * two identical builds produce an identical worker — so a redeploy of
       * the same code does not churn every device's cache — while any change
       * at all produces a new one.
       */
      const digest = createHash('sha256');
      for (const name of emitted) {
        const entry = bundle[name];
        digest.update(name);
        if (entry && entry.type === 'chunk') digest.update(entry.code);
        else if (entry && typeof entry.source === 'string') digest.update(entry.source);
        else if (entry) digest.update(Buffer.from(entry.source));
      }
      for (const asset of assets) digest.update(asset.fileName);
      /*
       * The HTML source, by hand, for the same reason it is precached by hand:
       * it is not in `bundle` yet. Without this a build that changed only
       * `index.html` — a meta tag, the first-paint stylesheet — would produce a
       * byte-identical worker, and no device would ever pick the change up.
       */
      digest.update(readFileSync(pkg('./index.html')));
      const version = digest.digest('hex').slice(0, 16);

      /*
       * GitHub Pages runs Jekyll over whatever it is handed unless told not
       * to, and Jekyll drops every file and directory whose name begins with
       * an underscore. Nothing this build emits does today, which is exactly
       * why the marker belongs here rather than in a deploy script: the day a
       * chunk is named `_shared-…js`, the failure is a blank page on a host
       * nobody can debug from, and not one test would have gone red.
       */
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        // The shell is the base: it is the URL a launch actually requests, and
        // it is the one spelling every host agrees on.
        source: serviceWorkerSource({
          version,
          precache,
          shell: base,
          swPath: withBase(base, 'sw.js'),
        }),
      });
    },
  };
}

/*
 * Where this build will be served from.
 *
 * `/` unless `BASE_PATH` says otherwise, so every existing command, every test
 * and every local preview is untouched. A project page sets it:
 *
 *     BASE_PATH=/Some-More-Cookies/ npm run build --workspace @somemore/web
 *
 * It is one value because it has to be: it decides the asset URLs, the
 * manifest's identity and scope, the service worker's registration scope and
 * every entry in its precache list. See `src/pwa/base.ts`.
 */
const BASE = normaliseBase(process.env['BASE_PATH']);

export default defineConfig({
  base: BASE,
  plugins: [react(), pwaPlugin(BASE)],
  resolve: {
    alias: {
      '@somemore/sim': pkg('../../packages/sim/src/index.ts'),
      '@somemore/content': pkg('../../packages/content/src/index.ts'),
      '@somemore/protocol': pkg('../../packages/protocol/src/index.ts'),
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
