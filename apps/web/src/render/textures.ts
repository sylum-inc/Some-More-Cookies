/**
 * Procedural texture generation (ADR-0002).
 *
 * No binary assets exist, so every surface is drawn at runtime into a canvas.
 * This is not merely expedient: a PS1 look wants 64–128px textures with
 * nearest filtering, which is exactly the range procedural generation is good
 * at. Hand-painted 2048px art would have to be thrown away to get here.
 *
 * Every generator is seeded, so a campsite's machine wear, decals and serial
 * plate are reproducible from its serial number.
 */

import * as THREE from 'three';
import { Rng } from '@somemore/sim';

export type TextureKey =
  | 'graham'
  | 'chocolate'
  | 'marshmallow'
  | 'bark'
  | 'foliage'
  | 'dirt'
  | 'gravel'
  | 'grass'
  | 'water'
  | 'enamel'
  | 'aluminium'
  | 'smokedPlastic'
  | 'rubber'
  | 'frost'
  | 'ash'
  | 'ember'
  | 'flame'
  | 'steam'
  | 'stone'
  | 'canvas'
  | 'noise';

export interface TextureOptions {
  size?: number;
  seed?: number | string;
  /** Palette overrides, hex strings. */
  colors?: string[];
}

type Ctx2D = CanvasRenderingContext2D;

const cache = new Map<string, THREE.Texture>();

/** Creates a drawing surface. Falls back gracefully outside a browser. */
function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: Ctx2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** Fills the whole surface. */
function fill(ctx: Ctx2D, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
}

/** Scatters seeded pixel speckle — the workhorse of a pixel-art look. */
function speckle(
  ctx: Ctx2D,
  size: number,
  rng: Rng,
  colors: readonly string[],
  density: number,
  pixel = 1,
): void {
  const count = Math.floor(size * size * density);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[rng.int(0, colors.length - 1)] ?? '#000';
    ctx.fillRect(rng.int(0, size - 1), rng.int(0, size - 1), pixel, pixel);
  }
}

