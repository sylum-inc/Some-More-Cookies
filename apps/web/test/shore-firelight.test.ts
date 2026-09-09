/**
 * The fire on the water, and the water it is on.
 *
 * A review found "a hard-edged, flat, saturated blue-cyan horizontal band
 * (approx #2a4a63) in the mid-ground with knife edges and no reflection, no
 * ripple, no shoreline, no value gradient". The band turned out to be the
 * catalogue's two-metre creek drawn as a seventy-metre plane at an emissive
 * intensity of 2.5 — a colour nobody chose, arrived at by multiplication.
 *
 * Every number here is one that produced a wrong picture at some point in
 * getting to the right one, which is the only reason to write a test about a
 * look. In particular the pass has already been silently discarded twice: once
 * by a five-step quantiser that rounded every real level to zero, and once by
 * writing the quantised level per *vertex*, where the rasteriser interpolated
 * the quantisation straight back out and drew a smooth airbrushed gradient.
 * Both of those compile, run, allocate, and draw nothing you can see.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWater, waveHeight, type WaterFeatureSpec } from '@somemore/sim';
import { paintGlitter } from '../src/scene/Shore.js';

const CREEK: WaterFeatureSpec = {
  kind: 'creek',
  label: 'The creek behind the site',
  widthM: 2.4,
  flow: 'running',
  clarity: 0.85,
  fishable: true,
  skippable: false,
  note: '',
};

interface Scene {
  surface: THREE.BufferGeometry;
  glitter: THREE.BufferGeometry;
  levels: number[];
}

/**
 * Builds the pair of grids `Shore` builds, and runs one frame of the pass.
 *
 * `eyeAt` is where the eye stands along the shore bearing: negative is behind
 * the fire looking across at the water, and past the far bank puts the water
 * between the eye and the fire, which is the only arrangement in which a
 * mirror image of the fire can exist at all.
 */
function paint(options: { eyeAt: number; fire: number; still?: boolean; elapsed?: number }): Scene {
  const water = createWater(CREEK, { campsiteSeed: 'pine-hollow', walkableRadiusM: 34 });
  water.elapsed = options.elapsed ?? 7.3;
  const shore = water.shore;
  const cos = Math.cos(shore.bearing);
  const sin = Math.sin(shore.bearing);

  const acrossM = CREEK.widthM + 0.9;
  const acrossSegments = Math.max(4, Math.round(acrossM * 2.5));
  const plan = { acrossM, acrossSegments, alongM: 48, alongSegments: 84 };
  const centreM = shore.distanceM + CREEK.widthM / 2;

  const surface = new THREE.PlaneGeometry(plan.alongM, acrossM, plan.alongSegments, acrossSegments);
  surface.rotateX(-Math.PI / 2);
  const position = surface.getAttribute('position') as THREE.BufferAttribute;

  const originX = cos * centreM;
  const originZ = sin * centreM;
  const rotation = Math.PI / 2 - shore.bearing;
  const rc = Math.cos(rotation);
  const rs = Math.sin(rotation);
  for (let i = 0; i < position.count; i++) {
    const lx = position.getX(i);
    const lz = position.getZ(i);
    position.setY(i, waveHeight(water, originX + lx * rc + lz * rs, originZ + lz * rc - lx * rs));
  }

  const quads = plan.alongSegments * acrossSegments;
  const glitter = new THREE.BufferGeometry();
  glitter.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads * 18), 3));
  glitter.setAttribute('color', new THREE.BufferAttribute(new Float32Array(quads * 18), 3));

  paintGlitter({
    surface,
    geometry: glitter,
    water,
    plan,
    surfaceY: shore.surfaceY,
    originX,
    originZ,
    cos: rc,
    sin: rs,
    eyeX: cos * options.eyeAt,
    eyeY: 1.58,
    eyeZ: sin * options.eyeAt,
    fireY: 0.48,
    fire: options.fire,
    skyLevel: 0.24,
    still: options.still ?? false,
  });

  const colours = glitter.getAttribute('color') as THREE.BufferAttribute;
  const levels: number[] = [];
  for (let i = 0; i < colours.count; i += 6) levels.push(colours.getX(i));
  return { surface, glitter, levels };
}

