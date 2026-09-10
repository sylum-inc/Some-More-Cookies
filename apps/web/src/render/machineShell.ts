/**
 * The SM-01's static geometry, and the unwrap that gets paint onto it.
 *
 * This lives beside `Machine.tsx` rather than inside it for one reason: the
 * unwrap is the part of this object most likely to be silently wrong, and a
 * thing that can be silently wrong has to be a thing that can be built and
 * looked at without a browser. Everything here is pure geometry — no React, no
 * materials, no DOM — so an offline rasteriser can build the same cabinet the
 * game builds and photograph it.
 *
 * **The unwrap is the point.** A `BoxGeometry` gives every face UVs that run
 * 0..1 corner to corner, so a tile stretched over the 0.86 m front and the
 * same tile stretched over a 0.03 m corner post arrive at wildly different
 * texel densities — one is a texture and the other is a flat wash. Worse, a
 * graphic that has to be *in a particular place* cannot be expressed in
 * per-face UVs at all. So every face is instead projected onto whichever
 * elevation it faces, at one fixed scale in pixels per metre, and the painting
 * is done in metres in `textures.ts`.
 */

import * as THREE from 'three';
import { mergePlaced, type PlacedPart } from './geometry.js';
import {
  MACHINE_ATLAS,
  MACHINE_ATLAS_SIZE,
  MACHINE_DOOR_ATLAS,
  MACHINE_DOOR_ATLAS_SIZE,
  type AtlasRegion,
} from './textures.js';

/** Body dimensions in metres — roughly an upright freezer on rubber feet. */
export const BODY = { width: 0.86, height: 1.02, depth: 0.62 };

/** The chamber mouth cut into the front face, and the shell around it. */
export const CHAMBER = {
  width: 0.52,
  height: 0.42,
  /** Height of the opening's centre above the floor. */
  centreY: 0.56,
  /** Wall thickness of the cabinet shell. */
  shell: 0.06,
  /** Depth of the front frame. */
  frontDepth: 0.06,
};

/**
 * The sign board bolted to the top cap.
 *
 * An art review's verdict on this object was that it "does not say what it
 * is" — it read as a kiosk, an ATM, a small appliance, anything but a machine
 * that makes a s'more, because there was no food cue anywhere on it. The two
 * places a graphic can go on a cabinet this size are the upper front band and
 * the flank, and the upper front band was already carrying the placard, the
 * lamp, the readout and six controls.
 *
 * So the machine gets a crown, the way every piece of municipal equipment that
 * has to be identified from across a car park has one. It is also the only
 * change here that alters the silhouette, which is the only thing about this
 * object that survives at eleven metres.
 */
export const CROWN = { width: 0.66, height: 0.27, depth: 0.07, y: 1.195, z: 0.2 };

/** A rectangle in the door's own frame: centre, extent, and where it sits in depth. */
export interface Slab {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  depth: number;
}

/** The door leaf, hinged at the group origin on its left edge. */
export const DOOR: Slab = { x: 0.29, y: 0, width: 0.58, height: 0.48, z: 0.012, depth: 0.055 };
/** The rubber seal on its inner face. */
export const GASKET: Slab = { x: 0.29, y: 0, width: 0.56, height: 0.46, z: -0.016, depth: 0.012 };
/** The smoked window cut through both. */
export const WINDOW = { x: 0.29, y: 0.03, width: 0.34, height: 0.24 };

/** Where the drip tray sits, in cabinet space. Shared with the emissive mask. */
export const DRIP_TRAY = { width: 0.42, y: 0.238, z: BODY.depth / 2 + 0.036 };

/**
 * The condenser fins on the front, and the bay painted behind them.
 *
 * Shared with `textures.ts` in spirit and pinned here in fact: the painted bay,
 * the emissive bars that make the vents glow while the machine works, and the
 * fins themselves have to line up to within a couple of millimetres or the
 * light comes out of the wrong place. They were 16 cm apart when this started —
 * the fins sat at 0.15–0.31 m and the paint was drawn for a bay at 0.07–0.24 m
 * — which is the kind of mistake that only ever shows up in a render.
 */
