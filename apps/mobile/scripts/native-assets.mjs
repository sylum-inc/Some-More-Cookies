/**
 * Draws the native launcher icons and launch images.
 *
 * `npx cap add ios` and `npx cap add android` copy a template that contains
 * placeholder PNGs — a Capacitor logo on a white field. Those are binary
 * assets, and this repository does not have any (ADR-0002). So the moment
 * either project is generated, this script overwrites every one of them with a
 * picture drawn from `apps/web/src/pwa/icon.ts` — the same campfire, the same
 * palette, the same nearest-neighbour upscale as the web icons and the same
 * five-bit quantisation as the world itself.
 *
 * Run it after `cap add` and after any `cap sync`:
 *
 *     node scripts/native-assets.mjs
 *     node scripts/native-assets.mjs --out /tmp/preview   # somewhere to look
 *
 * With `--out` it writes the whole tree to a directory of your choosing and
 * needs no native project at all, which is how it is verified on a machine
 * with neither Xcode nor an Android SDK.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderIcon, renderSplash, drawCampfire, upscale, ICON_PALETTE } from '../../web/src/pwa/icon.ts';
import { encodePng } from '../../web/src/pwa/png.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '..');

const png = (bitmap) => encodePng(bitmap, (data) => deflateSync(data, { level: 9 }));

/** Android launcher densities, in the ratios the platform defines. */
const DENSITIES = [
  { name: 'mdpi', factor: 1 },
  { name: 'hdpi', factor: 1.5 },
  { name: 'xhdpi', factor: 2 },
  { name: 'xxhdpi', factor: 3 },
  { name: 'xxxhdpi', factor: 4 },
];

/**
 * The Android adaptive-icon foreground layer.
 *
 * The layer is 108dp and the system may crop everything outside the middle
 * 72dp, so the fire is drawn at just over half scale to survive a circular
 * mask on one launcher and a squircle on the next. It is opaque rather than
 * transparent — this encoder writes truecolour with no alpha — which means the
 * background layer never shows. That is fine here and only here: the layer
 * behind it is the same night, so an opaque foreground and a transparent one
 * produce the same icon.
 */
function foreground(size) {
  return upscale(drawCampfire(64, { scale: 0.52, lift: 0.085 }), size, size);
}

/** A flat field of night, for the layer nothing will ever see. */
function nightField(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const [r, g, b] = ICON_PALETTE.night;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width: size, height: size, data };
}

/** Every file the two platforms want, as paths relative to a project root. */
function plan() {
  const files = [];

  // --- Android ---------------------------------------------------------
  const res = 'android/app/src/main/res';
  for (const density of DENSITIES) {
    const launcher = Math.round(48 * density.factor);
    const adaptive = Math.round(108 * density.factor);
    files.push(
      { path: `${res}/mipmap-${density.name}/ic_launcher.png`, bitmap: () => renderIcon(launcher) },
      {
        path: `${res}/mipmap-${density.name}/ic_launcher_round.png`,
        // Round launchers crop to a circle, so the fire is pulled in the same
        // way a maskable web icon is.
        bitmap: () => renderIcon(launcher, { scale: 0.78, lift: 0.045 }),
      },
      {
        path: `${res}/mipmap-${density.name}/ic_launcher_foreground.png`,
        bitmap: () => foreground(adaptive),
      },
      {
        path: `${res}/mipmap-${density.name}/ic_launcher_background.png`,
        bitmap: () => nightField(adaptive),
      },
    );
  }
  // The launch image the template's `AppTheme.NoActionBarLaunch` shows.
  files.push(
    { path: `${res}/drawable/splash.png`, bitmap: () => renderSplash(480, 800) },
    { path: `${res}/drawable-port-hdpi/splash.png`, bitmap: () => renderSplash(480, 800) },
    { path: `${res}/drawable-land-hdpi/splash.png`, bitmap: () => renderSplash(800, 480) },
    { path: `${res}/drawable-port-xhdpi/splash.png`, bitmap: () => renderSplash(720, 1280) },
    { path: `${res}/drawable-land-xhdpi/splash.png`, bitmap: () => renderSplash(1280, 720) },
    { path: `${res}/drawable-port-xxhdpi/splash.png`, bitmap: () => renderSplash(960, 1600) },
    { path: `${res}/drawable-land-xxhdpi/splash.png`, bitmap: () => renderSplash(1600, 960) },
    { path: `${res}/drawable-port-xxxhdpi/splash.png`, bitmap: () => renderSplash(1280, 1920) },
    { path: `${res}/drawable-land-xxxhdpi/splash.png`, bitmap: () => renderSplash(1920, 1280) },
  );

  // --- iOS -------------------------------------------------------------
  const assets = 'ios/App/App/Assets.xcassets';
  files.push({
    path: `${assets}/AppIcon.appiconset/AppIcon-512@2x.png`,
    bitmap: () => renderIcon(1024),
  });
  // One square image, shown at every size and orientation with aspect fill —
  // which is why it is square and why the fire is small in the middle of it.
  for (const suffix of ['-1', '-2', '-3']) {
    files.push({
      path: `${assets}/Splash.imageset/splash-2732x2732${suffix}.png`,
      bitmap: () => renderSplash(2732, 2732),
    });
  }

  return files;
}

/** The catalogue metadata Xcode and Android read alongside the pictures. */
const MANIFESTS = [
  {
    path: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json',
    body: JSON.stringify(
      {
        images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
        info: { author: 'some-more', version: 1 },
      },
      null,
      2,
    ),
  },
  {
    path: 'ios/App/App/Assets.xcassets/Splash.imageset/Contents.json',
    body: JSON.stringify(
      {
        images: [
          { filename: 'splash-2732x2732-1.png', idiom: 'universal', scale: '1x' },
          { filename: 'splash-2732x2732-2.png', idiom: 'universal', scale: '2x' },
          { filename: 'splash-2732x2732-3.png', idiom: 'universal', scale: '3x' },
        ],
        info: { author: 'some-more', version: 1 },
      },
      null,
      2,
    ),
  },
  {
    path: 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    body:
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
      '    <background android:drawable="@mipmap/ic_launcher_background"/>\n' +
      '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
      '</adaptive-icon>\n',
  },
  {
    path: 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
    body:
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
      '    <background android:drawable="@mipmap/ic_launcher_background"/>\n' +
      '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
      '</adaptive-icon>\n',
  },
];

function main() {
  const outIndex = process.argv.indexOf('--out');
  const target = outIndex >= 0 ? resolve(process.argv[outIndex + 1] ?? '.') : MOBILE;
  const explicit = outIndex >= 0;

  const files = plan();
  let written = 0;
  let skipped = 0;

  for (const { path, bitmap } of files) {
    const full = join(target, path);
    // Without `--out`, only write into a project that exists. Creating an
    // `android/` tree with nothing but icons in it would look like a native
    // project and build like nothing at all.
    if (!explicit && !existsSync(join(target, path.split('/')[0]))) {
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, png(bitmap()));
    written += 1;
  }

  for (const { path, body } of MANIFESTS) {
    const full = join(target, path);
    if (!explicit && !existsSync(join(target, path.split('/')[0]))) {
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    written += 1;
  }

  console.log(`native assets: ${written} written into ${target}`);
  if (skipped > 0) {
    console.log(
      `             ${skipped} skipped — run "npx cap add ios" / "npx cap add android" first,\n` +
        '             or pass --out <dir> to write the whole tree somewhere to look at.',
    );
  }
}

main();
