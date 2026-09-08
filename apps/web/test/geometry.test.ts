/**
 * The conifers, measured.
 *
 * An art review graded the previous trees in all forty-two captured frames as
 * "literal isosceles triangles at every distance… zero value variation, no
 * silhouette break". Two of those three words are measurable and are measured
 * here, against a control: a plain `ConeGeometry` of the same height and reach,
 * which is exactly the shape the review was describing.
 *
 * The measurement that matters is the *silhouette profile* — the width of the
 * tree as seen from the side, sampled up its height. A cone's profile is a
 * straight line with one maximum. A conifer's steps in and out once per whorl
 * of boughs, and the number of those steps is what "ragged" means as a number.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createTreeGeometry,
  createTreeGeometrySet,
  mergeGeometries,
  type TreeForm,
} from '../src/render/geometry.js';

const HEIGHT = 4.2;
// 48 slices over a 4.2 m tree is about 9 cm apiece, which resolves a whorl of
// boughs (they are half a metre apart). At 24 the whorls alias against the
// sampling and a ragged tree measures as a smooth one.
const SAMPLES = 48;

/**
 * Width of the mesh at a height, by slicing every triangle with the horizontal
 * plane there.
 *
 * Binning vertices instead is the obvious cheap version and it is wrong: it
 * reports zero for any band that a triangle merely spans, so a solid tree
 * measures as a stack of floating discs and the raggedness count is noise.
 */
function silhouette(geometry: THREE.BufferGeometry, height = HEIGHT): number[] {
  const p = geometry.getAttribute('position') as THREE.BufferAttribute;
  const widths: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const y = ((s + 0.5) / SAMPLES) * height;
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < p.count; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = t + e;
        const j = t + ((e + 1) % 3);
        const y0 = p.getY(i);
        const y1 = p.getY(j);
        if (y0 === y1 || y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
        const x = p.getX(i) + (p.getX(j) - p.getX(i)) * ((y - y0) / (y1 - y0));
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    widths.push(max === -Infinity ? 0 : max - min);
  }
  return widths;
}

/** How many times the outline steps back out on the way up. */
function silhouetteBreaks(widths: number[]): number {
  let breaks = 0;
  for (let i = 1; i < widths.length - 1; i++) {
    if (widths[i]! > widths[i - 1]! + 1e-4 && widths[i]! >= widths[i + 1]!) breaks++;
  }
  return breaks;
}

/**
 * The fraction of the canopy outline that is not locally straight.
 *
 * The blunter measure of the two, and the one with the margin in it. A cone's
 * edge is a straight line — every slice inside a tier has a second difference
 * of exactly zero, and only the join between tiers registers at all — so the
 * old tree scores about 0.14 whatever seed it is given. Anything built out of
 * unequal bough tips cannot.
 */
function notLocallyStraight(widths: number[]): number {
  const widest = Math.max(...widths);
  let broken = 0;
  let counted = 0;
  for (let i = 1; i < widths.length - 1; i++) {
    if (widths[i]! <= widest * 0.3) continue;
    counted++;
    if (Math.abs(widths[i - 1]! - 2 * widths[i]! + widths[i + 1]!) > widest * 0.05) broken++;
  }
  return counted === 0 ? 0 : broken / counted;
}

/**
 * The shape the review was complaining about: the tree this replaced, rebuilt
 * here exactly as it was — a trunk and two six-segment cones.
 *
 * Keeping the old shape as a control is the only way the raggedness number
 * means anything. Without it "three silhouette breaks" is a number somebody
 * picked; with it, it is three more than what shipped.
 */
function isoscelesControl(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunkHeight = HEIGHT * 0.25;
  const trunk = new THREE.CylinderGeometry(HEIGHT * 0.035, HEIGHT * 0.055, trunkHeight, 5, 1);
  trunk.translate(0, trunkHeight / 2, 0);
  parts.push(trunk);
  let y = trunkHeight * 0.8;
  for (let i = 0; i < 2; i++) {
    const radius = HEIGHT * (0.3 - (i / 2) * 0.12);
    const tierHeight = HEIGHT * (0.4 - (i / 2) * 0.08);
    const cone = new THREE.ConeGeometry(radius, tierHeight, 6, 1);
    cone.translate(0, y + tierHeight / 2, 0);
    parts.push(cone);
    y += tierHeight * 0.55;
  }
  return mergeGeometries(parts);
}

