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
  | 'charCracks'
  | 'foliage'
  | 'dirt'
  | 'duff'
  | 'trodden'
  | 'paintedMetal'
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

/**
 * Short strokes at random angles, wrapped around the tile.
 *
 * The workhorse for anything made of *fibres* — needle litter, a bough of
 * foliage, a scuff. Speckle cannot do this job: a one-pixel dot has no
 * orientation and no extent, so a field of them averages to a flat tone the
 * moment the surface is more than a few pixels from the camera, which is
 * exactly what "a smooth radial gradient of brown" was. A stroke four to eight
 * texels long survives the downsample to 426x240 as a mark rather than as
 * noise, and that is the difference between a texture and a tint.
 *
 * Drawn nine times at tile offsets so a stroke that runs off one edge comes
 * back on the other; without that every tile has a clean border and the
 * repeat reads as a grid.
 */
function strokes(
  ctx: Ctx2D,
  size: number,
  rng: Rng,
  colors: readonly string[],
  count: number,
  minLength: number,
  maxLength: number,
  width = 1,
): void {
  ctx.lineWidth = width;
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const angle = rng.range(0, Math.PI * 2);
    const length = rng.range(minLength, maxLength);
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    ctx.strokeStyle = colors[rng.int(0, colors.length - 1)] ?? '#000';
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        // Only the wraps that can actually reach the tile are worth drawing.
        if (ox !== 0 && Math.min(x, size - x) > maxLength) continue;
        if (oy !== 0 && Math.min(y, size - y) > maxLength) continue;
        ctx.beginPath();
        ctx.moveTo(x + ox * size, y + oy * size);
        ctx.lineTo(x + dx + ox * size, y + dy + oy * size);
        ctx.stroke();
      }
    }
  }
  ctx.lineWidth = 1;
}

/**
 * The forest floor's reference brightness: the mean of the `dirt` tile the
 * ground has always worn, in the renderer's linear working space.
 *
 * The ground tiles are normalised against this rather than eyeballed, because
 * a tile's *mean* and a tile's *structure* are two different things and only
 * one of them is the art direction here. `duff` was drawn with a value range
 * four times `dirt`'s, which is the whole point — but it also came out half a
 * stop brighter overall, and multiplied by the manifest's ground colour that
 * is a 50 % lift on the largest surface in the game at every hour, including
 * the night the whole product is set in. `e2e/night.spec.ts` asserts a *band*,
 * not a floor; brightening the ground is as much a failure as darkening it.
 *
 * So the tiles carry the grain and the material colours carry the level,
 * exactly as before, and swapping a tile cannot quietly relight the campsite.
 */
export const GROUND_TILE_MEAN = 0.0343;

/**
 * How much lighter bare trodden soil is than needle litter.
 *
 * Small on purpose: the difference between a worn ring and the duff around it
 * is mostly *grain* — no needles left in it, the stones pressed up out of it —
 * and only a little value. A ring that is twice the brightness of its
 * surroundings reads as a light shining on the ground, which is the failure
 * this replaced.
 */
export const TRODDEN_LIFT = 1.7;

