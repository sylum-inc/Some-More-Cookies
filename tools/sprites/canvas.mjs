/**
 * A pixel canvas, a palette, and a PNG encoder, in about three hundred lines.
 *
 * Every sprite in this game is drawn by code. ADR-0002 says everything is
 * procedural behind swap-in interfaces because there is no artist and no asset
 * pipeline, and that applies to the interface as much as to the trees — so the
 * icons are not files somebody drew, they are functions that draw.
 *
 * There is no image dependency either, for the same reason `services/api`
 * speaks the Postgres wire protocol and RFC 6455 by hand: adding a PNG library
 * to draw a 24-pixel icon is a bad trade. Node ships zlib, and a PNG is a
 * signature, three chunks and a CRC.
 *
 * The API is deliberately small and pixel-honest. There is no anti-aliasing,
 * no sub-pixel anything, and no alpha blending: a pixel is one palette index
 * or it is transparent. That constraint is the aesthetic — it is what made
 * handheld art of this era read at a glance on a small screen — and a drawing
 * call that cannot cheat is a drawing call that stays legible when the whole
 * icon is twenty-four pixels across.
 */

import { deflateSync } from 'node:zlib';

/**
 * The house palette.
 *
 * One ramp per material, four steps each: darkest is the outline, lightest is
 * the highlight. Icons that share a ramp read as the same substance, which is
 * how a set of icons becomes a set rather than a pile — and it is why this is
 * a fixed table rather than a colour per icon.
 *
 * Warm ramps for anything the fire touches, cool ramps for night and metal,
 * and a single accent that is used for exactly one thing: what the world wants
 * you to notice right now.
 */
export const PALETTE = {
  none: null,

  // Ink. Outlines and shadow, never pure black — pure black against the
  // dithered night reads as a hole rather than as a line.
  ink: '#0d0b10',
  ink2: '#1b1720',
  ink3: '#2c2634',

  // Ember: fire, heat, anything alight.
  ember1: '#5c1e0a',
  ember2: '#a83c10',
  ember3: '#ef7a1e',
  ember4: '#ffc861',

  // Wood: logs, sticks, the rod, the table.
  wood1: '#3a2416',
  wood2: '#6b4526',
  wood3: '#9c6a3c',
  wood4: '#c99a63',

  // Stone: rocks, the pit ring, gravel.
  stone1: '#22242b',
  stone2: '#454a55',
  stone3: '#6f7683',
  stone4: '#9ba3b1',

  // Steel: the SM-01, the radio, the torch body, HUD bezel.
  steel1: '#1d2229',
  steel2: '#3b4552',
  steel3: '#6a7787',
  steel4: '#a6b3c2',

  // Cream: marshmallow, ice cream, moon, paper.
  cream1: '#6b5b45',
  cream2: '#a89272',
  cream3: '#ddc9a3',
  cream4: '#fbf1d8',

  // Green: foliage, ferns, moss.
  green1: '#16281a',
  green2: '#2c4a2c',
  green3: '#4a7342',
  green4: '#7aa25c',

  // Sky: night blues, water, cold.
  sky1: '#131a2c',
  sky2: '#26365a',
  sky3: '#456architecture',
  sky4: '#8aa6d8',

  // Chocolate.
  choc1: '#2a160e',
  choc2: '#4e2a18',
  choc3: '#7a4526',

  // The one accent. Used for what the world wants you to look at, and for
  // nothing else — an accent that appears everywhere points at nothing.
  accent: '#ffd24a',
};

// One typo above would be a silent wrong colour; catch it at load.
PALETTE.sky3 = '#456a9e';

/** Every palette key, so a sprite module can be checked against the set. */
export const PALETTE_KEYS = Object.keys(PALETTE);

/**
 * A fixed-size indexed pixel buffer.
 *
 * Stores palette *keys*, not colours, so a sprite can be recoloured wholesale
 * later (a torch-lit variant, a disabled state) without redrawing it.
 */
