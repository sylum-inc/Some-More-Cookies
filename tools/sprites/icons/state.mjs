/**
 * state — small glyphs for what the world is currently doing.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`. A 24x24 box centred in a 32x32 cell, light from the
 * upper left, four values per material, `outline()` last, and never a letter
 * or a digit.
 *
 * These are STATE, not score. There is no bar, no pip and no meter anywhere in
 * this file, because a row of segments is a number wearing a costume and this
 * game shows a player no numbers. Each glyph says what the world IS by being a
 * different picture, not by being more or less full.
 *
 * Three shared vocabularies, so the fourteen read as one set:
 *
 *   fire     the same bed and the same two charred logs in every one of the
 *            four, in the same ramp, so the log ends read as wood in all of
 *            them. The progression is height and heat: a cold grey mound with
 *            a curl of smoke, a lumpy bed of coals, one leaning tongue, a
 *            three-tipped column. Every step changes the SILHOUETTE, not just
 *            the hue — squinted at in a row it should look like a fire being
 *            lit even with the colour switched off.
 *   weather  the same cloud, at the same height, in the same place, with
 *            something different happening under it — except clear, which is
 *            the cloud's absence and so is the sun alone with its rays. That
 *            sun is the same sun the day icon uses: one sun exists in this set.
 *   time     the same shallow ridge of ground along the bottom of all four,
 *            with one body in the sky. Height is the hour. Dawn is a pale
 *            hemisphere cut by the horizon with flat rays lying on the ground;
 *            dusk is a deep low cap with no rays and the first stars out — the
 *            two halves of the day are different pictures, not mirror images.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `dither()` that respects a silhouette — it only recolours pixels that are
 * already drawn, so texture never leaks past an edge where `outline()` cannot
 * rescue it.
 */
function ditherIn(pix, x, y, w, h, key, phase = 0, over = null) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if ((x + dx + y + dy + phase) % 2 !== 0) continue;
      const current = pix.get(x + dx, y + dy);
      if (current === "none") continue;
      if (over && !over.includes(current)) continue;
      pix.set(x + dx, y + dy, key);
    }
  }
}

/**
 * Lights the top edge of a mass and shades its bottom edge, column by column.
 *
 * A blob of one colour is a hole; the same blob with a lit crown and a dark
 * underside is a solid thing lit from above. Restricted to `bodyKeys` so it
 * only touches the mass it was aimed at, and to a box so the caller can light
 * the left of a shape and shade the right of it — the upper-left bias every
 * icon in the set agrees about.
 */
function rimLight(pix, box, bodyKeys, lightKey, darkKey) {
  const [x0, y0, w, h] = box;
  for (let x = x0; x < x0 + w; x++) {
    let first = -1;
    let last = -1;
    for (let y = y0; y < y0 + h; y++) {
      if (!bodyKeys.includes(pix.get(x, y))) continue;
      if (first < 0) first = y;
      last = y;
    }
    if (first < 0) continue;
    if (lightKey) pix.set(x, first, lightKey);
    if (darkKey && last > first) pix.set(x, last, darkKey);
  }
}

/** Fills a list of [y, x0, x1] spans. Hand-authored shapes, one row at a time. */
function spans(pix, rows, key) {
  for (const [y, x0, x1] of rows) pix.line(x0, y, x1, y, key);
}

/* -------------------------------------------------------------------------- */
/* Fire                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Two stubby logs crossed under the bed, their ends poking out either side.
 * Called with the same three keys in all four fire states, so the log ends
 * read as wood whether the fire is roaring or stone cold.
 */
function logs(pix, dark, body, light) {
  pix.line(5, 26, 13, 22, body);
  pix.line(5, 27, 13, 23, dark);
  pix.line(5, 25, 12, 21, light);

  pix.line(27, 25, 19, 22, body);
  pix.line(27, 26, 19, 23, dark);
  pix.line(26, 24, 19, 21, light);
}

/** The mound the fire sits in. Same shape whatever it is made of. */
function bed(pix, dark, body) {
  pix.disc(16, 24, 9, 3.4, dark);
  pix.disc(16, 23.6, 7, 2.5, body);
}