export const FINS = { count: 6, baseY: 0.078, pitch: 0.026, width: 0.34, thickness: 0.011 };

/**
 * The control panel's layout, shared between the trim geometry and the JSX.
 *
 * It is here rather than spread across two files because the two halves of it
 * had drifted into each other: the rating plate is 0.40 m by 0.20 m and the
 * three programme detents sat 0.07 m below the panel centre, which put the
 * switches inside the plate — every machine in the game was drawn with its
 * programme knobs standing in the middle of the small print. Numbers that have
 * to clear each other belong next to each other, and `machineShell.test.ts`
 * asserts that they do.
 */
export const PANEL = {
  /** Centre of the control-panel group, in cabinet space. */
  y: 0.86,
  z: BODY.depth / 2 + 0.002,
  /** The riveted rating plate the printed decal is stuck to. */
  plate: { x: -0.2, y: 0.9, width: 0.43, height: 0.215, depth: 0.019 },
  /** The printed decal itself, sitting a millimetre proud of the plate. */
  decal: { width: 0.4, height: 0.2, standoff: 0.001 },
  /** How far the switch row sits below the group centre. */
  switchRowY: -0.1,
  /** The largest control on that row, for the clearance check. */
  switchRadius: 0.024,
};

const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);

/** Merges the parts and disposes the sources, which exist only to be merged. */
function bake(parts: readonly PlacedPart[]): THREE.BufferGeometry {
  const merged = mergePlaced(parts);
  for (const part of parts) part.geometry.dispose();
  return merged;
}

/**
 * The enamel cabinet: back, sides, top, bottom, the front face built as a
 * frame around the chamber mouth, and the crown board above it.
 *
 * Built as a shell with a real opening rather than one solid box. A single box
 * has no hole in it, so opening the door revealed the machine's own front
 * panel with the sandwich sealed inside the geometry — the reveal could not
 * work until the chamber had a mouth.
 */
export function buildEnamelShell(): THREE.BufferGeometry {
  const z = BODY.depth / 2 - CHAMBER.frontDepth / 2;
  const sideWidth = (BODY.width - CHAMBER.width) / 2;
  const above = BODY.height - (CHAMBER.centreY + CHAMBER.height / 2);
  const below = CHAMBER.centreY - CHAMBER.height / 2;
  const parts: PlacedPart[] = [
    { geometry: box(BODY.width, BODY.height, CHAMBER.shell), position: [0, BODY.height / 2, -BODY.depth / 2 + CHAMBER.shell / 2] },
    { geometry: box(BODY.width, CHAMBER.shell, BODY.depth), position: [0, BODY.height - CHAMBER.shell / 2, 0] },
    { geometry: box(BODY.width, CHAMBER.shell, BODY.depth), position: [0, CHAMBER.shell / 2, 0] },
    { geometry: box(CHAMBER.width, above, CHAMBER.frontDepth), position: [0, BODY.height - above / 2, z] },
    { geometry: box(CHAMBER.width, below, CHAMBER.frontDepth), position: [0, below / 2, z] },
    { geometry: box(CROWN.width, CROWN.height, CROWN.depth), position: [0, CROWN.y, CROWN.z] },
  ];
  for (const side of [-1, 1]) {
    parts.push({ geometry: box(CHAMBER.shell, BODY.height, BODY.depth), position: [side * (BODY.width / 2 - CHAMBER.shell / 2), BODY.height / 2, 0] });
    parts.push({ geometry: box(sideWidth, BODY.height, CHAMBER.frontDepth), position: [side * (BODY.width / 2 - sideWidth / 2), BODY.height / 2, z] });
  }
  const geometry = bake(parts);
  applyElevationUvs(geometry);
  return geometry;
}