const triangles = (g: THREE.BufferGeometry): number =>
  (g.getAttribute('position') as THREE.BufferAttribute).count / 3;

describe('the silhouette of a conifer', () => {
  it('measures the stacked cones this replaces as two steps and a straight edge', () => {
    // The control, and the bar. If this ever starts failing, the measurement
    // is broken, not the trees. The two steps are the joins between the trunk
    // and the first cone and between the two cones — everything between them
    // is a perfectly straight taper, which is what the review saw.
    const widths = silhouette(isoscelesControl());
    expect(silhouetteBreaks(widths)).toBe(2);
    expect(notLocallyStraight(widths)).toBeLessThan(0.16);
  });

  it('steps in and out more than that on every living tree', () => {
    for (const form of ['spire', 'broad'] as const) {
      for (const seed of [1, 977, 4242, 60013, 12, 131, 786, 20250]) {
        const widths = silhouette(createTreeGeometry(seed, HEIGHT, { form }));
        const where = `${form} #${seed} outline: ${widths.map((w) => w.toFixed(2)).join(' ')}`;
        expect(silhouetteBreaks(widths), where).toBeGreaterThanOrEqual(3);
        // The measure with the margin in it: a fifth of the outline off the
        // straight line, against the old tree's one seventh.
        expect(notLocallyStraight(widths), where).toBeGreaterThan(0.2);
      }
    }
  });

  it('is still broken up at the far level, which is never a flat triangle', () => {
    // Over 40 m the direction allows a two-tone billboard; what it does not
    // allow is the single triangle, so the cheap tree keeps its whorls.
    for (const seed of [3, 88, 1500]) {
      const g = createTreeGeometry(seed, HEIGHT, { form: 'spire', detail: 'far' });
      expect(silhouetteBreaks(silhouette(g))).toBeGreaterThanOrEqual(1);
      expect(triangles(g)).toBeLessThan(triangles(createTreeGeometry(seed, HEIGHT)));
    }
  });

  it('varies the tips within one whorl, not just between whorls', () => {
    // Two trees of the same form at the same height are not the same outline.
    const a = silhouette(createTreeGeometry(5, HEIGHT, { form: 'spire' }));
    const b = silhouette(createTreeGeometry(6, HEIGHT, { form: 'spire' }));
    const different = a.filter((w, i) => Math.abs(w - b[i]!) > 0.02).length;
    expect(different).toBeGreaterThan(SAMPLES / 2);
  });

  it('never grows taller than the height it was asked for', () => {
    // The crown apex used to overshoot by most of a whorl, which put every
    // tree in the wood a sixth above the treeline the scene had planned.
    for (const form of ['spire', 'broad', 'broken', 'snag'] as const) {
      for (const seed of [2, 71, 9001]) {
        const p = createTreeGeometry(seed, HEIGHT, { form }).getAttribute(
          'position',
        ) as THREE.BufferAttribute;
        let top = -Infinity;
        let bottom = Infinity;
        for (let i = 0; i < p.count; i++) {
          top = Math.max(top, p.getY(i));
          bottom = Math.min(bottom, p.getY(i));
        }
        expect(top, `${form} #${seed}`).toBeLessThanOrEqual(HEIGHT + 1e-4);
        // And it stands on the ground rather than hovering over it: the lean
        // is a shear from the base, not a rotation about it.
        expect(bottom, `${form} #${seed}`).toBeGreaterThan(-0.05);
      }
    }
  });
});