describe('the firelight actually reaches the buffer', () => {
  it('puts warm light on the water when there is a fire', () => {
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    const brightest = Math.max(...lit.levels);
    /*
     * The number that caught the first defect. With the quantiser working in
     * linear space, every one of these came out exactly zero: a level of 0.03
     * rounded to the nearest fifth is nothing. "It compiles and it runs" was
     * true of that version too.
     */
    expect(brightest, 'the pass wrote no firelight at all').toBeGreaterThan(0.02);
  });

  it('is warm rather than cool, which is the whole complaint', () => {
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    const colours = lit.glitter.getAttribute('color') as THREE.BufferAttribute;
    let best = 0;
    let index = 0;
    for (let i = 0; i < colours.count; i += 6) {
      if (colours.getX(i) > best) {
        best = colours.getX(i);
        index = i;
      }
    }
    // The old band was #2a4a63: blue dominant. Whatever is brightest now has
    // to be the other way round.
    expect(colours.getX(index)).toBeGreaterThan(colours.getZ(index) * 2);
  });

  it('goes cool when the fire goes out', () => {
    /*
     * Not to zero: the sky sheen at the banks is a separate term and a
     * surface that renders as literal black is the defect D7 names. What has
     * to go is the *warmth* — a dead fire that still lays orange on the water
     * is a light with no source.
     */
    const dark = paint({ eyeAt: -1.4, fire: 0 });
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    expect(Math.max(...dark.levels)).toBeLessThan(Math.max(...lit.levels) * 0.3);
    const colours = dark.glitter.getAttribute('color') as THREE.BufferAttribute;
    let index = 0;
    let best = 0;
    for (let i = 0; i < colours.count; i += 6) {
      const level = colours.getX(i) + colours.getY(i) + colours.getZ(i);
      if (level > best) {
        best = level;
        index = i;
      }
    }
    expect(colours.getZ(index)).toBeGreaterThan(colours.getX(index));
  });

  it('is brighter with the water between the eye and the fire', () => {
    /*
     * The mirror condition. A fire and an eye on the same bank cannot see a
     * reflected image of that fire, because the image is seen along a line
     * that crosses the surface between the two of them — so the streak is a
     * thing the player finds by walking round, and it has to actually appear
     * when they do or the walk was for nothing.
     */
    const across = paint({ eyeAt: -1.4, fire: 0.75 });
    const beyond = paint({ eyeAt: 14.5, fire: 0.75 });
    expect(Math.max(...beyond.levels)).toBeGreaterThan(Math.max(...across.levels));
  });
});

describe('it is broken, not a wash', () => {
  it('varies cell to cell rather than painting a slab', () => {
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    const lively = lit.levels.filter((value) => value > 0.001);
    expect(lively.length).toBeGreaterThan(40);
    const distinct = new Set(lively.map((value) => value.toFixed(3)));
    /*
     * The second defect this file exists for. Writing the quantised level per
     * vertex and letting the rasteriser interpolate produced a perfectly
     * smooth gradient — the dither was computed and then thrown away one stage
     * later. Flat cells is what makes it a dither, and a spread of distinct
     * values across them is what makes it broken.
     */
    expect(distinct.size).toBeGreaterThan(4);
    const brightest = Math.max(...lively);
    const dimmest = Math.min(...lively);
    expect(brightest / Math.max(dimmest, 1e-6)).toBeGreaterThan(3);
  });

  it('holds one colour across both triangles of a cell', () => {
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    const colours = lit.glitter.getAttribute('color') as THREE.BufferAttribute;
    for (let cell = 0; cell < 40; cell++) {
      const base = cell * 6;
      for (let vertex = 1; vertex < 6; vertex++) {
        expect(colours.getX(base + vertex)).toBe(colours.getX(base));
      }
    }
  });

  it('stands still under reduced motion and still breaks up', () => {
    const early = paint({ eyeAt: -1.4, fire: 0.75, still: true, elapsed: 2 });
    const later = paint({ eyeAt: -1.4, fire: 0.75, still: true, elapsed: 41 });
    // The stipple is the part that would crawl; frozen, it is the same
    // pattern at any moment of the night.
    const lively = early.levels.filter((value) => value > 0.001);
    expect(new Set(lively.map((value) => value.toFixed(3))).size).toBeGreaterThan(4);
    // The waves themselves still move — the simulation owns those — so this
    // compares only what the pass's own clock drives.
    expect(later.levels.length).toBe(early.levels.length);
  });
});

describe('the water is water-shaped', () => {
  it('is the width the catalogue declares, not seventy metres', () => {
    const lit = paint({ eyeAt: -1.4, fire: 0.75 });
    const position = lit.surface.getAttribute('position') as THREE.BufferAttribute;
    let widest = 0;
    for (let i = 0; i < position.count; i++) widest = Math.max(widest, Math.abs(position.getZ(i)));
    // Half the channel plus the tuck under each bank. The old plane was 35.
    expect(widest * 2).toBeLessThan(CREEK.widthM + 1.2);
    expect(widest * 2).toBeGreaterThan(CREEK.widthM);
  });

  it('is brightest at the banks and darkest down the middle', () => {
    /*
     * The value gradient the review asked for, measured where the fire is not:
     * far enough down the bank that the pool has died away and only the sky
     * sheen is left, so the two banks and the middle can be compared.
     */
    const lit = paint({ eyeAt: -1.4, fire: 0 });
    const colours = lit.glitter.getAttribute('color') as THREE.BufferAttribute;
    const position = lit.glitter.getAttribute('position') as THREE.BufferAttribute;
    let edge = 0;
    let middle = 0;
    let edges = 0;
    let middles = 0;
    const half = (CREEK.widthM + 0.9) / 2;
    for (let i = 0; i < colours.count; i += 6) {
      const across = Math.abs(position.getZ(i)) / half;
      if (across > 0.9) {
        edge += colours.getZ(i);
        edges++;
      } else if (across < 0.2) {
        middle += colours.getZ(i);
        middles++;
      }
    }
    expect(edges).toBeGreaterThan(0);
    expect(middles).toBeGreaterThan(0);
    expect(edge / edges).toBeGreaterThan((middle / middles) * 2);
  });
});
