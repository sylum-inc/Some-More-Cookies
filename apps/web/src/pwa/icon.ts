/**
 * The launcher icon and the iOS launch image, drawn rather than stored.
 *
 * There are no binary assets in this repository (ADR-0002), so these are
 * rasterised from code at build time exactly like every texture in the world.
 * The drawing happens on a small grid and is upscaled with nearest-neighbour
 * for the same reason the world renders at 320x240 and upscales (ADR-0003):
 * a smoothly antialiased 512px campfire would be a different product's icon,
 * and the one place a person sees this product before they open it should
 * look like the product.
 *
 * Pure arithmetic over a byte array. No DOM, no canvas, no `Math.random` —
 * so the same function runs in the build and in a browser test, and two runs
 * produce byte-identical output.
 */

/** Straight sRGB bytes. */
export type RGB = readonly [number, number, number];

/**
 * Drawn from the night palette in `ui/styles.ts`.
 *
 * `night`, `ember` and `amber` are that file's tokens verbatim. The rest are
 * the shades those three produce when they land on wood and smoke, chosen by
 * eye against the running fire rather than derived, because the fire itself
 * was chosen by eye.
 */
export const ICON_PALETTE = {
  night: [0x0a, 0x0d, 0x12],
  glow: [0x7d, 0x35, 0x14],
  logDark: [0x33, 0x25, 0x1a],
  logLit: [0x74, 0x4c, 0x28],
  ember: [0xff, 0x6a, 0x1f],
  amber: [0xff, 0xa4, 0x2c],
  core: [0xff, 0xe4, 0xb0],
} as const satisfies Record<string, RGB>;

/** The theme colour a manifest and a status bar are tinted with. */
export const NIGHT_HEX = '#0a0d12';

/** The 4x4 ordered dither the PS1 pipeline uses, as a flat 0..15 table. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/**
 * One 8-bit channel, snapped to the 5 bits a PS1 framebuffer actually had.
 *
 * Table-driven over the dithered range, because this runs once per channel per
 * pixel and the launch images are several million pixels each.
 */
const QUANTISE = (() => {
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) {
    const value = i - 128;
    const step = Math.max(0, Math.min(31, Math.round((value / 255) * 31)));
    table[i] = Math.round((step / 31) * 255);
  }
  return table;
})();

