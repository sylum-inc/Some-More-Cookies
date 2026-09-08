/**
 * Code-authored low-poly geometry (ADR-0002).
 *
 * PS1 geometry is simple enough that generating it in code is practical, and
 * doing so lets the marshmallow's patch grid and the sandwich's bite state map
 * directly onto vertices — the simulation drives the mesh rather than
 * selecting between canned meshes.
 */

import * as THREE from 'three';
import {
  BITE_POSITIONS,
  patchColor,
  sandwichLayers,
  terrainHeight,
  type BiteState,
  type MarshmallowState,
  type Patch,
  type SandwichRecord,
  type WaterBasin,
} from '@somemore/sim';

// --- Marshmallow -----------------------------------------------------------

export interface MarshmallowMesh {
  geometry: THREE.BufferGeometry;
  /** Updates vertex colours and sag from simulation state. */
  update(marshmallow: MarshmallowState): void;
  dispose(): void;
}

/**
 * Builds a marshmallow whose vertices correspond 1:1 with simulation patches,
 * so browning, charring and flame appear exactly where the model put them.
 *
 * Non-indexed with flat shading: faceted is correct for the art direction and
 * lets each quad take its own patch colour without bleeding into neighbours.
 */
export function createMarshmallowMesh(marshmallow: MarshmallowState): MarshmallowMesh {
  const columns = countColumns(marshmallow.patches);
  const rows = countRows(marshmallow.patches);
  const radius = marshmallow.radius;
  const halfLength = marshmallow.halfLength;

  // One extra ring at each end closes the capsule.
  const ringCount = rows + 2;
  const quadCount = columns * (ringCount - 1);
  const vertexCount = quadCount * 6;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  // Which patch each vertex reads its colour from.
  const patchIndex = new Int32Array(vertexCount);
  // Base positions, kept so sag can be re-applied from the original shape.
  const basePositions = new Float32Array(vertexCount * 3);

  /** Axial position (-1..1) of a ring. */
  const ringAxial = (ring: number): number => {
    if (ring === 0) return -1.12;
    if (ring === ringCount - 1) return 1.12;
    const t = rows === 1 ? 0.5 : (ring - 1) / (rows - 1);
    return -1 + t * 2;
  };

  /** Marshmallow profile: a cylinder with softly rounded ends. */
  const profile = (axial: number): number => {
    const a = Math.min(1, Math.abs(axial));
    return radius * Math.pow(Math.max(0, 1 - Math.pow(a, 5)), 0.34);
  };

  const patchFor = (ring: number, column: number): number => {
    const row = Math.min(rows - 1, Math.max(0, ring - 1));
    return row * columns + (column % columns);
  };

  let v = 0;
  const write = (ring: number, column: number): void => {
    const axial = ringAxial(ring);
    const theta = (column / columns) * Math.PI * 2;
    const r = profile(axial);
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = axial * halfLength;

    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    basePositions[v * 3] = x;
    basePositions[v * 3 + 1] = y;
    basePositions[v * 3 + 2] = z;

    const nl = Math.hypot(x, z) || 1;
    normals[v * 3] = x / nl;
    normals[v * 3 + 1] = axial > 1 || axial < -1 ? Math.sign(axial) : 0;
    normals[v * 3 + 2] = z / nl;

    uvs[v * 2] = column / columns;
    uvs[v * 2 + 1] = (axial + 1.2) / 2.4;

    patchIndex[v] = patchFor(ring, column);
    colors[v * 3] = 1;
    colors[v * 3 + 1] = 1;
    colors[v * 3 + 2] = 1;
    v++;
  };

  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let column = 0; column < columns; column++) {
      const next = (column + 1) % columns;
      write(ring, column);
      write(ring + 1, column);
      write(ring + 1, next);
      write(ring, column);
      write(ring + 1, next);
      write(ring, next);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const scratch: [number, number, number] = [0, 0, 0];

  return {
    geometry,
    update(state: MarshmallowState) {
      const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const patches = state.patches;
      const sag = state.sag;

      for (let i = 0; i < vertexCount; i++) {
        const patch = patches[patchIndex[i] as number];
        if (patch) {
          patchColor(patch, scratch);
          // Blisters read as a slight darkening and swelling.
          const bulge = 1 + patch.blister * 0.08;
          colorAttr.setXYZ(i, scratch[0], scratch[1], scratch[2]);

          const bx = basePositions[i * 3] as number;
          const by = basePositions[i * 3 + 1] as number;
          const bz = basePositions[i * 3 + 2] as number;
          // Melting droops the marshmallow downward, most at the ends.
          const droop = sag * 0.5 * (0.35 + Math.abs(by / halfLength));
          posAttr.setXYZ(i, bx * bulge, by - droop * radius, bz * bulge);
        }
      }
      colorAttr.needsUpdate = true;
      posAttr.needsUpdate = true;
      geometry.computeBoundingSphere();
    },
    dispose() {
      geometry.dispose();
    },
  };
}

function countColumns(patches: readonly Patch[]): number {
  let max = 0;
  for (const p of patches) if (p.column > max) max = p.column;
  return max + 1;
}

function countRows(patches: readonly Patch[]): number {
  let max = 0;
  for (const p of patches) if (p.row > max) max = p.row;
  return max + 1;
}

// --- Sandwich --------------------------------------------------------------

/** Perimeter segments used to build each layer. Multiple of BITE_POSITIONS. */
export const SANDWICH_SEGMENTS = BITE_POSITIONS * 4;

/**
 * Rounded-square perimeter radius at an angle — graham crackers are square,
 * so a plain cylinder would read as a cake rather than a sandwich.
 */
export function squareRadius(angle: number, half: number, cornerRadius = 0.28): number {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const square = half / Math.max(c, s);
  const circle = half * Math.SQRT2 * 0.72;
  return square * (1 - cornerRadius) + circle * cornerRadius;
}

/**
 * Bite depth at an arbitrary angle, interpolated between the eight recorded
 * bite positions so the removed geometry has smooth edges.
 */
export function biteDepthAtAngle(bite: BiteState | null, angle: number): number {
  if (!bite) return 0;
  const normalised = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const position = (normalised / (Math.PI * 2)) * BITE_POSITIONS;
  const i0 = Math.floor(position) % BITE_POSITIONS;
  const i1 = (i0 + 1) % BITE_POSITIONS;
  const t = position - Math.floor(position);
  const d0 = bite.depths[i0] ?? 0;
  const d1 = bite.depths[i1] ?? 0;
  // Smoothstep between bite positions: a bite is a curve, not a facet.
  const smooth = t * t * (3 - 2 * t);
  return d0 + (d1 - d0) * smooth;
}

