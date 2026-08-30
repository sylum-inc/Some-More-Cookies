/**
 * A PNG encoder, in about a hundred lines.
 *
 * There are no binary assets in this repository and no image dependency
 * (ADR-0002), so every icon and launch image is drawn by `icon.ts` and written
 * out here. Colour type 2 — truecolour, no alpha — because every image this
 * product produces is opaque, and an `apple-touch-icon` with an alpha channel
 * is rejected by iOS.
 *
 * Deflate is passed in rather than imported. That keeps this file free of any
 * platform assumption, so the same encoder runs in the Vite build, in the
 * native-asset script, and in a browser test that wants to check its own
 * output — and it means the interesting part, the scanline filtering, is
 * testable without a Node runtime anywhere near it.
 */

import type { Bitmap } from './icon.js';

/** Compresses with zlib. `node:zlib`'s `deflateSync` satisfies this exactly. */
export type Deflate = (data: Uint8Array) => Uint8Array;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * Per-scanline filter selection: the standard minimum-sum-of-absolute-
 * differences heuristic over None, Sub and Up.
 *
 * Worth the twenty lines. Unfiltered, the launch images deflate to megabytes;
 * filtered they deflate to tens of kilobytes.
 */
export function filterScanlines(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap;
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < height; y += 1) {
    let identical = y > 0;
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const i = x * 3;
      const r = data[from] as number;
      const g = data[from + 1] as number;
      const b = data[from + 2] as number;
      if (identical && (previous[i] !== r || previous[i + 1] !== g || previous[i + 2] !== b)) {
        identical = false;
      }
      line[i] = r;
      line[i + 1] = g;
      line[i + 2] = b;
    }

    /*
     * A row identical to the one above filters to a run of zeroes under type 2.
     * Worth special-casing rather than discovering: these images are a small
     * picture upscaled with nearest-neighbour, so most rows *are* the one
     * above, and searching for the best filter on each of them is the whole
     * cost of generating the launch images.
     */
    if (identical) {
      raw[y * (stride + 1)] = 2;
      continue;
    }

    let best = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 3; type += 1) {
      const candidate = candidates[type] as Uint8Array;
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 3 ? (line[i - 3] as number) : 0;
        const b = previous[i] as number;
        const value =
          type === 0
            ? (line[i] as number)
            : type === 1
              ? ((line[i] as number) - a) & 0xff
              : ((line[i] as number) - b) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = type;
      }
    }

    raw[y * (stride + 1)] = best;
    raw.set(candidates[best] as Uint8Array, y * (stride + 1) + 1);
    previous.set(line);
  }
  return raw;
}

export function encodePng(bitmap: Bitmap, deflate: Deflate): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, bitmap.width);
  view.setUint32(4, bitmap.height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const idat = deflate(filterScanlines(bitmap));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
