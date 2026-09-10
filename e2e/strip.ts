import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/**
 * Motion, as a contact sheet.
 *
 * The art director grades PNGs, and a PNG cannot show a camera with a neck. So
 * every term this build spent a session on — the head trailing a turn on a
 * spring and coming back past where it stopped, the thing in the player's
 * hands lagging half a second behind their eyes, a flame bending with the
 * wind, lightning, water moving — was invisible to the only judgement being
 * applied to it. That is not "hard to grade": it is ungraded, which is worse,
 * because an ungraded thing looks exactly like a thing that was never built.
 *
 * The fix is the one animators have used since before any of this: lay the
 * frames out in a row and read them left to right. Eight frames across two
 * rows, each at a readable size, is enough to see a spring overshoot and
 * settle, a stride bob, or a gust arrive — and it is one file, which is what
 * a critic can actually look at.
 *
 * Deliberately in `e2e/` rather than `tools/`: it exists to serve the gallery,
 * which is a Playwright project, and the PNG codec here is a reader as well as
 * a writer, which the sprite pipeline's encoder is not.
 */

interface Rgb {
  readonly width: number;
  readonly height: number;
  /** Three bytes per pixel, row-major. */
  readonly data: Uint8Array;
}

/** Enough of a PNG reader for Playwright's own screenshots. */
export function decodePng(buffer: Buffer): Rgb {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const parts: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9]!;
    }
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? current[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;
      let value = line[i]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 3;
      out[to] = current[from]!;
      out[to + 1] = current[from + 1]!;
      out[to + 2] = current[from + 2]!;
    }
    previous = current;
  }
  return { width, height, data: out };
}

export function encodePng(image: Rgb): Buffer {
  const stride = image.width * 3;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const value of bytes) c = table[(c ^ value) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Box-filtered, not point-sampled.
 *
 * A dithered frame reduced by picking every Nth pixel keeps whichever half of
 * the Bayer cell it happened to land on, so the same picture comes out
 * lighter or darker depending only on the scale factor. Averaging the block is
 * both correct and what a person squinting at the screen actually sees.
 */
function shrink(image: Rgb, width: number, height: number): Rgb {
  const out = new Uint8Array(width * height * 3);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * image.width + xx) * 3;
          r += image.data[i]!;
          g += image.data[i + 1]!;
          b += image.data[i + 2]!;
          n += 1;
        }
      }
      const to = (y * width + x) * 3;
      out[to] = Math.round(r / n);
      out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n);
    }
  }
  return { width, height, data: out };
}

/** Frames laid out left to right, wrapping, with a hairline between them. */
function contactSheet(frames: readonly Rgb[], columns: number): Rgb {
  const cell = frames[0]!;
  const rows = Math.ceil(frames.length / columns);
  const gap = 2;
  const width = columns * cell.width + (columns - 1) * gap;
  const height = rows * cell.height + (rows - 1) * gap;
  const out = new Uint8Array(width * height * 3).fill(90);
  frames.forEach((frame, index) => {
    const ox = (index % columns) * (cell.width + gap);
    const oy = Math.floor(index / columns) * (cell.height + gap);
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const from = (y * frame.width + x) * 3;
        const to = ((oy + y) * width + ox + x) * 3;
        out[to] = frame.data[from]!;
        out[to + 1] = frame.data[from + 1]!;
        out[to + 2] = frame.data[from + 2]!;
      }
    }
  });
  return { width, height, data: out };
}

export interface StripOptions {
  /** How many frames. Eight across four columns reads as two lines of time. */
  readonly frames?: number;
  /** Milliseconds between frames. */
  readonly every?: number;
  /** Width of one frame in the sheet; the height follows the aspect. */
  readonly cell?: number;
  readonly columns?: number;
}

/**
 * Runs `drive`, then captures a run of frames and writes them as one sheet.
 *
 * `drive` is awaited *before* the first frame rather than between frames: the
 * interesting part of a spring is what it does after the input stops, and a
 * capture that keeps poking it measures the poke.
 */
export async function captureStrip(
  page: Page,
  path: string,
  drive: () => Promise<void>,
  options: StripOptions = {},
): Promise<void> {
  const count = options.frames ?? 8;
  const every = options.every ?? 90;
  const cell = options.cell ?? 640;
  const columns = options.columns ?? 4;

  await drive();
  const shots: Rgb[] = [];
  for (let i = 0; i < count; i += 1) {
    const buffer = await page.screenshot();
    const full = decodePng(buffer);
    shots.push(shrink(full, cell, Math.round((cell * full.height) / full.width)));
    if (i < count - 1) await page.waitForTimeout(every);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(contactSheet(shots, columns)));
}