function quantise5(value: number): number {
  const index = Math.round(value) + 128;
  return QUANTISE[index < 0 ? 0 : index > 511 ? 511 : index] as number;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

/**
 * The flame silhouette: half-width at height `t`, 0 at the base, 1 at the tip.
 *
 * Widest a quarter of the way up rather than at the base, which is what makes
 * it read as fire rather than as a triangle.
 */
function flameHalfWidth(t: number, maxWidth: number): number {
  if (t <= 0 || t >= 1) return 0;
  // The exponent is what decides whether this reads as a flame or as a leaf:
  // a square root leaves a rounded top, and a rounded top is a balloon.
  return maxWidth * (1 - t) ** 0.85 * (0.55 + 0.45 * Math.sin(Math.PI * t));
}

/** The flame leans, very slightly, the way a still night lets it. */
function flameCentre(t: number): number {
  return 0.5 + 0.032 * Math.sin(t * 3.0) - 0.012 * t;
}

/** Rotated-rectangle test. Returns the local cross-axis offset, or null. */
function insideBar(
  u: number,
  v: number,
  cx: number,
  cy: number,
  angle: number,
  halfLength: number,
  halfThickness: number,
): number | null {
  const dx = u - cx;
  const dy = v - cy;
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const rx = dx * c - dy * s;
  const ry = dx * s + dy * c;
  if (Math.abs(rx) > halfLength || Math.abs(ry) > halfThickness) return null;
  return ry / halfThickness;
}

/** Deterministic hash in 0..1, so the ember bed is stippled the same every run. */
function hash01(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major, no premultiplication. */
  data: Uint8ClampedArray;
}

export interface CampfireOptions {
  /**
   * How much of the frame the fire occupies, around the same centre.
   *
   * A maskable icon is cropped to a platform-chosen shape, so its content has
   * to survive being cut back to the inner 80%. Everything outside the fire is
   * night, which crops to night, so only the fire itself needs shrinking.
   */
  scale?: number;
  /**
   * Moves the fire up the frame, in frame units.
   *
   * At full size the fire is composed with its base low, the way a fire sits
   * on the ground. Shrunk for a mask, that composition leaves it sitting in
   * the bottom third of a circle it should be in the middle of, so the scaled
   * variants lift it back to the centre.
   */
  lift?: number;
}

/**
 * Draws the campfire on a `grid` x `grid` field.
 *
 * Everything is in normalised coordinates so the same drawing works at 16 and
 * at 64, with minimum feature sizes expressed in pixels so the logs do not
 * disappear on the smallest grid.
 */
export function drawCampfire(grid: number, options: CampfireOptions = {}): Bitmap {
  const scale = options.scale ?? 1;
  const lift = options.lift ?? 0;
  const data = new Uint8ClampedArray(grid * grid * 4);
  const px = 1 / grid;
  const baseY = 0.715;

  // Feature sizes never fall below roughly a pixel and a half, or the icon
  // stops being a campfire on a 16-pixel grid and starts being an orange smear.
  const logThickness = Math.max(0.044, 1.6 * px);
  const flames: readonly { maxWidth: number; height: number; colour: RGB }[] = [
    { maxWidth: Math.max(0.165, 3.0 * px), height: 0.52, colour: ICON_PALETTE.ember },
    { maxWidth: Math.max(0.104, 1.9 * px), height: 0.38, colour: ICON_PALETTE.amber },
    { maxWidth: Math.max(0.046, 1.0 * px), height: 0.21, colour: ICON_PALETTE.core },
  ];

  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const u = (x + 0.5) / grid;
      const v = (y + 0.5) / grid;
      // Into fire space: the frame stays put, the fire shrinks inside it.
      const fu = (u - 0.5) / scale + 0.5;
      const fv = (v + lift - baseY) / scale + baseY;

      // The glow the fire throws on the dark, which is most of the icon.
      const distance = Math.hypot(fu - 0.5, (fv - 0.68) * 1.1);
      const falloff = Math.max(0, 1 - distance / 0.74) ** 1.9;
      let colour: RGB = mix(ICON_PALETTE.night, ICON_PALETTE.glow, falloff * 0.95);

      // Two crossed logs. The upper face of each catches the fire.
      for (const angle of [0.3, -0.3]) {
        const local = insideBar(fu, fv, 0.5, 0.795, angle, 0.29, logThickness);
        if (local === null) continue;
        colour = local < -0.25 ? ICON_PALETTE.logLit : ICON_PALETTE.logDark;
      }

      // The ember bed between them: stippled, not solid, because coals are.
      if (Math.abs(fu - 0.5) < 0.17 && fv > 0.745 && fv < 0.815) {
        const stipple = hash01(Math.floor(fu * grid), Math.floor(fv * grid));
        if (stipple > 0.42) colour = mix(ICON_PALETTE.ember, ICON_PALETTE.amber, stipple);
      }

      // The flame, outermost first so the core lands on top.
      for (const flame of flames) {
        const t = (baseY - fv) / flame.height;
        if (t <= 0 || t >= 1) continue;
        const halfWidth = flameHalfWidth(t, flame.maxWidth);
        if (Math.abs(fu - flameCentre(t)) <= halfWidth) colour = flame.colour;
      }

      // Two sparks. Fixed positions: a random one would be a different icon
      // every build, and an icon that changes is an icon nobody recognises.
      for (const spark of [
        [0.585, 0.2],
        [0.425, 0.12],
      ] as const) {
        const radius = Math.max(0.018, 0.7 * px);
        if (Math.hypot(fu - spark[0], fv - spark[1]) <= radius) colour = ICON_PALETTE.amber;
      }

      // 5-bit quantisation with the ordered dither, so the glow gradates the
      // way the sky does in the world rather than banding into rings.
      const threshold = ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) + 0.5) / 16 - 0.5;
      const spread = 255 / 31;
      const offset = (y * grid + x) * 4;
      data[offset] = quantise5(colour[0] + threshold * spread);
      data[offset + 1] = quantise5(colour[1] + threshold * spread);
      data[offset + 2] = quantise5(colour[2] + threshold * spread);
      data[offset + 3] = 255;
    }
  }

  return { width: grid, height: grid, data };
}

/**
 * The grid a given icon size is drawn on.
 *
 * Powers of two so the upscale is an exact pixel multiple and no icon ends up
 * with 1.5-pixel logs. 64 is the ceiling because that is the texture size the
 * rest of the product draws at (ADR-0002).
 */
export function gridFor(size: number): number {
  if (size <= 16) return 16;
  if (size <= 48) return 32;
  return 64;
}

/**
 * Nearest-neighbour upscale. The point of the whole exercise.
 *
 * Rows that repeat are copied whole rather than resampled, which matters at
 * launch-image sizes: a 2796-row image from a 520-row source is five identical
 * rows out of every six.
 */
