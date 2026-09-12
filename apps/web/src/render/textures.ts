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
  | 'contact'
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

  /**
   * Compacted soil, for the sides of the pit and for the terrain past the mats.
   *
   * Every colour here used to sit between 25° and 30° of hue, which is orange,
   * and it multiplies against a manifest ground colour that is also 27° — so
   * the two compounded and a midday capture of the forest floor was graded
   * "closer to Mars than to a pine hollow". Soil is not one hue. The wet and
   * shaded parts of it go cool and almost neutral while the dry crust stays
   * warm, and it is that split, rather than the average, that reads as earth.
   */
  dirt: (ctx, size, rng) => {
    fill(ctx, size, '#3a3028');
    speckle(ctx, size, rng, ['#312a24', '#463a2e', '#272426', '#52432f'], 0.7);
    // The cool half: damp soil in the low spots, which is what stops a whole
    // hillside reading as one warm field.
    speckle(ctx, size, rng, ['#2b2c30', '#343138'], 0.06);
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
    /*
     * Rust-brown, not orange-brown, and that is a smaller change than it
     * sounds.
     *
     * The manifest's own words for this campsite's floor are "deep rust-brown
     * needle litter over compacted dirt". Every colour in the first version of
     * this tile sat between 24° and 32° of hue — which is orange — and the tile
     * is *multiplied* by a manifest ground colour that is itself at 27°, so the
     * two compounded rather than averaging. A midday capture of the clearing
     * came back a near-uniform saturated orange with a very narrow value range,
     * and the note on it was that the forest floor read closer to Mars than to
     * a pine hollow.
     *
     * Rust is red-brown: the same value, ten degrees round the wheel, and a
     * good deal less yellow in the pale end. The rest of the fix is not here —
     * it is the daylight ramp no longer *raising* the ground's chroma as it
     * lifts its value, and the terrain past the mats no longer being handed the
     * same colour as the ground at the player's feet.
     */
    fill(ctx, size, '#3f2e23');
    // Broad patches: where the litter is deep, and where it has worn thin.
    blotches(ctx, size, rng, ['#2f2118', '#261a14'], 7, size / 9, size / 4.2);
    blotches(ctx, size, rng, ['#4a3428', '#553c2c'], 6, size / 10, size / 4.5);
    // Fallen needles, in three ages: fresh rust, weathered brown, black.
    strokes(ctx, size, rng, ['#6e442c', '#5a3a26', '#2a1c15'], size * 2, size / 16, size / 7);
    strokes(ctx, size, rng, ['#7f5334'], size * 0.5, size / 20, size / 10);
    // Grit and cone scales, the small pale things that catch a low sun. Greyer
    // than they were: cone scales weather to bone, not to straw, and a pale
    // yellow speck at this density is what pushed the whole field warm.
    speckle(ctx, size, rng, ['#867b6a', '#978c7a'], 0.035);
    // The cool dark: the gaps between needles are shadow lit only by the sky,
    // and they are the entire reason a real forest floor is not monochrome.
    // Sparse and barely blue — rendered at six times life size it looks like
    // confetti, and at the one texel per fifth of a pixel this tile is actually
    // sampled at, anything stronger averages into a grey cast over everything.
    speckle(ctx, size, rng, ['#1b1712'], 0.042);
    speckle(ctx, size, rng, ['#1e2128'], 0.014);
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
    // Greyer than the duff around it as well as lighter: bare soil that has
    // been walked on has had the needles taken out of it, and the needles are
    // where the red in a forest floor lives.
    fill(ctx, size, '#4b4036');
    blotches(ctx, size, rng, ['#55493d', '#42372d', '#5d5145'], 12, size / 9, size / 3.6);
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

  /**
   * The dark pool where a thing meets the ground.
   *
   * Three art directors, grading independently, each reported the same
   * failure in these frames: the rocks "sit *on* the ground rather than *in*
   * it", "read as decals pasted on a plane", have "no contact shadow so it
   * sits on the ground instead of in it". They are right, and at midday they
   * are most right — the sun is overhead, cast shadows collapse to nothing,
   * and there is then no cue at all that an object and a floor are touching.
   *
   * A shadow map does not solve this and would be the wrong tool anyway: at
   * 512 texels over a forty-metre camera the thing a rock needs — a tight
   * dark core exactly at the contact line — is below the resolution, and the
   * pass costs a re-render of everything that casts. The hardware this is
   * imitating drew a blob and the blob was right. It is directionless, which
   * is correct: contact occlusion is not a shadow of a light, it is the sky
   * being blocked, and that is the same from every side.
   *
   * Drawn white at the rim and dark at the core so it can be multiplied into
   * whatever is underneath rather than painted over it — the floor keeps its
   * own grain and its own hue and simply gets darker, which is the difference
   * between a shadow and a sticker.
   *
   * **Dithered on purpose.** A smooth radial ramp at sixty-four pixels under
   * nearest sampling is a set of concentric rings, and rings around every rock
   * is a worse artefact than no shadow at all. An ordered threshold turns the
   * ramp into the same stipple the rest of the frame is made of, so the pool
   * dissolves into the ground instead of terracing into it.
   */
  contact: (ctx, size, rng) => {
    fill(ctx, size, '#ffffff');
    const image = ctx.getImageData(0, 0, size, size);
    const half = size / 2;
    // The 4x4 ordered matrix the renderer already dithers with, so the two
    // patterns are in step rather than beating against each other.
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        // A slightly lumpy disc: nothing in a wood is round, and an exact
        // circle under every prop reads as a decal, which is the complaint.
        const wobble = 1 + rng.range(-0.05, 0.05);
        const d = Math.sqrt(dx * dx + dy * dy) * wobble;
        // Darkest at the core and gone well before the rim, so the pool is
        // "smallest and darkest at the contact line" rather than a wide grey
        // halo. Squared falloff, then eased, is what gives it the tight centre.
        const core = Math.max(0, 1 - d);
        // Gentler than a square, so the pool is a pool rather than a dot with
        // a wide neutral margin: the first version put all of its darkness
        // inside the middle fifth and read, correctly, as a smudge.
        const strength = Math.pow(core, 1.25) * 0.82;
        const threshold = (BAYER[(y % 4) * 4 + (x % 4)] as number) / 16;
        // Quantised to sixteen steps against the ordered matrix: the value
        // that survives is the stipple, not a ramp.
        const level = Math.max(0, Math.min(1, strength));
        const stepped = Math.floor(level * 16 + threshold) / 16;
        const v = Math.round(255 * (1 - stepped));
        const i = (y * size + x) * 4;
        image.data[i] = v;
        image.data[i + 1] = v;
        image.data[i + 2] = v;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
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

  /*
   * The plate, which is no longer near-white.
   *
   * At `#e6e3dc` this was the brightest surface anywhere on the machine — in a
   * night frame it read as a lit rectangle stuck to the cabinet, and at four
   * metres it out-shouted the object it is a label for. A rating plate is
   * painted or anodised aluminium that has been outdoors for twenty years; it
   * is a mid grey, and the contrast that makes the name legible comes from the
   * ink being dark, not from the plate being white.
   */
  fill(ctx, size, '#b9b4a4');
  speckle(ctx, size, rng, ['#afaa9a', '#c3beae'], 0.12);

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

  ctx.font = `bold ${Math.floor(size * 0.095)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('SM-01', size * 0.07, size * 0.285);
  // On its own line rather than set beside the model number, which is where it
  // was: "SM-01" in bold at this size is about a third of the plate wide, and
  // the description started a quarter of the way across it. The two strings
  // overlapped on every machine in the game.
  ctx.font = `${Math.floor(size * 0.05)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('TRANSFORMATION FREEZER', size * 0.07, size * 0.395);

  // A functional rule, the Rams-influenced touch.
  ctx.fillStyle = `rgba(26,28,32,${(0.5 - fade * 0.3).toFixed(3)})`;
  ctx.fillRect(size * 0.07, size * 0.475, size * 0.86, Math.max(1, size / 96));

  /*
   * Two lines of data and a warning, where there were four lines and a warning.
   *
   * The arithmetic is not close. The plate is 0.40 m by 0.20 m and it is read
   * from about two metres through a 426x240 buffer, so the whole plate is
   * roughly 47 by 24 screen pixels: a line set at four and a half per cent of
   * a 256 px canvas arrives about one pixel tall. Five such lines are not
   * small print, they are a grey field at the frequency of the dither, which
   * is why an art review read this plate as unpainted placeholder rather than
   * as text.
   *
   * So the block is cut to what can actually survive: two lines at seven and a
   * half per cent — about two and a half screen pixels each, which is a *mark*
   * — with real air between them, and a warning line in the oxide red that is
   * the only other thing on the plate with any colour in it. What is gone is
   * gone: blank plate reads as blank plate, and blank plate is what a real
   * rating label mostly is.
   */
  ctx.fillStyle = ink;
  ctx.font = `${Math.floor(size * 0.075)}px "Courier New", monospace`;
  ctx.fillText(`SER ${options.serial}`, size * 0.07, size * 0.51);
  ctx.fillText(`MFG ${options.built}   R-290`, size * 0.07, size * 0.605);

  ctx.fillStyle = `rgba(138,59,42,${(0.95 - fade * 0.45).toFixed(3)})`;
  ctx.font = `bold ${Math.floor(size * 0.075)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('COLD SURFACES', size * 0.07, size * 0.705);

  // Stickers, tilted and aged.
  ctx.fillStyle = ink;
  let y = size * 0.825;
  for (const sticker of options.stickers.slice(0, 1)) {
    ctx.save();
    ctx.translate(size * 0.08, y);
    ctx.rotate(rng.range(-0.05, 0.05));
    ctx.fillStyle = rng.chance(0.5) ? '#d8cfae' : '#cfd8d4';
    const w = size * 0.66;
    const h = size * 0.105;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(30,30,30,0.75)';
    ctx.font = `${Math.floor(size * 0.055)}px "Courier New", monospace`;
    /*
     * The first word and the number, not the first fourteen characters.
     *
     * "CAMPGROUND INSPECTION 08" set small enough to fit is a grey smear, and
     * cut to fourteen characters it is "CAMPGROUND INS", which reads as a
     * string that got truncated by a bug. What is actually legible on a
     * peeling inspection tag at two metres is one word and a number, so that
     * is what is printed.
     */
    const words = sticker.split(/[\s,]+/).filter(Boolean);
    const number = sticker.match(/\d+/)?.[0] ?? '';
    ctx.fillText(`${words[0] ?? ''} ${number}`.trim().slice(0, 14), size * 0.02, size * 0.022);
    ctx.restore();
    y += size * 0.1;
  }

  // Wear: scuffs and paint loss.
  const scuffs = Math.floor(options.wear * 16);
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

/* -------------------------------------------------------------------------- */
/* The SM-01's painted skin (spec §3.1)                                       */
/*                                                                            */
/* Everything below draws the machine and nothing else. It is appended rather  */
/* than woven into `GENERATORS` on purpose: the keyed generators are tiles     */
/* that repeat over whatever they are put on, and these are *elevations* — a   */
/* front, a side, a door, drawn once at a known scale and unwrapped onto the   */
/* cabinet by `Machine.tsx`. A tile cannot carry a graphic that has to be in   */
/* one particular place, and a `BoxGeometry`'s 0..1-per-face UVs cannot carry  */
/* a tile at an honest texel density on a box that is 0.86 m across one face   */
/* and 0.03 m across the next.                                                */
/* -------------------------------------------------------------------------- */

/**
 * A rectangle of the machine atlas, in atlas pixels at the reference size,
 * with the real-world extent it covers.
 *
 * Both halves matter and they are why this is data rather than magic numbers
 * in two files. `Machine.tsx` projects each face of the cabinet onto the
 * matching elevation to build UVs; the drawing code below converts metres to
 * atlas pixels through the same numbers. If they disagree, the paint slides
 * off the panel, and the only way to notice is to look.
 */
export interface AtlasRegion {
  /** Position and size in atlas pixels, at the reference atlas size. */
  readonly px: number;
  readonly py: number;
  readonly pw: number;
  readonly ph: number;
  /** Horizontal extent in metres: x for front/back/top, z for the side. */
  readonly h: readonly [number, number];
  /** Vertical extent in metres: y, or z on the top face. */
  readonly v: readonly [number, number];
}

/** The reference atlas edge. Every region is expressed against this. */
export const MACHINE_ATLAS_SIZE = 256;

/**
 * The cabinet's four elevations, laid out in one texture.
 *
 * The front and side are drawn at about 142 px/m, which is the texel density a
 * 128 px tile gives a 0.9 m panel — the PS1 range this renderer is built for,
 * not a modern lightmap. The back is deliberately squashed vertically to about
 * a third of that: it faces away from the clearing at every campsite and
 * carries nothing but horizontal bands, which is the one kind of detail a
 * vertical squash cannot spoil.
 */
export const MACHINE_ATLAS = {
  front: { px: 0, py: 0, pw: 128, ph: 190, h: [-0.45, 0.45], v: [0, 1.35] },
  side: { px: 128, py: 0, pw: 100, ph: 190, h: [-0.35, 0.35], v: [0, 1.35] },
  back: { px: 0, py: 190, pw: 128, ph: 66, h: [-0.45, 0.45], v: [0, 1.35] },
  top: { px: 128, py: 190, pw: 100, ph: 66, h: [-0.45, 0.45], v: [-0.35, 0.35] },
  /** Bottoms, inner returns, anything nobody stands in front of. */
  misc: { px: 228, py: 0, pw: 28, ph: 256, h: [0, 1], v: [0, 1] },
} as const satisfies Record<string, AtlasRegion>;

export type MachineAtlasFace = keyof typeof MACHINE_ATLAS;

/**
 * The enamel the cabinet is painted in.
 *
 * It is not the industrial white the spec's material list names, and the
 * reason is worth writing down. White enamel put the machine within a few per
 * cent of the handheld's own cream bezel, so at any distance where the panel
 * detail has gone — which is most of the game — the SM-01 dissolved into the
 * frame around the screen. A chipped institutional green is the same class of
 * object (municipal, enamelled, left outdoors for years) at a hue and value
 * nothing else in the clearing occupies: the ground is rust-brown, the bezel
 * is cream, the pines are darker and far more saturated, and the fire stays
 * the brightest thing in the frame at night because this is a mid-value paint
 * and not a light source.
 *
 * The value was chosen by measurement rather than by eye, because "a different
 * hue" is not the same claim as "separates from the frame": a green at the
 * same brightness as the bezel still merges once the buffer is 426 px wide and
 * quantised to five bits. Sampling the enamel and the bezel out of the seven
 * shipped `hour-*` frames and re-lighting the enamel through the new albedo
 * gives, as a luminance gap from the bezel:
 *
 *     hour          old cream   this green
 *     pre-dawn        0.261       0.290
 *     dawn            0.241       0.275
 *     morning         0.148       0.206
 *     midday          0.041       0.065
 *     afternoon       0.041       0.066
 *     dusk            0.197       0.243
 *     early night     0.226       0.263
 *
 * Every hour separates further than it did, and the two that were nearly
 * indistinguishable — midday and afternoon, at four hundredths — separate by
 * half as much again. Going darker still keeps widening that gap; this is as
 * dark as it goes before pre-dawn stops being a surface and starts being a
 * silhouette, which is the floor D7 puts under it.
 */
const ENAMEL = {
  base: '#7f8c76',
  light: '#8b9882',
  lighter: '#97a48d',
  dark: '#6f7b67',
  darker: '#616c5a',
  shadow: '#4e5747',
  /** What a chip shows: oxide primer, and the bare filler around its edge. */
  primer: '#423d31',
  bare: '#7e786a',
  /** Sun-bleached: the same paint after ten summers facing the clearing. */
  bleached: '#a0a792',
  bleachedLight: '#acb29d',
} as const;

/** Rust, soot and grease — the three things that age an outdoor appliance. */
const GRIME = {
  rust: '#8a4a25',
  rustDark: '#61331a',
  rustLight: '#a86733',
  sootHard: 'rgba(24,20,17,0.55)',
  grease: 'rgba(52,44,34,0.26)',
  splash: 'rgba(74,58,40,0.30)',
} as const;

/**
 * The s'more mark, in the game's own warm palette.
 *
 * Drawn as five stacked bands because that is what the product *is*, and
 * because a stack of bands is the one illustration that survives being twenty
 * pixels tall: at the arrival camera this mark is about 26 screen pixels high,
 * which is five bands of four or five pixels each, and each band is a
 * different value. Anything with interior drawing — a bitten corner, a
 * highlight, a squeeze of ice cream — averages to a beige lozenge at that size
 * and says nothing at all.
 */
const SMORE = {
  ink: '#2a2320',
  grahamTop: '#cf9a52',
  graham: '#b8843f',
  chocolate: '#4e2a18',
  cream: '#f4ead4',
  toast: '#c9884a',
} as const;

/** Maps a point given in metres on an elevation to atlas pixels. */
function atlasPoint(region: AtlasRegion, h: number, v: number, scale: number): [number, number] {
  const u = (h - region.h[0]) / (region.h[1] - region.h[0]);
  const t = (v - region.v[0]) / (region.v[1] - region.v[0]);
  return [(region.px + u * region.pw) * scale, (region.py + (1 - t) * region.ph) * scale];
}

/** Fills a rectangle given in metres on an elevation. */
function metreRect(
  ctx: Ctx2D,
  region: AtlasRegion,
  scale: number,
  h0: number,
  v0: number,
  h1: number,
  v1: number,
  color: string,
): void {
  const [x0, y0] = atlasPoint(region, Math.min(h0, h1), Math.max(v0, v1), scale);
  const [x1, y1] = atlasPoint(region, Math.max(h0, h1), Math.min(v0, v1), scale);
  ctx.fillStyle = color;
  ctx.fillRect(
    Math.round(x0),
    Math.round(y0),
    Math.max(1, Math.round(x1 - x0)),
    Math.max(1, Math.round(y1 - y0)),
  );
}

/** Fills a whole region, in atlas pixels. */
function fillRegion(ctx: Ctx2D, region: AtlasRegion, scale: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(
    Math.round(region.px * scale),
    Math.round(region.py * scale),
    Math.ceil(region.pw * scale),
    Math.ceil(region.ph * scale),
  );
}

/** Chalky enamel: a flat coat, then blocky value noise so it is not a wash. */
function enamelCoat(
  ctx: Ctx2D,
  region: AtlasRegion,
  scale: number,
  rng: Rng,
  base: string,
  light: string,
  dark: string,
): void {
  fillRegion(ctx, region, scale, base);
  const x0 = Math.round(region.px * scale);
  const y0 = Math.round(region.py * scale);
  const w = Math.max(1, Math.floor(region.pw * scale));
  const h = Math.max(1, Math.floor(region.ph * scale));
  const patches = Math.floor(w * h * 0.034);
  for (let i = 0; i < patches; i++) {
    ctx.fillStyle = rng.chance(0.5) ? light : dark;
    ctx.fillRect(x0 + rng.int(0, w - 1), y0 + rng.int(0, h - 1), rng.int(1, 2), rng.int(1, 2));
  }
}

/**
 * A rust streak weeping downward from a fixing.
 *
 * Real rust on painted steel runs: it starts at the fastener, widens as it
 * goes, and fades out. Seven tapering steps of decreasing opacity do that,
 * where a single hard bar reads as a drawn line.
 */
function rustStreak(
  ctx: Ctx2D,
  region: AtlasRegion,
  scale: number,
  h: number,
  vTop: number,
  vBottom: number,
  width: number,
  rng: Rng,
): void {
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const v0 = vTop + (vBottom - vTop) * t;
    const v1 = vTop + (vBottom - vTop) * Math.min(1, t + 1 / (steps - 1));
    const wide = width * (0.5 + t * 1.1);
    const color = t < 0.25 ? GRIME.rustDark : t < 0.7 ? GRIME.rust : GRIME.rustLight;
    ctx.globalAlpha = 0.7 - t * 0.5;
    const jitter = rng.range(-0.004, 0.004);
    metreRect(ctx, region, scale, h - wide / 2 + jitter, v0, h + wide / 2 + jitter, v1, color);
    ctx.globalAlpha = 1;
  }
}

/** A hand's worth of grime: a smear plus a few finger marks. */
function handSmudge(ctx: Ctx2D, region: AtlasRegion, scale: number, h: number, v: number, rng: Rng): void {
  ctx.globalAlpha = 0.55;
  metreRect(ctx, region, scale, h - 0.055, v - 0.05, h + 0.055, v + 0.05, GRIME.grease);
  ctx.globalAlpha = 1;
  for (let i = 0; i < 6; i++) {
    const fh = h + rng.range(-0.05, 0.05);
    const fv = v + rng.range(-0.045, 0.045);
    ctx.globalAlpha = rng.range(0.25, 0.6);
    metreRect(ctx, region, scale, fh, fv, fh + rng.range(0.008, 0.016), fv + rng.range(0.012, 0.024), GRIME.sootHard);
    ctx.globalAlpha = 1;
  }
}

/** Blends two hex colours, for fading a mark toward the panel around it. */
function mixHex(color: string, toward: string, amount: number): string {
  if (amount <= 0) return color;
  const parse = (value: string): [number, number, number] => [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
  const [r0, g0, b0] = parse(color);
  const [r1, g1, b1] = parse(toward);
  const lerp = (a: number, b: number): number => Math.round(a + (b - a) * amount);
  return `rgb(${lerp(r0, r1)},${lerp(g0, g1)},${lerp(b0, b1)})`;
}

/**
 * The s'more mark: five bands, an ink outline, and nothing else.
 *
 * `fade` bleaches it toward the panel colour, which is how one drawing serves
 * both the crown sign — fresh, on a dark plaque — and the painted sign on the
 * flank that has faced the clearing since the unit was installed.
 */
function smoreMark(
  ctx: Ctx2D,
  region: AtlasRegion,
  scale: number,
  centreH: number,
  centreV: number,
  width: number,
  height: number,
  fade: number,
): void {
  const f = (color: string): string => mixHex(color, ENAMEL.bleached, fade);

  // Band heights as fractions of the mark's total height. The marshmallow is
  // the tallest because it is the only band the player has personally roasted.
  const bands: ReadonlyArray<{ inset: number; height: number; fill: string; lid: string | null }> = [
    { inset: 0.0, height: 0.2, fill: f(SMORE.graham), lid: f(SMORE.grahamTop) },
    { inset: 0.05, height: 0.12, fill: f(SMORE.chocolate), lid: null },
    { inset: 0.02, height: 0.3, fill: f(SMORE.cream), lid: null },
    { inset: 0.05, height: 0.12, fill: f(SMORE.chocolate), lid: null },
    { inset: 0.0, height: 0.26, fill: f(SMORE.graham), lid: f(SMORE.grahamTop) },
  ];
  // Width and height are given separately because the two places this mark
  // goes are different shapes: a wide crown board and a nearly square flank.
  // Tying the height to the width put a 0.30 m mark on a 0.62 m board, and the
  // bands were half the thickness they could have been for free.
  const totalHeight = height;
  const ink = f(SMORE.ink);
  const outline = Math.max(totalHeight * 0.045, ((region.h[1] - region.h[0]) / region.pw) * 1.2);

  let v = centreV - totalHeight / 2;
  for (const band of bands) {
    const half = (width / 2) * (1 - band.inset);
    const bandHeight = totalHeight * band.height;
    // Ink first and the fill inset into it: an outline drawn as a stroke gets
    // eaten by rounding when the whole mark is twenty pixels tall.
    metreRect(ctx, region, scale, centreH - half, v, centreH + half, v + bandHeight, ink);
    metreRect(
      ctx,
      region,
      scale,
      centreH - half + outline,
      v + outline * 0.5,
      centreH + half - outline,
      v + bandHeight - outline * 0.5,
      band.fill,
    );
    if (band.lid) {
      metreRect(
        ctx,
        region,
        scale,
        centreH - half + outline,
        v + bandHeight - outline * 2.4,
        centreH + half - outline,
        v + bandHeight - outline * 0.5,
        band.lid,
      );
    }
    v += bandHeight;
  }

  // Two toast marks on the marshmallow. At this size they are the whole
  // difference between "roasted" and "a white slab".
  const creamBottom = centreV - totalHeight / 2 + totalHeight * 0.32;
  const creamHeight = totalHeight * 0.3;
  const toast = f(SMORE.toast);
  metreRect(ctx, region, scale, centreH - width * 0.3, creamBottom + creamHeight * 0.22, centreH - width * 0.1, creamBottom + creamHeight * 0.52, toast);
  metreRect(ctx, region, scale, centreH + width * 0.05, creamBottom + creamHeight * 0.45, centreH + width * 0.27, creamBottom + creamHeight * 0.74, toast);
}

export interface MachineSkinOptions {
  /** Seeds every scuff, chip and streak, so a campsite's unit is its unit. */
  serial: string;
  /** 0..1, from `machine.identity.wear`. */
  wear: number;
  /** Atlas edge in pixels. The reference size on `mid`, half it on `low`. */
  size?: number;
}

/**
 * The painted cabinet: front, side, back and top elevations in one texture.
 *
 * The three things an art review said were missing from this object are all
 * here, and all in paint rather than in geometry, because paint is free and
 * the draw-call budget is not: a food cue (the s'more mark on the crown, and
 * again large and sun-faded on the flank that faces the clearing), wear that
 * says the machine has been used (rust weeping from the hinge fixings, grease
 * and soot where hands go, a splash line along the bottom), and a body colour
 * that is not the bezel's.
 */
export function createMachineBodyTexture(options: MachineSkinOptions): THREE.Texture | null {
  const size = options.size ?? MACHINE_ATLAS_SIZE;
  const cacheKey = `machineBody:${options.serial}:${size}:${options.wear.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;
  const { ctx, canvas } = surface;
  const scale = size / MACHINE_ATLAS_SIZE;
  const rng = new Rng(`${options.serial}-body`);
  const wear = Math.min(1, Math.max(0, options.wear));

  fill(ctx, size, ENAMEL.base);
  for (const face of ['front', 'side', 'back', 'top', 'misc'] as const) {
    enamelCoat(ctx, MACHINE_ATLAS[face], scale, rng, ENAMEL.base, ENAMEL.light, ENAMEL.dark);
  }

  drawFrontElevation(ctx, scale, rng, wear);
  drawSideElevation(ctx, scale, rng, wear);
  drawBackElevation(ctx, scale, rng, wear);
  drawTopElevation(ctx, scale, rng, wear);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}

/** The face the player operates: crown sign, panel recess, hinge rust. */
function drawFrontElevation(ctx: Ctx2D, scale: number, rng: Rng, wear: number): void {
  const front = MACHINE_ATLAS.front;

  // The crown sign board, 1.06–1.33 m. A dark plaque, so the mark on it is a
  // light shape on a dark ground — the contrast that survives 426 px.
  metreRect(ctx, front, scale, -0.34, 1.05, 0.34, 1.34, ENAMEL.darker);
  metreRect(ctx, front, scale, -0.325, 1.065, 0.325, 1.325, '#38443a');
  metreRect(ctx, front, scale, -0.31, 1.08, 0.31, 1.31, '#2c372e');
  smoreMark(ctx, front, scale, 0, 1.196, 0.40, 0.225, 0);

  // A shadow gap under the crown, so it reads as bolted on, not moulded in.
  metreRect(ctx, front, scale, -0.34, 1.03, 0.34, 1.052, ENAMEL.shadow);

  // The control-panel bay: the shallow recess the placard and the switches sit
  // in. Painted, because a recess drawn in shadow costs nothing and a recess
  // built in geometry costs twelve triangles and a seam.
  metreRect(ctx, front, scale, -0.43, 0.742, 0.43, 1.008, ENAMEL.dark);
  metreRect(ctx, front, scale, -0.43, 0.990, 0.43, 1.008, ENAMEL.shadow);
  metreRect(ctx, front, scale, -0.43, 0.742, 0.43, 0.758, ENAMEL.light);

  // The chamber surround: slightly darker than the flat, the way a pressing
  // that has been wiped ten thousand times goes.
  metreRect(ctx, front, scale, -0.30, 0.34, 0.30, 0.78, ENAMEL.dark);

  // Hinge fixings on the left jamb, and what has been weeping out of them
  // since the unit was installed.
  for (const y of [0.72, 0.40]) {
    metreRect(ctx, front, scale, -0.335, y - 0.012, -0.285, y + 0.012, ENAMEL.shadow);
    rustStreak(ctx, front, scale, -0.31, y - 0.014, y - 0.014 - 0.28 * (0.5 + wear), 0.028, rng);
  }

  // The drip-tray mouth under the door: a dark slot with a lip shadow. The
  // tray itself is real aluminium geometry; this is the dark it sits in.
  metreRect(ctx, front, scale, -0.20, 0.250, 0.20, 0.302, '#2c332a');
  metreRect(ctx, front, scale, -0.20, 0.288, 0.20, 0.302, '#1e241d');

  // Condenser bay behind the fins, dark so the fins read as standing proud.
  // 0.066–0.220 m, which is where `FINS` in `machineShell.ts` actually puts
  // them: this pair of numbers is the one place the paint and the geometry can
  // disagree without anything failing.
  metreRect(ctx, front, scale, -0.18, 0.064, 0.18, 0.222, ENAMEL.shadow);

  // Grease where the latch hand goes, and the scuff line where boots and an
  // armful of firewood have hit the plinth.
  handSmudge(ctx, front, scale, 0.33, 0.56, rng);
  ctx.globalAlpha = 0.5;
  metreRect(ctx, front, scale, -0.45, 0.0, 0.45, 0.045, GRIME.splash);
  ctx.globalAlpha = 1;

  chipsAndScuffs(ctx, front, scale, rng, wear, 1);
}

/** The flank that faces the clearing: the painted sign, and ten summers of sun. */
function drawSideElevation(ctx: Ctx2D, scale: number, rng: Rng, wear: number): void {
  const side = MACHINE_ATLAS.side;

  /*
   * The sun-bleached band.
   *
   * Not the whole panel: paint fades where the light lands, which on an object
   * standing in a clearing is a band across the upper two-thirds with a soft
   * lower edge where the undergrowth has shaded it. Drawn as four steps rather
   * than a gradient because the renderer quantises to five bits per channel
   * anyway — a smooth ramp arrives as four steps with the banding in places
   * nobody chose.
   */
  const steps = [
    { v0: 0.46, v1: 0.60, color: ENAMEL.light },
    { v0: 0.60, v1: 0.74, color: ENAMEL.lighter },
    { v0: 0.74, v1: 1.02, color: ENAMEL.bleached },
    { v0: 1.02, v1: 1.10, color: ENAMEL.bleachedLight },
  ];
  for (const step of steps) metreRect(ctx, side, scale, -0.35, step.v0, 0.35, step.v1, step.color);

  // The painted sign: the same mark, large, faded most where the band is
  // brightest. This is the one that has to survive being seen from the fire,
  // so it takes nearly the full depth of the flank.
  smoreMark(ctx, side, scale, 0.02, 0.715, 0.44, 0.34, 0.42);

  // A hairline border round the sign, the way a stencilled panel is edged.
  ctx.globalAlpha = 0.5;
  const border = { h0: -0.235, h1: 0.275, v0: 0.5, v1: 0.935 };
  metreRect(ctx, side, scale, border.h0, border.v0, border.h1, border.v0 + 0.012, ENAMEL.shadow);
  metreRect(ctx, side, scale, border.h0, border.v1 - 0.012, border.h1, border.v1, ENAMEL.shadow);
  metreRect(ctx, side, scale, border.h0, border.v0, border.h0 + 0.012, border.v1, ENAMEL.shadow);
  metreRect(ctx, side, scale, border.h1 - 0.012, border.v0, border.h1, border.v1, ENAMEL.shadow);
  ctx.globalAlpha = 1;

  // Rust from the top seam, which is where the water sits.
  for (let i = 0; i < 3; i++) {
    rustStreak(ctx, side, scale, rng.range(-0.28, 0.28), 1.05, 1.05 - rng.range(0.12, 0.34) * (0.4 + wear), 0.02, rng);
  }

  // Mud and needle wash up the bottom of the flank.
  ctx.globalAlpha = 0.6;
  metreRect(ctx, side, scale, -0.35, 0, 0.35, 0.08, GRIME.splash);
  ctx.globalAlpha = 0.3;
  metreRect(ctx, side, scale, -0.35, 0.08, 0.35, 0.2, GRIME.splash);
  ctx.globalAlpha = 1;

  chipsAndScuffs(ctx, side, scale, rng, wear, 0.8);
}

/** The back: the cold plant breathes here, and nobody looks. */
function drawBackElevation(ctx: Ctx2D, scale: number, rng: Rng, wear: number): void {
  const back = MACHINE_ATLAS.back;
  metreRect(ctx, back, scale, -0.32, 0.05, 0.32, 0.28, ENAMEL.shadow);
  for (let i = 0; i < 5; i++) {
    const y = 0.07 + i * 0.042;
    metreRect(ctx, back, scale, -0.30, y, 0.30, y + 0.02, ENAMEL.darker);
  }
  ctx.globalAlpha = 0.55;
  metreRect(ctx, back, scale, -0.45, 0, 0.45, 0.09, GRIME.splash);
  ctx.globalAlpha = 1;
  chipsAndScuffs(ctx, back, scale, rng, wear, 0.6);
}

/** The top: seen by anybody standing next to it, so it gets the weather. */
function drawTopElevation(ctx: Ctx2D, scale: number, rng: Rng, wear: number): void {
  const top = MACHINE_ATLAS.top;
  enamelCoat(ctx, top, scale, rng, ENAMEL.bleached, ENAMEL.bleachedLight, ENAMEL.light);
  // Standing water leaves rings, and the grit that came with it.
  for (let i = 0; i < 6; i++) {
    const h = rng.range(-0.34, 0.28);
    const v = rng.range(-0.28, 0.22);
    ctx.globalAlpha = rng.range(0.14, 0.34);
    metreRect(ctx, top, scale, h, v, h + rng.range(0.04, 0.13), v + rng.range(0.03, 0.09), GRIME.splash);
    ctx.globalAlpha = 1;
  }
  for (let i = 0; i < 2; i++) {
    rustStreak(ctx, top, scale, rng.range(-0.3, 0.3), 0.3, 0.3 - rng.range(0.08, 0.2), 0.02, rng);
  }
  chipsAndScuffs(ctx, top, scale, rng, wear, 0.5);
}

/**
 * Chipped enamel and scuffs, scaled by the unit's wear.
 *
 * A chip is two rectangles, not one: the paint edge around it is lighter than
 * the paint and what is under it is much darker, and without both it reads as
 * a dirty mark rather than as a place the enamel has come off.
 */
function chipsAndScuffs(
  ctx: Ctx2D,
  region: AtlasRegion,
  scale: number,
  rng: Rng,
  wear: number,
  density: number,
): void {
  const spanH = region.h[1] - region.h[0];
  const spanV = region.v[1] - region.v[0];
  const chips = Math.floor((4 + wear * 15) * density);
  for (let i = 0; i < chips; i++) {
    // Weighted to the bottom and to the edges: that is where things hit it.
    const h = region.h[0] + spanH * (rng.chance(0.5) ? rng.range(0, 0.14) : rng.range(0.86, 1));
    const v = region.v[0] + spanV * Math.pow(rng.range(0, 1), 2.1);
    const w = spanH * rng.range(0.006, 0.02);
    const t = spanV * rng.range(0.004, 0.013);
    metreRect(ctx, region, scale, h - w * 0.25, v - t * 0.25, h + w * 1.25, v + t * 1.25, ENAMEL.bare);
    metreRect(ctx, region, scale, h, v, h + w, v + t, ENAMEL.primer);
  }
  const scuffs = Math.floor((7 + wear * 20) * density);
  for (let i = 0; i < scuffs; i++) {
    const h = region.h[0] + spanH * rng.range(0, 1);
    const v = region.v[0] + spanV * Math.pow(rng.range(0, 1), 1.6);
    ctx.globalAlpha = rng.range(0.1, 0.34);
    metreRect(
      ctx,
      region,
      scale,
      h,
      v,
      h + spanH * rng.range(0.02, 0.09),
      v + spanV * rng.range(0.003, 0.008),
      rng.chance(0.5) ? ENAMEL.lighter : ENAMEL.shadow,
    );
    ctx.globalAlpha = 1;
  }
}

/**
 * The emissive mask for the cabinet: black except where light gets out.
 *
 * §3.1 says colour on this machine is functional, and what the machine had was
 * an indicator lamp, a chamber lamp and nothing else — so a run that takes a
 * minute looked, from six metres away, exactly like a machine that was off.
 * This is the vent light: the condenser bay behind the fins, the drip-tray
 * slot, the seam under the crown, and the plant vents at the back.
 * `Machine.tsx` drives the intensity and the colour — amber while the chamber
 * is still warm, icy blue once it is freezing — so this map only ever says
 * *where*, never *how much*.
 */
export function createMachineBodyEmissive(size = MACHINE_ATLAS_SIZE): THREE.Texture | null {
  const cacheKey = `machineGlow:${size}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;
  const { ctx, canvas } = surface;
  const scale = size / MACHINE_ATLAS_SIZE;
  const front = MACHINE_ATLAS.front;
  const back = MACHINE_ATLAS.back;

  fill(ctx, size, '#000000');

  // Behind the fins. Bars rather than a slab: the fins stand proud of the
  // panel with a gap between each, so what actually escapes is stripes.
  for (let i = 0; i < 6; i++) {
    const y = 0.072 + i * 0.026;
    metreRect(ctx, front, scale, -0.175, y, 0.175, y + 0.013, '#ffffff');
    metreRect(ctx, front, scale, -0.175, y + 0.013, 0.175, y + 0.019, '#5a5a5a');
  }
  // The drip-tray slot, and a thin seam under the crown board.
  metreRect(ctx, front, scale, -0.19, 0.256, 0.19, 0.296, '#c8c8c8');
  metreRect(ctx, front, scale, -0.32, 1.034, 0.32, 1.05, '#8a8a8a');
  // The plant vents at the back.
  for (let i = 0; i < 5; i++) {
    const y = 0.07 + i * 0.042;
    metreRect(ctx, back, scale, -0.30, y, 0.30, y + 0.02, '#9a9a9a');
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}

/**
 * The door leaf's elevation: x 0..0.58 from the hinge, y -0.24..0.24.
 *
 * Separate from the body atlas because the door moves — its UVs are in the
 * door's own frame, not the cabinet's. It is still one material and one mesh,
 * so it costs nothing.
 */
export const MACHINE_DOOR_ATLAS = {
  face: { px: 0, py: 0, pw: 84, ph: 70, h: [0, 0.58], v: [-0.24, 0.24] },
  edge: { px: 86, py: 0, pw: 40, ph: 70, h: [0, 1], v: [0, 1] },
} as const satisfies Record<string, AtlasRegion>;

export const MACHINE_DOOR_ATLAS_SIZE = 128;

/** The door leaf's skin: the same enamel, plus every hand that has opened it. */
export function createMachineDoorTexture(options: MachineSkinOptions): THREE.Texture | null {
  const size = options.size ?? MACHINE_DOOR_ATLAS_SIZE;
  const cacheKey = `machineDoor:${options.serial}:${size}:${options.wear.toFixed(2)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const surface = createCanvas(size);
  if (!surface) return null;
  const { ctx, canvas } = surface;
  const scale = size / MACHINE_DOOR_ATLAS_SIZE;
  const rng = new Rng(`${options.serial}-door`);
  const wear = Math.min(1, Math.max(0, options.wear));
  const face = MACHINE_DOOR_ATLAS.face;

  fill(ctx, size, ENAMEL.base);
  enamelCoat(ctx, face, scale, rng, ENAMEL.base, ENAMEL.light, ENAMEL.dark);
  enamelCoat(ctx, MACHINE_DOOR_ATLAS.edge, scale, rng, ENAMEL.dark, ENAMEL.base, ENAMEL.darker);

  // A pressed border, the way a fridge door is stiffened.
  metreRect(ctx, face, scale, 0.03, -0.215, 0.55, -0.198, ENAMEL.light);
  metreRect(ctx, face, scale, 0.03, 0.198, 0.55, 0.215, ENAMEL.shadow);

  // Hinge plates on the leaf, and the rust that has run down from them.
  for (const y of [0.16, -0.16]) {
    metreRect(ctx, face, scale, 0.008, y - 0.022, 0.062, y + 0.022, ENAMEL.shadow);
    rustStreak(ctx, face, scale, 0.035, y - 0.024, y - 0.024 - 0.11 * (0.4 + wear), 0.026, rng);
  }

  /*
   * Where the hand goes.
   *
   * The handle is at x = 0.53 on this leaf and the door has been pulled open
   * and shoved shut every night for years, so the paint there carries grease
   * from a palm, soot from the fire on the fingertips, and a patch worn
   * through to the primer under the thumb. It is the most convincing wear
   * available on this object, because it is the wear the player is about to
   * add to themselves.
   */
  ctx.globalAlpha = 0.4;
  metreRect(ctx, face, scale, 0.44, -0.15, 0.57, 0.15, GRIME.grease);
  ctx.globalAlpha = 1;
  handSmudge(ctx, face, scale, 0.50, 0.02, rng);
  handSmudge(ctx, face, scale, 0.505, -0.09, rng);
  metreRect(ctx, face, scale, 0.486, -0.022, 0.518, 0.032, ENAMEL.bare);
  metreRect(ctx, face, scale, 0.492, -0.014, 0.512, 0.024, ENAMEL.primer);

  chipsAndScuffs(ctx, face, scale, rng, wear, 0.7);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(cacheKey, texture);
  return texture;
}
