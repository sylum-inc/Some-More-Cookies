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
import { ENVIRONMENTS } from '@somemore/content';
import {
  createBoxGeometry,
  createGroundCoverGeometry,
  createLitterGeometry,
  createTerrainGeometry,
  createTreeGeometry,
  createTreeGeometrySet,
  drawnTerrainHeight,
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
    // The direction's #4a6b4a / #33513a / #1e3328, as ratios against the mid
    // band **taken in linear light**: about 2.07 and about 0.39. Multipliers
    // rather than colours, so the per-campsite canopy colour and the hour
    // still own the hue.
    expect(Math.max(...values)).toBeGreaterThan(1.9);
    expect(Math.min(...values)).toBeLessThan(0.5);
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

/**
 * Colour, measured rather than looked at.
 *
 * The review that produced these tests said "there is not one green pixel in
 * the canopy" and "within a single skirt the shading is dead flat". The
 * second half of that was true and the first half was a symptom: the tone
 * bands were being computed as ratios of *sRGB bytes* and then applied as
 * multipliers in the renderer's *linear* working space, where they mean
 * something much smaller. Everything below turns "does the wood have colour
 * in it" into numbers, because a screenshot could not tell the difference
 * between that bug and a deliberately flat art direction.
 */
describe('colour in the wood', () => {
  const LUMA = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /** Linear channel back to an sRGB byte, which is what a player's eye gets. */
  const toByte = (linear: number): number =>
    255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055);

  /**
   * The upper faces of one skirt, grouped.
   *
   * Every upper face of a skirt is a triangle of the fan around that skirt's
   * apex, so they all share vertex 0 exactly — which makes the apex position
   * a free grouping key and means this measures a *skirt*, not a height band.
   * Height bands do not work here: the skirts deliberately overlap.
   */
  const skirtFans = (g: THREE.BufferGeometry): { apex: number[]; rim: number[]; low: number }[] => {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const fans = new Map<string, { apex: number[]; rim: number[]; low: number }>();
    for (let t = 0; t < p.count; t += 3) {
      if (n.getY(t) <= 0.05) continue;
      const key = `${p.getX(t).toFixed(5)},${p.getY(t).toFixed(5)},${p.getZ(t).toFixed(5)}`;
      const fan = fans.get(key) ?? { apex: [], rim: [], low: Infinity };
      fan.apex.push(LUMA(c.getX(t), c.getY(t), c.getZ(t)));
      for (const i of [1, 2]) {
        fan.rim.push(LUMA(c.getX(t + i), c.getY(t + i), c.getZ(t + i)));
        fan.low = Math.min(fan.low, p.getY(t + i));
      }
      fans.set(key, fan);
    }
    // Four triangles or more: the needle fringe also shares a vertex, in pairs.
    return [...fans.values()].filter((f) => f.apex.length >= 4);
  };

  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('shades every skirt on its own, rather than shading the tree', () => {
    /*
     * The number this replaces: 1.09.
     *
     * The old skirt put one tone on its whole upper face and 92% of it on the
     * rim, so apex-to-rim was 1.087 and the only thing moving inside a skirt
     * was the ±12% random face lift — noise, not a gradient. Three bands per
     * skirt puts the top band at the apex and the mid band at the rim, which
     * is 2.07 / 1.0 before jitter, and measures at about 1.85 once the crown
     * ramp and the lift are in.
     */
    for (const form of ['spire', 'broad', 'broken'] as const) {
      for (const seed of [11, 42, 777, 20250]) {
        const fans = skirtFans(createTreeGeometry(seed, HEIGHT, { form }));
        expect(fans.length, `${form} #${seed} has skirts`).toBeGreaterThan(2);
        for (const fan of fans) {
          const where = `${form} #${seed} skirt`;
          expect(mean(fan.apex) / mean(fan.rim), where).toBeGreaterThan(1.6);
        }
      }
    }
  });

  it('separates top face from underside by a step the dither can resolve', () => {
    /*
     * The bands are multipliers, so what a player actually sees depends on the
     * campsite's own foliage colour — which is why this runs over all twelve.
     *
     * Old: 28/255 of green between the brightest canopy vertex and the
     * darkest, averaged across the catalogue. New: 46/255. The eight-step
     * ordered dither at 320x240 puts a band edge roughly every 8/255, so the
     * old spread was three steps for the whole tree and the new one is nearly
     * six.
     */
    const g = createTreeGeometry(11, HEIGHT, { form: 'spire' });
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    let brightest = [1, 1, 1];
    let darkest = [1, 1, 1];
    let hi = 0;
    let lo = Infinity;
    for (let i = 0; i < c.count; i++) {
      const v = [c.getX(i), c.getY(i), c.getZ(i)] as number[];
      // Bark is decisively red-dominant and is not canopy; see the trunk test.
      if ((v[0] as number) / (v[1] as number) > 2) continue;
      const value = LUMA(v[0] as number, v[1] as number, v[2] as number);
      if (value > hi) {
        hi = value;
        brightest = v;
      }
      if (value < lo) {
        lo = value;
        darkest = v;
      }
    }
    const separations = ENVIRONMENTS.map((environment) => {
      const base = new THREE.Color(environment.scene.nightPalette.foliage);
      const channel = [base.r, base.g, base.b];
      const green = (tint: number[]): number =>
        toByte(Math.min(1, (channel[1] as number) * (tint[1] as number)));
      return { id: environment.id, delta: green(brightest) - green(darkest) };
    });
    for (const row of separations) {
      expect(row.delta, `${row.id} green top-to-under`).toBeGreaterThan(35);
    }
    expect(mean(separations.map((row) => row.delta))).toBeGreaterThan(40);
  });

  it('does not brighten or darken the wood on the way', () => {
    /*
     * D7's floor works both ways: the fix for a flat wood is not to turn the
     * exposure up. The mean vertex tint over forty trees measured 0.830
     * before the bands were recomputed and 0.821 after — a wood of the same
     * value, with the value distributed instead of smeared.
     */
    let sum = 0;
    let count = 0;
    for (let seed = 0; seed < 40; seed++) {
      const c = createTreeGeometry(seed, HEIGHT).getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c.count; i++) {
        sum += LUMA(c.getX(i), c.getY(i), c.getZ(i));
        count++;
      }
    }
    expect(sum / count).toBeGreaterThan(0.74);
    expect(sum / count).toBeLessThan(0.92);
  });

  it('gives every tree in a wood its own green', () => {
    /*
     * The direction's `#3f5f42 -> #4e6340 -> #2f4a38` drift, as a multiplier
     * so the manifest keeps owning the hue. What is asserted is the shape of
     * the drift, not its absolute values:
     *
     * - the treeline is not one colour (chroma spans at least 15%),
     * - and it is still *this campsite's* colour (the wood's mean tint stays
     *   within a few per cent of neutral, so twelve environments keep twelve
     *   identities rather than converging on the drift's own green).
     */
    const woods = Array.from({ length: 24 }, (_, i) => createTreeGeometry(i * 977 + 3, HEIGHT));
    const warmth: number[] = [];
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let n = 0;
    for (const g of woods) {
      const c = g.getAttribute('color') as THREE.BufferAttribute;
      let r = 0;
      let green = 0;
      let b = 0;
      let canopy = 0;
      for (let i = 0; i < c.count; i++) {
        if (c.getX(i) / c.getY(i) > 2) continue;
        r += c.getX(i);
        green += c.getY(i);
        b += c.getZ(i);
        canopy++;
      }
      if (canopy === 0) continue; // a snag is all bark
      warmth.push(r / green);
      rSum += r / canopy;
      gSum += green / canopy;
      bSum += b / canopy;
      n++;
    }
    expect(Math.max(...warmth) / Math.min(...warmth), 'warm-to-cool spread').toBeGreaterThan(1.15);
    // Centred on neutral: the mean canopy is what the manifest asked for.
    const meanTint = [rSum / n, gSum / n, bSum / n];
    const chroma = Math.max(...meanTint) / Math.min(...meanTint);
    expect(chroma, `wood mean tint ${meanTint.map((v) => v.toFixed(3)).join(', ')}`).toBeLessThan(1.12);
  });

  it('deals the hue across a wood instead of rolling it four times', () => {
    /*
     * The wood a campsite actually draws is four to six bucket geometries,
     * not forty. Four independent hue rolls come up nearly the same green
     * about one campsite in four — measured at a warm-to-cool spread of 1.08
     * at seed 99991 against 1.37 at seed 60013 — which is the flat treeline
     * this was meant to break up, at a quarter of the catalogue. Dealing an
     * even slice of the drift to each bucket, rotated by a per-campsite
     * phase, puts the *worst* wood in two hundred at 1.20.
     */
    const warmthOf = (g: THREE.BufferGeometry): number => {
      const c = g.getAttribute('color') as THREE.BufferAttribute;
      let r = 0;
      let green = 0;
      for (let i = 0; i < c.count; i++) {
        if (c.getX(i) / c.getY(i) > 2) continue; // bark
        r += c.getX(i);
        green += c.getY(i);
      }
      return green > 0 ? r / green : Number.NaN;
    };
    let worst = Infinity;
    for (let i = 0; i < 200; i++) {
      for (const count of [4, 6]) {
        const warmth = createTreeGeometrySet(i * 7919 + 3, HEIGHT, count)
          .map(warmthOf)
          .filter((v) => !Number.isNaN(v));
        worst = Math.min(worst, Math.max(...warmth) / Math.min(...warmth));
      }
    }
    expect(worst, 'the flattest wood in two hundred campsites').toBeGreaterThan(1.15);
  });

  it('makes the trunk a thin dark stick rather than a pale post', () => {
    /*
     * "A fat pale cylinder ... reads as a mushroom stalk." Both halves.
     *
     * Width: the base radius was up to 0.048x the tree's height, which is a
     * 40 cm trunk on a 4.2 m tree and fifteen pixels across at six metres
     * through the world camera's 62 degree field. A third of that is both
     * what the direction asked for and what a fir that height actually
     * measures. The floor matters as much as the ceiling — under about a
     * pixel the trunk stops existing and the canopy floats.
     */
    for (const form of ['spire', 'broad', 'broken', 'snag'] as const) {
      let widest = 0;
      let narrowest = Infinity;
      for (let seed = 0; seed < 40; seed++) {
        const p = createTreeGeometry(seed, HEIGHT, { form }).getAttribute(
          'position',
        ) as THREE.BufferAttribute;
        let radius = 0;
        for (let i = 0; i < p.count; i++) {
          if (p.getY(i) > 1e-6) continue; // the trunk is the only thing on the ground
          radius = Math.max(radius, Math.hypot(p.getX(i), p.getZ(i)));
        }
        widest = Math.max(widest, radius);
        narrowest = Math.min(narrowest, radius);
      }
      // A snag has no canopy and is read entirely by its trunk, so it keeps
      // half again — still well under half of what every tree used to be.
      const ceiling = form === 'snag' ? 0.028 : 0.017;
      expect(widest / HEIGHT, `${form} widest trunk radius`).toBeLessThan(ceiling);
      expect(narrowest / HEIGHT, `${form} narrowest trunk radius`).toBeGreaterThan(0.008);
    }

    // And dark, and warm: red beats green on the trunk where green beats red
    // on every bough. That inversion is the only thing telling a player it is
    // wood at a resolution where it is three pixels wide.
    const c = createTreeGeometry(11, HEIGHT, { form: 'spire' }).getAttribute(
      'color',
    ) as THREE.BufferAttribute;
    const bark: number[] = [];
    const canopy: number[] = [];
    for (let i = 0; i < c.count; i++) {
      const value = LUMA(c.getX(i), c.getY(i), c.getZ(i));
      (c.getX(i) / c.getY(i) > 2 ? bark : canopy).push(value);
    }
    expect(bark.length).toBeGreaterThan(12);
    expect(mean(bark), 'bark is darker than the canopy it sits under').toBeLessThan(mean(canopy) * 0.5);
  });

  it('closes the daylight gap under the bottom skirt', () => {
    /*
     * The direction: within 15% of the ground. A broad fir used to hold its
     * lowest boughs at 39% of its height, which at any distance is a stalk
     * with a hat on it, and the gap was the other half of the mushroom.
     *
     * The floor is the other half of the assertion: the underside apex of the
     * lowest skirt reaches below its rim, and at `far` detail three skirts
     * have to cover the whole canopy, so it went underground before it was
     * clamped.
     */
    for (const form of ['spire', 'broad', 'broken'] as const) {
      for (const detail of ['near', 'mid', 'far'] as const) {
        for (let seed = 0; seed < 30; seed++) {
          const fans = skirtFans(createTreeGeometry(seed, HEIGHT, { form, detail }));
          const lowest = Math.min(...fans.map((f) => f.low));
          const where = `${form}/${detail} #${seed}`;
          expect(lowest / HEIGHT, where).toBeLessThanOrEqual(0.15);
          expect(lowest, where).toBeGreaterThan(0);
        }
      }
    }
  });
});

