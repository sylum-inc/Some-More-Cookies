/**
 * Pictures of sound.
 *
 * The engine has never been listened to and cannot be listened to from here,
 * so the next best thing is to make it *look* at. A spectrogram shows a
 * repeating column pattern, a hole in the low end, three layers stacked in the
 * same octave and a click at a buffer boundary, all of which are invisible in
 * a table of scalars.
 *
 * No image dependency and no font of its own, for the same reason
 * `tools/sprites/canvas.mjs` has neither: this repo already owns a PNG codec
 * and a 5x9 bitmap face, and adding a second of either to draw an axis label
 * is a bad trade. Both are injected rather than imported, because they live in
 * TypeScript (`e2e/strip.ts`, `apps/web/src/render/bitmapFont.ts`) and this
 * module is plain ESM so Node can unit-test it directly.
 *
 * Colours are a warm-to-cool ramp on a dark ground: this is a campfire game,
 * and a plot that looks like the thing it measures is easier to keep looking
 * at than a rainbow.
 */

/** An RGB24 image, the shape `e2e/strip.ts`'s `encodePng` takes. */
export function createImage(width, height, background = [10, 9, 12]) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = background[0];
    data[i * 3 + 1] = background[1];
    data[i * 3 + 2] = background[2];
  }
  return { width, height, data };
}

export function setPixel(image, x, y, rgb) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return;
  const at = (py * image.width + px) * 3;
  image.data[at] = rgb[0];
  image.data[at + 1] = rgb[1];
  image.data[at + 2] = rgb[2];
}

export function fillRect(image, x, y, w, h, rgb) {
  for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) setPixel(image, x + dx, y + dy, rgb);
}

export function drawLine(image, x0, y0, x1, y1, rgb) {
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
    setPixel(image, x, y, rgb);
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
}

/**
 * Text in the game's own 5x9 face.
 *
 * `glyphFor` is passed in from `apps/web/src/render/bitmapFont.ts`; the plots
 * are labelled in the same typeface the HUD uses, which costs nothing and
 * means an axis label and a subtitle are recognisably from one machine.
 */
export function drawText(image, glyphFor, text, x, y, rgb, scale = 1) {
  const CELL_WIDTH = 5;
  const CELL_HEIGHT = 9;
  let cursor = x;
  for (const character of text.toUpperCase()) {
    const glyph = glyphFor(character);
    for (let gy = 0; gy < CELL_HEIGHT; gy += 1) {
      for (let gx = 0; gx < CELL_WIDTH; gx += 1) {
        if (!glyph.bits[gy * CELL_WIDTH + gx]) continue;
        fillRect(image, cursor + gx * scale, y + gy * scale, scale, scale, rgb);
      }
    }
    cursor += (CELL_WIDTH + 1) * scale;
  }
  return cursor - x;
}

export function textWidth(text, scale = 1) {
  return text.length * 6 * scale;
}

/**
 * dB to colour: a black-red-amber-white ramp.
 *
 * Perceptually monotonic in lightness, which is what matters — the eye reads
 * "brighter is louder" from a greyscale ramp and reads nothing at all from a
 * hue rotation. The warm tint is decoration on top of that, not the signal.
 */
export function heat(db, floorDb = -85, ceilingDb = 0) {
  const t = Math.max(0, Math.min(1, (db - floorDb) / (ceilingDb - floorDb)));
  if (t < 0.35) {
    const u = t / 0.35;
    return [Math.round(10 + 150 * u), Math.round(9 + 20 * u), Math.round(12 + 45 * u)];
  }
  if (t < 0.7) {
    const u = (t - 0.35) / 0.35;
    return [Math.round(160 + 75 * u), Math.round(29 + 130 * u), Math.round(57 - 20 * u)];
  }
  const u = (t - 0.7) / 0.3;
  return [Math.round(235 + 20 * u), Math.round(159 + 96 * u), Math.round(37 + 210 * u)];
}

const AXIS = [96, 92, 100];
const GRID = [42, 40, 48];
const LABEL = [188, 182, 176];
const TITLE = [236, 214, 178];