/**
 * Everything aluminium: plinth, top cap, chamber bezel, condenser fins, corner
 * posts, the grille surround, the crown cap, the door hinges, the placard's
 * mounting plate and the drip tray.
 *
 * The front used to be one large enamel plane with everything on it lying
 * flush: the decal, the readout, the door. A flat plane facing the camera has
 * no internal form no matter how it is lit or what material it wears — which
 * is why this cabinet rendered as a single beige silhouette despite being
 * built from twenty-three boxes in four materials, and why relighting the
 * campsite did nothing for it. Everything here faces a different way from the
 * panel behind it, or is made of something with a different roughness, or
 * both. That is what a surface needs in order to be read as a surface.
 */
export function buildAluminiumTrim(): THREE.BufferGeometry {
  const lip = 0.038;
  const bezelZ = BODY.depth / 2 + 0.014;
  const halfW = CHAMBER.width / 2 + lip / 2;
  const halfH = CHAMBER.height / 2 + lip / 2;
  const parts: PlacedPart[] = [
    { geometry: box(BODY.width + 0.03, 0.09, BODY.depth + 0.03), position: [0, 0.045, 0] },
    { geometry: box(BODY.width + 0.04, 0.05, BODY.depth + 0.04), position: [0, BODY.height + 0.025, 0] },
    // The grille surround, low on the back where the cold plant breathes.
    { geometry: box(0.6, 0.2, 0.012), position: [0, 0.16, -BODY.depth / 2 - 0.004] },
    // The weather cap along the top of the crown board. There are no mounting
    // cheeks: anything short enough to read as a bracket is entirely buried
    // inside the 5 cm top cap, which is a mesh nobody would ever see.
    { geometry: box(CROWN.width + 0.04, 0.03, CROWN.depth + 0.02), position: [0, CROWN.y + CROWN.height / 2 + 0.012, CROWN.z] },
    /*
     * The placard's mounting plate.
     *
     * The plate used to be a texture on a plane lying flat on the enamel, and
     * a decal that is flush with the panel it is on is not a plate, it is a
     * print. Two centimetres of aluminium under it is the whole difference
     * between "a sticker" and "a rating plate somebody riveted on".
     */
    {
      geometry: box(PANEL.plate.width, PANEL.plate.height, PANEL.plate.depth),
      position: [PANEL.plate.x, PANEL.plate.y, BODY.depth / 2 + PANEL.plate.depth / 2 - 0.007],
    },
  ];
  // A bezel standing proud around the chamber mouth, so the door reads as set
  // into a frame rather than painted onto a wall.
  for (const sy of [1, -1]) {
    parts.push({ geometry: box(CHAMBER.width + lip * 2, lip, 0.03), position: [0, CHAMBER.centreY + sy * halfH, bezelZ] });
  }
  for (const sx of [1, -1]) {
    parts.push({ geometry: box(lip, CHAMBER.height, 0.03), position: [sx * halfW, CHAMBER.centreY, bezelZ] });
  }
  /*
   * Condenser fins, low on the front where the cold plant would sit.
   * Horizontal edges against a vertical panel: the one arrangement that
   * catches a low moon and a fire at the same time.
   */
  for (let i = 0; i < FINS.count; i++) {
    parts.push({
      geometry: box(FINS.width, FINS.thickness, 0.022),
      position: [0, FINS.baseY + i * FINS.pitch, BODY.depth / 2 + 0.009],
    });
  }
  /*
   * Corner posts down the front edges. They break the silhouette, which is
   * the only thing that reads at all once you are more than a couple of
   * metres away and the panel detail has gone.
   */
  for (const sx of [-1, 1]) {
    parts.push({ geometry: box(0.03, BODY.height - 0.14, 0.03), position: [sx * (BODY.width / 2 - 0.012), BODY.height / 2 + 0.03, BODY.depth / 2 - 0.012] });
  }
  /*
   * The door hinges, which the cabinet did not have.
   *
   * The door swung on nothing: it rotated about the edge of a group and there
   * was no hardware there at all. That mattered beyond pedantry, because the
   * review asked for rust streaks *below the hinges* and rust weeping out of
   * nowhere is just a dirty mark. Two knuckles and two jamb plates, and the
   * streaks painted under them in the atlas now start somewhere.
   */
  for (const sy of [1, -1]) {
    const y = CHAMBER.centreY + sy * 0.16;
    parts.push({ geometry: box(0.055, 0.05, 0.014), position: [-0.312, y, BODY.depth / 2 + 0.007] });
    parts.push({
      geometry: new THREE.CylinderGeometry(0.015, 0.015, 0.056, 8),
      position: [-0.299, y, BODY.depth / 2 + 0.028],
    });
  }
  /*
   * The drip tray.
   *
   * A transformation freezer defrosts, and what a defrosting appliance has
   * under its door is a tray. It is also the only honest way to give this
   * object the "dispensing tray" cue an art review asked for: the SM-01 does
   * not vend anything — the player opens the door and lifts the sandwich out
   * with their own hand — so a chute would be a machine promising something it
   * never does, and §4.4's rule about commerce staying out of the ritual is
   * partly a rule about not lying with hardware.
   */
  parts.push({ geometry: box(DRIP_TRAY.width, 0.016, 0.078), position: [0, DRIP_TRAY.y, DRIP_TRAY.z] });
  parts.push({ geometry: box(DRIP_TRAY.width, 0.03, 0.012), position: [0, DRIP_TRAY.y + 0.015, DRIP_TRAY.z + 0.039] });
  for (const sx of [-1, 1]) {
    parts.push({ geometry: box(0.014, 0.03, 0.078), position: [sx * (DRIP_TRAY.width / 2 - 0.007), DRIP_TRAY.y + 0.015, DRIP_TRAY.z] });
  }
  return bake(parts);
}

