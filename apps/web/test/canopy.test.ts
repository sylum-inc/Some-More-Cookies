/**
 * The crowns over the clearing.
 *
 * `world-stargazing` is captioned "only a ragged patch of sky through the
 * crowns", and a review pointed out that the frame contained no crowns: 95%
 * flat black, dots at an even density, no framing, no silhouette, no scale
 * reference. The caption described something nobody had drawn.
 *
 * What is asserted here is the *composition*, because that is what was wrong
 * and it is measurable. The stargazing view is aimed at the zenith through the
 * explore lens — 68 degrees vertical over a 16:9 frame — so where the frame's
 * edges and corners fall as angles from straight up is arithmetic, and whether
 * a bough covers them is a question with an answer.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCanopy, shadeCanopy } from '../src/scene/NightSky.js';

const DEG = Math.PI / 180;
/** Pine Hollow's own `skyOpenness`: a bowl in the trees, a third of the sky. */
const HOLLOW = 0.32;

/** Every vertex as (zenith angle, azimuth), which is the frame it composes in. */
function polar(geometry: THREE.BufferGeometry): { zenith: number; azimuth: number }[] {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const out: { zenith: number; azimuth: number }[] = [];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, y, z);
    out.push({
      zenith: Math.acos(Math.min(1, Math.max(-1, y / radius))),
      azimuth: Math.atan2(x, z),
    });
  }
  return out;
}

