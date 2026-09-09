/**
 * Prints the overlays and looks at them.
 *
 * `tools/font/proof.mjs` opens with the argument and it is the same argument
 * here: a proof you have not looked at is not a proof. Every structural
 * property of the kit — that the layout never overflows, that the cut lands on
 * a line boundary, that every colour is on the palette — is asserted in
 * `apps/web/test/pixelPanel.test.ts`, and not one of those checks can tell you
 * that a bevel mitres the wrong way, that a stamp reads as a hoop, or that the
 * fade at a scroll cut is invisible. That last one has now shipped three times
 * and was found by a person opening a screenshot on all three.
 *
 *   node tools/pixel/proof.mjs             # sheets + terminal report
 *   node tools/pixel/proof.mjs --report    # terminal only, for iterating
 *
 * Each sheet is a real 320x240 frame with a world in it, because the charge
 * the kit answers is a charge about *contrast*: the panels did not look wrong
 * on their own, they looked wrong over a nearest-neighbour render. So the
 * campsite behind them is drawn first, in the sprite palette, out of the same
 * `Pix` the 88 icons are drawn with — and if a panel still reads as a second
 * product, this is where that shows.
 *
 * Node reads the TypeScript directly (type stripping, Node >= 22.18) so there
 * is no build step between editing the kit and seeing it. The one piece of
 * plumbing is the resolver hook below.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `./thing.js` means `./thing.ts` when only the second one exists.
 *
 * The repo compiles with `moduleResolution: bundler` and `verbatimModuleSyntax`,
 * so every relative import inside `apps/web/src` is written with a `.js`
 * extension that Vite and `tsc` both understand and bare Node does not. The
 * font proof never hit this because `bitmapFont.ts` imports nothing. The kit is
 * seven modules that import each other, so it does.
 *
 * A resolver hook rather than a build step: the whole value of these proofs is
 * that they rasterise the module the game ships, and anything that compiles a
 * copy first is proving something about the copy.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asJs = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(asJs))) {
        const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(asTs))) return next(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return next(specifier, context);
  },
});

const { PALETTE, Pix, encodePng } = await import('../sprites/canvas.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const kit = await import(join(ROOT, 'apps/web/src/ui/pixel/index.ts'));
const {
  PANEL_PALETTE,
  PANEL_INKS,
  colourDistance,
  parseHex,
  quantisePair,
  layoutPanel,
  focusTargets,
  intrinsicHeight,
  drawOverlay,
} = kit;

const { PINE_HOLLOW } = await import(join(ROOT, 'packages/content/src/environments/pine-hollow.ts'));
const { hasGlyph } = await import(join(ROOT, 'apps/web/src/render/bitmapFont.ts'));

/**
 * The panel palette, registered into the sprite encoder's table.
 *
 * `encodePng` is an *indexed* encoder: it walks a `Pix` of palette keys and
 * looks each one up in `PALETTE`. The overlay palette is not the sprite ramp
 * and must not become it — `styles.ts` owns those colours and the whole point
 * of `pixel/palette.ts` is that they arrive exact — so the eleven are added
 * under a `ui_` prefix for the length of this process. Prefixed rather than
 * bare because `ink` exists in both tables and means two different colours;
 * silently rebinding the sprite ramp's outline colour would repaint the
 * campsite behind the panel and the sheet would lie about the contrast it
 * exists to show.
 */
for (const key of PANEL_INKS) PALETTE[`ui_${key}`] = PANEL_PALETTE[key];