/**
 * The rubber: a shadow gap under the top cap, and four feet.
 *
 * A recess reads as a seam between two pressings; without one the cabinet is
 * a single extrusion.
 */
export function buildRubberTrim(): THREE.BufferGeometry {
  const parts: PlacedPart[] = [
    { geometry: box(BODY.width - 0.05, 0.014, 0.02), position: [0, BODY.height - 0.055, BODY.depth / 2 - 0.006] },
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({
        geometry: new THREE.CylinderGeometry(0.04, 0.045, 0.024, 8),
        position: [sx * (BODY.width / 2 - 0.08), 0.012, sz * (BODY.depth / 2 - 0.08)],
      });
    }
  }
  return bake(parts);
}

/** The seven grille slats over the vent, which share one dark plastic. */
export function buildGrilleSlats(): THREE.BufferGeometry {
  const parts: PlacedPart[] = [];
  for (let i = 0; i < 7; i++) {
    parts.push({ geometry: box(0.56, 0.008, 0.006), position: [0, 0.09 + i * 0.026, -BODY.depth / 2 - 0.012] });
  }
  return bake(parts);
}

/** A door slab's four enamel pieces, or its gasket's four, as one geometry. */
export function buildSlabFrame(
  slab: Slab,
  hole: { x: number; y: number; width: number; height: number },
): THREE.BufferGeometry {
  return bake(
    doorFrame(slab, hole).map((piece) => ({
      geometry: box(piece.width, piece.height, slab.depth),
      position: [piece.x, piece.y, slab.z] as const,
    })),
  );
}

/** The door leaf, unwrapped onto its own elevation. */
export function buildDoorLeaf(): THREE.BufferGeometry {
  const geometry = buildSlabFrame(DOOR, WINDOW);
  applyDoorUvs(geometry);
  return geometry;
}

/**
 * A slab with a rectangular hole in it, as four boxes: a band above the hole,
 * a band below, and a jamb either side between them.
 */