export interface SandwichLayerMesh {
  geometry: THREE.BufferGeometry;
  kind: 'graham' | 'chocolate' | 'cream';
  offsetX: number;
  offsetZ: number;
  y: number;
  thickness: number;
}

/**
 * Builds the five layers of a sandwich, with bites actually removed from the
 * geometry (spec deviation D3) rather than swapped between bite-state meshes.
 */
export function buildSandwichGeometry(
  sandwich: SandwichRecord,
  bite: BiteState | null,
  halfWidth = 0.032,
): SandwichLayerMesh[] {
  const layers = sandwichLayers(sandwich);
  const meshes: SandwichLayerMesh[] = [];
  let y = 0;

  for (const layer of layers) {
    // The cream layer bulges outward where it was squished.
    const bulge = layer.kind === 'cream' ? 1 + sandwich.appearance.edgeBulge * 0.09 : 1;
    const geometry = buildBittenPrism(halfWidth * bulge, layer.thickness, bite);
    meshes.push({
      geometry,
      kind: layer.kind,
      offsetX: layer.offsetX,
      offsetZ: layer.offsetZ,
      y: y + layer.thickness / 2,
      thickness: layer.thickness,
    });
    y += layer.thickness;
  }
  return meshes;
}

/** A rounded-square prism with bites carved out of its perimeter. */
function buildBittenPrism(half: number, thickness: number, bite: BiteState | null): THREE.BufferGeometry {
  const segments = SANDWICH_SEGMENTS;
  const halfThickness = thickness / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const radiusAt = (i: number): number => {
    const angle = (i / segments) * Math.PI * 2;
    const depth = biteDepthAtAngle(bite, angle);
    // A bite removes up to 82% of the radius at its centre.
    return squareRadius(angle, half) * (1 - depth * 0.82);
  };

  const pointAt = (i: number): [number, number] => {
    const angle = (i / segments) * Math.PI * 2;
    const r = radiusAt(i);
    return [Math.cos(angle) * r, Math.sin(angle) * r];
  };

  const pushVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, vv: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, vv);
  };

  for (let i = 0; i < segments; i++) {
    const [x0, z0] = pointAt(i);
    const [x1, z1] = pointAt(i + 1);
    const u0 = i / segments;
    const u1 = (i + 1) / segments;

    // Top face (fan from centre).
    pushVertex(0, halfThickness, 0, 0, 1, 0, 0.5, 0.5);
    pushVertex(x0, halfThickness, z0, 0, 1, 0, u0, 1);
    pushVertex(x1, halfThickness, z1, 0, 1, 0, u1, 1);

    // Bottom face.
    pushVertex(0, -halfThickness, 0, 0, -1, 0, 0.5, 0.5);
    pushVertex(x1, -halfThickness, z1, 0, -1, 0, u1, 0);
    pushVertex(x0, -halfThickness, z0, 0, -1, 0, u0, 0);

    // Side wall.
    const nx = (x0 + x1) * 0.5;
    const nz = (z0 + z1) * 0.5;
    const nl = Math.hypot(nx, nz) || 1;
    const sx = nx / nl;
    const sz = nz / nl;
    pushVertex(x0, -halfThickness, z0, sx, 0, sz, u0, 0);
    pushVertex(x1, -halfThickness, z1, sx, 0, sz, u1, 0);
    pushVertex(x1, halfThickness, z1, sx, 0, sz, u1, 1);
    pushVertex(x0, -halfThickness, z0, sx, 0, sz, u0, 0);
    pushVertex(x1, halfThickness, z1, sx, 0, sz, u1, 1);
    pushVertex(x0, halfThickness, z0, sx, 0, sz, u0, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

// --- Campsite props --------------------------------------------------------

/**
 * Conifers.
 *
 * What was here before was a trunk and two or three `ConeGeometry` tiers, and
 * an art review graded it in every one of forty-two captured frames: "literal
 * isosceles triangles at every distance… two stacked flat matte-grey
 * triangles, zero value variation, no silhouette break", at three hundred
 * pixels on screen. All three complaints are separate and all three are fair.
 *
 *   - **The silhouette.** A six-segment cone seen from the side is a triangle
 *     with two straight edges, and stacking three of them makes a bigger
 *     triangle with two straight edges. Real conifers are ragged: the outline
 *     is made of bough tips at different reaches, not of a taper. So the rim
 *     of every skirt is jittered per segment, and each skirt is phase-rotated
 *     against the one below so their tips interleave rather than line up into
 *     a single silhouette edge.
 *   - **The value.** One flat colour lit by one flat normal. Vertex colours
 *     give three tone bands — lit crown, mid, shaded underside — which is the
 *     same trick `groundTint` plays on the terrain, and for the same reason:
 *     the polygon count is not the problem, the absence of a second value is.
 *   - **The repetition.** Four shapes for a whole wood, all four the same
 *     shape. Now the seed also picks a *form*, and two of the four forms are
 *     dead: a bare snag and a tree with its top snapped out. A skyline needs
 *     something that is not a triangle in it or it reads as a sawtooth.
 *
 * The whole tree is built into flat arrays rather than merged from three.js
 * primitives. Two reasons: per-face and per-vertex tinting is not something
 * `ConeGeometry` can express, and the old version allocated five or six
 * `BufferGeometry` objects per tree and threw them away, which was fine at
 * three tiers and is not at seven.
 *
 * Budget (ARCHITECTURE §10, 60k triangles visible): a mid-detail tree is about
 * 100 triangles against the old 56, and the campsite instances at most 240 of
 * them, so the wood costs roughly 25k triangles rather than 13k. That is the
 * reason each skirt is two triangle fans (2N) and not a capped frustum (3N),
 * and the reason `detail` exists at all.
 */

/** Which shape of conifer. Two of the four are dead, on purpose. */
export type TreeForm = 'spire' | 'broad' | 'broken' | 'snag';

/**
 * How much tree to build.
 *
 * Every instance of one geometry is the same distance-independent mesh — the
 * campsite instances a handful of shapes across the whole wood — so this is
 * chosen per *bucket*, not per frame. `far` is deliberately still a stack of
 * ragged rings and never a single flat triangle, which is the thing the review
 * was actually complaining about.
 */
export type TreeDetail = 'near' | 'mid' | 'far';

export interface TreeOptions {
  /** Omit to let the seed pick one, weighted towards living trees. */
  form?: TreeForm;
  /** Default `'mid'`. */
  detail?: TreeDetail;
  /** Snow load on the upper faces, 0..1. Default 0. */
  snow?: number;
  /**
   * The material colour these vertex tints will be multiplied against.
   *
   * Only needed for snow: a multiplicative tint on a dark green material makes
   * bright green, not snow, and the only way to land on an actual neutral is
   * to know what is being multiplied. Everything else here is a relative
   * value shift and does not care.
   */
  baseColor?: number;
}

/**
 * The three tone bands from the art direction, as multipliers rather than
 * colours.
 *
 * The direction names sunward `#4a5a3e`, mid `#33402c` and shade `#1c241a`.
 * They cannot be written into the mesh as absolutes: the canopy colour is
 * per-campsite (`palette.foliage`, from the manifest) and the hour moves it,
 * so a baked hex would flatten every wood in the catalogue to the same green
 * and would stop the night from arriving. Dividing each band by the mid band
 * keeps the *relationship* the director graded — a crown 1.4× its own mid and
 * a shade a little over half it — and leaves identity and hour where they
 * belong. Same reasoning as `groundTint`, which is centred on 1 for the same
 * reason.
 */
const TONE_SUNWARD: readonly [number, number, number] = [74 / 51, 90 / 64, 62 / 44];
const TONE_MID: readonly [number, number, number] = [1, 1, 1];
const TONE_SHADE: readonly [number, number, number] = [28 / 51, 36 / 64, 26 / 44];

/**
 * Bark, warm and dark.
 *
 * The trunk shares the canopy's material — the whole wood is a few draw calls
 * and splitting bark out would double them — so the only thing that can make
 * it read as wood rather than as more foliage is a tint. Warm and dark against
 * a green base lands on the olive-brown a fir trunk is in this light.
 */
const TONE_BARK: readonly [number, number, number] = [1.12, 0.74, 0.52];

/** Snow, if we were told nothing about what it is being multiplied against. */
const SNOW_FALLBACK: readonly [number, number, number] = [2.3, 1.85, 2.7];

/** Lying snow in this palette: not white — a cold, slightly blue grey. */
const SNOW_TARGET = 0xcdd6d8;

interface Surfaces {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
}

type Tone = readonly [number, number, number];

/**
 * A conifer, ragged and seeded.
 *
 * The signature is unchanged from the version that made triangles, so the
 * campsite keeps working untouched; everything new is optional.
 */
export function createTreeGeometry(
  seed: number,
  height = 4,
  options: TreeOptions = {},
): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const detail = options.detail ?? 'mid';
  const form = options.form ?? pickForm(rng());
  const snow = Math.max(0, Math.min(1, options.snow ?? 0));
  const snowTone = snowTint(options.baseColor);

  const surfaces: Surfaces = { positions: [], normals: [], uvs: [], colors: [] };

  // Radial resolution, and odd at every level on purpose: an even count puts
  // a vertex directly opposite every other vertex, and that mirror symmetry
  // is what made the old six-segment cone read as a drawn triangle whichever
  // way it was turned.
  const segments = detail === 'near' ? 9 : detail === 'far' ? 5 : 7;

  /*
   * Trunk height and canopy start vary a lot between forms. A spire carries
   * its skirts almost to the ground; a broad old fir is bare for the first
   * third, which is what lets you see *through* a wood instead of at it.
   */
  const bareFraction =
    form === 'snag' ? 1 : form === 'broad' ? 0.3 + rng() * 0.14 : 0.13 + rng() * 0.1;
  // A broken top is a tree that has lost its leader, not a stump: it keeps
  // most of its height and all of its canopy, and what it contributes to the
  // skyline is a blunt end where every other tree has a point.
  const trunkTop = form === 'broken' ? height * (0.68 + rng() * 0.16) : height;
  const trunkHeight = form === 'snag' ? trunkTop : trunkTop * (bareFraction + 0.55);

  addTrunk(surfaces, {
    height: trunkHeight,
    radius: height * (0.028 + rng() * 0.016),
    segments: detail === 'far' ? 4 : 5,
    broken: form === 'broken' || form === 'snag',
    rng,
  });

  if (form === 'snag') {
    // A dead standing trunk with the stubs of its branches. This is the shape
    // that breaks a treeline: everything else in the wood is a cone, and one
    // vertical stick with three spikes on it is worth more to the skyline
    // than another variation on the cone would be.
    const stubs = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < stubs; i++) {
      addStub(surfaces, {
        y: trunkTop * (0.35 + rng() * 0.6),
        angle: rng() * Math.PI * 2,
        length: height * (0.08 + rng() * 0.12),
        radius: height * 0.016,
        droop: -0.15 - rng() * 0.5,
      });
    }
  } else {
    const canopyBase = trunkTop * bareFraction;
    const canopyTop = form === 'broken' ? trunkTop * 0.92 : trunkTop;
    const skirtCount =
      detail === 'far'
        ? 3
        : form === 'broken'
          ? 3 + Math.floor(rng() * 2)
          : 5 + Math.floor(rng() * 3);

    /*
     * Taper. `1` shrinks each skirt in proportion to how far up it is; above 1
     * the lower skirts stay wide and the shrink happens near the top, which is
     * the shape of an old fir, and below 1 the tree is a spike.
     *
     * Kept under 1.5 in both cases, which is the number measurement decided.
     * At taper 2 each skirt is less than half the reach of the one below it —
     * a bigger drop than any jitter can undo — so the outline falls away
     * monotonically and measures as one smooth edge: a curved triangle
     * instead of a straight one, which is no better. Low enough and a wide
     * skirt can out-reach the tapering cross-section of its neighbour, and the
     * profile gains the step in and out that reads as boughs.
     */
    const taper = form === 'broad' ? 1.05 + rng() * 0.3 : 0.85 + rng() * 0.35;
    const spread = height * (form === 'broad' ? 0.23 + rng() * 0.06 : 0.19 + rng() * 0.05);

    // Phase between skirts. The direction asked for 12-20 degrees, which with
    // seven points is a third of a segment and so comes back into phase every
    // third skirt — three skirts of tips, then the same three again, which is
    // a stripe. Expressed as a fraction of the segment angle instead, it
    // cannot land back on itself.
    const segmentAngle = (Math.PI * 2) / segments;
    let phase = rng() * Math.PI * 2;

    /*
     * The skirts divide the canopy into `skirtCount` steps and sit at the
     * *bottom* of each, so the fraction driving the taper never reaches 1.
     *
     * It did in the first pass — the top skirt was placed at t = 1, which made
     * its radius exactly zero, and measurement showed the top third of every
     * tree collapsing to a bare spike with the whole canopy bunched below it.
     * The apex of the last skirt is the tree's tip; the last skirt itself
     * still has to be a skirt.
     */
    const step = (canopyTop - canopyBase) / skirtCount;

    for (let i = 0; i < skirtCount; i++) {
      const t = i / skirtCount;
      const yBase = canopyBase + step * i;
      const radius = spread * Math.pow(1 - t, taper) * (0.84 + rng() * 0.34);
      addSkirt(surfaces, {
        yBase,
        // Each skirt's apex reaches past the base of the one above, so the
        // stack overlaps and there is no daylight between tiers — gaps were
        // what made the old stack read as separate hats. Clamped, or the
        // topmost apex overshoots the height the caller asked for by most of
        // a step and every tree in the wood is a sixth taller than it says.
        yTip: Math.min(canopyTop, yBase + step * (1.5 + rng() * 0.6)),
        yUnder: yBase - step * (0.35 + rng() * 0.25),
        radius,
        segments,
        phase,
        rng,
        // Crown faces catch the light, the ones down in the tree do not. This
        // is deliberately *not* an azimuth test: instances are placed at
        // random Y rotations, so a sunward side baked into the mesh would
        // point a different way on every tree in the wood.
        lit: t,
        // Full at the crown and gone by the middle of the tree. The ramp has
        // to reach 1 inside the range `t` actually takes — the skirts stop
        // short of 1 by a whole step — or the top of the tree is permanently
        // half-snowed and reads as bright green rather than as snow.
        snow: snow * Math.min(1, Math.max(0, (t - 0.3) / 0.45)),
        snowTone,
        fringe: detail === 'near',
      });
      phase += segmentAngle * (0.34 + rng() * 0.3);
    }

    if (form === 'broken') {
      // A snapped top: splinters, not a clean cut. Three spikes off the break
      // is enough to read at this resolution.
      for (let i = 0; i < 3; i++) {
        addStub(surfaces, {
          y: trunkTop * (0.96 + rng() * 0.06),
          angle: rng() * Math.PI * 2,
          length: height * (0.03 + rng() * 0.06),
          radius: height * 0.012,
          droop: 0.8 + rng() * 0.6,
        });
      }
    }
  }

  /*
   * Lean, applied as a shear rather than a rotation.
   *
   * Rotating the whole tree would lift one side of the trunk out of the
   * ground — trees are placed on a heightfield with no per-instance pitch, so
   * a tilted base is a visible gap. Shearing by height keeps the base planted
   * and bends the tree over, which is also closer to how a wind-formed
   * conifer actually stands.
   */
  const leanAngle = rng() * Math.PI * 2;
  const leanAmount = height * (0.01 + rng() * 0.05);
  applyLean(surfaces, leanAngle, leanAmount, height);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(surfaces.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(surfaces.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surfaces.uvs, 2));
  // Ignored unless the material is created with `vertexColors: true`, and
  // harmless if it is not — which is what lets this ship before the call site
  // opts in.
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(surfaces.colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A set of tree shapes that is guaranteed to contain more than one kind of
 * tree.
 *
 * Asking for four independent seeds gives four independent form rolls, and
 * four rolls of a weighted die come up all-living about one campsite in
 * three — a whole wood with nothing dead in it anywhere. A wood is a deck,
 * not four coin flips, so the forms are dealt rather than rolled: every set
 * has a snapped top in it from four shapes onwards, and a bare snag from six.
 */
export function createTreeGeometrySet(
  seed: number,
  height = 4,
  count = 4,
  options: Omit<TreeOptions, 'form'> = {},
): THREE.BufferGeometry[] {
  /*
   * The order is the whole point, and so is where the snag sits in it.
   *
   * The campsite picks a bucket per tree uniformly at random, so every shape
   * in this set is a quarter of the wood at `count` 4 and a sixth at 6. A
   * quarter of a wood standing dead is not "a few dead snags", it is a burn
   * scar — so at four the deck is three living trees and one with its top
   * snapped out, and the bare snag only appears once there are enough buckets
   * for it to be the exception it is meant to be.
   */
  const order: TreeForm[] = ['spire', 'broad', 'broken', 'spire', 'snag', 'broad'];
  return Array.from({ length: count }, (_, i) =>
    // The same `seed + i * 977` the campsite already used, so a campsite that
    // switches to this keeps the trees it had in the places it had them.
    createTreeGeometry(seed + i * 977, height, {
      ...options,
      form: order[i % order.length] as TreeForm,
    }),
  );
}

/** Weighted so most of a wood is alive. */
function pickForm(roll: number): TreeForm {
  if (roll < 0.42) return 'spire';
  if (roll < 0.8) return 'broad';
  if (roll < 0.92) return 'broken';
  return 'snag';
}

/**
 * Snow as a multiplier.
 *
 * With the material colour known we can divide by it and land exactly on the
 * snow colour whatever the campsite's green is. Without it, a fixed lift that
 * is strongest in blue and weakest in green — which is what desaturating a
 * green amounts to — gets close enough that nobody reads it as bright moss.
 */
function snowTint(baseColor: number | undefined): Tone {
  if (baseColor === undefined) return SNOW_FALLBACK;
  const base = new THREE.Color(baseColor);
  const target = new THREE.Color(SNOW_TARGET);
  /*
   * The floor is only there so a pure black canopy does not divide by zero,
   * and it has to be tiny.
   *
   * `THREE.Color` converts a hex out of sRGB into the linear working space, so
   * the default canopy `#1d3323` arrives as 0.012, 0.033, 0.017 — the first
   * version of this used a floor of 1/32, which is *above* the red and blue of
   * every green in the catalogue. It clamped two channels out of three to the
   * same number, and the snow came out the wrong hue entirely while the
   * arithmetic looked right.
   */
  const floor = 1 / 2048;
  // And a cap, because a canopy that is almost black would otherwise ask for a
  // multiplier in the thousands, which is a float precision problem rather
  // than a colour.
  const cap = 128;
  return [
    Math.min(cap, target.r / Math.max(floor, base.r)),
    Math.min(cap, target.g / Math.max(floor, base.g)),
    Math.min(cap, target.b / Math.max(floor, base.b)),
  ];
}

interface TrunkSpec {
  height: number;
  radius: number;
  segments: number;
  broken: boolean;
  rng: () => number;
}

/** A tapered trunk, open at both ends — the skirts and the ground cap it. */
function addTrunk(surfaces: Surfaces, spec: TrunkSpec): void {
  const { height, radius, segments, rng } = spec;
  const topRadius = radius * (spec.broken ? 0.72 : 0.42);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    // A trunk is not a cylinder. Even a few per cent of wobble per face is
    // the difference between a tapered post and a tree at close range.
    const w0 = 0.9 + rng() * 0.2;
    const w1 = 0.9 + rng() * 0.2;
    const x0 = Math.cos(a0) * radius * w0;
    const z0 = Math.sin(a0) * radius * w0;
    const x1 = Math.cos(a1) * radius * w1;
    const z1 = Math.sin(a1) * radius * w1;
    const tx0 = Math.cos(a0) * topRadius * w0;
    const tz0 = Math.sin(a0) * topRadius * w0;
    const tx1 = Math.cos(a1) * topRadius * w1;
    const tz1 = Math.sin(a1) * topRadius * w1;
    const u0 = i / segments;
    const u1 = (i + 1) / segments;
    // Sunward and shade alternate around the trunk so it has a lit side and a
    // dark side whichever way the instance is turned.
    const lit = 0.7 + 0.3 * Math.cos(a0 * 1.5);
    const tone = scaleTone(TONE_BARK, 0.75 + lit * 0.4);
    pushTriangle(surfaces, x0, 0, z0, x1, 0, z1, tx1, height, tz1, u0, 0, u1, 0, u1, 1, tone, tone, tone);
    pushTriangle(surfaces, x0, 0, z0, tx1, height, tz1, tx0, height, tz0, u0, 0, u1, 1, u0, 1, tone, tone, tone);
  }
}

interface StubSpec {
  y: number;
  angle: number;
  length: number;
  radius: number;
  /** Positive points the stub up, negative down. */
  droop: number;
}

/** A dead branch stub: three tapered faces, which is enough of a stick. */
function addStub(surfaces: Surfaces, spec: StubSpec): void {
  const { y, angle, length, radius, droop } = spec;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const tipX = dx * length;
  const tipY = y + length * droop;
  const tipZ = dz * length;
  const tone = scaleTone(TONE_BARK, 0.9);
  const shade = scaleTone(TONE_BARK, 0.55);
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * Math.PI * 2;
    const a1 = ((i + 1) / 3) * Math.PI * 2;
    // The stub's own cross-section, built in the plane perpendicular to the
    // trunk rather than to the stub. At this length the difference is a few
    // millimetres and a correct frame would cost a basis per stub.
    const p0x = dx * radius + Math.cos(a0) * radius;
    const p0z = dz * radius + Math.sin(a0) * radius;
    const p1x = dx * radius + Math.cos(a1) * radius;
    const p1z = dz * radius + Math.sin(a1) * radius;
    const y0 = y + Math.sin(a0) * radius * 0.6;
    const y1 = y + Math.sin(a1) * radius * 0.6;
    pushTriangle(
      surfaces,
      p0x, y0, p0z,
      p1x, y1, p1z,
      tipX, tipY, tipZ,
      0, 0, 1, 0, 0.5, 1,
      i === 0 ? tone : shade,
      i === 0 ? tone : shade,
      shade,
    );
  }
}