/** A `PanelSurface` that writes into a `Pix`. The whole coupling, in six lines. */
function pixSurface(pix) {
  return {
    width: pix.width,
    height: pix.height,
    fill(x, y, w, h, ink) {
      pix.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), `ui_${ink}`);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The world behind the page                                                  */
/* -------------------------------------------------------------------------- */

const WIDTH = 320;
const HEIGHT = 240;

/**
 * A campsite, roughly.
 *
 * Not the renderer — three.js in a build script would be absurd — but the same
 * palette, the same ordered dither and the same horizon-plus-fire composition
 * the real frame has, which is everything the sheet needs it for. The panel is
 * being judged against warm dithered dark with an amber source in it.
 */
function drawWorld(pix) {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const horizon = 132;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const threshold = bayer[y % 4][x % 4] / 16;
      if (y < horizon) {
        // Dusk rather than midnight. The first sheets used the darkest two
        // blues in the ramp and the scrim then had nothing to be transparent
        // *over* — which made the one thing this sheet exists to judge, how
        // much world survives an overlay, unjudgeable.
        const t = 1 - y / horizon;
        pix.set(x, y, t > threshold ? 'sky2' : 'sky3');
      } else {
        const t = (y - horizon) / (HEIGHT - horizon);
        pix.set(x, y, t > threshold ? 'wood2' : 'green2');
      }
    }
  }
  // A treeline: columns of dark green with dithered tops.
  for (let i = 0; i < 22; i++) {
    const x = (i * 37) % WIDTH;
    const height = 40 + ((i * 53) % 46);
    pix.rect(x, horizon - height, 3 + (i % 3), height, i % 2 === 0 ? 'green1' : 'green2');
  }
  // The fire, and the light it throws on the duff.
  // Off to one side and low, so it is beside the panel rather than under it:
  // a fire the page is covering proves nothing about the page.
  const fx = 34;
  const fy = 214;
  for (let r = 34; r > 0; r--) {
    const key = r > 26 ? 'wood2' : r > 18 ? 'ember1' : r > 11 ? 'ember2' : r > 6 ? 'ember3' : 'ember4';
    for (let y = fy - Math.round(r * 0.45); y <= fy + Math.round(r * 0.45); y++) {
      for (let x = fx - r; x <= fx + r; x++) {
        const nx = (x - fx) / r;
        const ny = (y - fy) / (r * 0.45);
        if (nx * nx + ny * ny > 1) continue;
        const threshold = bayer[((y % 4) + 4) % 4][((x % 4) + 4) % 4] / 16;
        if (r > 14 && threshold > 0.55) continue;
        pix.set(x, y, key);
      }
    }
  }
  return pix;
}

/* -------------------------------------------------------------------------- */
/* The three panels                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The Passport, with the game's own writing in it.
 *
 * Straight out of `packages/content` — Pine Hollow's arrival beat and what you
 * hear first — because lorem ipsum cannot tell you whether a five-pixel-wide
 * lowercase can carry an em dash and a subordinate clause, and this game's
 * prose is nothing but em dashes and subordinate clauses.
 */
function passportBlocks() {
  return [
    { kind: 'machine', id: 'kicker', text: 'Some More · Campground registration' },
    { kind: 'heading', id: 'title', level: 1, text: 'Campfire Passport' },
    { kind: 'body', id: 'issued', tone: 'soft', text: 'Ash Kimura · issued 12 May 2026' },
    { kind: 'rule', id: 'cover-rule', style: 'solid' },
    { kind: 'heading', id: 'stamps-label', level: 2, text: 'Stamps' },
    {
      kind: 'stamps',
      id: 'stamps',
      marks: [
        { id: 'first-fire', label: 'first fire' },
        { id: 'pine-hollow', label: 'pine hollow' },
        { id: 'night-walk', label: 'night walk' },
        { id: 'clear-sky', label: 'clear sky' },
      ],
    },
    { kind: 'heading', id: 'site-label', level: 2, text: 'This campsite' },
    { kind: 'body', id: 'arrival', text: PINE_HOLLOW.arrival.arrivalBeat },
    { kind: 'body', id: 'heard', tone: 'soft', text: PINE_HOLLOW.arrival.firstHeard },
    { kind: 'heading', id: 'record-label', level: 2, text: 'Record of sandwiches' },
    {
      kind: 'machine',
      id: 'provenance',
      text: 'CLASS  CLASSIC\nROAST  Even gold\nSTACK  Square\nUNIT   SM-01/4471\nCYCLE  SET · 52s',
    },
    { kind: 'rule', id: 'keep-rule', style: 'dashed' },
    { kind: 'heading', id: 'keep-label', level: 2, text: 'Keep this passport' },
    {
      kind: 'body',
      id: 'keep-body',
      tone: 'soft',
      text:
        'This passport lives on this device. Linking an account keeps everything in it — nothing is lost, and nothing changes about how you play.',
    },
    {
      kind: 'controls',
      id: 'link',
      controls: [
        { kind: 'button', id: 'link-apple', label: 'Apple' },
        { kind: 'button', id: 'link-google', label: 'Google' },
        { kind: 'button', id: 'link-email', label: 'Email' },
      ],
    },
  ];
}