const MARGIN_LEFT = 62;
const MARGIN_RIGHT = 16;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 30;

/** Nice round frequencies to label a log axis with. */
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

const formatHz = (hz) => (hz >= 1000 ? `${hz / 1000}K` : `${hz}`);

/**
 * A log-frequency, dB-scaled spectrogram with labelled axes.
 *
 * Log frequency is not a stylistic choice: on a linear axis the entire bottom
 * three octaves — everything this report has to say about whether the fire has
 * a low end — occupy the bottom 2 % of the picture and cannot be read at all.
 */
export function spectrogramImage(spec, options) {
  const {
    glyphFor,
    title = '',
    subtitle = '',
    width = 960,
    height = 420,
    minHz = 20,
    maxHz = Math.min(20000, (spec.bins - 1) * spec.binHz),
    floorDb = -85,
  } = options;

  const image = createImage(width, height);
  const plotX = MARGIN_LEFT;
  const plotY = MARGIN_TOP;
  const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
  const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
  const columns = spec.columns.length;
  if (columns === 0 || plotW <= 0 || plotH <= 0) return image;

  const logMin = Math.log(minHz);
  const logMax = Math.log(maxHz);
  // Row -> frequency, so every output row gets a value even where the FFT is
  // sparse (the bottom of a log axis) or dense (the top, where bins are
  // averaged rather than point-sampled and aliased).
  const rowHz = new Float64Array(plotH + 1);
  for (let row = 0; row <= plotH; row += 1) {
    rowHz[row] = Math.exp(logMax - ((logMax - logMin) * row) / plotH);
  }

  for (let px = 0; px < plotW; px += 1) {
    const from = Math.floor((px * columns) / plotW);
    const to = Math.max(from + 1, Math.floor(((px + 1) * columns) / plotW));
    for (let row = 0; row < plotH; row += 1) {
      const hiBin = Math.min(spec.bins - 1, Math.floor(rowHz[row] / spec.binHz));
      const loBin = Math.min(hiBin, Math.floor(rowHz[row + 1] / spec.binHz));
      let loudest = -200;
      for (let c = from; c < to && c < columns; c += 1) {
        const column = spec.columns[c];
        for (let bin = loBin; bin <= hiBin; bin += 1) {
          const value = column[bin];
          if (value > loudest) loudest = value;
        }
      }
      setPixel(image, plotX + px, plotY + row, heat(loudest, floorDb, 0));
    }
  }

  // --- axes ---------------------------------------------------------------
  for (const hz of FREQ_TICKS) {
    if (hz < minHz || hz > maxHz) continue;
    const row = Math.round((plotH * (logMax - Math.log(hz))) / (logMax - logMin));
    if (row < 0 || row > plotH) continue;
    for (let px = 0; px < plotW; px += 4) setPixel(image, plotX + px, plotY + row, GRID);
    drawLine(image, plotX - 4, plotY + row, plotX - 1, plotY + row, AXIS);
    const label = `${formatHz(hz)}HZ`;
    drawText(image, glyphFor, label, plotX - 8 - textWidth(label), plotY + row - 4, LABEL);
  }

  const seconds = columns * spec.hopSeconds;
  const step = seconds <= 6 ? 1 : seconds <= 20 ? 5 : 10;
  for (let t = 0; t <= seconds; t += step) {
    const px = Math.round((plotW * t) / seconds);
    if (px > plotW) break;
    drawLine(image, plotX + px, plotY + plotH, plotX + px, plotY + plotH + 3, AXIS);
    const label = `${t}S`;
    drawText(image, glyphFor, label, plotX + px - textWidth(label) / 2, plotY + plotH + 6, LABEL);
  }
  drawLine(image, plotX - 1, plotY, plotX - 1, plotY + plotH, AXIS);
  drawLine(image, plotX - 1, plotY + plotH, plotX + plotW, plotY + plotH, AXIS);

  if (title) drawText(image, glyphFor, title, plotX, 6, TITLE, 2);
  if (subtitle) drawText(image, glyphFor, subtitle, plotX, 26, LABEL);
  return image;
}