interface SkirtSpec {
  /** Where the skirt's rim hangs. */
  yBase: number;
  /** The apex of the upper face — the point the boughs rise to. */
  yTip: number;
  /** The point the underside closes down to. */
  yUnder: number;
  radius: number;
  segments: number;
  phase: number;
  rng: () => number;
  /** 0 at the bottom of the canopy, 1 at the crown. Drives the tone band. */
  lit: number;
  snow: number;
  snowTone: Tone;
  fringe: boolean;
}

/**
 * One skirt of boughs: an upper fan and an under fan meeting at a ragged rim.
 *
 * Two fans rather than a capped frustum because the top of a skirt is always
 * covered by the skirt above it — only the crown's is ever seen — so the
 * inner ring a frustum would need is a third more triangles for a surface
 * that is inside the tree.
 *
 * The rim is where all the work is. Each tip gets its own radius and its own
 * height, so the outline is a row of unequal spikes rather than a circle seen
 * edge-on, and the direction's +/-8% turned out to be far too polite at 320x240
 * — under about 15% the profile still measures as a straight edge.
 */
function addSkirt(surfaces: Surfaces, spec: SkirtSpec): void {
  const { yBase, yTip, yUnder, radius, segments, phase, rng, snow, snowTone, fringe } = spec;

  const rimX: number[] = [];
  const rimY: number[] = [];
  const rimZ: number[] = [];
  const rimAngle: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = phase + (i / segments) * Math.PI * 2;
    const jitter = 0.82 + rng() * 0.34;
    const r = radius * jitter;
    rimAngle.push(angle);
    rimX.push(Math.cos(angle) * r);
    rimZ.push(Math.sin(angle) * r);
    // Drooping tips, unequally. A rim at one height is a hard horizontal
    // line, and a horizontal line across a tree is the most artificial thing
    // in the frame.
    rimY.push(yBase - radius * (rng() * 0.22));
  }

  const litTone = mixTone(TONE_MID, TONE_SUNWARD, Math.min(1, spec.lit * 1.2));
  const tipTone = snow > 0 ? mixTone(litTone, snowTone, snow) : litTone;

  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const u0 = i / segments;
    const u1 = (i + 1) / segments;

    // Upper face. The apex vertex carries the lit (or snowed) tone and the rim
    // carries the mid band, so the gradient runs down the bough the way light
    // does — and the snow sits on the inner part of the face, which is the
    // "top 40% of the upper face" the direction asked for, for free.
    const faceLift = 0.9 + rng() * 0.24;
    // Rim indices run anticlockwise seen from above, so apex-i-j winds the
    // face *downwards* and a single-sided material culls the entire canopy —
    // which is how this was first written and why the tree came out as a
    // trunk with a hole where the boughs were.
    pushTriangle(
      surfaces,
      0, yTip, 0,
      rimX[j] as number, rimY[j] as number, rimZ[j] as number,
      rimX[i] as number, rimY[i] as number, rimZ[i] as number,
      0.5, 1, u1, 0, u0, 0,
      scaleTone(tipTone, faceLift),
      scaleTone(litTone, faceLift * 0.92),
      scaleTone(litTone, faceLift * 0.92),
    );

    // Under face, wound the other way. This is the shade band and it is what
    // stops the canopy being see-through from below with a single-sided
    // material.
    const shade = scaleTone(TONE_SHADE, 0.88 + rng() * 0.2);
    pushTriangle(
      surfaces,
      0, yUnder, 0,
      rimX[i] as number, rimY[i] as number, rimZ[i] as number,
      rimX[j] as number, rimY[j] as number, rimZ[j] as number,
      0.5, 0, u0, 0.4, u1, 0.4,
      scaleTone(TONE_SHADE, 0.7),
      shade,
      shade,
    );

    /*
     * Needle fringe, near detail only.
     *
     * The direction asked for a 2-4 px alpha-tested fringe on the outline.
     * Alpha testing needs an alpha channel in the foliage texture and a second
     * material state; a spike of actual geometry costs two triangles, reads
     * the same at this resolution, and cannot go wrong when the material
     * changes. Two, not one, because a sliver this thin is seen from both
     * sides and the canopy material is `FrontSide` — one triangle would be
     * there from one side of the tree and gone from the other.
     *
     * Every third segment. Every segment is a fur collar, and at 320x240 a
     * continuous fringe is just a slightly bigger tree.
     */
    if (fringe && i % 3 === 0) {
      const a = rimAngle[i] as number;
      const reach = radius * (0.1 + rng() * 0.1);
      const ax = rimX[i] as number;
      const ay = (rimY[i] as number) + radius * 0.05;
      const az = rimZ[i] as number;
      const bx = ax + Math.cos(a) * reach;
      const by = (rimY[i] as number) - radius * 0.06;
      const bz = az + Math.sin(a) * reach;
      const cx = rimX[j] as number;
      const cy = rimY[j] as number;
      const cz = rimZ[j] as number;
      const spine = scaleTone(TONE_SHADE, 1.1);
      pushTriangle(surfaces, ax, ay, az, bx, by, bz, cx, cy, cz,
        u0, 0, u0, 0.2, u1, 0, litTone, spine, litTone);
      pushTriangle(surfaces, ax, ay, az, cx, cy, cz, bx, by, bz,
        u0, 0, u1, 0, u0, 0.2, litTone, litTone, spine);
    }
  }
}