export function upscale(source: Bitmap, width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    columns[x] = Math.min(source.width - 1, Math.floor((x * source.width) / width)) * 4;
  }

  const stride = width * 4;
  let previousRow = -1;
  let previousOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    const to = y * stride;
    if (sy === previousRow) {
      data.copyWithin(to, previousOffset, previousOffset + stride);
      continue;
    }
    const rowStart = sy * source.width * 4;
    for (let x = 0; x < width; x += 1) {
      const from = rowStart + (columns[x] as number);
      const out = to + x * 4;
      data[out] = source.data[from] ?? 0;
      data[out + 1] = source.data[from + 1] ?? 0;
      data[out + 2] = source.data[from + 2] ?? 0;
      data[out + 3] = source.data[from + 3] ?? 255;
    }
    previousRow = sy;
    previousOffset = to;
  }
  return { width, height, data };
}

/** A square icon at any size, drawn small and upscaled hard. */
export function renderIcon(size: number, options: CampfireOptions = {}): Bitmap {
  return upscale(drawCampfire(gridFor(size), options), size, size);
}

/**
 * The iOS launch image: the campsite before the campsite.
 *
 * iOS shows this instead of a white flash while a standalone web app boots,
 * which for a product that opens on a dark trail is the difference between
 * arriving and being flashbanged. It is the night with the fire small in the
 * middle of it, at the same nearest-neighbour scale as everything else.
 */
export function renderSplash(width: number, height: number): Bitmap {
  /*
   * Drawn at the framebuffer size the world itself uses and upscaled hard.
   *
   * Two reasons, and the second is the one that matters. It is thirty times
   * less arithmetic, so the whole set of launch images is generated in a
   * second rather than in twenty; and it is what the product looks like. A
   * smoothly resolved 1290x2796 gradient would be the only surface in Some
   * More rendered at native resolution, which is the same as saying it would
   * be the only one that does not belong.
   */
  const internalScale = Math.min(1, 240 / Math.min(width, height));
  const w = Math.max(1, Math.round(width * internalScale));
  const h = Math.max(1, Math.round(height * internalScale));

  const data = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2;
  const cy = h * 0.46;
  const mark = Math.max(8, Math.round(Math.min(w, h) * 0.3));
  const fire = upscale(drawCampfire(64), mark, mark);
  const x0 = Math.round(cx - mark / 2);
  const y0 = Math.round(cy - mark / 2);
  const radius = Math.hypot(w, h) * 0.5;
  const spread = 255 / 31;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const offset = (y * w + x) * 4;

      // A vignette, dithered, so the flat field does not band on an OLED.
      const distance = Math.hypot(x - cx, y - cy) / radius;
      const lift = Math.max(0, 1 - distance) ** 2.4 * 0.28;
      const colour = mix(ICON_PALETTE.night, ICON_PALETTE.glow, lift);
      const threshold = ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) + 0.5) / 16 - 0.5;
      let r = quantise5(colour[0] + threshold * spread);
      let g = quantise5(colour[1] + threshold * spread);
      let b = quantise5(colour[2] + threshold * spread);

      /*
       * Lighten, not replace.
       *
       * Pasting the icon in as a block put a visible square of the icon's own
       * night on top of the launch image's night — the two are the same colour
       * in the middle and are not at the edges, so the seam showed. Taking the
       * brighter of the two is what fire on a dark field actually does, and it
       * makes the mark's edge disappear into the vignette.
       */
      const inFireX = x - x0;
      const inFireY = y - y0;
      if (inFireX >= 0 && inFireX < mark && inFireY >= 0 && inFireY < mark) {
        const from = (inFireY * mark + inFireX) * 4;
        const fr = fire.data[from] ?? 0;
        const fg = fire.data[from + 1] ?? 0;
        const fb = fire.data[from + 2] ?? 0;
        if (fr > r) r = fr;
        if (fg > g) g = fg;
        if (fb > b) b = fb;
      }

      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }

  return upscale({ width: w, height: h, data }, width, height);
}

/** What the manifest advertises and the build emits. Kept in one place. */
export interface IconSpec {
  file: string;
  size: number;
  purpose: 'any' | 'maskable';
}

/**
 * Every size a browser, launcher or app switcher actually asks for.
 *
 * 192 and 512 are the two Chromium requires for installability; the rest are
 * what Android launchers, Windows tiles and browser tabs pick from. Maskable
 * variants are separate images rather than a dual-purpose one, because a
 * `purpose: "any maskable"` icon gets cropped when it is used as `any`.
 */
