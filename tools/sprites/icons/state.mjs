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
 *   fire     the same bed of ash and the same two charred logs in every one of
 *            the four. The progression is height and heat and nothing else:
 *            grey mound, red coals, one small tongue, a full column of flame.
 *            Squinted at in a row it should look like a fire being lit.
 *   weather  the same cloud, in the same place, with something different
 *            happening under it — except clear, which is the cloud's absence
 *            and so is drawn as the sun alone with rays.
 *   time     the same curved horizon along the bottom of every one of the four,
 *            with one body in the sky at a different height. Height is the
 *            hour. Left is rising, right is setting, and the colour goes pale
 *            at dawn and deep at dusk so the two halves of the day never read
 *            as each other.
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
 * only touches the mass it was aimed at.
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

/* -------------------------------------------------------------------------- */
/* Fire                                                                       */
/* -------------------------------------------------------------------------- */

/** Two stubby logs crossed under the bed, their ends poking out either side. */
function logs(pix, dark, body, light) {
  pix.line(5, 26, 13, 22, body);
  pix.line(5, 27, 13, 23, dark);
  pix.line(5, 25, 12, 21, light);

  pix.line(27, 25, 19, 22, body);
  pix.line(27, 26, 19, 23, dark);
  pix.line(26, 24, 19, 21, light);
}

/** The mound of ash the fire sits in. Same shape whatever it is made of. */
function bed(pix, dark, body) {
  pix.disc(16, 24, 9, 3.4, dark);
  pix.disc(16, 23.6, 7, 2.5, body);
}

/**
 * A tongue of flame: one pixel at the tip, widest around halfway down, and
 * drawing back in again at the base, leaning as it climbs. The waist is the
 * whole trick — a shape that only widens on the way down is a cone, and a cone
 * on a log pile reads as a mountain. Drawn as spans rather than a polygon so
 * the taper stays smooth at this size.
 */
