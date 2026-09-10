/**
 * The SM-01's unwrap.
 *
 * This file exists because of the lesson this codebase keeps re-learning: a
 * render feature that is silently discarded looks exactly like one that was
 * never written. The cabinet's paint — the s'more mark on the crown, the
 * painted sign on the flank, the rust under the hinges, the glow slot over the
 * drip tray — is placed in *metres* on an elevation, and it only arrives on
 * the machine if every face is projected onto the matching elevation at the
 * matching scale. Get that wrong and nothing throws, nothing looks broken in
 * the texture, and the graphic is simply somewhere else on the box.
 *
 * Two failures in particular are asserted here because both have already
 * happened in this project:
 *
 *   - `BoxGeometry` UVs run 0..1 corner to corner on every face, so the same
 *     tile lands at wildly different texel densities on a 0.86 m panel and a
 *     0.03 m post. That is what made the grille slats read as a flat dark
 *     rectangle, and it is the thing a planar unwrap exists to stop.
 *   - The painted condenser bay and the real condenser fins were drawn 16 cm
 *     apart — the fins at 0.15–0.31 m and the paint for a bay at 0.07–0.24 m —
 *     so the light would have come out above the vents it is supposed to be
 *     leaking through.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BODY,
  CROWN,
  DOOR,
  DRIP_TRAY,
  FINS,
  GASKET,
  PANEL,
  WINDOW,
  buildAluminiumTrim,
  buildDoorLeaf,
  buildEnamelShell,
  buildSlabFrame,
  regionUv,
} from '../src/render/machineShell.js';
import {
  MACHINE_ATLAS,
  MACHINE_ATLAS_SIZE,
  MACHINE_DOOR_ATLAS,
  MACHINE_DOOR_ATLAS_SIZE,
} from '../src/render/textures.js';

/** Every vertex, as position + normal + uv. */
function vertices(geometry: THREE.BufferGeometry): Array<{
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
}> {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const out = [];
  for (let i = 0; i < position.count; i++) {
    out.push({
      x: position.getX(i),
      y: position.getY(i),
      z: position.getZ(i),
      nx: normal.getX(i),
      ny: normal.getY(i),
      nz: normal.getZ(i),
      u: uv.getX(i),
      v: uv.getY(i),
    });
  }
  return out;
}

/**
 * Where a region's edges sit in UV space.
 *
 * The elevation's *bottom* is the region's *lowest* v, which is the opposite
 * of its canvas row: `CanvasTexture` flips on upload, so the row at the bottom
 * of the drawing is the row at the bottom of the texture.
 */
function bounds(region: (typeof MACHINE_ATLAS)['front'], size: number) {
  const [u0, v0] = regionUv(region, region.h[0], region.v[0], size);
  const [u1, v1] = regionUv(region, region.h[1], region.v[1], size);
  return { u0, u1, v0, v1 };
}

describe('the atlas layout', () => {
  it('keeps every region inside the texture and out of each other', () => {
    const regions = Object.values(MACHINE_ATLAS);
    for (const region of regions) {
      expect(region.px).toBeGreaterThanOrEqual(0);
      expect(region.py).toBeGreaterThanOrEqual(0);
      expect(region.px + region.pw).toBeLessThanOrEqual(MACHINE_ATLAS_SIZE);
      expect(region.py + region.ph).toBeLessThanOrEqual(MACHINE_ATLAS_SIZE);
    }
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i]!;
        const b = regions[j]!;
        const apart =
          a.px + a.pw <= b.px || b.px + b.pw <= a.px || a.py + a.ph <= b.py || b.py + b.ph <= a.py;
        expect(apart).toBe(true);
      }
    }
  });

  it('draws the front and the flank at the same texel density', () => {
    // Anisotropy here is a stretched graphic. The back is deliberately squashed
    // and is excluded; nothing is drawn on it but horizontal bands.
    for (const region of [MACHINE_ATLAS.front, MACHINE_ATLAS.side]) {
      const across = region.pw / (region.h[1] - region.h[0]);
      const up = region.ph / (region.v[1] - region.v[0]);
      expect(Math.abs(across - up) / across).toBeLessThan(0.05);
      expect(across).toBeGreaterThan(100);
      expect(across).toBeLessThan(200);
    }
  });

  it('draws the door at the body density, so the two skins match at the seam', () => {
    const body = MACHINE_ATLAS.front.pw / (MACHINE_ATLAS.front.h[1] - MACHINE_ATLAS.front.h[0]);
    const face = MACHINE_DOOR_ATLAS.face;
    const door = face.pw / (face.h[1] - face.h[0]);
    expect(Math.abs(door - body) / body).toBeLessThan(0.05);
  });
});