export const ICON_SPECS: readonly IconSpec[] = [
  { file: 'icons/icon-16.png', size: 16, purpose: 'any' },
  { file: 'icons/icon-32.png', size: 32, purpose: 'any' },
  { file: 'icons/icon-48.png', size: 48, purpose: 'any' },
  { file: 'icons/icon-72.png', size: 72, purpose: 'any' },
  { file: 'icons/icon-96.png', size: 96, purpose: 'any' },
  { file: 'icons/icon-128.png', size: 128, purpose: 'any' },
  { file: 'icons/icon-144.png', size: 144, purpose: 'any' },
  { file: 'icons/icon-192.png', size: 192, purpose: 'any' },
  { file: 'icons/icon-256.png', size: 256, purpose: 'any' },
  { file: 'icons/icon-384.png', size: 384, purpose: 'any' },
  { file: 'icons/icon-512.png', size: 512, purpose: 'any' },
  { file: 'icons/maskable-192.png', size: 192, purpose: 'maskable' },
  { file: 'icons/maskable-512.png', size: 512, purpose: 'maskable' },
  // iOS ignores the manifest's icons entirely and reads `apple-touch-icon`,
  // which must be opaque and unrounded — the system rounds it itself.
  { file: 'icons/apple-touch-icon.png', size: 180, purpose: 'any' },
];

/**
 * The iOS launch images, by device pixel size.
 *
 * iOS only uses a `link rel="apple-touch-startup-image"` whose media query
 * matches the device exactly, so this is a list of real screens rather than a
 * set of convenient sizes. It is not exhaustive and cannot be: every device
 * outside it falls back to the theme colour, which is the same night, so the
 * failure mode is a plain dark screen rather than a white one.
 */
export interface SplashSpec {
  file: string;
  width: number;
  height: number;
  /** CSS pixels of the logical viewport, for the media query. */
  cssWidth: number;
  cssHeight: number;
  ratio: number;
  orientation: 'portrait' | 'landscape';
}

const SPLASH_DEVICES: readonly { cssWidth: number; cssHeight: number; ratio: number }[] = [
  { cssWidth: 320, cssHeight: 568, ratio: 2 }, // SE 1st gen
  { cssWidth: 375, cssHeight: 667, ratio: 2 }, // SE 2nd/3rd gen, 8
  { cssWidth: 390, cssHeight: 844, ratio: 3 }, // 12/13/14, 15/16 base
  { cssWidth: 393, cssHeight: 852, ratio: 3 }, // 15/16 Pro
  { cssWidth: 402, cssHeight: 874, ratio: 3 }, // 16 Pro
  { cssWidth: 428, cssHeight: 926, ratio: 3 }, // Pro Max, older
  { cssWidth: 430, cssHeight: 932, ratio: 3 }, // Pro Max, current
  { cssWidth: 440, cssHeight: 956, ratio: 3 }, // 16 Pro Max
  { cssWidth: 768, cssHeight: 1024, ratio: 2 }, // iPad
  { cssWidth: 834, cssHeight: 1194, ratio: 2 }, // iPad Pro 11
  { cssWidth: 1024, cssHeight: 1366, ratio: 2 }, // iPad Pro 12.9
];

export const SPLASH_SPECS: readonly SplashSpec[] = SPLASH_DEVICES.flatMap((device) => [
  {
    file: `splash/splash-${device.cssWidth}x${device.cssHeight}-portrait.png`,
    width: device.cssWidth * device.ratio,
    height: device.cssHeight * device.ratio,
    cssWidth: device.cssWidth,
    cssHeight: device.cssHeight,
    ratio: device.ratio,
    orientation: 'portrait' as const,
  },
  {
    file: `splash/splash-${device.cssWidth}x${device.cssHeight}-landscape.png`,
    width: device.cssHeight * device.ratio,
    height: device.cssWidth * device.ratio,
    cssWidth: device.cssWidth,
    cssHeight: device.cssHeight,
    ratio: device.ratio,
    orientation: 'landscape' as const,
  },
]);

/** The `<link>` tags iOS needs, as data rather than as pasted HTML. */
export function splashLinkAttributes(spec: SplashSpec, base = '/'): { media: string; href: string } {
  const media =
    `(device-width: ${spec.cssWidth}px) and (device-height: ${spec.cssHeight}px) ` +
    `and (-webkit-device-pixel-ratio: ${spec.ratio}) and (orientation: ${spec.orientation})`;
  return { media, href: `${base}${spec.file}` };
}