/**
 * RMS envelope over time, in dBFS, with the peak envelope behind it.
 *
 * Two traces rather than one because the gap between them *is* the crest
 * factor, drawn: a fire whose peak line sits well above its RMS line has
 * discrete crackles in it, and one whose two lines run parallel a few dB apart
 * is a noise band with a fade on it.
 */
export function envelopeImage(channels, sampleRate, options) {
  const {
    glyphFor,
    title = '',
    subtitle = '',
    width = 960,
    height = 300,
    floorDb = -72,
  } = options;

  const image = createImage(width, height);
  const plotX = MARGIN_LEFT;
  const plotY = MARGIN_TOP;
  const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
  const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
  const frames = channels[0].length;
  if (frames === 0 || plotW <= 0 || plotH <= 0) return image;

  const toRow = (db) => plotY + plotH - Math.round((plotH * (Math.max(db, floorDb) - floorDb)) / -floorDb);
  const toDb = (amplitude) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -200);

  for (const db of [0, -12, -24, -36, -48, -60]) {
    if (db < floorDb) continue;
    const row = toRow(db);
    for (let px = 0; px < plotW; px += 4) setPixel(image, plotX + px, row, GRID);
    const label = `${db}DB`;
    drawText(image, glyphFor, label, plotX - 8 - textWidth(label), row - 4, LABEL);
  }

  const rms = [];
  const peaks = [];
  for (let px = 0; px < plotW; px += 1) {
    const from = Math.floor((px * frames) / plotW);
    const to = Math.max(from + 1, Math.floor(((px + 1) * frames) / plotW));
    let sum = 0;
    let count = 0;
    let peak = 0;
    for (let i = from; i < to && i < frames; i += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      sum += mono * mono;
      count += 1;
      const magnitude = Math.abs(mono);
      if (magnitude > peak) peak = magnitude;
    }
    rms.push(count > 0 ? Math.sqrt(sum / count) : 0);
    peaks.push(peak);
  }

  for (let px = 1; px < plotW; px += 1) {
    drawLine(image, plotX + px - 1, toRow(toDb(peaks[px - 1])), plotX + px, toRow(toDb(peaks[px])), [120, 62, 40]);
  }
  for (let px = 1; px < plotW; px += 1) {
    drawLine(image, plotX + px - 1, toRow(toDb(rms[px - 1])), plotX + px, toRow(toDb(rms[px])), [246, 176, 66]);
  }

  const seconds = frames / sampleRate;
  const step = seconds <= 6 ? 1 : seconds <= 20 ? 5 : 10;
  for (let t = 0; t <= seconds; t += step) {
    const px = Math.round((plotW * t) / seconds);
    if (px > plotW) break;
    drawLine(image, plotX + px, plotY + plotH, plotX + px, plotY + plotH + 3, AXIS);
    const label = `${t}S`;
    drawText(image, glyphFor, label, plotX + px - textWidth(label) / 2, plotY + plotH + 6, LABEL);
  }
  drawLine(image, plotX - 1, plotY, plotX - 1, plotY + plotH, AXIS);
  drawLine(image, plotX - 1, plotY + plotH, plotX + plotW, plotY + plotH, AXIS);

  if (title) drawText(image, glyphFor, title, plotX, 6, TITLE, 2);
  drawText(image, glyphFor, subtitle || 'PEAK DARK, RMS BRIGHT', plotX, 26, LABEL);
  return image;
}

/* -------------------------------------------------------------------------- */
/* WAV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 16-bit PCM WAV, so a person can eventually put headphones on.
 *
 * This is the only artefact in the pipeline that answers the questions the
 * measurements cannot, which is why it is written even though nothing in this
 * process can play it.
 */
export function encodeWav(channels, sampleRate) {
  const count = channels.length;
  const frames = channels[0].length;
  const bytes = frames * count * 2;
  const buffer = Buffer.alloc(44 + bytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(count, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * count * 2, 28);
  buffer.writeUInt16LE(count * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(bytes, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < count; c += 1) {
      const value = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      // Asymmetric scaling: +1.0 must map to 32767, not wrap to -32768.
      buffer.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}