/**
 * A tongue of flame: one pixel at the tip, widest around a third of the way
 * down, pinched at the waist and drawing back in again at the base, leaning as
 * it climbs. The waist is the whole trick — a shape that only widens on the
 * way down is a cone, and a cone on a log pile reads as a mountain — so the
 * caller can deepen it by hand, because at eleven rows the smooth taper alone
 * quantises to a straight-sided ramp. `hook` bends the last two rows sideways
 * so the top is a lick rather than an apex.
 */
function flame(pix, cx, topY, baseY, maxW, lean, key, opts = {}) {
  const { waist = 0, hook = 0 } = opts;
  const height = Math.max(1, baseY - topY);
  for (let y = topY; y <= baseY; y++) {
    const t = (y - topY) / height;
    const pinch = 1 - waist * Math.exp(-Math.pow((t - 0.55) / 0.18, 2));
    const halfWidth = maxW * Math.sin(Math.PI * 0.8 * Math.pow(t, 0.62)) * pinch;
    const x = cx + lean * (1 - t) * (1 - t);
    pix.line(Math.round(x - halfWidth), y, Math.round(x + halfWidth), y, key);
  }
  if (hook) {
    const tipX = Math.round(cx + lean);
    pix.set(tipX + hook, topY, key);
    pix.set(tipX + hook, topY + 1, key);
  }
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

/** Where the family's cloud sits. All five weather icons stage it here. */
const CLOUD_Y = 12;

/** The cloud. Three bumps and a flat base, in whatever ramp the sky is in. */
function cloud(pix, cy, dark, body, light) {
  pix.disc(11, cy + 1, 4.6, 3.6, body);
  pix.disc(17, cy - 2, 5.4, 4.4, body);
  pix.disc(23, cy + 1, 4.2, 3.2, body);
  pix.rect(7, cy, 17, 4, body);
  // Lit on the left, and only on the left: the right shoulder keeps the body
  // value so the cloud agrees with the light the rest of the set uses.
  rimLight(pix, [4, cy - 8, 17, 14], [body], light, dark);
  rimLight(pix, [21, cy - 8, 7, 14], [body], null, dark);
  ditherIn(pix, 6, cy + 2, 20, 3, dark, 1, [body]);
}

/** The sun's disc, warm and lit from the upper left. */
function sun(pix, cx, cy, r, dark, body, light) {
  pix.disc(cx, cy, r, r, body);
  pix.disc(cx - r * 0.3, cy - r * 0.3, r * 0.45, r * 0.45, light);
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    if (Math.cos(t) - Math.sin(t) < 0.2) {
      pix.set(
        Math.round(cx + Math.cos(t) * (r - 0.4)),
        Math.round(cy + Math.sin(t) * (r - 0.4)),
        dark,
      );
    }
  }
}

/**
 * Eight spokes standing off the disc. The same set for clear and for day —
 * `maxY` is the only difference between them, because the day sun has ground
 * under it and a ray that reaches the ridge welds the sun to it.
 */