function flame(pix, cx, topY, baseY, maxW, lean, key) {
  const height = Math.max(1, baseY - topY);
  for (let y = topY; y <= baseY; y++) {
    const t = (y - topY) / height;
    const halfWidth = maxW * Math.sin(Math.PI * 0.8 * Math.pow(t, 0.62));
    const x = cx + lean * (1 - t) * (1 - t);
    pix.line(Math.round(x - halfWidth), y, Math.round(x + halfWidth), y, key);
  }
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

/** The cloud. Three bumps and a flat base, in whatever ramp the sky is in. */
function cloud(pix, cy, dark, body, light) {
  pix.disc(11, cy + 1, 4.6, 3.6, body);
  pix.disc(17, cy - 2, 5.4, 4.4, body);
  pix.disc(23, cy + 1, 4.2, 3.2, body);
  pix.rect(7, cy, 17, 4, body);
  rimLight(pix, [4, cy - 8, 24, 14], [body], light, dark);
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

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** The horizon: a curved ridge of ground along the bottom, same in all four. */
function horizon(pix) {
  pix.disc(16, 29, 11.5, 6.5, "stone2");
  pix.rect(0, 28, 32, 4, "none");
  rimLight(pix, [4, 20, 24, 8], ["stone2"], "stone3", null);
  ditherIn(pix, 5, 25, 22, 3, "stone1", 0, ["stone2"]);
}

/** A star: one bright pixel with a dimmer cross, so it twinkles rather than blobs. */
function star(pix, x, y, big = false) {
  pix.set(x, y, "cream4");
  if (!big) return;
  pix.set(x - 1, y, "cream2");
  pix.set(x + 1, y, "cream2");
  pix.set(x, y - 1, "cream2");
  pix.set(x, y + 1, "cream2");
}

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Dead. Grey ash, cold charcoal, nothing above the mound.
    name: "state-fire-out",
    draw(pix) {
      // A half-burnt branch sticking out of the ashes, drawn first so the
      // mound buries its lower end.
      pix.line(13, 25, 24, 16, "stone2");
      pix.line(13, 24, 24, 15, "stone3");
      logs(pix, "ink", "ink2", "ink3");
      bed(pix, "stone2", "stone3");
      ditherIn(pix, 8, 20, 16, 6, "stone4", 0, ["stone3"]);
      rimLight(
        pix,
        [5, 19, 22, 9],
        ["stone2", "stone3", "stone4"],
        "stone4",
        "stone1",
      );
      // Cold chunks of charcoal sitting in the ash.
      pix.set(13, 22, "ink3");
      pix.set(14, 22, "ink3");
      pix.set(19, 23, "ink3");
      pix.set(10, 24, "ink3");
      pix.outline();
    },
  },

  {
    // Coals. The same mound, dull red under a grey crust — no flame at all.
    name: "state-fire-embers",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember1");
      ditherIn(pix, 8, 21, 16, 5, "ember2", 0, ["ember1"]);
      pix.disc(15, 23, 3.4, 1.6, "ember2");
      pix.set(14, 23, "ember3");
      pix.set(18, 24, "ember3");
      pix.set(11, 24, "ember3");
      // The grey crust an ember bed wears until you poke it.
      ditherIn(pix, 8, 20, 16, 3, "stone2", 1, ["ember1", "ember2"]);
      rimLight(
        pix,
        [5, 19, 22, 9],
        ["ember1", "ember2", "stone2"],
        "stone3",
        "ember1",
      );
      pix.outline();
    },
  },

  {
    // Low. Live coals and one small tongue, about a third of the height.
    name: "state-fire-low",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember2");
      ditherIn(pix, 8, 21, 16, 5, "ember3", 0, ["ember2"]);
      pix.disc(15, 23, 3.2, 1.4, "ember3");
      pix.set(14, 23, "ember4");
      pix.set(15, 23, "ember4");

      flame(pix, 15.5, 12, 23, 2.4, 2.0, "ember2");
      flame(pix, 15.5, 15, 22, 1.5, 1.3, "ember3");
      flame(pix, 15.2, 18, 21, 0.7, 0.6, "ember4");
      // A second, smaller tongue, so the flame is never symmetrical.
      flame(pix, 20.5, 18, 23, 1.8, -0.9, "ember2");
      flame(pix, 20.5, 20, 23, 0.9, -0.5, "ember3");
      pix.outline();
    },
  },

  {
    // Good. A full column of flame with a white-hot core, filling the cell.
    name: "state-fire-good",
    draw(pix) {
      logs(pix, "ink2", "wood1", "wood2");
      bed(pix, "ember1", "ember2");

      flame(pix, 16, 5, 24, 4.2, 2.2, "ember2");
      flame(pix, 22, 11, 24, 2.6, -2.0, "ember2");
      flame(pix, 10, 14, 24, 2.2, 1.8, "ember2");
      flame(pix, 16, 8, 23, 2.8, 1.8, "ember3");
      flame(pix, 21.6, 14, 23, 1.6, -1.2, "ember3");
      flame(pix, 10.6, 17, 23, 1.2, 0.9, "ember3");
      flame(pix, 15.8, 12, 22, 1.6, 1.1, "ember4");
      flame(pix, 15.6, 16, 21, 0.8, 0.5, "cream4");

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
      const rays = [
        [16, 5, 16, 7],
        [16, 25, 16, 27],
        [5, 16, 7, 16],
        [25, 16, 27, 16],
        [9, 9, 10, 10],
        [23, 9, 22, 10],
        [9, 23, 10, 22],
        [23, 23, 22, 22],
      ];
      for (const [x0, y0, x1, y1] of rays) pix.line(x0, y0, x1, y1, "ember4");
      sun(pix, 16, 16, 6, "ember2", "ember3", "ember4");
      pix.set(13, 13, "cream4");
      pix.set(14, 13, "cream4");
      pix.set(13, 14, "cream4");
      pix.outline();
    },
  },

  {
    // Overcast. One heavy cloud, filling the cell, with nothing under it.
    name: "state-weather-cloud",
    draw(pix) {
      cloud(pix, 16, "stone2", "stone3", "stone4");
      pix.outline();
    },
  },

  {
    // Rain. The cloud, and three slanted streaks of falling water beneath it.
    name: "state-weather-rain",
    draw(pix) {
      cloud(pix, 12, "stone2", "stone3", "stone4");
      const drops = [
        [11, 19, 9, 23],
        [17, 21, 15, 26],
        [22, 19, 20, 24],
      ];
      for (const [x0, y0, x1, y1] of drops) {
        pix.line(x0, y0, x1, y1, "sky3");
        pix.line(x0 + 1, y0, x1 + 1, y1, "sky4");
      }
      pix.outline();
    },
  },

  {
    // Snow. The cloud, and flakes drifting rather than falling straight.
    name: "state-weather-snow",
    draw(pix) {
      cloud(pix, 12, "stone2", "stone3", "stone4");
      const flakes = [
        [10, 22, true],
        [21, 20, true],
        [16, 26, false],
        [14, 18, false],
      ];
      for (const [x, y, big] of flakes) {
        pix.set(x, y, "cream4");
        if (!big) {
          pix.set(x, y - 1, "cream3");
          pix.set(x + 1, y, "cream3");
          continue;
        }
        pix.line(x - 2, y, x + 2, y, "cream3");
        pix.line(x, y - 2, x, y + 2, "cream3");
        pix.set(x - 1, y, "cream4");
        pix.set(x, y - 1, "cream4");
      }
      pix.outline();
    },
  },

  {
    // Storm. A darker cloud, and a bolt out of the bottom of it.
    name: "state-weather-storm",
    draw(pix) {
      cloud(pix, 11, "stone1", "stone2", "stone3");
      pix.poly(
        [
          [18, 16],
          [13, 22],
          [16, 22],
          [12, 27],
          [19, 20],
          [16, 20],
          [20, 16],
        ],
        "ember3",
      );
      pix.line(17, 17, 14, 21, "ember4");
      pix.line(15, 23, 13, 26, "ember4");
      pix.outline();
    },
  },

  {
    // Fog. The family's cloud, come down to the ground and drifting: wavy
    // banks under it where rain has streaks and snow has flakes. Wavy and of
    // three different lengths, because three equal bars would be a meter.
    name: "state-weather-fog",
    draw(pix) {
      cloud(pix, 11, "stone1", "stone2", "stone3");
      const banks = [
        [6, 20, 17],
        [13, 23, 12],
        [8, 26, 15],
      ];
      banks.forEach(([x, y, w], i) => {
        for (let dx = 0; dx < w; dx++) {
          const wave = Math.sin((dx + i * 5) * 0.3) > 0 ? 0 : 1;
          const edge = dx < 2 || dx > w - 3;
          pix.set(x + dx, y + wave, edge ? "stone3" : "stone4");
        }
      });
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
    // Dawn. The sun half out of the ground on the left, still pale.
    name: "state-time-dawn",
    draw(pix) {
      sun(pix, 11, 22.5, 5, "ember2", "ember3", "ember4");
      horizon(pix);
      pix.outline();
    },
  },

  {
    // Day. The sun at the top of its arc, hot and clear of the ground.
    name: "state-time-day",
    draw(pix) {
      sun(pix, 16, 11, 5.4, "ember2", "ember4", "cream4");
      pix.set(13, 8, "cream4");
      pix.set(14, 8, "cream4");
      pix.set(13, 9, "cream4");
      horizon(pix);
      pix.outline();
    },
  },

  {
    // Dusk. The sun going down on the right, deep red, first star already out.
    name: "state-time-dusk",
    draw(pix) {
      star(pix, 8, 8, true);
      sun(pix, 21, 22.5, 5, "ember1", "ember2", "ember3");
      horizon(pix);
      pix.outline();
    },
  },
];