/** Shears the built vertices over by height, keeping the base planted. */
function applyLean(surfaces: Surfaces, angle: number, amount: number, height: number): void {
  if (amount <= 0) return;
  const dx = Math.cos(angle) * amount;
  const dz = Math.sin(angle) * amount;
  for (let i = 0; i < surfaces.positions.length; i += 3) {
    const y = surfaces.positions[i + 1] as number;
    // Squared, so the lean is all in the crown: a trunk that leaves the
    // ground already tilted reads as a fallen tree, not a leaning one.
    const t = Math.max(0, y / height) ** 1.6;
    surfaces.positions[i] = (surfaces.positions[i] as number) + dx * t;
    surfaces.positions[i + 2] = (surfaces.positions[i + 2] as number) + dz * t;
  }
}

function scaleTone(tone: Tone, factor: number): Tone {
  return [tone[0] * factor, tone[1] * factor, tone[2] * factor];
}

function mixTone(from: Tone, to: Tone, t: number): Tone {
  const k = Math.max(0, Math.min(1, t));
  return [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ];
}

/** One triangle, with its own flat normal and a tone at each corner. */
function pushTriangle(
  surfaces: Surfaces,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  au: number, av: number,
  bu: number, bv: number,
  cu: number, cv: number,
  toneA: Tone,
  toneB: Tone,
  toneC: Tone,
): void {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  surfaces.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  surfaces.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  surfaces.uvs.push(au, av, bu, bv, cu, cv);
  surfaces.colors.push(
    toneA[0], toneA[1], toneA[2],
    toneB[0], toneB[1], toneB[2],
    toneC[0], toneC[1], toneC[2],
  );
}