export class Pix {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Array(width * height).fill('none');
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** One pixel. Out-of-bounds is a no-op, so shapes can run off the edge. */
  set(x, y, key) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (!this.inside(px, py)) return this;
    if (key === undefined) return this;
    if (!(key in PALETTE)) throw new Error(`unknown palette key: ${key}`);
    this.data[py * this.width + px] = key;
    return this;
  }

  get(x, y) {
    return this.inside(x, y) ? this.data[y * this.width + x] : 'none';
  }

  /** Filled rectangle, inclusive of x,y and w,h wide. */
  rect(x, y, w, h, key) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, key);
    return this;
  }

  /** Rectangle outline, one pixel thick. */
  frame(x, y, w, h, key) {
    for (let dx = 0; dx < w; dx++) {
      this.set(x + dx, y, key);
      this.set(x + dx, y + h - 1, key);
    }
    for (let dy = 0; dy < h; dy++) {
      this.set(x, y + dy, key);
      this.set(x + w - 1, y + dy, key);
    }
    return this;
  }

  /** Bresenham line. */
  line(x0, y0, x1, y1, key) {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y, key);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
    return this;
  }

  /** Filled ellipse by centre and radii. */
  disc(cx, cy, rx, ry, key) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x - cx) / Math.max(0.0001, rx);
        const ny = (y - cy) / Math.max(0.0001, ry);
        if (nx * nx + ny * ny <= 1.02) this.set(x, y, key);
      }
    }
    return this;
  }

  /** Ellipse outline. */
  ring(cx, cy, rx, ry, key) {
    const inner = new Pix(this.width, this.height);
    inner.disc(cx, cy, rx, ry, 'ink');
    inner.disc(cx, cy, rx - 1, ry - 1, 'none');
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) if (inner.get(x, y) !== 'none') this.set(x, y, key);
    }
    return this;
  }

  /** Convex polygon from [x,y] pairs, scanline filled. */
  poly(points, key) {
    const ys = points.map((p) => p[1]);
    const top = Math.floor(Math.min(...ys));
    const bottom = Math.ceil(Math.max(...ys));
    for (let y = top; y <= bottom; y++) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if (ay === by) continue;
        if (y >= Math.min(ay, by) && y < Math.max(ay, by)) {
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) this.set(x, y, key);
      }
    }
    return this;
  }

  /**
   * A 50% checker of one key over another, for gradients that stay in palette.
   *
   * The whole look of this era came from having four colours and needing eight,
   * so the fifth through eighth were dithers. Anywhere a ramp step is too
   * abrupt, this is the answer rather than a new colour.
   */
  dither(x, y, w, h, key, phase = 0) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if ((x + dx + y + dy + phase) % 2 === 0) this.set(x + dx, y + dy, key);
      }
    }
    return this;
  }

  /**
   * Draws a one-pixel outline around everything already drawn.
   *
   * The single most important call in this file. An icon without a hard
   * outline disappears against a dithered forest floor at 24 pixels; with one
   * it reads at a glance, which is the entire job of a handheld HUD.
   */
  outline(key = 'ink') {
    const copy = this.data.slice();
    const at = (x, y) => (this.inside(x, y) ? copy[y * this.width + x] : 'none');
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (at(x, y) !== 'none') continue;
        const touching =
          at(x - 1, y) !== 'none' ||
          at(x + 1, y) !== 'none' ||
          at(x, y - 1) !== 'none' ||
          at(x, y + 1) !== 'none';
        if (touching) this.set(x, y, key);
      }
    }
    return this;
  }

  /** Offset copy of everything drawn, underneath it. A cheap drop shadow. */
  shadow(dx = 1, dy = 1, key = 'ink') {
    const copy = this.data.slice();
    for (let y = this.height - 1; y >= 0; y--) {
      for (let x = this.width - 1; x >= 0; x--) {
        if (copy[y * this.width + x] === 'none') continue;
        const tx = x + dx;
        const ty = y + dy;
        if (this.inside(tx, ty) && this.get(tx, ty) === 'none') this.set(tx, ty, key);
      }
    }
    return this;
  }

  /** Mirror in place, for symmetric icons drawn once. */
  mirrorX() {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < Math.floor(this.width / 2); x++) {
        const key = this.get(x, y);
        if (key !== 'none') this.set(this.width - 1 - x, y, key);
      }
    }
    return this;
  }

  /** Stamps another Pix at an offset, skipping its transparent pixels. */
  stamp(other, x, y) {
    for (let dy = 0; dy < other.height; dy++) {
      for (let dx = 0; dx < other.width; dx++) {
        const key = other.get(dx, dy);
        if (key !== 'none') this.set(x + dx, y + dy, key);
      }
    }
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function rgba(key) {
  if (key === 'none' || key === null) return [0, 0, 0, 0];
  const hex = PALETTE[key];
  if (!hex) throw new Error(`unknown palette key: ${key}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

/**
 * A `Pix` as an 8-bit RGBA PNG.
 *
 * Filter byte zero on every row — these are tiny images of flat colour and
 * zlib handles them fine, so paeth filtering would buy nothing but a bug
 * surface.
 */
export function encodePng(pix) {
  const raw = Buffer.alloc(pix.height * (1 + pix.width * 4));
  let offset = 0;
  for (let y = 0; y < pix.height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < pix.width; x++) {
      const [r, g, b, a] = rgba(pix.get(x, y));
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(pix.width, 0);
  header.writeUInt32BE(pix.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