/**
 * The clearing floor.
 *
 * Every assertion here exists because the thing it checks was wrong once and
 * would not have shown up as an error. The dominant failure in this project is
 * a render feature that is silently discarded, and ground is the surface where
 * that is hardest to see: half of every frame is ground, and a mat that is
 * culled, a tint that is never attached and a texture magnified past the point
 * of being a texture all look identical to a flat brown field.
 */
describe('the ground', () => {
  /** Every triangle's face normal. */
  function faceNormals(geometry: THREE.BufferGeometry): THREE.Vector3[] {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const out: THREE.Vector3[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2);
      out.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize());
    }
    return out;
  }

  const flat = (): number => 0;

  it('carries the tint the ground material asks for', () => {
    /*
     * `groundTint` was written for the terrain, applied only to rocks, and the
     * ground material was built with `vertexColors: true` against a geometry
     * that had no colour attribute at all — for three art reviews. That is not
     * a neutral mistake either: `MeshStandardMaterial` has no
     * `defaultAttributeValues`, so a missing `color` leaves the shader reading
     * the generic vertex attribute, whose specified default is black.
     */
    const terrain = createTerrainGeometry(46, 26, 7, 0.7);
    const colors = terrain.getAttribute('color') as THREE.BufferAttribute | undefined;
    expect(colors, 'the terrain must carry a colour attribute').toBeDefined();
    const position = terrain.getAttribute('position') as THREE.BufferAttribute;
    expect(colors?.count).toBe(position.count);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < (colors?.count ?? 0); i++) {
      const v = colors?.getY(i) ?? 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Centred on 1, so the manifest's own ground colour is still the ground
    // colour, and wide enough that the variation survives the dither.
    expect(min).toBeGreaterThan(0.6);
    expect(max).toBeLessThan(1.6);
    expect(max - min).toBeGreaterThan(0.2);
  });

  it('draws the mat face up, or does not draw it at all', () => {
    /*
     * The one that cost the most to find. Wound outward-then-round, these
     * triangles face *down*, and every material in this scene is `FrontSide` —
     * so the whole clearing floor was culled and the picture was identical to
     * the picture without it. Caught by rendering the scene offline and
     * noticing that the campfire lit the ground showing through the fire pit's
     * hole and nothing around it.
     */
    const cover = createGroundCoverGeometry({ seed: 3, height: flat });
    for (const piece of [cover.worn, cover.duff]) {
      for (const normal of faceNormals(piece)) expect(normal.y).toBeGreaterThan(0.5);
    }
    for (const kind of ['pebble', 'sprig'] as const) {
      for (const normal of faceNormals(createLitterGeometry(kind, 11))) {
        expect(normal.y).toBeGreaterThan(0.1);
      }
    }
  });

  it('leaves the fire pit alone', () => {
    // The ash bed is a disc of radius 0.42 five millimetres off the ground and
    // the ring stones stand at 0.4. A mat over the top of those buries the one
    // object the whole game is pointed at.
    const cover = createGroundCoverGeometry({ seed: 3, height: flat });
    const position = cover.worn.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      expect(Math.hypot(position.getX(i), position.getZ(i))).toBeGreaterThan(0.5);
    }
  });

  it('gives the worn ring a ragged edge rather than a circle', () => {
    // A circle reads as a decal, which is the failure every other fix in this
    // area has been correcting.
    const cover = createGroundCoverGeometry({ seed: 3, height: flat });
    const position = cover.duff.getAttribute('position') as THREE.BufferAttribute;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getZ(i));
      // The inner rim only: the outer one is a circle on purpose.
      if (r > 5) continue;
      if (r < min) min = r;
      if (r > max) max = r;
    }
    expect(max - min).toBeGreaterThan(0.6);
  });

  it('meets the terrain the renderer draws, not the one the player walks', () => {
    /*
     * The drawn ground is flat triangles through samples of `terrainHeight`,
     * and departs from it by up to nine centimetres between vertices, in both
     * directions. A mat laid at the analytic height and lifted a centimetre
     * and a half is swallowed across a good fraction of its area, in patches.
     */
    const grid = { size: 46, segments: 26, seed: 7, amplitude: 0.7 };
    const cover = createGroundCoverGeometry({
      seed: 7,
      height: (x: number, z: number) => drawnTerrainHeight(x, z, grid),
    });
    const position = cover.duff.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const above = position.getY(i) - drawnTerrainHeight(position.getX(i), position.getZ(i), grid);
      expect(above).toBeGreaterThan(0);
      expect(above).toBeLessThan(0.05);
    }
  });

  it('stays inside its share of the budget', () => {
    // Four draw calls and about a thousand triangles for the eight metres that
    // are half of every frame, against ARCHITECTURE §10's 120 and 60k.
    for (const spokes of [14, 20, 26]) {
      const cover = createGroundCoverGeometry({ seed: 1, spokes, height: flat });
      expect(cover.triangles).toBeLessThanOrEqual(480);
      expect(triangles(cover.worn) + triangles(cover.duff)).toBe(cover.triangles);
    }
    expect(triangles(createLitterGeometry('pebble', 1))).toBeLessThanOrEqual(8);
    expect(triangles(createLitterGeometry('sprig', 1))).toBeLessThanOrEqual(4);
  });

  it('is the same ground twice for the same seed', () => {
    const a = createGroundCoverGeometry({ seed: 90210, height: flat });
    const b = createGroundCoverGeometry({ seed: 90210, height: flat });
    expect(Array.from((a.worn.getAttribute('position') as THREE.BufferAttribute).array)).toEqual(
      Array.from((b.worn.getAttribute('position') as THREE.BufferAttribute).array),
    );
  });
});