/** An irregular low-poly rock. */
export function createRockGeometry(seed: number, size = 0.4): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const geometry = new THREE.IcosahedronGeometry(size, 0);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const scale = 0.65 + rng() * 0.6;
    position.setXYZ(
      i,
      position.getX(i) * scale,
      position.getY(i) * scale * 0.7,
      position.getZ(i) * scale,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', groundTint(position, seed));
  return geometry;
}

/**
 * The ground's own variation, as vertex colour.
 *
 * The terrain is a metre-and-three-quarters to a quad, and until now every
 * quad was the same flat brown differing only by its normal — which is exactly
 * what an art review meant by "a visible patchwork of brown quads" and "flat
 * brown paper polygons". The polygon size is not the problem and making it
 * smaller would only make more, smaller patches; the problem is that a real
 * forest floor is never one colour twice in a row.
 *
 * So each vertex gets a tint, and the flat shading that was showing off the
 * mesh now shows off the ground instead. Three things go into it:
 *
 *   - **Two octaves of value noise**, the low one at about eight metres for
 *     broad patches of duff and bare soil, the high one at two for the grain
 *     inside them.
 *   - **Height**, slightly. Ridges catch more light and dry out; hollows hold
 *     needles and stay dark. Only a few per cent, but it is the term that
 *     makes the shape of the ground readable rather than just noisy.
 *   - **A hue tilt with it**, warm on the high ground and cool in the damp,
 *     which is the cheapest possible second colour and the thing the palette
 *     was accused of not having.
 *
 * Multiplied against the material's own colour, so the hour still moves the
 * whole ground together — this varies it, it does not repaint it.
 */