describe('the cabinet unwrap', () => {
  const shell = buildEnamelShell();
  const all = vertices(shell);

  it('sends every forward-facing vertex to the front elevation', () => {
    const front = bounds(MACHINE_ATLAS.front, MACHINE_ATLAS_SIZE);
    const facing = all.filter((p) => p.nz > 0.9);
    expect(facing.length).toBeGreaterThan(20);
    for (const p of facing) {
      expect(p.u).toBeGreaterThanOrEqual(front.u0 - 1e-6);
      expect(p.u).toBeLessThanOrEqual(front.u1 + 1e-6);
      expect(p.v).toBeGreaterThanOrEqual(front.v0 - 1e-6);
      expect(p.v).toBeLessThanOrEqual(front.v1 + 1e-6);
      // And to the right *place* on it, not merely inside the rectangle.
      const [u, v] = regionUv(MACHINE_ATLAS.front, p.x, p.y, MACHINE_ATLAS_SIZE);
      expect(p.u).toBeCloseTo(u, 6);
      expect(p.v).toBeCloseTo(v, 6);
    }
  });

  it('sends the flanks to the side elevation, mirrored so the sign reads from either hand', () => {
    for (const sign of [1, -1]) {
      const facing = all.filter((p) => p.nx * sign > 0.9);
      expect(facing.length).toBeGreaterThan(4);
      for (const p of facing) {
        const [u, v] = regionUv(MACHINE_ATLAS.side, p.z * sign, p.y, MACHINE_ATLAS_SIZE);
        expect(p.u).toBeCloseTo(u, 6);
        expect(p.v).toBeCloseTo(v, 6);
      }
    }
  });

  it('gives every face the same UV per metre, which per-face box UVs do not', () => {
    /*
     * The whole point of the unwrap. With `BoxGeometry`'s own UVs this ratio
     * is 1/width for every face, so the 0.52 m panel above the chamber and the
     * 0.17 m panel beside it would differ by a factor of three.
     */
    const expected = MACHINE_ATLAS.front.pw / (MACHINE_ATLAS.front.h[1] - MACHINE_ATLAS.front.h[0]) / MACHINE_ATLAS_SIZE;
    const facing = all.filter((p) => p.nz > 0.9);
    let compared = 0;
    for (let i = 0; i < facing.length; i++) {
      for (let j = i + 1; j < facing.length; j++) {
        const a = facing[i]!;
        const b = facing[j]!;
        const dx = Math.abs(a.x - b.x);
        if (dx < 0.02) continue;
        expect(Math.abs(a.u - b.u) / dx).toBeCloseTo(expected, 5);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('puts the crown board on the crown band of the elevation', () => {
    const top = CROWN.y + CROWN.height / 2;
    const bottom = CROWN.y - CROWN.height / 2;
    // The whole board has to be inside the region the paint is drawn in.
    expect(top).toBeLessThanOrEqual(MACHINE_ATLAS.front.v[1]);
    expect(bottom).toBeGreaterThan(BODY.height);
    const crownFace = all.filter((p) => p.nz > 0.9 && p.y > BODY.height + 0.02);
    expect(crownFace.length).toBeGreaterThan(3);
    for (const p of crownFace) {
      const [, v] = regionUv(MACHINE_ATLAS.front, 0, p.y, MACHINE_ATLAS_SIZE);
      expect(p.v).toBeCloseTo(v, 6);
    }
  });

  it('leaves no vertex outside the atlas', () => {
    // A region edge that lands exactly on 0 or 1 arrives a few billionths
    // either side of it, which is float arithmetic and not a bug.
    for (const p of all) {
      expect(p.u).toBeGreaterThanOrEqual(-1e-6);
      expect(p.u).toBeLessThanOrEqual(1 + 1e-6);
      expect(p.v).toBeGreaterThanOrEqual(-1e-6);
      expect(p.v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('the door unwrap', () => {
  it('puts the leaf face on the door elevation, in the door’s own frame', () => {
    const leaf = vertices(buildDoorLeaf());
    const facing = leaf.filter((p) => p.nz > 0.9);
    expect(facing.length).toBeGreaterThan(8);
    for (const p of facing) {
      const [u, v] = regionUv(MACHINE_DOOR_ATLAS.face, p.x, p.y, MACHINE_DOOR_ATLAS_SIZE);
      expect(p.u).toBeCloseTo(u, 6);
      expect(p.v).toBeCloseTo(v, 6);
    }
    // The handle end of the leaf, where the hand wear is painted, has to be
    // inside the drawn region rather than off the end of it.
    const rightmost = Math.max(...facing.map((p) => p.x));
    expect(rightmost).toBeLessThanOrEqual(MACHINE_DOOR_ATLAS.face.h[1] + 1e-6);
    expect(rightmost).toBeGreaterThan(0.5);
  });

  it('leaves the gasket alone, because rubber wears no elevation', () => {
    const gasket = vertices(buildSlabFrame(GASKET, WINDOW));
    // Still the stock box UVs: this one tiles a 64 px rubber texture.
    expect(gasket.some((p) => p.u === 0 && p.v === 1)).toBe(true);
  });
});

describe('the hardware the paint is drawn around', () => {
  it('keeps the condenser fins inside the bay painted behind them', () => {
    const lowest = FINS.baseY - FINS.thickness / 2;
    const highest = FINS.baseY + (FINS.count - 1) * FINS.pitch + FINS.thickness / 2;
    // The bay in `drawFrontElevation` is 0.064–0.222 m.
    expect(lowest).toBeGreaterThan(0.064);
    expect(highest).toBeLessThan(0.222);
  });

  it('keeps the drip tray under the glow slot and clear of the fins', () => {
    const trayTop = DRIP_TRAY.y + 0.03;
    const finsTop = FINS.baseY + (FINS.count - 1) * FINS.pitch + FINS.thickness / 2;
    expect(DRIP_TRAY.y - 0.008).toBeGreaterThan(finsTop);
    // The painted slot is 0.250–0.302 m and the emissive bar 0.256–0.296.
    expect(trayTop).toBeLessThanOrEqual(0.302);
    expect(trayTop).toBeGreaterThan(0.25);
  });

  it('keeps the switch row off the rating plate', () => {
    /*
     * The bug this is here for: the plate is 0.20 m tall and centred on the
     * panel, and the programme detents sat 0.07 m below the panel centre, so
     * every machine in the game was drawn with three switches standing in the
     * middle of the small print.
     */
    const plateBottom = PANEL.plate.y - PANEL.plate.height / 2;
    const switchTop = PANEL.y + PANEL.switchRowY + PANEL.switchRadius;
    expect(switchTop).toBeLessThan(plateBottom);
  });

  it('keeps the printed decal on the plate it is riveted to', () => {
    expect(PANEL.decal.width).toBeLessThanOrEqual(PANEL.plate.width);
    expect(PANEL.decal.height).toBeLessThanOrEqual(PANEL.plate.height);
    // And the plate proud of the panel it is on, because a decal flush with
    // the enamel is a print, not a plate.
    const trim = vertices(buildAluminiumTrim());
    const plateFace = Math.max(
      ...trim.filter((p) => p.nz > 0.9 && p.x < 0.02 && p.x > -0.42 && p.y > 0.79 && p.y < 1.01).map((p) => p.z),
    );
    expect(plateFace).toBeGreaterThan(BODY.depth / 2 + 0.008);
  });

  it('puts a hinge where the door actually pivots, so the rust starts somewhere', () => {
    const trim = vertices(buildAluminiumTrim());
    // The door group sits at x = -0.29; the knuckles stand just outside it.
    const hinge = trim.filter((p) => p.x < -0.28 && p.x > -0.33 && p.z > BODY.depth / 2);
    expect(hinge.length).toBeGreaterThan(0);
    const heights = hinge.map((p) => p.y);
    // One above the window and one below it, matching the painted streaks.
    expect(Math.max(...heights)).toBeGreaterThan(0.68);
    expect(Math.min(...heights)).toBeLessThan(0.44);
    expect(DOOR.height).toBeGreaterThan(0.4);
  });
});