/**
 * `BoxGeometry` lays 0..1 UVs across every face whatever size the face is, so
 * a metre-wide bear box magnified a 64-pixel tile to a centimetre and a half a
 * texel. An art review picked exactly one object out of a dusk frame and
 * called it "a plain grey rectangle... an untextured box".
 */
describe('a box that is a surface', () => {
  function uvExtent(geometry: THREE.BufferGeometry): number {
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    let max = 0;
    for (let i = 0; i < uv.count; i++) max = Math.max(max, uv.getX(i), uv.getY(i));
    return max;
  }

  it('tiles by the metre rather than by the face', () => {
    expect(uvExtent(createBoxGeometry(0.1, 0.1, 0.1, { tile: 0.4 }))).toBeCloseTo(0.25, 5);
    expect(uvExtent(createBoxGeometry(1.6, 1.6, 1.6, { tile: 0.4 }))).toBeCloseTo(4, 5);
  });

  it('weathers: lit on top, dark underneath, dirtier at the foot', () => {
    const geometry = createBoxGeometry(1, 1, 1, { seed: 5 });
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute;
    let top = 0;
    let bottom = 0;
    let sideLow = 0;
    let sideHigh = 0;
    for (let i = 0; i < position.count; i++) {
      const value = color.getY(i);
      if (normal.getY(i) > 0.5) top = Math.max(top, value);
      else if (normal.getY(i) < -0.5) bottom = Math.max(bottom, value);
      else if (position.getY(i) < 0) sideLow = Math.max(sideLow, value);
      else sideHigh = Math.max(sideHigh, value);
    }
    expect(top).toBeGreaterThan(sideHigh);
    expect(sideHigh).toBeGreaterThan(sideLow);
    expect(sideLow).toBeGreaterThan(bottom);
  });
});