/**
 * Settings, with the two rows the accessibility suite reads.
 *
 * "Text size" and "Fire brightness" are here with their real ranges because
 * they are the two that have been wrong three times: both run over a range
 * that does not start at zero, so the handle's position and the value it
 * stands for are different numbers. The readout is a string the caller has
 * already formatted and the fraction is the handle's position, which is the
 * whole reason this kit takes them as two separate arguments.
 */
function settingsBlocks() {
  const position = (value, min, max) => (value - min) / (max - min);
  return [
    { kind: 'heading', id: 'title', level: 1, text: 'Settings' },
    { kind: 'heading', id: 'picture', level: 2, text: 'Picture' },
    {
      kind: 'controls',
      id: 'picture-controls',
      controls: [
        {
          kind: 'slider',
          id: 'fire-brightness',
          label: 'Fire brightness',
          readout: '100% of normal',
          fraction: position(1, 0.35, 1.5),
        },
        { kind: 'slider', id: 'dither', label: 'Dithering', readout: '100%', fraction: 1 },
        {
          /*
           * The readout is `sliderReadout()`'s real output — "×1.00" — and it
           * is here because this sheet is where the problem with it showed.
           * There was no U+00D7 in the font, so the panel drew the hollow box
           * `bitmapFont.ts` reserves for a glyph nobody has authored: a
           * multiplier printed as a missing character, caught here rather than
           * by a player. The conversion resolved it in the font — that readout
           * took three rounds of art grading and was not going to lose to a
           * missing glyph — and the row stays on the sheet so the mark is
           * looked at every run rather than assumed.
           */
          kind: 'slider',
          id: 'text-size',
          label: 'Text size',
          hint: 'Bitmap type has two sizes. The rest of this dial buys leading and measure.',
          readout: '×1.00',
          fraction: position(1, 0.85, 1.8),
        },
      ],
    },
    { kind: 'heading', id: 'comfort', level: 2, text: 'Comfort' },
    {
      kind: 'controls',
      id: 'comfort-controls',
      controls: [
        {
          kind: 'checkbox',
          id: 'simplified-gestures',
          label: 'Simplified gestures',
          hint: 'Tend the fire with controls instead of reaching for it.',
          checked: true,
        },
        {
          kind: 'checkbox',
          id: 'virtual-joystick',
          label: 'Walk with a joystick',
          checked: false,
        },
        { kind: 'checkbox', id: 'reduce-motion', label: 'Reduce camera motion', checked: false },
      ],
    },
    { kind: 'rule', id: 'keys-rule', style: 'hair' },
    { kind: 'heading', id: 'keys', level: 2, text: 'Keys' },
    {
      kind: 'machine',
      id: 'keys-list',
      text: 'SM-01: load, door, latch\nAssemble: pick up, set down',
    },
    {
      kind: 'controls',
      id: 'close',
      controls: [{ kind: 'button', id: 'close', label: 'Close' }],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Sheets                                                                     */
/* -------------------------------------------------------------------------- */

function frame(blocks, rect, options = {}) {
  const pix = new Pix(WIDTH, HEIGHT);
  drawWorld(pix);
  const layout = layoutPanel({ rect, blocks, scale: options.scale ?? 1, scrollTop: options.scrollTop ?? 0 });
  drawOverlay(pixSurface(pix), { x: 0, y: 0, width: WIDTH, height: HEIGHT }, layout, {
    focusedId: options.focusedId ?? null,
  });
  return { pix, layout };
}

/** Nearest neighbour, because looking at pixel art through a smoothed zoom is looking at a lie. */
function magnify(pix, factor) {
  const big = new Pix(pix.width * factor, pix.height * factor);
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      const key = pix.get(x, y);
      if (key !== 'none') big.rect(x * factor, y * factor, factor, factor, key);
    }
  }
  return big;
}

/** A region of a `Pix` as characters, for reading a bevel in a terminal. */
function chart(pix, x, y, w, h) {
  const glyph = {
    ui_ink: '#',
    ui_inkSoft: '+',
    ui_paper: '.',
    ui_paperLit: '"',
    ui_paperEdge: ':',
    ui_paperShade: '-',
    ui_stamp: 'S',
    ui_amber: 'A',
    ui_night: ' ',
  };
  const rows = [];
  for (let py = y; py < y + h; py++) {
    let row = '';
    for (let px = x; px < x + w; px++) {
      const key = pix.get(px, py);
      row += glyph[key] ?? (key === 'none' ? ' ' : '?');
    }
    rows.push(row);
  }
  return rows.join('\n');
}

const reportOnly = process.argv.includes('--report');
const out = join(ROOT, 'artifacts', 'pixel');

const sheets = [];

// 1. The Passport, tall, with the page scrolled to the top.
{
  const rect = { x: 12, y: 8, width: 296, height: 224 };
  const { pix, layout } = frame(passportBlocks(), rect);
  sheets.push({ name: 'passport', pix, layout, blocks: passportBlocks() });
}

// 2. Settings, with a control focused, because the ring is the one thing on
//    these panels that has no CSS ancestor at all.
{
  const rect = { x: 20, y: 10, width: 280, height: 220 };
  const { pix, layout } = frame(settingsBlocks(), rect, { focusedId: 'text-size' });
  sheets.push({ name: 'settings', pix, layout, blocks: settingsBlocks() });
}

// 3. A short panel with a long page in it, scrolled into the middle. This is
//    the sheet the cut is on, and the one three art grades would have needed.
const SCROLLED = { x: 24, y: 52, width: 272, height: 136 };
{
  const { pix, layout } = frame(passportBlocks(), SCROLLED, { scrollTop: 96 });
  sheets.push({ name: 'scrolled', pix, layout, blocks: passportBlocks() });
}

// 4. The same panel at the end of its scroll, with a button focused. Two
//    things are being proved here and both were bugs. The end of a long page
//    has to be *reachable* — snapping the offset down to a line boundary
//    quietly made the last block of every long panel unreachable, and the last
//    block of the Passport is the three account-linking buttons. And once you
//    are at the end the mark has to be gone, because a permanent mark on a
//    page with nothing below it is the same lie in the other direction.
{
  const { pix, layout } = frame(passportBlocks(), SCROLLED, {
    scrollTop: 10_000,
    focusedId: 'link-google',
  });
  sheets.push({ name: 'end', pix, layout, blocks: passportBlocks() });
}

/* -------------------------------------------------------------------------- */
/* The terminal report                                                        */
/* -------------------------------------------------------------------------- */

const lines = [];
lines.push('PANEL PALETTE, AND ITS DISTANCE FROM THE WORLD RAMP');
lines.push('');
const spriteKeys = Object.keys(PALETTE).filter((k) => k !== 'none' && !k.startsWith('ui_'));
for (const ink of PANEL_INKS) {
  const hex = PANEL_PALETTE[ink];
  const target = parseHex(hex);
  let best = null;
  for (const key of spriteKeys) {
    const distance = colourDistance(target, parseHex(PALETTE[key]));
    if (best === null || distance < best.distance) best = { key, distance };
  }
  lines.push(`  ${ink.padEnd(11)} ${hex}   nearest sprite ramp: ${best.key.padEnd(8)} ${best.distance.toFixed(0)}`);
}
lines.push('');
lines.push('  A colour a caller might still be holding, quantised to a dither pair:');
for (const hex of ['#efe8d7', '#c6b696', '#3a332b']) {
  const pair = quantisePair(hex);
  lines.push(`    ${hex} -> ${pair.from} + ${pair.to} at ${Math.round(pair.amount * 16)}/16 (off by ${pair.distance.toFixed(0)})`);
}

for (const sheet of sheets) {
  const { layout } = sheet;
  const measure = layout.content.width;
  lines.push('');
  lines.push(`${sheet.name.toUpperCase()}  panel ${layout.panel.width}x${layout.panel.height}, measure ${measure}px`);
  lines.push(`  content        ${layout.contentHeight}px into ${layout.content.height}px${layout.overflow ? ' — overflows' : ''}`);
  lines.push(`  wants a panel  ${intrinsicHeight({ rect: layout.panel, blocks: sheet.blocks })}px tall to hold it all`);
  lines.push(`  scroll         asked ${layout.scroll.requested}, snapped to ${layout.scroll.top}, max ${layout.scroll.max}`);
  if (layout.cut) {
    lines.push(`  cut            row ${layout.cut.y} (${layout.cut.y - layout.content.y} into the page), mark ${layout.cut.mark.height}px deep`);
    lines.push(`  below the cut  ${layout.cut.below.join(', ') || 'nothing'}`);
  } else {
    lines.push(`  cut            none — ${layout.overflow ? 'this is the end of the page' : 'it all fits'}`);
  }
  const targets = focusTargets(layout);
  lines.push(`  focus targets  ${targets.length} (${targets.filter((t) => t.visible).length} on the page)`);
  for (const target of targets) {
    lines.push(
      `    ${target.visible ? ' ' : '~'} ${target.role.padEnd(8)} ${target.id.padEnd(20)} ` +
        `${target.control.width}x${target.control.height} at ${target.control.x},${target.control.y}  "${target.label}"`,
    );
  }
  const widest = Math.max(
    0,
    ...layout.blocks.flatMap((b) => b.lines.map((l) => l.rect.x + l.rect.width - layout.content.x)),
  );
  lines.push(`  widest line    ${widest}px of ${measure}px`);
}

/*
 * Everything on these sheets the font cannot draw.
 *
 * A missing glyph is drawn as a hollow box on purpose — `bitmapFont.ts` argues
 * that missing type should look missing — but a hollow box is only useful to
 * somebody who is looking, and the conversion will be moving thousands of
 * characters of shipped copy into this font at once. So the sheets are read
 * back for characters that have no glyph, and the list is the conversion's
 * to-do rather than something a player finds.
 */
lines.push('');
lines.push('CHARACTERS ON THESE SHEETS THE FONT CANNOT DRAW');
{
  const seen = new Map();
  const walk = (block) => {
    const texts = [];
    if (typeof block.text === 'string') texts.push(block.text);
    for (const mark of block.marks ?? []) texts.push(mark.label);
    for (const control of block.controls ?? []) {
      texts.push(control.label);
      if (control.hint) texts.push(control.hint);
      if (control.readout) texts.push(control.readout);
    }
    for (const text of texts) {
      for (const character of text) {
        if (character === '\n' || hasGlyph(character)) continue;
        const point = character.codePointAt(0).toString(16).padStart(4, '0');
        seen.set(character, `U+${point.toUpperCase()}`);
      }
    }
  };
  for (const block of [...passportBlocks(), ...settingsBlocks()]) walk(block);
  if (seen.size === 0) lines.push('  none');
  for (const [character, point] of seen) {
    lines.push(`  ${point}  "${character}"  — drawn as the hollow missing-glyph box`);
  }
}

lines.push('');
lines.push('THE TOP-LEFT CORNER OF THE PASSPORT — the mitre is the diagonal');
lines.push(chart(sheets[0].pix, 12, 8, 26, 10));
lines.push('');
lines.push('THE TOP-RIGHT CORNER — a lit band handing over to a shaded one');
lines.push(chart(sheets[0].pix, 12 + 296 - 26, 8, 26, 10));
lines.push('');
lines.push('THE CUT ON THE SCROLLED PANEL — the last line clear, then the mark');
{
  const layout = sheets[2].layout;
  // From the last line of type down to the page's bottom edge, so both halves
  // of the invariant are in one picture: the line finishes, and the mark is
  // somewhere else.
  const from = layout.cut.y - 11;
  lines.push(chart(sheets[2].pix, layout.content.x, from, 72, layout.content.y + layout.content.height - from));
}
lines.push('');
lines.push('A STAMP, WHOLE — broken ring, mottled ink, stepped label');
lines.push(chart(sheets[0].pix, sheets[0].layout.blocks.find((b) => b.kind === 'stamps').marks[0].rect.x, sheets[0].layout.blocks.find((b) => b.kind === 'stamps').marks[0].rect.y, 40, 40));

// eslint-disable-next-line no-console
console.log(lines.join('\n'));

if (!reportOnly) {
  mkdirSync(out, { recursive: true });
  for (const sheet of sheets) {
    writeFileSync(join(out, `${sheet.name}.png`), encodePng(sheet.pix));
    writeFileSync(join(out, `${sheet.name}-3x.png`), encodePng(magnify(sheet.pix, 3)));
  }
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${sheets.length * 2} sheets to artifacts/pixel/ at 1x and 3x`);
}