function groundTint(position: THREE.BufferAttribute, seed: number): THREE.BufferAttribute {
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const broad = valueNoise2D(x / 8.2, z / 8.2, seed);
    const fine = valueNoise2D(x / 2.1, z / 2.1, seed ^ 0x5bd1);
    // Centred on 1, so a vertex with average noise is exactly the colour the
    // manifest asked for and nothing shifts the campsite's identity.
    const tone = 1 + (broad - 0.5) * 0.26 + (fine - 0.5) * 0.12;
    const lift = Math.max(-1, Math.min(1, y * 1.4));
    colors[i * 3] = tone * (1 + lift * 0.05);
    colors[i * 3 + 1] = tone * (1 + lift * 0.015);
    colors[i * 3 + 2] = tone * (1 - lift * 0.045);
  }
  return new THREE.BufferAttribute(colors, 3);
}

/** Bilinear value noise on a lattice. Deterministic in `seed`, no allocation. */
function valueNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  // Smoothstep, so the lattice does not show as a grid of diamonds.
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = latticeValue(x0, z0, seed);
  const b = latticeValue(x0 + 1, z0, seed);
  const c = latticeValue(x0, z0 + 1, seed);
  const d = latticeValue(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function latticeValue(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}

/**
 * The understorey: the layer the catalogue described and nothing ever drew.
 *
 * `packages/content` specifies forty scatter kits with real densities and real
 * art direction — sword fern at seventy instances per hundred square metres,
 * Spanish moss at thirty-four, bracken, heather, devil's club, nurse logs,
 * cypress knees, cryptobiotic crust. The renderer knew four shapes: tree, rock,
 * log, terrain. Worse, `World.tsx` filtered the manifest to kits over 2.5 m
 * tall before it ever reached the scene, so every one of those was discarded on
 * the way in. That is why walking away from the fire showed six cones and four
 * rocks, and it is the whole of "there is nothing to look at".
 *
 * Forty bespoke plants would be forty draw calls for variety nobody can resolve
 * at night through fog, so the kits map onto six families by silhouette. A
 * sword fern and a bracken differ botanically and read identically as a dark
 * arching mass at four metres in firelight; what has to differ is the shape of
 * the mass, not the species.
 */
export type UnderstoreyFamily = 'frond' | 'shrub' | 'blade' | 'mat' | 'cushion' | 'veil';

/** Which silhouette each catalogue kit takes. Unlisted kits fall back to shrub. */
const KIT_FAMILIES: Readonly<Record<string, UnderstoreyFamily>> = {
  kit_swordfern: 'frond',
  kit_bracken: 'frond',
  kit_bracken_moor: 'frond',
  kit_devils_club: 'frond',
  kit_palmetto: 'frond',
  kit_salal: 'shrub',
  kit_heather: 'shrub',
  kit_blackbrush: 'shrub',
  kit_rabbitbrush: 'shrub',
  kit_lupine: 'shrub',
  kit_foxglove: 'shrub',
  kit_willow_bar: 'shrub',
  kit_blueberry_lichen: 'shrub',
  kit_young_fir: 'shrub',
  kit_cotton_grass: 'blade',
  kit_dune_grass: 'blade',
  kit_salt_grass: 'blade',
  kit_shortgrass: 'blade',
  kit_track_weed: 'blade',
  kit_pickleweed: 'blade',
  kit_thermal_moss: 'mat',
  kit_cryptobiotic: 'mat',
  kit_duckweed: 'mat',
  kit_alpine_cushion: 'cushion',
  kit_heather_alpine: 'cushion',
  kit_krummholz: 'cushion',
  kit_moss_veil: 'veil',
};

export function understoreyFamily(kitId: string): UnderstoreyFamily {
  return KIT_FAMILIES[kitId] ?? 'shrub';
}

/**
 * One plant of a family, built to be instanced.
 *
 * Everything here is a handful of triangles on purpose: at these densities the
 * scene draws thousands of them, and the budget in ARCHITECTURE §10 is the
 * constraint that decides how much world there can be.
 */
export function createUnderstoreyGeometry(
  family: UnderstoreyFamily,
  seed: number,
  height = 0.8,
): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const parts: THREE.BufferGeometry[] = [];

  switch (family) {
    case 'frond': {
      // Arching fronds from a common crown. The arch is the whole silhouette:
      // straight blades read as grass, and a fern is not grass.
      const blades = 5 + Math.floor(rng() * 3);
      for (let i = 0; i < blades; i++) {
        const angle = (i / blades) * Math.PI * 2 + rng() * 0.4;
        const length = height * (0.7 + rng() * 0.5);
        const blade = new THREE.PlaneGeometry(height * 0.16, length, 1, 3);
        // Bend it over: each segment pitched further than the last.
        const position = blade.getAttribute('position') as THREE.BufferAttribute;
        for (let v = 0; v < position.count; v++) {
          const t = (position.getY(v) + length / 2) / length;
          position.setZ(v, t * t * length * 0.42);
          position.setY(v, position.getY(v) - t * t * length * 0.12);
        }
        position.needsUpdate = true;
        blade.translate(0, length / 2, 0);
        blade.rotateY(angle);
        parts.push(blade);
      }
      break;
    }
    case 'shrub': {
      // A clumpy mass. Two or three overlapping low-poly spheres, squashed.
      const lobes = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < lobes; i++) {
        const radius = height * (0.3 + rng() * 0.22);
        const lobe = new THREE.IcosahedronGeometry(radius, 0);
        const position = lobe.getAttribute('position') as THREE.BufferAttribute;
        for (let v = 0; v < position.count; v++) {
          position.setXYZ(
            v,
            position.getX(v) * (0.8 + rng() * 0.5),
            position.getY(v) * 0.72,
            position.getZ(v) * (0.8 + rng() * 0.5),
          );
        }
        position.needsUpdate = true;
        lobe.translate(
          (rng() - 0.5) * height * 0.4,
          radius * 0.8 + rng() * height * 0.16,
          (rng() - 0.5) * height * 0.4,
        );
        parts.push(lobe);
      }
      break;
    }
    case 'blade': {
      // Grass: crossed quads, the cheapest thing that still catches firelight
      // from more than one direction.
      const clumps = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < clumps; i++) {
        const h = height * (0.6 + rng() * 0.7);
        const quad = new THREE.PlaneGeometry(height * 0.5, h, 1, 1);
        quad.translate(0, h / 2, 0);
        quad.rotateY((i / clumps) * Math.PI + rng() * 0.5);
        parts.push(quad);
      }
      break;
    }
    case 'mat': {
      // Moss and crust: a ragged disc lying on the ground, lifted a hair so it
      // does not fight the terrain for the same pixels.
      const disc = new THREE.CircleGeometry(height * 1.6, 7);
      disc.rotateX(-Math.PI / 2);
      const position = disc.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < position.count; v++) {
        position.setXYZ(
          v,
          position.getX(v) * (0.7 + rng() * 0.6),
          position.getY(v) + rng() * height * 0.1,
          position.getZ(v) * (0.7 + rng() * 0.6),
        );
      }
      position.needsUpdate = true;
      disc.translate(0, height * 0.02, 0);
      parts.push(disc);
      break;
    }
    case 'cushion': {
      // Alpine cushion and krummholz: wind-flattened domes, wider than tall.
      const dome = new THREE.IcosahedronGeometry(height * 0.7, 0);
      const position = dome.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < position.count; v++) {
        position.setXYZ(
          v,
          position.getX(v) * (1.1 + rng() * 0.4),
          Math.max(0, position.getY(v)) * 0.42,
          position.getZ(v) * (1.1 + rng() * 0.4),
        );
      }
      position.needsUpdate = true;
      parts.push(dome);
      break;
    }
    case 'veil': {
      // Spanish moss: hanging strands. The catalogue calls this the single most
      // identity-defining element of its environment, so it hangs rather than
      // stands, and it is built to be placed up in a canopy.
      const strands = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < strands; i++) {
        const length = height * (0.6 + rng() * 0.8);
        const strand = new THREE.PlaneGeometry(height * 0.12, length, 1, 1);
        strand.translate(0, -length / 2, 0);
        strand.rotateY(rng() * Math.PI);
        strand.translate((rng() - 0.5) * height * 0.5, 0, (rng() - 0.5) * height * 0.5);
        parts.push(strand);
      }
      break;
    }
  }

  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** A split log for the fire and the woodpile. */