/** Rec.709 luma of an sRGB byte triple, in linear light. */
function linearLuma(r: number, g: number, b: number): number {
  const decode = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

/**
 * Scales a finished tile so its mean linear luminance is exactly `target`.
 *
 * Done in linear light and applied to the linear values, so it changes the
 * level and nothing else: hue, the ratio between the light and dark parts, and
 * the size of the marks all survive. Computed from the tile rather than
 * written down, so the tile can be redrawn without the balance drifting.
 */
function normaliseLinearMean(ctx: Ctx2D, size: number, target: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  let sum = 0;
  for (let i = 0; i < size * size; i++) {
    sum += linearLuma(data[i * 4] as number, data[i * 4 + 1] as number, data[i * 4 + 2] as number);
  }
  const mean = sum / (size * size);
  if (mean <= 0) return;
  const scale = target / mean;
  const encode = (c: number): number => {
    const v = c / 255;
    const linear = (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * scale;
    const clamped = Math.min(1, Math.max(0, linear));
    const out = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(out * 255);
  };
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = encode(data[i * 4] as number);
    data[i * 4 + 1] = encode(data[i * 4 + 1] as number);
    data[i * 4 + 2] = encode(data[i * 4 + 2] as number);
  }
  ctx.putImageData(image, 0, 0);
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

  /**
   * The seams a burning log glows through, as an emissive map.
   *
   * A log on this fire used to take a flat red wash across its whole surface,
   * scaled by how alight it was, which at a distance reads as a mustard slab
   * with the brightness turned up — an art review's words for the most
   * looked-at object in the game were "a flat #b8a44a rounded rectangle. No
   * grain, no char, no glow."
   *
   * Wood does not glow evenly. It splits along the grain and the fire gets
   * into the splits, so what you see is a dark charred surface with a few
   * bright seams running through it and the odd hot pocket where two meet.
   * Black almost everywhere on purpose: this multiplies the emissive, so
   * black is "this part of the log is just charcoal" and the bright parts are
   * the only places light comes out. A uniform map would put us back where we
   * started.
   */
  charCracks: (ctx, size, rng) => {
    fill(ctx, size, '#000000');
    // Long seams along the grain, which for a log lying on its side runs
    // across the texture rather than up it.
    const seams = Math.max(3, Math.round(size / 14));
    for (let i = 0; i < seams; i++) {
      let y = rng.range(0, size);
      const drift = rng.range(-0.22, 0.22);
      const heat = rng.range(0.45, 1);
      ctx.strokeStyle = `rgba(255,${Math.round(90 + heat * 90)},${Math.round(20 + heat * 30)},${heat.toFixed(2)})`;
      ctx.lineWidth = rng.range(1, Math.max(1.5, size / 32));
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += Math.max(2, size / 12)) {
        y += drift * (size / 12) + rng.range(-1.2, 1.2);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Hot pockets: where the seams have opened into each other and the coal
    // underneath is showing. Brighter than the seams and much rarer.
    for (let i = 0; i < Math.max(2, size / 22); i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(size / 40, size / 16);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, 'rgba(255,214,150,0.95)');
      glow.addColorStop(0.5, 'rgba(255,120,40,0.55)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  },

  /**
   * A bough of conifer, not a field of green noise.
   *
   * The old tile was a 0.6-density one-pixel speckle over four close greens
   * with a dozen low-contrast blotches. Every one of those decisions works
   * against the only thing this texture has to do, which is survive being
   * minified onto a tree thirty pixels tall: uncorrelated one-pixel noise
   * averages to its own mean under any downsample, and four colours within
   * 12/255 of each other have no mean worth seeing. Graded, correctly, as "the
   * trees are untextured silhouettes".
   *
   * So the structure is at the scale a bough actually is. Dark gaps between
   * the whorls, lit clumps on top of them, and needles as strokes rather than
   * as dots — with a value range from #0f2015 to #74a05e, which is four times
   * the spread the old tile had and is what puts a second value inside the
   * mass of a tree.
   */
  foliage: (ctx, size, rng) => {
    fill(ctx, size, '#233d27');
    // The holes: a conifer is mostly the shadow between its boughs.
    blotches(ctx, size, rng, ['#0f2015', '#14261a', '#122616'], 15, size / 13, size / 5);
    // And the boughs that catch the light on top of them.
    blotches(ctx, size, rng, ['#39632f', '#2f5733', '#44743a'], 13, size / 15, size / 7);
    // Needles. Angled, so the tile has a direction and reads as growth.
    strokes(ctx, size, rng, ['#2b5030', '#17301c', '#4d8244'], size * 1.4, size / 22, size / 9);
    // Sparse: a bright single pixel is a highlight at one density and a
    // firefly at three times it.
    speckle(ctx, size, rng, ['#5e8a4d', '#1a3320'], 0.05);
  },

  dirt: (ctx, size, rng) => {
    fill(ctx, size, '#3c3026');
    speckle(ctx, size, rng, ['#332920', '#48392c', '#2b221a', '#54432f'], 0.7);
  },

  /**
   * The forest floor away from the fire: needle litter over dark soil.
   *
   * `dirt` is a fine four-colour speckle, which is right for the sides of a
   * pit and wrong for the largest surface in the game. Half of every frame is
   * ground; at a metre and a half a texel is a tenth of a pixel and the whole
   * field collapses to its average. What has to be there instead is *litter* —
   * fallen needles, cone scales, patches where the duff has worn through to
   * soil — at a scale of four to ten texels, which is a few pixels on screen
   * even from standing height.
   */
  duff: (ctx, size, rng) => {
    fill(ctx, size, '#423225');
    // Broad patches: where the litter is deep, and where it has worn thin.
    blotches(ctx, size, rng, ['#332619', '#2b2016'], 7, size / 9, size / 4.2);
    blotches(ctx, size, rng, ['#4a382a', '#54402e'], 6, size / 10, size / 4.5);
    // Fallen needles, in three ages: fresh rust, weathered brown, black.
    strokes(ctx, size, rng, ['#6b4d2f', '#5a4128', '#2c1f14'], size * 2, size / 16, size / 7);
    strokes(ctx, size, rng, ['#7d5c39'], size * 0.5, size / 20, size / 10);
    // Grit and cone scales, the small pale things that catch a low sun.
    speckle(ctx, size, rng, ['#8a7a61', '#9b8a6c'], 0.035);
    speckle(ctx, size, rng, ['#1d150e'], 0.05);
    // Same level as the tile it replaces; four times the value range.
    normaliseLinearMean(ctx, size, GROUND_TILE_MEAN);
  },

  /**
   * Where people have stood: compacted bare soil, paler and greyer.
   *
   * "Worn to bare soil in a ring around the fire" has been in this campsite's
   * own prose for four rounds and has never been on the screen. It cannot be
   * done with a tint alone — a ring of the same texture at a different
   * brightness reads as a light, not as a surface — so the trodden ground gets
   * its own tile with its own grain: no needles left in it, the small stones
   * pressed up out of it, and the scuff of feet across it.
   */
  trodden: (ctx, size, rng) => {
    /*
     * Only about a third brighter than `duff` on average, not twice.
     *
     * The first version put a #66 base against duff's #3a, and with the
     * material colours on top of that the ring came out as a pale disc with a
     * dark moat round it — a decal, which is the one thing a worn ring must
     * not be. Bare soil next to needle litter is a small step in value and a
     * large step in *grain*, and it is the grain that has to do the work.
     */
    fill(ctx, size, '#4e4132');
    blotches(ctx, size, rng, ['#584a39', '#443729', '#5f5040'], 12, size / 9, size / 3.6);
    // Stones pressed up out of the soil, each with a shadow on one side.
    for (let i = 0; i < size / 3.4; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(1, Math.max(2, size / 22));
      ctx.fillStyle = '#3a3128';
      ctx.beginPath();
      ctx.arc(x + r * 0.35, y + r * 0.35, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rng.chance(0.5) ? '#7d7160' : '#6d6455';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Scuffs, and the ash that always ends up outside a fire ring.
    strokes(ctx, size, rng, ['#463a2e', '#63553f'], size * 0.7, size / 12, size / 5);
    speckle(ctx, size, rng, ['#8d8271', '#332c25'], 0.045);
    normaliseLinearMean(ctx, size, GROUND_TILE_MEAN * TRODDEN_LIFT);
  },

  /**
   * Painted steel that has been outdoors for thirty years.
   *
   * The landmarks wore `aluminium`, which is a brushed grain over a flat mid
   * grey — at twenty metres that is a uniform rectangle, and an art review
   * picked out exactly one object in the frame as "an untextured box". Paint
   * is the difference: it chips, and where it chips it rusts, and it streaks
   * down from the chip. Those are large marks, which is why they survive being
   * two pixels wide.
   */
  paintedMetal: (ctx, size, rng) => {
    fill(ctx, size, '#4d5347');
    // Panel shading, so a face is not one value across its width.
    for (let y = 0; y < size; y++) {
      const shade = Math.sin((y / size) * Math.PI * 2) * 5 + rng.range(-3, 3);
      ctx.fillStyle = `rgba(${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${shade > 0 ? 240 : 0},${(Math.abs(shade) / 90).toFixed(3)})`;
      ctx.fillRect(0, y, size, 1);
    }
    // Chips down to bare metal, and the rust that follows them.
    for (let i = 0; i < size / 3; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(0.8, Math.max(1.6, size / 26));
      ctx.fillStyle = rng.chance(0.45) ? '#6f6a5f' : '#5a3a24';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (rng.chance(0.5)) {
        ctx.strokeStyle = 'rgba(96,58,32,0.5)';
        ctx.lineWidth = Math.max(1, r * 0.7);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + rng.range(-1, 1), y + rng.range(2, size / 5));
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    speckle(ctx, size, rng, ['#565d50', '#43483e', '#63594a'], 0.14);
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

  /*
   * The brand, at a size that survives being a machine in a wood at night.
   *
   * This was set at eleven per cent of the plate in the same weight as the
   * technical block under it, which is a defensible piece of typography and
   * completely illegible in the product: the plate covers a few centimetres of
   * a machine seen from two metres, through a 320x240 buffer and an affine
   * wobble, so twenty-eight texture pixels of cap height arrive as about six
   * screen pixels of grey mush. An art director's note was that the machine
   * the game is *named after* has no logo — "a low-contrast grey-brown smear
   * over noise text" — and that is exactly what it was.
   *
   * So the hierarchy is made real rather than tasteful. The name is nearly
   * twice the height it was and sits alone; the model number gets the second
   * rank; and the paragraph of specification below is demoted to what it
   * honestly is at this distance — texture that says "this is equipment", not
   * text anybody reads. An oxidised-red rule frames the whole plate, which is
   * the one saturated colour on the object and is what makes it read as an
   * enamelled placard rather than as a sticker.
   */
  ctx.strokeStyle = `rgba(138,59,42,${(0.9 - fade * 0.4).toFixed(3)})`;
  ctx.lineWidth = Math.max(2, size * 0.012);
  ctx.strokeRect(size * 0.035, size * 0.035, size * 0.93, size * 0.93);

  /*
   * Fitted to the plate rather than set at a size and hoped for.
   *
   * Nineteen per cent of the plate was chosen to make the name legible on a
   * machine seen from two metres through a 320x240 buffer — and it was, but
   * "SOME MORE" at that size is wider than the space between the left margin
   * and the right border, so every machine frame in the game shipped a plate
   * reading "SOME MO". An art review counted it as an error and was right:
   * the machine the product is named after had its name cut in half.
   *
   * Measured and scaled down only if it does not fit, so the intended size is
   * still the size whenever the string is short enough to take it. A brand is
   * the one piece of text on this plate that must never be clipped, and a
   * layout that depends on nobody ever changing the name is a layout that
   * breaks the first time somebody does.
   */
  ctx.textBaseline = 'top';
  const brandLimit = size * 0.86;
  let brandSize = size * 0.19;
  ctx.font = `bold ${Math.floor(brandSize)}px "Helvetica Neue", Arial, sans-serif`;
  const brandWidth = ctx.measureText('SOME MORE').width;
  if (brandWidth > brandLimit) {
    brandSize *= brandLimit / brandWidth;
    ctx.font = `bold ${Math.floor(brandSize)}px "Helvetica Neue", Arial, sans-serif`;
  }
  ctx.fillStyle = ink;
  ctx.fillText('SOME MORE', size * 0.07, size * 0.075);

  ctx.font = `bold ${Math.floor(size * 0.085)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('SM-01', size * 0.07, size * 0.275);
  ctx.font = `${Math.floor(size * 0.05)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('TRANSFORMATION FREEZER', size * 0.28, size * 0.305);

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