export function doorFrame(
  slab: Slab,
  hole: { x: number; y: number; width: number; height: number },
): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
  const top = slab.y + slab.height / 2;
  const bottom = slab.y - slab.height / 2;
  const left = slab.x - slab.width / 2;
  const right = slab.x + slab.width / 2;
  const holeTop = hole.y + hole.height / 2;
  const holeBottom = hole.y - hole.height / 2;
  const holeLeft = hole.x - hole.width / 2;
  const holeRight = hole.x + hole.width / 2;
  return [
    { x: slab.x, y: (top + holeTop) / 2, width: slab.width, height: top - holeTop },
    { x: slab.x, y: (bottom + holeBottom) / 2, width: slab.width, height: holeBottom - bottom },
    { x: (left + holeLeft) / 2, y: hole.y, width: holeLeft - left, height: hole.height },
    { x: (right + holeRight) / 2, y: hole.y, width: right - holeRight, height: hole.height },
  ];
}

/* -------------------------------------------------------------------------- */
/* The unwrap                                                                 */
/* -------------------------------------------------------------------------- */

/** Converts a point on an elevation, in metres, to a UV in the atlas. */
export function regionUv(region: AtlasRegion, h: number, v: number, atlasSize: number): [number, number] {
  const hFrac = (h - region.h[0]) / (region.h[1] - region.h[0]);
  const vFrac = (v - region.v[0]) / (region.v[1] - region.v[0]);
  return [
    (region.px + hFrac * region.pw) / atlasSize,
    // Canvas y runs down and `CanvasTexture` flips on upload, so the bottom of
    // the elevation is the bottom of the region.
    1 - (region.py + (1 - vFrac) * region.ph) / atlasSize,
  ];
}

/**
 * Projects every face of the cabinet onto the elevation it faces.
 *
 * Face normals decide, not vertex position: a merged box soup has no idea
 * which box a triangle came from, but every triangle knows which way it looks,
 * and on a cabinet built entirely from axis-aligned boxes that is the same
 * information. `BoxGeometry` duplicates its corners per face, so each vertex
 * carries exactly one face normal and there is nothing to average.
 */
export function applyElevationUvs(geometry: THREE.BufferGeometry, atlasSize = MACHINE_ATLAS_SIZE): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    let coords: [number, number];
    if (nz >= nx && nz >= ny) {
      coords = regionUv(normal.getZ(i) > 0 ? MACHINE_ATLAS.front : MACHINE_ATLAS.back, x, y, atlasSize);
    } else if (nx >= ny) {
      // Mirrored on the far flank so the painted sign is the right way round
      // from either side, and so neither side gets a stretched leftover patch.
      coords = regionUv(MACHINE_ATLAS.side, normal.getX(i) > 0 ? z : -z, y, atlasSize);
    } else if (normal.getY(i) > 0) {
      coords = regionUv(MACHINE_ATLAS.top, x, z, atlasSize);
    } else {
      // Undersides. Nobody stands under a freezer; they get the plain strip.
      const hFrac = (x + BODY.width / 2) / BODY.width;
      const vFrac = (z + BODY.depth / 2) / BODY.depth;
      coords = regionUv(MACHINE_ATLAS.misc, hFrac, vFrac, atlasSize);
    }
    uv.setXY(i, coords[0], coords[1]);
  }
  uv.needsUpdate = true;
}

/** The same projection for the door leaf, in the door's own frame. */
export function applyDoorUvs(geometry: THREE.BufferGeometry, atlasSize = MACHINE_DOOR_ATLAS_SIZE): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    let coords: [number, number];
    if (normal.getZ(i) > 0.5) {
      coords = regionUv(MACHINE_DOOR_ATLAS.face, x, y, atlasSize);
    } else {
      // Edges and the back of the leaf: the plain strip, projected so the
      // texel density stays in the same range rather than stretching one tile
      // across a 0.58 m return.
      const edge = MACHINE_DOOR_ATLAS.edge;
      coords = regionUv(edge, (x / DOOR.width) % 1, ((y + DOOR.height / 2) / DOOR.height) % 1, atlasSize);
    }
    uv.setXY(i, coords[0], coords[1]);
  }
  uv.needsUpdate = true;
}