describe('the crowns exist and are shaped like crowns', () => {
  it('draws boughs at all', () => {
    const canopy = buildCanopy(HOLLOW, 24);
    const position = canopy.getAttribute('position') as THREE.BufferAttribute;
    expect(position.count).toBeGreaterThan(200);
    expect(canopy.getIndex()?.count ?? 0).toBeGreaterThan(300);
  });

  it('leaves an irregular hole rather than a circular aperture', () => {
    /*
     * The inner rim is the composition. If every bough reached the same
     * distance from the zenith the opening would be a clean disc, which reads
     * as the mouth of a tunnel — the first render of this did exactly that at
     * its *outer* rim and looked like a cave.
     */
    const points = polar(buildCanopy(HOLLOW, 24));
    const tips = points.map((p) => p.zenith).sort((a, b) => a - b);
    const nearest = tips[0] as number;
    const rim = tips[Math.floor(tips.length * 0.06)] as number;
    expect(rim - nearest).toBeGreaterThan(4 * DEG);
  });

  it('bites into all four edges of a view aimed at the zenith', () => {
    /*
     * At 68 degrees vertical on 16:9 the frame's top and bottom edges sit
     * about 34 degrees from the axis and its left and right about 50, with the
     * corners near 54. Foliage has to cross the shorter pair or the "hole"
     * simply is the frame.
     */
    const points = polar(buildCanopy(HOLLOW, 24));
    const quadrants = [0, 0, 0, 0];
    for (const { zenith, azimuth } of points) {
      if (zenith > 34 * DEG) continue;
      const quadrant = Math.floor((((azimuth + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4);
      quadrants[quadrant] = (quadrants[quadrant] as number) + 1;
    }
    for (const count of quadrants) expect(count).toBeGreaterThan(0);
  });

  it('stays clear of a frame composed at the horizon', () => {
    /*
     * The arrival frames and the whole weather sheet are shot at a horizon
     * pitch against the treeline `Campsite` draws. Hanging foliage across the
     * top of those is a different change from the one that was asked for, so
     * the boughs stop well above where that frame ends — about 27 degrees of
     * altitude at the shallowest pitch the gallery uses.
     */
    const points = polar(buildCanopy(HOLLOW, 24));
    const lowest = Math.max(...points.map((p) => p.zenith));
    expect(90 * DEG - lowest).toBeGreaterThan(28 * DEG);
  });

  it('opens up as the catalogue says the sky opens up', () => {
    const closed = polar(buildCanopy(0, 24)).map((p) => p.zenith);
    const open = polar(buildCanopy(1, 24)).map((p) => p.zenith);
    expect(Math.min(...open)).toBeGreaterThan(Math.min(...closed));
  });

  it('scales its bough count without changing its shape', () => {
    const low = buildCanopy(HOLLOW, 14);
    const high = buildCanopy(HOLLOW, 32);
    const count = (g: THREE.BufferGeometry): number => (g.getAttribute('position') as THREE.BufferAttribute).count;
    expect(count(low)).toBeLessThan(count(high));
    // Both still reach the rim: a low tier gets fewer crowns, not no framing.
    expect(Math.min(...polar(low).map((p) => p.zenith))).toBeLessThan(40 * DEG);
  });
});

describe('a dark surface, never a black rectangle (D7)', () => {
  it('never writes zero, even with the fire out and no sun', () => {
    const canopy = buildCanopy(HOLLOW, 24);
    shadeCanopy(canopy, 0, 0);
    const colours = canopy.getAttribute('color') as THREE.BufferAttribute;
    let darkest = Infinity;
    for (let i = 0; i < colours.count; i++) {
      darkest = Math.min(darkest, colours.getX(i) + colours.getY(i) + colours.getZ(i));
    }
    /*
     * The frame this whole change exists for measured 95% black. Replacing an
     * empty black frame with a black silhouette on a black frame would be the
     * same picture with more triangles in it.
     */
    // In linear light. Through the sRGB transfer that is about #0d0f14 — a
    // dark value with three counts of blue in it, not a hole.
    expect(darkest).toBeGreaterThan(0.005);
  });

  it('is mottled rather than one flat value', () => {
    const canopy = buildCanopy(HOLLOW, 24);
    shadeCanopy(canopy, 0, 0);
    const colours = canopy.getAttribute('color') as THREE.BufferAttribute;
    const values = new Set<string>();
    for (let i = 0; i < colours.count; i++) values.add(colours.getX(i).toFixed(4));
    expect(values.size).toBeGreaterThan(8);
  });

  it('takes the fire on its undersides and nowhere else', () => {
    const cold = buildCanopy(HOLLOW, 24);
    shadeCanopy(cold, 0, 0);
    const warm = buildCanopy(HOLLOW, 24);
    shadeCanopy(warm, 1, 0);
    const coldColours = cold.getAttribute('color') as THREE.BufferAttribute;
    const warmColours = warm.getAttribute('color') as THREE.BufferAttribute;
    const points = polar(cold);

    let rootGain = 0;
    let tipGain = 0;
    for (let i = 0; i < coldColours.count; i++) {
      const gain = warmColours.getX(i) - coldColours.getX(i);
      // Low in the sky is near the clearing, and the clearing is where the
      // fire is; up at the zenith is the top of the canopy.
      // The rim is ragged at both ends, so the two bands are taken well
      // apart: a bough's root can sit anywhere from 51 to 61 degrees out.
      const zenith = (points[i] as { zenith: number }).zenith;
      if (zenith > 54 * DEG) rootGain = Math.max(rootGain, gain);
      else if (zenith < 40 * DEG) tipGain = Math.max(tipGain, gain);
    }
    expect(rootGain).toBeGreaterThan(tipGain * 2);
    /*
     * And a hint of it, not a light rig. Two earlier passes put a blazing
     * orange sunburst and then a copper bowl over the sky, both of which
     * compiled perfectly.
     */
    expect(rootGain).toBeLessThan(0.05);
  });

  it('turns from blue-black to backlit green when the sun is up', () => {
    const night = buildCanopy(HOLLOW, 24);
    shadeCanopy(night, 0, 0);
    const day = buildCanopy(HOLLOW, 24);
    shadeCanopy(day, 0, 1);
    const nightColours = night.getAttribute('color') as THREE.BufferAttribute;
    const dayColours = day.getAttribute('color') as THREE.BufferAttribute;
    // Blue-dominant at night, green-dominant in daylight.
    expect(nightColours.getZ(0)).toBeGreaterThan(nightColours.getY(0));
    expect(dayColours.getY(0)).toBeGreaterThan(dayColours.getZ(0));
  });
});