function sunRays(pix, cx, cy, inner, outer, key, maxY = Infinity) {
  for (let a = 0; a < 8; a++) {
    const t = (a / 8) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const y0 = Math.min(maxY, cy + s * inner);
    const y1 = Math.min(maxY, cy + s * outer);
    pix.line(cx + c * inner, y0, cx + c * outer, y1, key);
  }
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** Per-column wander, so the crest of the ridge is land and not a machined lip. */
const CREST_WOBBLE = [
  0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, 0,
];

/**
 * The horizon: a shallow arc of ground along the very bottom, the same in all
 * four time icons. Shallow on purpose — the sky is the subject and the ground
 * is the baseline it is measured against, so the ridge shows a crest and no
 * more. Returns the crest height per column, which is the line dawn's sun is
 * cut by and dusk's sun sinks behind.
 */
function horizon(pix) {
  const tops = [];
  for (let x = 3; x <= 28; x++) {
    const t = (x - 15) / 13;
    const top = Math.min(27, Math.round(25 + 2.2 * t * t) + CREST_WOBBLE[x - 3]);
    tops[x] = top;
    for (let y = top; y <= 27; y++) pix.set(x, y, "stone2");
  }
  for (let x = 3; x <= 28; x++) {
    // Light from the upper left: the left of the crest catches it, the right
    // shoulder falls away.
    if (x < 15) pix.set(x, tops[x], "stone3");
    else if (x > 19) pix.set(x, tops[x], "stone1");
    // One row of dither under the crest and no more — three rows of checker at
    // this size is texture noise rather than form.
    const y = tops[x] + 1;
    if (y <= 27 && (x + y) % 2 === 0) pix.set(x, y, "stone1");
  }
  return tops;
}

/**
 * A star: one bright pixel with a dimmer cross, so it twinkles rather than
 * blobs. Deliberately thin — snow is drawn as solid clumps of falling matter
 * so that "night" and "snowing" never share a mark.
 */
function star(pix, x, y, big = false) {
  pix.set(x, y, "cream4");
  if (!big) return;
  pix.set(x - 1, y, "cream3");
  pix.set(x + 1, y, "cream3");
  pix.set(x, y - 1, "cream3");
  pix.set(x, y + 1, "cream3");
}

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Dead. Grey ash, cold charcoal, and one curl of smoke going up: the
    // dimmest icon of the four, and the only one with nothing hot in it.
    name: "state-fire-out",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "stone1", "stone2");
      // The crown catches what light there is; the rest of the mound does not.
      ditherIn(pix, 8, 20, 9, 3, "stone3", 0, ["stone2"]);
      rimLight(pix, [5, 19, 11, 9], ["stone1", "stone2", "stone3"], "stone3", "stone1");
      rimLight(pix, [16, 19, 12, 9], ["stone1", "stone2", "stone3"], "stone2", "stone1");

      // Cold chunks of charcoal sitting in the ash, flush with the mound so
      // the silhouette stays a smooth dome — the flat state of the four.
      pix.set(13, 22, "ink3");
      pix.set(14, 22, "ink3");
      pix.set(19, 23, "ink3");
      pix.set(10, 24, "ink3");

      // One curl of smoke: a ribbon that leans left, then right, then left
      // again. Not a stick — a straight diagonal here reads as a half-burnt
      // branch and turns the whole icon into a frying pan.
      const curl = [
        [21, 15, 16],
        [20, 14, 15],
        [19, 13, 14],
        [18, 13, 14],
        [17, 14, 15],
        [16, 15, 16],
        [15, 16, 17],
        [14, 16, 17],
        [13, 15, 16],
        [12, 15, 15],
      ];
      spans(pix, curl, "stone3");
      for (const [y, x0, x1] of curl) if (x1 > x0) pix.set(x1, y, "stone2");

      pix.outline();
    },
  },

  {
    // Coals. A lumpy bed of dull red under a grey crust, with lumps of
    // charcoal standing proud of the mound and one small tongue clearing it —
    // so "out" and "embers" differ as cut-outs, not only as colours.
    name: "state-fire-embers",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember2");
      ditherIn(pix, 8, 21, 16, 5, "ember3", 0, ["ember2"]);
      pix.disc(15, 23, 3.4, 1.6, "ember3");

      // Charcoal standing proud of the mound: three lumps at three heights, so
      // the top edge is bumpy here and a smooth dome in "out". That is the
      // whole difference between the two with the colour switched off.
      const lumps = [
        [9, 20, 4, 3],
        [14, 19, 4, 3],
        [19, 20, 4, 3],
        [12, 21, 2, 2],
      ];
      for (const [x, y, w, h] of lumps) {
        pix.rect(x, y, w, h, "ink3");
        pix.set(x, y, "ink2");
        pix.set(x + w - 1, y + h - 1, "ink");
      }

      // One short tongue licking clear of the charcoal.
      flame(pix, 16.5, 15, 21, 1.1, 0.6, "ember3", { hook: 1 });
      pix.set(17, 16, "ember4");
      pix.set(17, 17, "ember4");

      // The grey crust an ember bed wears until you poke it.
      ditherIn(pix, 8, 21, 16, 3, "stone2", 1, ["ember2"]);
      rimLight(pix, [5, 20, 11, 8], ["ember1", "ember2", "ember3"], "ember3", "ember1");
      rimLight(pix, [16, 20, 12, 8], ["ember1", "ember2", "ember3"], "ember2", "ember1");
      pix.outline();
    },
  },

  {
    // Low. Live coals and one leaning tongue with a pinched waist, plus a
    // second tongue set far enough away that clear background runs between
    // them: two licks, not one peak.
    name: "state-fire-low",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember2");
      ditherIn(pix, 8, 21, 16, 5, "ember3", 0, ["ember2"]);
      pix.disc(14, 23, 3.2, 1.4, "ember3");
      pix.set(13, 23, "ember4");
      pix.set(14, 23, "ember4");

      flame(pix, 14, 12, 22, 2.3, 1.7, "ember2", { waist: 0.45, hook: 1 });
      flame(pix, 14.1, 15, 21, 1.4, 1.2, "ember3", { waist: 0.35 });
      flame(pix, 14.2, 18, 20, 0.7, 0.6, "ember4");

      flame(pix, 22.5, 18, 23, 1.1, -1.2, "ember2", { waist: 0.3, hook: -1 });
      flame(pix, 22.4, 20, 22, 0.6, -0.6, "ember3");
      pix.outline();
    },
  },

  {
    // Good. A tall column with two shorter tongues flanking it, background
    // running between all three, so the top edge is three tips rather than one
    // arch. Four ember values and nothing paler: the core is ember4 dithered
    // into ember3, not a fifth colour.
    name: "state-fire-good",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember2");

      flame(pix, 7.5, 14, 23, 1.1, 1.4, "ember2", { waist: 0.3, hook: 1 });
      flame(pix, 24.5, 12, 23, 1.1, -1.4, "ember2", { waist: 0.3, hook: -1 });
      flame(pix, 16, 6, 22, 3.4, 1.6, "ember2", { waist: 0.3, hook: 1 });

      flame(pix, 7.7, 17, 22, 0.7, 1.2, "ember3");
      flame(pix, 24.3, 15, 22, 0.7, -1.2, "ember3");
      flame(pix, 16, 9, 21, 2.3, 1.2, "ember3", { waist: 0.28 });
      flame(pix, 15.8, 13, 20, 1.2, 0.8, "ember4");
      ditherIn(pix, 12, 12, 8, 9, "ember4", 0, ["ember3"]);

      pix.disc(16, 23.6, 6, 2.2, "ember3");
      ditherIn(pix, 10, 22, 13, 4, "ember4", 0, ["ember3"]);
      rimLight(pix, [5, 20, 22, 8], ["ember1"], null, "ember1");
      pix.outline();
    },
  },

  {
    // Clear. No cloud in the cell at all: the sun on its own, with rays.
    name: "state-weather-clear",
    draw(pix) {
      sunRays(pix, 16, 16, 8, 10, "ember4");
      sun(pix, 16, 16, 6, "ember2", "ember3", "ember4");
      pix.outline();
    },
  },

  {
    // High cloud. The family's cloud in the family's place, with the sun still
    // getting past it — this is the sky you can see blue through.
    name: "state-weather-cloud",
    draw(pix) {
      sun(pix, 21, 11, 5, "ember2", "ember3", "ember4");
      cloud(pix, CLOUD_Y, "stone2", "stone3", "stone4");
      pix.outline();
    },
  },

  {
    /*
     * Overcast, which is a lid rather than a cloud.
     *
     * This used to share a drawing with high cloud, so two of the nine skies
     * the world can produce were one glyph — and an art review measured the
     * two frames as differing by 1.5 of 255, which means the icon was the only
     * thing that could have told them apart and it did not. The difference in
     * life is not that overcast cloud is darker; it is that there is no edge
     * to it and no sky behind it. So: no gaps, no sun, a flat unbroken deck
     * filling the cell's width, and the ramp running the wrong way — light at
     * the bottom, where the ground bounces back into it.
     */
    name: "state-weather-overcast",
    draw(pix) {
      /*
       * Two decks, one behind the other, filling the cell edge to edge.
       *
       * The first attempt at this was a dark trapezoid, which read as a black
       * rectangle rather than as weather — the mistake being to draw overcast
       * as *dark* when what it actually is, is *unbroken*. So the values stay
       * in the middle of the stone ramp where the other clouds live, and what
       * says overcast is that there is no gap anywhere and no edge to the
       * whole thing: it leaves the cell on both sides.
       */
      // The upper deck, receding.
      pix.rect(3, 9, 26, 5, "stone2");
      pix.disc(9, 9, 6, 3, "stone3");
      pix.disc(19, 9, 7, 3, "stone3");
      pix.disc(26, 10, 5, 3, "stone2");
      // The lower one, nearer and heavier, hanging under it.
      pix.rect(3, 14, 26, 6, "stone3");
      pix.disc(8, 20, 7, 3.5, "stone3");
      pix.disc(18, 20, 8, 3.5, "stone3");
      pix.disc(26, 19, 5, 3, "stone2");
      // The underside, where the ground bounces light back into it. Lighter at
      // the bottom, which is the ramp running the opposite way to a fair-
      // weather cloud and is most of what says "lid".
      pix.rect(5, 21, 22, 2, "stone4");
      pix.dither(5, 19, 22, 3, "stone2", 0);
      pix.outline();
    },
  },

  {
    /*
     * Wind, which had no glyph at all and was borrowing the clear sky's sun.
     *
     * Wind is the one weather with nothing in the air to draw, so it is drawn
     * as what it does: three streaks bending round something, and a bough bent
     * with them. Bent rather than straight — a straight streak is speed and a
     * curved one is pressure, and it is pressure that puts a fire out.
     */
    name: "state-weather-wind",
    draw(pix) {
      // The bough, leaning hard.
      pix.line(7, 27, 13, 15, "wood2");
      pix.line(8, 27, 14, 15, "wood1");
      pix.poly([[13, 16], [22, 12], [26, 15], [17, 19]], "green2");
      pix.poly([[13, 16], [20, 13], [24, 15], [16, 18]], "green3");
      // Three gusts, each hooking over at its end.
      for (const [y, x0, x1] of [[7, 5, 22], [11, 8, 26], [24, 4, 18]]) {
        pix.line(x0, y, x1, y, "stone4");
        pix.line(x1, y, x1 + 2, y + 2, "stone4");
        pix.set(x1 + 2, y + 3, "stone3");
      }
      pix.outline();
    },
  },

  {
    // Rain. The cloud, and three streaks of falling water clear of its
    // underside — lit down their left edges, and of three different lengths.
    name: "state-weather-rain",
    draw(pix) {
      cloud(pix, CLOUD_Y, "stone2", "stone3", "stone4");
      const drops = [
        [10, 20, 8, 25],
        [16, 20, 15, 23],
        [21, 21, 20, 26],
      ];
      for (const [x0, y0, x1, y1] of drops) {
        pix.line(x0, y0, x1, y1, "sky4");
        pix.line(x0 + 1, y0, x1 + 1, y1, "sky3");
      }
      pix.outline();
    },
  },

  {
    // Snow. The cloud, and flakes drifting under it. Solid clumps, because
    // snow is falling matter — the thin cream cross belongs to the stars.
    name: "state-weather-snow",
    draw(pix) {
      cloud(pix, CLOUD_Y, "stone2", "stone3", "stone4");
      const flakes = [
        [9, 21],
        [20, 20],
        [14, 25],
        [24, 24],
      ];
      for (const [x, y] of flakes) {
        pix.rect(x, y, 2, 2, "cream3");
        pix.set(x, y, "cream4");
        pix.set(x + 1, y + 1, "cream2");
      }
      pix.outline();
    },
  },

  {
    // Storm. The darker cloud, and a bolt that starts clear of it and turns
    // twice, with the notches deep enough to survive the outline.
    name: "state-weather-storm",
    draw(pix) {
      cloud(pix, CLOUD_Y, "stone1", "stone2", "stone3");
      const bolt = [
        [20, 18, 21],
        [21, 17, 20],
        [22, 16, 19],
        [23, 15, 18],
        [24, 17, 21],
        [25, 16, 20],
        [26, 15, 18],
        [27, 14, 16],
      ];
      spans(pix, bolt, "ember3");
      for (const [y, x0, x1] of bolt) {
        pix.set(x0, y, "ember4");
        pix.set(x1, y, "ember2");
      }
      pix.outline();
    },
  },

  {
    // Fog. The family's cloud come down to the ground: one soft bank with a
    // bumpy crown that the cloud's underside dissolves into, so this is a
    // single object — cloud sinking into ground — and not a stack of bars.
    name: "state-weather-fog",
    draw(pix) {
      cloud(pix, CLOUD_Y, "stone2", "stone3", "stone4");
      // One low bank, wider than the cloud and softer than it: a single mass
      // with a rolling top edge, lit along its crown like everything else in
      // the set. Not bars — three bars at this size is a barcode.
      const bankTop = [
        24, 23, 22, 21, 21, 22, 23, 22, 21, 20, 21, 22, 23, 22, 21, 21, 22, 23,
        24, 23, 22, 22, 23, 24,
      ];
      for (let i = 0; i < bankTop.length; i++) {
        const x = 4 + i;
        for (let y = bankTop[i]; y <= 27; y++) pix.set(x, y, "stone2");
        if (x < 19) pix.set(x, bankTop[i], "stone3");
      }
      // The cloud's underside darkens into the same value the bank is made of,
      // so the two read as one weather rather than a cloud and a kerb.
      ditherIn(pix, 4, 14, 24, 4, "stone2", 1, ["stone3", "stone4"]);
      ditherIn(pix, 4, 26, 24, 2, "stone1", 0, ["stone2"]);
      pix.outline();
    },
  },

  {
    // Night. The moon at the top of the sky, and the stars out.
    name: "state-time-night",
    draw(pix) {
      star(pix, 7, 8, true);
      star(pix, 25, 12);
      star(pix, 22, 6, true);
      star(pix, 10, 17);

      pix.disc(16, 11, 5.4, 5.4, "cream3");
      pix.disc(15.4, 10.4, 3.2, 3.2, "cream4");
      pix.disc(19.5, 11.5, 4.8, 4.8, "none");
      rimLight(pix, [9, 4, 14, 14], ["cream3", "cream4"], "cream4", "cream2");

      horizon(pix);
      pix.outline();
    },
  },

  {
    // Dawn. A pale hemisphere whose flat edge IS the horizon — cut by the
    // ridge, not sitting on it — with a warm halo and two flat rays lying
    // along the ground to its left. Rising is drawn, not implied.
    name: "state-time-dawn",
    draw(pix) {
      pix.line(4, 21, 7, 21, "ember4");
      pix.line(4, 24, 6, 24, "ember4");

      const tops = horizon(pix);
      const cx = 15;
      const cy = 25;
      const half = (r, key) => {
        for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
          const dx = x - cx;
          const top = Math.ceil(cy - Math.sqrt(Math.max(0, r * r - dx * dx)));
          const base = (tops[x] === undefined ? 27 : tops[x]) - 1;
          for (let y = top; y <= base; y++) pix.set(x, y, key);
        }
      };
      half(7, "ember3");
      half(5.5, "ember4");
      pix.disc(12.5, 21.5, 2.1, 1.7, "cream4");
      rimLight(pix, [8, 17, 7, 9], ["ember4"], "cream4", null);
      rimLight(pix, [16, 17, 6, 9], ["ember4"], "ember3", null);
      pix.outline();
    },
  },

  {
    // Day. The same sun the clear icon uses — same ramp, same rays, shortened
    // to sit above the ground. There is one sun in this set, not two.
    name: "state-time-day",
    draw(pix) {
      sunRays(pix, 16, 13, 7.5, 9.5, "ember4", 21);
      sun(pix, 16, 13, 5.5, "ember2", "ember3", "ember4");
      horizon(pix);
      pix.outline();
    },
  },

  {
    // Dusk. Not dawn mirrored: a deep low cap most of the way behind the
    // ridge, no rays at all, and the first two stars already out in the middle
    // of the sky where they read as a constellation and not as dead pixels.
    name: "state-time-dusk",
    draw(pix) {
      star(pix, 11, 10, true);
      star(pix, 18, 14, true);
      star(pix, 8, 17);

      const tops = horizon(pix);
      const cx = 20;
      const cy = 26;
      const r = 6;
      for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
        const dx = x - cx;
        const top = Math.ceil(cy - Math.sqrt(Math.max(0, r * r - dx * dx)));
        const base = (tops[x] === undefined ? 27 : tops[x]) - 1;
        for (let y = top; y <= base; y++) pix.set(x, y, "ember2");
      }
      pix.disc(18, 22.5, 2.4, 1.6, "ember3");
      ditherIn(pix, 15, 21, 8, 4, "ember3", 0, ["ember2"]);
      rimLight(pix, [13, 18, 8, 9], ["ember2", "ember3"], "ember3", null);
      rimLight(pix, [21, 18, 7, 9], ["ember2", "ember3"], "ember1", null);
      pix.outline();
    },
  },
];