export function createLogGeometry(length = 0.5, radius = 0.07): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.92, length, 7, 1);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** Merges geometries without pulling in an addon. */
export function mergeGeometries(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  let totalVertices = 0;
  /*
   * Vertex colour is carried through only if something in the batch has it.
   *
   * This used to drop the attribute on the floor, which is a silent failure of
   * exactly the wrong kind: a tinted conifer merged into a wood came out the
   * material's flat green with no error anywhere, and the tint had cost real
   * work to compute. Parts without a colour are filled with white, which is
   * the identity under the multiply the shader does — so mixing a tinted part
   * with an untinted one leaves the untinted one looking as it did.
   */
  let anyColor = false;
  for (const g of geometries) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    totalVertices += (nonIndexed.getAttribute('position') as THREE.BufferAttribute).count;
    if (g.getAttribute('color')) anyColor = true;
    if (nonIndexed !== g) nonIndexed.dispose();
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const colors = anyColor ? new Float32Array(totalVertices * 3).fill(1) : null;
  let offset = 0;

  for (const g of geometries) {
    const source = g.index ? g.toNonIndexed() : g;
    const p = source.getAttribute('position') as THREE.BufferAttribute;
    const n = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const u = source.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const c = source.getAttribute('color') as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      positions[(offset + i) * 3] = p.getX(i);
      positions[(offset + i) * 3 + 1] = p.getY(i);
      positions[(offset + i) * 3 + 2] = p.getZ(i);
      if (n) {
        normals[(offset + i) * 3] = n.getX(i);
        normals[(offset + i) * 3 + 1] = n.getY(i);
        normals[(offset + i) * 3 + 2] = n.getZ(i);
      }
      if (u) {
        uvs[(offset + i) * 2] = u.getX(i);
        uvs[(offset + i) * 2 + 1] = u.getY(i);
      }
      if (colors && c) {
        colors[(offset + i) * 3] = c.getX(i);
        colors[(offset + i) * 3 + 1] = c.getY(i);
        colors[(offset + i) * 3 + 2] = c.getZ(i);
      }
    }
    offset += p.count;
    if (source !== g) source.dispose();
  }

  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** One part of a merged assembly, in the assembly's own frame. */
