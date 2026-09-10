/**
 * Where things are, as opposed to what colour they are.
 *
 * Two art gradings in a row have said the same thing about this campsite's
 * ground cover — "one Y-shaped sprite repeated at near-identical scale and
 * spacing" — and one has said it about the field stars: "placed uniformly".
 * Both were true, both were placement rather than art, and neither could be
 * caught by anything in this suite, because both lived inside a `useMemo` in a
 * React component that needs a WebGL context to instantiate.
 *
 * So they do not live there any more. `plantUnderstorey` and `starDrift` are
 * plain exported functions, and "clumpier than an even scatter" and "three
 * distinct sizes" and "has voids in it" are all properties with numbers
 * attached. A screenshot cannot tell an even scatter from a clumped one at a
 * glance; a nearest-neighbour histogram can.
 */

import { describe, expect, it } from 'vitest';
import { plantUnderstorey, starDrift } from '../src/scene/Campsite.js';

/** The component's own PRNG, so the test plants the same wood the game does. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotationY: number;
}

function plant(options: { seed?: number; count?: number; density?: (x: number, z: number) => number } = {}) {
  const buckets: Item[][] = [[], []];
  const planted = plantUnderstorey({
    rng: mulberry(options.seed ?? 0x9e37),
    count: options.count ?? 380,
    radius: 22,
    buckets,
    density: options.density ?? (() => 1),
    height: () => 0,
    underwater: () => false,
  });
  return { planted, items: [...buckets[0]!, ...buckets[1]!] };
}

/** Mean distance from each instance to its nearest neighbour. */
function meanNearest(items: readonly Item[]): number {
  let total = 0;
  for (const a of items) {
    let best = Infinity;
    for (const b of items) {
      if (a === b) continue;
      const d = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
      if (d < best) best = d;
    }
    total += Math.sqrt(best);
  }
  return total / items.length;
}

/**
 * The index of dispersion over a 2 m lattice: variance of the per-cell count
 * divided by its mean.
 *
 * The textbook test for this exact question. An even (Poisson) scatter has an
 * index of 1 by construction, whatever its density; a clumped field is
 * over-dispersed and comes out well above it, because the cells inside a patch
 * are full and the cells between patches are empty. Nearest-neighbour distance
 * is the intuitive statistic and a much weaker one — a fifth of these plants
 * are deliberately strays, and a stray has a near neighbour like anything else.
 */