describe('the same campsite twice', () => {
  it('builds the identical mesh from the identical seed', () => {
    // A product promise, not a detail: a campsite you come back to is the
    // campsite you left.
    const a = createTreeGeometry(4242, HEIGHT);
    const b = createTreeGeometry(4242, HEIGHT);
    for (const name of ['position', 'color', 'uv'] as const) {
      const x = (a.getAttribute(name) as THREE.BufferAttribute).array;
      const y = (b.getAttribute(name) as THREE.BufferAttribute).array;
      expect(Array.from(x), name).toEqual(Array.from(y));
    }
  });

  it('builds a different mesh from a different seed', () => {
    const a = createTreeGeometry(1, HEIGHT, { form: 'spire' });
    const b = createTreeGeometry(2, HEIGHT, { form: 'spire' });
    expect(Array.from((a.getAttribute('position') as THREE.BufferAttribute).array)).not.toEqual(
      Array.from((b.getAttribute('position') as THREE.BufferAttribute).array),
    );
  });
});

describe('tone bands', () => {
  /** The brightest channel of each vertex tint. */
  const tints = (g: THREE.BufferGeometry): number[] => {
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    const out: number[] = [];
    for (let i = 0; i < c.count; i++) out.push(Math.max(c.getX(i), c.getY(i), c.getZ(i)));
    return out;
  };

  it('carries three separated values, not one flat colour', () => {
    const values = tints(createTreeGeometry(11, HEIGHT, { form: 'spire' }));
    // The direction's #4a5a3e / #33402c / #1c241a, as ratios against the mid
    // band: about 1.4 and about 0.56. Multipliers rather than colours, so the
    // per-campsite canopy colour and the hour still own the hue.
    expect(Math.max(...values)).toBeGreaterThan(1.25);
    expect(Math.min(...values)).toBeLessThan(0.7);
    const spread = new Set(values.map((v) => Math.round(v * 10)));
    expect(spread.size, 'distinct tone steps').toBeGreaterThanOrEqual(6);
  });

  it('puts the dark band on the undersides and the light band up top', () => {
    const g = createTreeGeometry(11, HEIGHT, { form: 'spire' });
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    let up = 0;
    let upCount = 0;
    let down = 0;
    let downCount = 0;
    for (let t = 0; t < p.count; t += 3) {
      const facing = n.getY(t);
      const value = (c.getY(t) + c.getY(t + 1) + c.getY(t + 2)) / 3;
      if (facing > 0.2) {
        up += value;
        upCount++;
      } else if (facing < -0.2) {
        down += value;
        downCount++;
      }
    }
    expect(upCount).toBeGreaterThan(0);
    expect(downCount).toBeGreaterThan(0);
    expect(up / upCount).toBeGreaterThan((down / downCount) * 1.5);
  });

  it('lands on a neutral for snow rather than on bright green', () => {
    // A multiplier over a dark green material makes brighter green unless it
    // is told what it is multiplying. Given the material colour it can divide
    // by it and hit an actual grey.
    const foliage = 0x1d3323;
    const g = createTreeGeometry(11, HEIGHT, { form: 'spire', snow: 1, baseColor: foliage });
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    const base = new THREE.Color(foliage);
    let bestSaturation = 1;
    let brightest = 0;
    for (let i = 0; i < c.count; i++) {
      const r = c.getX(i) * base.r;
      const green = c.getY(i) * base.g;
      const b = c.getZ(i) * base.b;
      const value = Math.max(r, green, b);
      if (value > brightest) {
        brightest = value;
        bestSaturation = (value - Math.min(r, green, b)) / (value || 1);
      }
    }
    // `base` is a very dark green: anything this bright is snow and nothing
    // else, and the saturation is the assertion that actually matters.
    expect(brightest).toBeGreaterThan(0.4);
    expect(bestSaturation).toBeLessThan(0.15);
  });

  it('leaves the tree unsnowed by default', () => {
    const plain = createTreeGeometry(11, HEIGHT, { form: 'spire' });
    const snowed = createTreeGeometry(11, HEIGHT, { form: 'spire', snow: 1 });
    expect(Math.max(...tints(snowed))).toBeGreaterThan(Math.max(...tints(plain)) * 1.4);
  });
});