export interface PlacedPart {
  readonly geometry: THREE.BufferGeometry;
  readonly position?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
}

/**
 * Merges parts that sit at different places, which {@link mergeGeometries}
 * cannot do — it takes bare geometries and would stack every box at the
 * origin.
 *
 * This is what turns a cabinet built from thirty-seven boxes on three shared
 * materials into three meshes. It is only ever correct for parts whose
 * transforms are *static*: a merged part cannot move again, because its
 * position is baked into the vertices. Anything animated (the door, the
 * lever, the latch) stays its own object, and so does anything that has to be
 * a separate raycast target for a pointer handler.
 *
 * Normals are recomputed by `mergeGeometries` as face normals, which sounds
 * like it should change the shading and does not: every PS1 material is
 * created with `flatShading: true` (`ps1.ts`), so three derives normals per
 * fragment and ignores the attribute entirely. A merge is therefore expected
 * to be pixel-identical, which is what makes the visual baselines a real test
 * of it rather than a rubber stamp.
 */
export function mergePlaced(parts: readonly PlacedPart[]): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  const moved = parts.map((part) => {
    const geometry = part.geometry.clone();
    const [px, py, pz] = part.position ?? [0, 0, 0];
    const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = part.scale ?? [1, 1, 1];
    position.set(px, py, pz);
    euler.set(rx, ry, rz);
    quaternion.setFromEuler(euler);
    scale.set(sx, sy, sz);
    geometry.applyMatrix4(matrix.compose(position, quaternion, scale));
    return geometry;
  });

  const merged = mergeGeometries(moved);
  // The clones have been copied into `merged`; the sources belong to whoever
  // made them and are left alone.
  for (const geometry of moved) geometry.dispose();
  return merged;
}

/** Small deterministic PRNG for geometry variation (not simulation state). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Terrain grid with seeded undulation. Deliberately low-resolution: PS1
 * ground was coarse, and a coarse grid is also what makes vertex jitter read
 * as authentic rather than as noise.
 */
export function createTerrainGeometry(
  size = 40,
  segments = 24,
  seed = 1,
  amplitude = 0.6,
  basin?: WaterBasin,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  // Heights come from `terrainHeight`, the same analytic function the
  // simulation walks on.
  //
  // This used to be a separate formula with per-vertex `mulberry` randomness,
  // which meant the drawn ground and the walked ground disagreed — measured at
  // up to 0.40 m on the shipping campsite, which is a floating or sunken
  // camera as soon as anybody walks off the flat. `locomotion.ts` already
  // says analytic terrain is why the two can never disagree; it was only true
  // of one of them.
  for (let i = 0; i < position.count; i++) {
    position.setY(
      i,
      terrainHeight(position.getX(i), position.getZ(i), seed, amplitude, basin),
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}