/** Seeded value-noise field sampled onto the canvas as blocky patches. */
function blotches(
  ctx: Ctx2D,
  size: number,
  rng: Rng,
  colors: readonly string[],
  count: number,
  minR: number,
  maxR: number,
): void {
  for (let i = 0; i < count; i++) {
    const r = rng.range(minR, maxR);
    ctx.fillStyle = colors[rng.int(0, colors.length - 1)] ?? '#000';
    ctx.beginPath();
    ctx.arc(rng.range(0, size), rng.range(0, size), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- Generators ------------------------------------------------------------

const GENERATORS: Record<TextureKey, (ctx: Ctx2D, size: number, rng: Rng, colors?: string[]) => void> = {
  graham: (ctx, size, rng) => {
    fill(ctx, size, '#c98a4b');
    speckle(ctx, size, rng, ['#b9793e', '#d89a5c', '#a86c35', '#e0a86c'], 0.55);
    // The docking holes that say "graham cracker" at a glance.
    const spacing = size / 4;
    ctx.fillStyle = '#8f5a28';
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        ctx.fillRect(
          Math.floor(spacing * (x + 0.5)),
          Math.floor(spacing * (y + 0.5)),
          Math.max(1, size / 42),
          Math.max(1, size / 42),
        );
      }
    }
    // Toasted edge.
    ctx.strokeStyle = '#8f5a28';
    ctx.lineWidth = Math.max(1, size / 32);
    ctx.strokeRect(0, 0, size, size);
  },

  chocolate: (ctx, size, rng) => {
    fill(ctx, size, '#4a2a17');
    speckle(ctx, size, rng, ['#3d2213', '#57331d', '#2f1a0f'], 0.35);
    // Moulded squares.
    ctx.strokeStyle = '#331c10';
    ctx.lineWidth = Math.max(1, size / 32);
    const cells = 4;
    for (let i = 1; i < cells; i++) {
      const p = (size / cells) * i;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    // A highlight band so chocolate reads as glossy even before specular.
    ctx.fillStyle = 'rgba(255,220,190,0.10)';
    ctx.fillRect(0, Math.floor(size * 0.16), size, Math.max(1, size / 16));
  },

  marshmallow: (ctx, size, rng) => {
    fill(ctx, size, '#f6f1e2');
    speckle(ctx, size, rng, ['#efe7d3', '#fbf7ec', '#e6dcc6'], 0.4);
    blotches(ctx, size, rng, ['rgba(230,220,200,0.5)'], 6, size / 20, size / 9);
  },

  bark: (ctx, size, rng) => {
    fill(ctx, size, '#4b3a2c');
    // Vertical fissures.
    for (let i = 0; i < size / 3; i++) {
      const x = rng.range(0, size);
      const w = rng.range(1, Math.max(2, size / 24));
      ctx.fillStyle = rng.chance(0.5) ? '#3a2c21' : '#5b4736';
      ctx.fillRect(x, 0, w, size);
    }
    speckle(ctx, size, rng, ['#2f241b', '#65503c'], 0.25);
  },

  foliage: (ctx, size, rng) => {
    fill(ctx, size, '#1f3a24');
    speckle(ctx, size, rng, ['#27492c', '#16301c', '#2f5733', '#122616'], 0.6);
    blotches(ctx, size, rng, ['#1a3320', '#2b5030'], 12, size / 16, size / 7);
  },

  dirt: (ctx, size, rng) => {
    fill(ctx, size, '#3c3026');
    speckle(ctx, size, rng, ['#332920', '#48392c', '#2b221a', '#54432f'], 0.7);
  },

  gravel: (ctx, size, rng) => {
    fill(ctx, size, '#4a4741');
    blotches(ctx, size, rng, ['#5b574f', '#3c3934', '#6a655c', '#333029'], 90, 1, Math.max(2, size / 22));
  },

  grass: (ctx, size, rng) => {
    fill(ctx, size, '#2b3f24');
    speckle(ctx, size, rng, ['#354c2b', '#22331d', '#3d5730', '#1b2917'], 0.65);
    // Sparse blades.
    ctx.strokeStyle = '#3f5a31';
    ctx.lineWidth = 1;
    for (let i = 0; i < size / 2; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rng.range(-1, 1), y - rng.range(1, size / 16));
      ctx.stroke();
    }
  },

  water: (ctx, size, rng) => {
    fill(ctx, size, '#16242e');
    for (let y = 0; y < size; y += 2) {
      ctx.fillStyle = rng.chance(0.5) ? '#1b2c38' : '#132029';
      ctx.fillRect(0, y, size, 1);
    }
    speckle(ctx, size, rng, ['#2b4453', '#0f1a21'], 0.12);
  },

  enamel: (ctx, size, rng) => {
    // Industrial white enamel, slightly warm and never pure white.
    fill(ctx, size, '#e6e3dc');
    speckle(ctx, size, rng, ['#dcd9d1', '#eeebe4'], 0.18);
  },

  aluminium: (ctx, size, rng) => {
    fill(ctx, size, '#a8aaad');
    // Brushed grain.
    for (let y = 0; y < size; y++) {
      const shade = rng.range(-14, 14);
      ctx.fillStyle = `rgb(${168 + shade},${170 + shade},${173 + shade})`;
      ctx.fillRect(0, y, size, 1);
    }
  },

  smokedPlastic: (ctx, size, rng) => {
    fill(ctx, size, '#2a2b30');
    speckle(ctx, size, rng, ['#25262b', '#303138'], 0.2);
    ctx.fillStyle = 'rgba(190,205,225,0.07)';
    ctx.fillRect(0, 0, size, Math.floor(size * 0.35));
  },

  rubber: (ctx, size, rng) => {
    fill(ctx, size, '#1d1d1f');
    speckle(ctx, size, rng, ['#232326', '#171718'], 0.35);
  },

  frost: (ctx, size, rng) => {
    // Drawn on transparent so it can be layered over anything.
    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < size * 3; i++) {
      const a = rng.range(0.15, 0.75);
      ctx.fillStyle = `rgba(226,240,252,${a.toFixed(3)})`;
      ctx.fillRect(rng.int(0, size - 1), rng.int(0, size - 1), 1, 1);
    }
    // Needle crystals.
    ctx.strokeStyle = 'rgba(236,246,255,0.55)';
    for (let i = 0; i < size / 5; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const len = rng.range(2, size / 8);
      const angle = rng.range(0, Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      ctx.stroke();
    }
  },

  ash: (ctx, size, rng) => {
    fill(ctx, size, '#3a3733');
    speckle(ctx, size, rng, ['#4a4741', '#2c2a27', '#5c5852'], 0.55);
  },

  ember: (ctx, size, rng) => {
    fill(ctx, size, '#241109');
    blotches(ctx, size, rng, ['#7a2408', '#b53c07', '#e06012', '#f08a1e'], 40, 1, Math.max(2, size / 14));
    speckle(ctx, size, rng, ['#ffb347', '#301508'], 0.2);
  },

  /**
   * One tongue of flame, with an alpha channel.
   *
   * The fire used to be drawn with the `ember` tile above, which is an opaque
   * square of coal colours: every flame in the pit was therefore a hard-edged
   * orange rectangle, and the only reason nobody had noticed is that until the
   * player could kneel down to the fire it was never more than a dozen pixels
   * across. Additively blending an opaque texture does not make it a flame; it
   * makes a lit block. This is a tongue — widest a little above the fuel,
   * drawn to a point, hottest up its middle, and transparent everywhere else.
   */
  flame: (ctx, size, rng) => {
    const image = ctx.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
      // 0 at the base of the tongue, 1 at the tip.
      const v = 1 - y / (size - 1);
      const halfWidth = 0.46 * Math.pow(1 - v, 0.7) * (0.55 + 0.45 * Math.min(1, v / 0.18));
      for (let x = 0; x < size; x++) {
        const across = halfWidth <= 0 ? 2 : Math.abs(x / (size - 1) - 0.5) / halfWidth;
        let alpha = across >= 1 ? 0 : Math.pow(1 - across * across, 1.5);
        // Densest low down, and torn up a little so the edge is not a curve.
        alpha *= 0.5 + 0.5 * (1 - v);
        alpha *= 0.78 + rng.range(0, 0.4);
        const core = Math.max(0, 1 - across * 1.7) * (1 - v * 0.55);
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = Math.round(72 + core * 165);
        data[i + 2] = Math.round(14 + core * 96);
        data[i + 3] = Math.round(Math.min(1, alpha) * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
  },

  /** A wisp coming off wet wood. Widens as it rises, and goes nowhere fast. */
  steam: (ctx, size, rng) => {
    const image = ctx.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
      const v = 1 - y / (size - 1);
      const halfWidth = 0.1 + 0.36 * v;
      for (let x = 0; x < size; x++) {
        const across = Math.abs(x / (size - 1) - 0.5) / halfWidth;
        let alpha = across >= 1 ? 0 : Math.pow(1 - across * across, 1.1);
        alpha *= Math.pow(1 - v, 1.1);
        alpha *= 0.6 + rng.range(0, 0.55);
        const i = (y * size + x) * 4;
        const grey = 196 + Math.round(rng.range(0, 34));
        data[i] = grey;
        data[i + 1] = grey;
        data[i + 2] = Math.round(grey * 0.97);
        data[i + 3] = Math.round(Math.min(1, alpha) * 190);
      }
    }
    ctx.putImageData(image, 0, 0);
  },

  stone: (ctx, size, rng) => {
    fill(ctx, size, '#5a5651');
    blotches(ctx, size, rng, ['#666159', '#4d4944', '#736d63'], 30, size / 18, size / 6);
    speckle(ctx, size, rng, ['#7c7568', '#403c37'], 0.2);
  },

  canvas: (ctx, size, rng) => {
    fill(ctx, size, '#6b6250');
    for (let i = 0; i < size; i += 2) {
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(i, 0, 1, size);
      ctx.fillRect(0, i, size, 1);
    }
    speckle(ctx, size, rng, ['#7a7059', '#5d5546'], 0.2);
  },

  noise: (ctx, size, rng) => {
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const v = rng.int(0, 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  },
};

/**
 * Builds (or returns a cached) texture.
 *
 * Returns `null` when there is no DOM, so simulation-side tests can import
 * this module without a browser.
 */
export function getTexture(key: TextureKey, options: TextureOptions = {}): THREE.Texture | null {
  const size = options.size ?? 64;
  const seed = options.seed ?? key;
  const cacheKey = `${key}:${size}:${String(seed)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;

  const rng = new Rng(typeof seed === 'number' ? seed : String(seed));
  const generator = GENERATORS[key];
  generator(surface.ctx, size, rng, options.colors);

  const texture = new THREE.CanvasTexture(surface.canvas);
  // Nearest filtering with no mipmaps is the PS1 look, and it is also the
  // cheapest possible sampling.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}

/**
 * Draws the SM-01's front decal plate: brand, model, serial and warnings,
 * aged by the unit's wear.
 */
export function createMachineDecal(options: {
  serial: string;
  built: number;
  wear: number;
  decalFade: number;
  stickers: readonly string[];
  size?: number;
}): THREE.Texture | null {
  const size = options.size ?? 256;
  const cacheKey = `decal:${options.serial}:${size}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;
  const { ctx, canvas } = surface;
  const rng = new Rng(options.serial);

  fill(ctx, size, '#e6e3dc');
  speckle(ctx, size, rng, ['#dcd9d1', '#eeebe4'], 0.12);

  const fade = Math.min(0.75, options.decalFade);
  const ink = `rgba(26,28,32,${(1 - fade * 0.7).toFixed(3)})`;

  // Brand, set in a restrained functional way.
  ctx.fillStyle = ink;
  ctx.font = `bold ${Math.floor(size * 0.11)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText('SOME MORE', size * 0.07, size * 0.07);

  ctx.font = `${Math.floor(size * 0.055)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('SM-01', size * 0.07, size * 0.21);
  ctx.fillText('TRANSFORMATION FREEZER', size * 0.07, size * 0.28);

  // A functional rule, the Rams-influenced touch.
  ctx.fillStyle = `rgba(26,28,32,${(0.5 - fade * 0.3).toFixed(3)})`;
  ctx.fillRect(size * 0.07, size * 0.37, size * 0.86, Math.max(1, size / 128));

  ctx.fillStyle = ink;
  ctx.font = `${Math.floor(size * 0.045)}px "Courier New", monospace`;
  ctx.fillText(`SER ${options.serial}`, size * 0.07, size * 0.42);
  ctx.fillText(`MFG ${options.built}`, size * 0.07, size * 0.48);
  ctx.fillText('220-240V~ 50/60Hz', size * 0.07, size * 0.54);
  ctx.fillText('R-290  CHARGE 148g', size * 0.07, size * 0.6);

  ctx.font = `${Math.floor(size * 0.04)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('COLD SURFACES — HANDLE WITH CARE', size * 0.07, size * 0.69);

  // Stickers, tilted and aged.
  let y = size * 0.77;
  for (const sticker of options.stickers.slice(0, 2)) {
    ctx.save();
    ctx.translate(size * 0.08, y);
    ctx.rotate(rng.range(-0.05, 0.05));
    ctx.fillStyle = rng.chance(0.5) ? '#d8cfae' : '#cfd8d4';
    const w = size * 0.6;
    const h = size * 0.075;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(30,30,30,0.75)';
    ctx.font = `${Math.floor(size * 0.032)}px "Courier New", monospace`;
    ctx.fillText(sticker.slice(0, 28), size * 0.015, size * 0.018);
    ctx.restore();
    y += size * 0.1;
  }

  // Wear: scuffs and paint loss.
  const scuffs = Math.floor(options.wear * 26);
  for (let i = 0; i < scuffs; i++) {
    ctx.fillStyle = `rgba(120,118,112,${rng.range(0.05, 0.3).toFixed(3)})`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(1, size / 12), rng.range(1, 3));
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}

/**
 * The finished sandwich's ice cream texture — hero tier, so it gets a larger
 * canvas, a real swirl, and toasted flecks derived from the roast.
 */
export function createIceCreamTexture(options: {
  creamColor: readonly [number, number, number];
  swirlColor: readonly [number, number, number];
  swirlStrength: number;
  fleckDensity: number;
  seed: number;
  size?: number;
}): THREE.Texture | null {
  const size = options.size ?? 256;
  const cacheKey = `cream:${options.seed}:${size}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;
  const { ctx, canvas } = surface;
  const rng = new Rng(options.seed);

  const toHex = (c: readonly [number, number, number]) =>
    `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

  fill(ctx, size, toHex(options.creamColor));

  // The caramelised swirl — ribbons, not noise, so it reads as ice cream.
  const ribbons = Math.floor(3 + options.swirlStrength * 9);
  ctx.strokeStyle = toHex(options.swirlColor);
  ctx.lineCap = 'round';
  for (let i = 0; i < ribbons; i++) {
    ctx.globalAlpha = rng.range(0.35, 0.85) * (0.4 + options.swirlStrength * 0.6);
    ctx.lineWidth = rng.range(size / 40, size / 12);
    ctx.beginPath();
    let x = rng.range(-size * 0.2, size * 1.2);
    let y = rng.range(-size * 0.2, size * 1.2);
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += rng.range(-size * 0.35, size * 0.35);
      y += rng.range(-size * 0.35, size * 0.35);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Dark toasted flecks — the Ember signature.
  const flecks = Math.floor(options.fleckDensity * size * 2.5);
  for (let i = 0; i < flecks; i++) {
    const shade = rng.range(0.1, 0.3);
    ctx.fillStyle = `rgba(${Math.round(shade * 90)},${Math.round(shade * 60)},${Math.round(shade * 40)},${rng.range(0.5, 1).toFixed(2)})`;
    ctx.fillRect(rng.int(0, size - 1), rng.int(0, size - 1), rng.int(1, 2), rng.int(1, 2));
  }

  // Fine surface grain so it is never flat.
  for (let i = 0; i < size * 6; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.02, 0.09).toFixed(3)})`;
    ctx.fillRect(rng.int(0, size - 1), rng.int(0, size - 1), 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}

/** Number of textures currently cached — used by the performance HUD. */
export function textureCacheSize(): number {
  return cache.size;
}

export function clearTextureCache(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}

/** Every generator key, for tests and the debug view. */
export const TEXTURE_KEYS = Object.keys(GENERATORS) as TextureKey[];