function dispersion(items: readonly Item[], cell = 2): number {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${Math.floor(item.x / cell)},${Math.floor(item.z / cell)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Every cell the disc covers, including the empty ones — which are the point.
  const cells: number[] = [];
  const reach = Math.ceil(22 / cell);
  for (let i = -reach; i < reach; i++) {
    for (let j = -reach; j < reach; j++) {
      const r = Math.hypot((i + 0.5) * cell, (j + 0.5) * cell);
      if (r < 4.5 || r > 21) continue;
      cells.push(counts.get(`${i},${j}`) ?? 0);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  const variance = cells.reduce((a, b) => a + (b - mean) ** 2, 0) / cells.length;
  return variance / mean;
}

describe('the undergrowth is planted rather than sprinkled', () => {
  it('plants what the catalogue asked for', () => {
    // The clumping added two rejecting filters. Doing that inside a
    // fixed-length loop would have halved the undergrowth as a side effect,
    // which is the sort of change that grades as "the ferns look thinner" and
    // gets fixed by turning the density up.
    const { planted, items } = plant({ count: 380 });
    expect(planted).toBe(380);
    expect(items.length).toBe(380);
  });

  it('is markedly clumpier than an even scatter of the same size', () => {
    /*
     * The measurement the grading was making by eye, made properly. This is the
     * scatter it replaced — uniform angle, square-rooted radius — against the
     * one it is now, at the same count over the same annulus.
     */
    const { items } = plant({ count: 380 });
    const rng = mulberry(0x9e37);
    const even: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      const angle = rng() * Math.PI * 2;
      const distance = 3.4 + Math.sqrt(rng()) * (22 - 3.4);
      even.push({
        x: Math.cos(angle) * distance,
        y: 0,
        z: Math.sin(angle) * distance,
        scale: 1,
        rotationY: 0,
      });
    }

    const clumped = dispersion(items);
    const flat = dispersion(even);
    // A Poisson field sits at 1 by construction. Patches with bare ground
    // between them are over-dispersed, and by a lot.
    expect(flat, `the baseline was not Poisson: ${flat.toFixed(2)}`).toBeLessThan(1.6);
    expect(clumped, `clumped ${clumped.toFixed(2)} vs even ${flat.toFixed(2)}`).toBeGreaterThan(
      flat * 1.8,
    );
    // And they really are closer together, which is the half a person sees.
    expect(meanNearest(items)).toBeLessThan(meanNearest(even) * 0.85);
  });

  it('grows three sizes rather than one', () => {
    /*
     * Three classes at roughly 0.52, 0.9 and 1.55, each with a little jitter
     * inside it. A ratio of about two between neighbours is what the eye reads
     * as different ages of the same plant; the old single roll over 0.8-1.3 is
     * a 1.6x total range, which at a metre from the knee is one size.
     */
    const { items } = plant({ count: 380 });
    const small = items.filter((i) => i.scale < 0.65).length;
    const middling = items.filter((i) => i.scale >= 0.65 && i.scale < 1.2).length;
    const large = items.filter((i) => i.scale >= 1.2).length;
    expect(small, 'no seedlings').toBeGreaterThan(items.length * 0.15);
    expect(middling, 'no established plants').toBeGreaterThan(items.length * 0.3);
    expect(large, 'nothing got the light').toBeGreaterThan(items.length * 0.08);
    // And nothing in between the classes, which is what makes them classes.
    expect(items.filter((i) => i.scale > 0.66 && i.scale < 0.78)).toHaveLength(0);
    expect(items.filter((i) => i.scale > 1.05 && i.scale < 1.3)).toHaveLength(0);
    // The biggest is about three times the smallest.
    const scales = items.map((i) => i.scale);
    expect(Math.max(...scales) / Math.min(...scales)).toBeGreaterThan(2.5);
  });

  it('is thicker where the density field says the wood is thicker', () => {
    // One half of the clearing shaded, the other open. The plants should follow.
    const { items } = plant({ count: 300, density: (x) => (x > 0 ? 0.95 : 0.12) });
    const shaded = items.filter((i) => i.x > 0).length;
    expect(shaded / items.length, 'the canopy term never reached the placement').toBeGreaterThan(
      0.7,
    );
  });

  it('keeps out of the fire and off the trail', () => {
    const { items } = plant({ count: 380 });
    for (const item of items) {
      // The clearing people camp in.
      expect(Math.hypot(item.x, item.z)).toBeGreaterThanOrEqual(3.4 - 1e-6);
      // And the corridor the player walks in along, near the camp.
      const trail = Math.atan2(6.2, 7.5);
      const angle = Math.atan2(item.z, item.x);
      let delta = Math.abs(angle - trail) % (Math.PI * 2);
      if (delta > Math.PI) delta = Math.PI * 2 - delta;
      if (Math.hypot(item.x, item.z) < 12) expect(delta).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('does not spin when there is nowhere to plant', () => {
    // A kit whose whole disc is inside the clearing, or a density field that
    // refuses everything. The attempt ceiling has to hold, or the campsite
    // never finishes building.
    expect(plant({ count: 200, density: () => 0 }).planted).toBe(0);
    const tiny: Item[][] = [[], []];
    expect(
      plantUnderstorey({
        rng: mulberry(1),
        count: 200,
        radius: 1,
        buckets: tiny,
        density: () => 1,
        height: () => 0,
        underwater: () => false,
      }),
    ).toBeLessThanOrEqual(200);
  });
});

describe('the field stars have drifts and voids in them', () => {
  /** A grid of directions over the upper hemisphere, at the dome's radius. */
  function samples(): number[] {
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 30; j++) {
        const theta = (i / 60) * Math.PI * 2;
        const phi = Math.acos((j / 30) * 0.95);
        const r = 120;
        out.push(
          starDrift(
            Math.sin(phi) * Math.cos(theta) * r,
            Math.cos(phi) * r + 20,
            Math.sin(phi) * Math.sin(theta) * r,
          ),
        );
      }
    }
    return out;
  }

  it('is not the flat field it replaced', () => {
    const values = samples();
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.sqrt(
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
    );
    // A uniform sprinkle has a standard deviation of exactly zero here, which
    // is what four hundred and twenty evenly-rolled points were.
    expect(spread, 'the sky is still uniform').toBeGreaterThan(0.12);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.4);
  });

  it('thins without ever tearing a hole', () => {
    // The voids have to be thin rather than empty: a sky with clean holes in it
    // reads as broken geometry, which is the failure mode this whole session
    // keeps finding.
    for (const v of samples()) {
      expect(v).toBeGreaterThan(0.12);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('runs a band across the dome rather than round the horizon', () => {
    // A bright lane that lay along the treeline would be competing with the one
    // thing already there. It is tilted, so it crosses.
    const at = (theta: number, phiDeg: number) => {
      const phi = (phiDeg * Math.PI) / 180;
      const r = 120;
      return starDrift(
        Math.sin(phi) * Math.cos(theta) * r,
        Math.cos(phi) * r + 20,
        Math.sin(phi) * Math.sin(theta) * r,
      );
    };
    // Around a ring of constant altitude the density must vary, or the band is
    // a horizontal stripe rather than a lane crossing the sky.
    const ring = Array.from({ length: 24 }, (_, i) => at((i / 24) * Math.PI * 2, 55));
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.25);
  });
});