describe('a wood', () => {
  it('always contains something that does not come to a point', () => {
    /*
     * Four independent form rolls come up all-alive about one campsite in
     * seven, and a skyline of nothing but cones is a sawtooth. The set deals
     * the forms instead of rolling them, so a wood of four shapes always has
     * a snapped top in it — measurable as a tree that stops short of the
     * height every other tree reaches.
     */
    const tops = createTreeGeometrySet(1234, HEIGHT, 4).map((g) => {
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      let top = 0;
      for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i));
      return top;
    });
    expect(Math.min(...tops)).toBeLessThan(HEIGHT * 0.9);
    expect(Math.max(...tops)).toBeCloseTo(HEIGHT, 5);
  });

  it('has a bare snag in it once there are buckets to spare', () => {
    // Not at four: every shape in the set is a quarter of the wood, and a
    // quarter of a wood standing dead is a burn scar rather than a forest.
    const four = createTreeGeometrySet(1234, HEIGHT, 4);
    expect(Math.min(...four.map((g) => Math.max(...silhouette(g))))).toBeGreaterThan(HEIGHT * 0.25);
    const six = createTreeGeometrySet(1234, HEIGHT, 6);
    expect(Math.min(...six.map((g) => Math.max(...silhouette(g))))).toBeLessThan(HEIGHT * 0.25);
  });

  it('keeps the same trees in the same places as the seeds it replaces', () => {
    // The campsite already stepped its four shapes by 977. The set uses the
    // same step so switching to it does not reshuffle an existing campsite.
    const set = createTreeGeometrySet(500, HEIGHT, 2);
    for (let i = 0; i < 2; i++) {
      const solo = createTreeGeometry(500 + i * 977, HEIGHT, {
        form: (['spire', 'broad'] as TreeForm[])[i] as TreeForm,
      });
      expect(Array.from((set[i]!.getAttribute('position') as THREE.BufferAttribute).array)).toEqual(
        Array.from((solo.getAttribute('position') as THREE.BufferAttribute).array),
      );
    }
  });

  it('stays inside its share of the triangle budget', () => {
    /*
     * ARCHITECTURE §10 allows 60k visible triangles and `Campsite.tsx` caps
     * the wood at 240 instances. A mid tree is roughly twice the 56 triangles
     * of the cone it replaces, which is the price of the silhouette; twice
     * again would be the whole budget spent on trees.
     */
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(triangles(createTreeGeometry(seed, HEIGHT))).toBeLessThanOrEqual(120);
      expect(triangles(createTreeGeometry(seed, HEIGHT, { detail: 'near' }))).toBeLessThanOrEqual(200);
      expect(triangles(createTreeGeometry(seed, HEIGHT, { detail: 'far' }))).toBeLessThanOrEqual(60);
    }
  });
});

describe('merging', () => {
  it('carries vertex colour through, which it used to drop', () => {
    // Silently: a tinted tree merged into a wood came out flat green with no
    // error anywhere.
    const a = createTreeGeometry(1, HEIGHT);
    const b = createTreeGeometry(2, HEIGHT);
    const merged = mergeGeometries([a, b]);
    expect(triangles(merged)).toBe(triangles(a) + triangles(b));
    const colors = merged.getAttribute('color') as THREE.BufferAttribute | undefined;
    expect(colors).toBeDefined();
    expect(colors!.count).toBe(
      (a.getAttribute('position') as THREE.BufferAttribute).count +
        (b.getAttribute('position') as THREE.BufferAttribute).count,
    );
    const source = a.getAttribute('color') as THREE.BufferAttribute;
    expect(colors!.getX(7)).toBeCloseTo(source.getX(7), 6);
  });

  it('gives an untinted part white, so mixing does not repaint it', () => {
    const plain = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const merged = mergeGeometries([plain, createTreeGeometry(1, HEIGHT)]);
    const colors = merged.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < (plain.getAttribute('position') as THREE.BufferAttribute).count; i++) {
      expect(colors.getX(i)).toBe(1);
      expect(colors.getY(i)).toBe(1);
      expect(colors.getZ(i)).toBe(1);
    }
  });

  it('adds no colour attribute when nothing in the batch has one', () => {
    const merged = mergeGeometries([
      new THREE.BoxGeometry(1, 1, 1).toNonIndexed(),
      new THREE.BoxGeometry(2, 1, 1).toNonIndexed(),
    ]);
    expect(merged.getAttribute('color')).toBeUndefined();
  });
});
