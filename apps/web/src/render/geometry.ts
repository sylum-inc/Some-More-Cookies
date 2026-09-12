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
  clamp01,
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
   * Where on the per-tree hue drift this tree sits, 0..1.
   *
   * Omit and the seed picks, which is right for a tree built on its own.
   * `createTreeGeometrySet` supplies it, because a wood of four independent
   * rolls lands on four *similar* greens about one campsite in four — the
   * same "four coin flips are not a deck" problem the form order solves, and
   * measured on the built meshes at a warm-to-cool spread of 1.08 across a
   * whole wood where a dealt set never drops below 1.4.
   */
  hue?: number;
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
 * The direction names a top face `#4a6b4a`, a mid `#33513a` and an underside
 * `#1e3328`. They cannot be written into the mesh as absolutes: the canopy
 * colour is per-campsite (`palette.foliage`, from the manifest) and the hour
 * moves it, so a baked hex would flatten every wood in the catalogue to the
 * same green and would stop the night from arriving. Keeping the *ratio* the
 * director graded leaves identity and hour where they belong.
 *
 * **The ratio has to be taken in linear light, and the first version took it
 * in sRGB bytes.** A vertex colour is multiplied into the albedo in the
 * renderer's working space, which is linear; `74 / 51` is a ratio of two
 * gamma-encoded numbers and means nothing there. Measured against the twelve
 * catalogue foliage colours, the sRGB-byte ratios separated the top face from
 * the underside by about 20/255 in green where the director's own two hexes
 * separate by 56 — the bands were computed, applied, and then squashed by the
 * transfer curve into something a screenshot reads as flat. Dividing in
 * linear puts that separation back at 31-37/255 over the same dark canopies:
 * two thirds more band, for the same three hexes.
 */
function bandRatio(top: number, bottom: number): Tone {
  // `THREE.Color` decodes an sRGB hex into the linear working space, which is
  // the whole point of doing it here rather than with byte arithmetic.
  const a = new THREE.Color(top);
  const b = new THREE.Color(bottom);
  return [a.r / b.r, a.g / b.g, a.b / b.b];
}

const TONE_SUNWARD: Tone = bandRatio(0x4a6b4a, 0x33513a);
const TONE_MID: Tone = [1, 1, 1];
const TONE_SHADE: Tone = bandRatio(0x1e3328, 0x33513a);

/**
 * Per-tree hue, so a treeline is not one wall of the same green.
 *
 * The direction asks for a drift across `#3f5f42`, `#4e6340` and `#2f4a38`.
 * Same problem as the bands: those are absolutes and the canopy colour is the
 * campsite's, so what is kept is the drift, normalised against the mean of
 * the three. Centred on 1, exactly like `groundTint`, so a wood's *average*
 * canopy is still precisely the colour the manifest asked for and none of the
 * twelve environments loses its identity.
 *
 * The luminance half of the drift is damped and the chroma half is not. Taken
 * whole, the darkest of the three anchors is 1.93x darker than the brightest,
 * and a wood where one tree in three is half the albedo of its neighbour
 * reads as two species rather than as one wood in uneven light. Damping
 * brightness to 0.45 brings that to 1.35x while leaving the full hue swing —
 * red spans 0.71 to 1.31 across the drift — which is the part that actually
 * separates one crown from the next at 320x240.
 */
const HUE_ANCHORS = [0x3f5f42, 0x4e6340, 0x2f4a38] as const;
const LUMINANCE_DAMPING = 0.45;

const HUE_DRIFT: readonly Tone[] = (() => {
  const linear = HUE_ANCHORS.map((hex) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b] as const;
  });
  const mean = [0, 1, 2].map((i) => linear.reduce((sum, v) => sum + (v[i] as number), 0) / linear.length);
  // Rec.709 luma, which is what "brighter tree" means to an eye.
  const luma = (v: readonly number[]): number =>
    0.2126 * (v[0] as number) + 0.7152 * (v[1] as number) + 0.0722 * (v[2] as number);
  return linear.map((v) => {
    const ratio = v.map((c, i) => c / (mean[i] as number));
    const level = luma(ratio);
    const damped = 1 + LUMINANCE_DAMPING * (level - 1);
    return ratio.map((c) => (c / level) * damped) as unknown as Tone;
  });
})();

/**
 * Where on the drift one tree sits.
 *
 * A continuous walk along the anchors rather than a pick of three, so a wood
 * of forty trees has forty greens in it and not three.
 */
function hueTint(roll: number): Tone {
  const span = HUE_DRIFT.length - 1;
  const t = Math.min(0.999999, Math.max(0, roll)) * span;
  const i = Math.floor(t);
  return mixTone(HUE_DRIFT[i] as Tone, HUE_DRIFT[Math.min(span, i + 1)] as Tone, t - i);
}

/**
 * Bark: `#2a211a` against the mid band, in linear, same as the tone bands.
 *
 * The trunk shares the canopy's material — the whole wood is a few draw calls
 * and splitting bark out would double them — so the only thing that can make
 * it read as wood rather than as more foliage is a tint. This one is dark and
 * decisively warm: over the catalogue's dark greens it lands on roughly
 * 24,14,12 where the canopy is 30,42,32, so red beats green on the trunk and
 * green beats red on the boughs. That inversion is what makes a trunk read as
 * a trunk at a resolution where it is three pixels wide.
 *
 * It used to be `[1.12, 0.74, 0.52]`, which put the trunk at 32,35,21 —
 * *brighter* than the canopy's own mid band and only just warmer. Graded as
 * "a fat pale cylinder ... reads as a mushroom stalk", and the pale half of
 * that was this number.
 */
const TONE_BARK: Tone = bandRatio(0x2a211a, 0x33513a);

/**
 * How high the lowest skirt is allowed to hang, as a fraction of the tree.
 *
 * The direction: "drop the lowest skirt to within 15% of ground so no
 * daylight gap opens under it".
 */
const LOWEST_SKIRT_FRACTION = 0.15;

/**
 * How much brighter the crown of a tree is than the boughs down inside it.
 *
 * Small on purpose. Before, this ramp *was* the shading — a skirt's whole
 * upper face took one value off it — and the result graded as flat. Now the
 * three bands do the shading within each skirt and this only says which end
 * of the tree the light is coming from.
 */
const CROWN_LIFT = 1.14;

/**
 * Snow, if we were told nothing about what it is being multiplied against.
 *
 * Derived from the foliage bands rather than written as three numbers,
 * because three numbers drift. It was `[2.3, 1.85, 2.7]`, tuned when the
 * sunward band was 1.45; the moment the bands were recomputed in linear light
 * the crown of an *unsnowed* tree came out brighter than the snow on a snowed
 * one, and the only reason that was caught is that a test had pinned the
 * ratio. So the ratio is now the definition: whatever the bands and the hue
 * drift are, the fallback snow is 1.6x the brightest tint any tree can
 * produce, pushed cold — green down, blue up, which is what desaturating a
 * green towards a blue-grey amounts to.
 */
const SNOW_COOL: Tone = [1, 0.83, 1.21];
const SNOW_LIFT = 1.6;
const SNOW_FALLBACK: Tone = (() => {
  const peak = Math.max(
    ...[0, 1, 2].map(
      (c) =>
        (TONE_SUNWARD[c] as number) *
        CROWN_LIFT *
        Math.max(...HUE_DRIFT.map((tint) => tint[c] as number)),
    ),
  );
  const cool = mulTone(TONE_SUNWARD, SNOW_COOL);
  return scaleTone(cool, (peak * SNOW_LIFT) / Math.max(...cool));
})();

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
  // Drawn before anything else so the roll is stable: adding a shape later
  // must not repaint the whole wood. Drawn even when the caller supplies a
  // hue, or opting in would shift every position in the tree.
  const hueRoll = rng();
  const tint = hueTint(options.hue ?? hueRoll);

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

  /*
   * Trunk width, cut to about a third of what it was.
   *
   * The old `0.028 + rng() * 0.016` is a trunk 22-35 cm across on a 4 m tree.
   * At the world camera's 62 degree field over a 240-line buffer that is 222
   * pixels per radian, so at six metres the trunk was eight pixels wide — a
   * post, and graded as one. A third of it is 8-11 cm, which is what a fir
   * that height actually measures, and still 3-4 pixels at the same distance:
   * thin enough to see the wood through, wide enough not to alias away.
   *
   * A snag is the exception and keeps half again, because a dead tree has no
   * canopy and is read entirely by its trunk. That is the whole reason it is
   * in the deck.
   */
  const trunkWidth = height * (0.0095 + rng() * 0.0055) * (form === 'snag' ? 1.6 : 1);
  addTrunk(surfaces, {
    height: trunkHeight,
    radius: trunkWidth,
    segments: detail === 'far' ? 4 : 5,
    broken: form === 'broken' || form === 'snag',
    tint,
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
        tint,
      });
    }
  } else {
    /*
     * How much bare trunk shows under the lowest skirt.
     *
     * `bareFraction` still decides the *shape* — a broad old fir carries its
     * canopy higher and is a different tree from a spire — but the visible gap
     * is capped at 15% of the tree's height, which is what the direction
     * asked for after grading the old broad fir's bare third as "a wide
     * daylight gap under the bottom skirt".
     *
     * The thing the bare third was there for was seeing *through* a wood
     * rather than at it. That now comes from the trunk being a third of the
     * width and a good deal darker than the canopy, which buys the same
     * see-through at a fifth of the pixels — and without the gap that made
     * every broad fir read as a stalk with a hat on.
     */
    const canopyBase = Math.min(trunkTop * bareFraction, height * LOWEST_SKIRT_FRACTION);
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
        // Floored at the ground: with the canopy dropped to 15% of the
        // height, the lowest skirt's underside apex reaches below zero at the
        // `far` detail level, where three skirts have to cover the whole
        // canopy and each step is a third of the tree.
        yUnder: Math.max(height * 0.005, yBase - step * (0.35 + rng() * 0.25)),
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
        tint,
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
          tint,
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
  /*
   * And the hue is dealt for the same reason the form is.
   *
   * Every bucket takes an even slice of the drift, so a wood always spans it
   * — but the whole set is rotated by a per-campsite phase, so two campsites
   * that both draw four trees do not both start on the same green. Without
   * the deal, four independent rolls gave a warm-to-cool spread of only 1.08
   * at seed 99991 against 1.37 at seed 60013: one wood in four came out as
   * the flat wall this was supposed to break up.
   */
  const phase = mulberry(seed ^ 0x9e37)();
  return Array.from({ length: count }, (_, i) =>
    // The same `seed + i * 977` the campsite already used, so a campsite that
    // switches to this keeps the trees it had in the places it had them.
    createTreeGeometry(seed + i * 977, height, {
      ...options,
      form: order[i % order.length] as TreeForm,
      hue: ((i + 0.5) / count + phase) % 1,
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
  /** This tree's place on the hue drift. */
  tint: Tone;
  rng: () => number;
}

/** A tapered trunk, open at both ends — the skirts and the ground cap it. */
function addTrunk(surfaces: Surfaces, spec: TrunkSpec): void {
  const { height, radius, segments, rng, tint } = spec;
  const bark = mulTone(TONE_BARK, tint);
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
    const tone = scaleTone(bark, 0.75 + lit * 0.4);
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
  tint: Tone;
}

/** A dead branch stub: three tapered faces, which is enough of a stick. */
function addStub(surfaces: Surfaces, spec: StubSpec): void {
  const { y, angle, length, radius, droop, tint } = spec;
  const bark = mulTone(TONE_BARK, tint);
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const tipX = dx * length;
  const tipY = y + length * droop;
  const tipZ = dz * length;
  const tone = scaleTone(bark, 0.9);
  const shade = scaleTone(bark, 0.55);
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
  /** This tree's place on the hue drift. */
  tint: Tone;
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
  const { yBase, yTip, yUnder, radius, segments, phase, rng, snow, snowTone, tint, fringe } = spec;

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

  /*
   * Three bands **per skirt**, which is the whole of the fix.
   *
   * They used to be three bands per *tree*: the upper face of a skirt was one
   * tone lerped from `lit`, its rim was 8% of that, and the underside was the
   * shade band. Within any one skirt that is two values eight per cent apart,
   * so every skirt was a flat lit shape over a flat dark shape and the stack
   * graded as "stacked paper cutouts, not volumes". Measured on the built
   * mesh, a single skirt's upper faces spanned 1.09x top to bottom, which is
   * below what an ordered dither at 320x240 can even resolve into a step.
   *
   * Now the top band sits at the apex — the inner part of the bough, up
   * against the trunk — the mid band at the rim, and the underside band under
   * the whole thing. Every skirt therefore carries the full 2.07 -> 1.0 ->
   * 0.39 range on its own, the underside of each self-shadows the top of the
   * one below, and the stack reads as depth rather than as a stack.
   *
   * `lit` survives as a lift of the *whole* skirt, not as its only shading:
   * the crown is a little brighter than the boughs down in the tree, which is
   * true, but it is no longer the difference between having bands and not.
   */
  const crown = Math.min(1, spec.lit * 1.2);
  const topTone = mulTone(scaleTone(TONE_SUNWARD, 1 + (CROWN_LIFT - 1) * crown), tint);
  const rimTone = mulTone(scaleTone(TONE_MID, 1 + (CROWN_LIFT - 1) * crown), tint);
  const underTone = mulTone(TONE_SHADE, tint);
  // Snow lies on the inner part of the upper face, which is where the apex
  // vertex is — so tinting the apex alone is the "top 40% of the upper face"
  // the direction asked for, for free. The tree's hue drift is deliberately
  // not applied to it: snow is snow at every campsite.
  const tipTone = snow > 0 ? mixTone(topTone, snowTone, snow) : topTone;

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
      scaleTone(rimTone, faceLift),
      scaleTone(rimTone, faceLift),
    );

    // Under face, wound the other way. This is the shade band and it is what
    // stops the canopy being see-through from below with a single-sided
    // material.
    const shade = scaleTone(underTone, 0.88 + rng() * 0.2);
    pushTriangle(
      surfaces,
      0, yUnder, 0,
      rimX[i] as number, rimY[i] as number, rimZ[i] as number,
      rimX[j] as number, rimY[j] as number, rimZ[j] as number,
      0.5, 0, u0, 0.4, u1, 0.4,
      scaleTone(underTone, 0.7),
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
      const spine = scaleTone(underTone, 1.1);
      pushTriangle(surfaces, ax, ay, az, bx, by, bz, cx, cy, cz,
        u0, 0, u0, 0.2, u1, 0, rimTone, spine, rimTone);
      pushTriangle(surfaces, ax, ay, az, cx, cy, cz, bx, by, bz,
        u0, 0, u1, 0, u0, 0.2, rimTone, rimTone, spine);
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

/** Two multipliers stacked: a band, and the tree's own hue. */
function mulTone(a: Tone, b: Tone): Tone {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
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

/**
 * A box that is a surface rather than a primitive.
 *
 * Everything built out of boxes in this world — the bear box, the site post,
 * the ruined frame, the survey stake, the shelf — used `BoxGeometry` straight,
 * and `BoxGeometry` lays 0..1 UVs across every face whatever size the face is.
 * That is the same defect the ground had, at a smaller scale and with the same
 * result: a metre-wide face carrying a sixty-four pixel tile magnified to a
 * centimetre and a half a texel, which is not a texture, it is a wash. An art
 * review picked exactly one object out of a dusk frame and called it "a plain
 * grey rectangle... an untextured box", and it was untextured in every way
 * that matters.
 *
 * Two things fix it and neither costs a triangle:
 *
 *   - **UVs in metres.** Each face is scaled by its own real dimensions, so
 *     one tile is `tile` metres whichever face it lands on and a big face gets
 *     more texture rather than a bigger texture.
 *   - **A weathering tint.** A vertex colour that darkens the undersides,
 *     lifts the top, and runs a gradient down each side — the dirt line every
 *     object that has stood outdoors has, and the single cheapest thing that
 *     separates a made object from a rendered cuboid.
 */
export function createBoxGeometry(
  width: number,
  height: number,
  depth: number,
  options: { tile?: number; seed?: number; index?: number; tone?: number } = {},
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const tile = options.tile ?? 0.45;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  /*
   * `BoxGeometry` builds its faces in a fixed order — +x, -x, +y, -y, +z, -z —
   * four vertices each at one segment. Each face's UV runs across two of the
   * three dimensions, and which two is what this table says.
   */
  const spans: readonly [number, number][] = [
    [depth, height], [depth, height],
    [width, depth], [width, depth],
    [width, height], [width, height],
  ];
  for (let face = 0; face < 6; face++) {
    const [su, sv] = spans[face] as [number, number];
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      if (i >= uv.count) break;
      uv.setXY(i, uv.getX(i) * (su / tile), uv.getY(i) * (sv / tile));
    }
  }
  uv.needsUpdate = true;

  const seed = options.seed ?? 1;
  const index = options.index ?? 0;
  const base = options.tone ?? 1;
  const colors = new Float32Array(position.count * 3);
  const half = height / 2;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const ny = geometry.getAttribute('normal')?.getY(i) ?? 0;
    // Top faces catch the sky, undersides get nothing at all.
    const facing = ny > 0.5 ? 1.16 : ny < -0.5 ? 0.68 : 1;
    // And every vertical face is dirtier at the bottom than at the top.
    const up = half > 0 ? clamp01((y + half) / (height || 1)) : 1;
    const grime = ny > -0.5 && ny < 0.5 ? 0.8 + up * 0.26 : 1;
    // A per-part nudge, so a box built out of seven boxes is not seven
    // identical values.
    const nudge = 0.94 + latticeValue(index + 1, i >> 2, seed) * 0.12;
    const value = base * facing * grime * nudge;
    colors[i * 3] = value * 1.02;
    colors[i * 3 + 1] = value;
    colors[i * 3 + 2] = value * 0.96;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** An irregular low-poly rock. */
/**
 * A rock, and the bug that made every one of them a pile of loose triangles.
 *
 * `IcosahedronGeometry` is **non-indexed**: twenty faces are stored as sixty
 * separate corners, so the twelve corners of the solid appear five times each.
 * This function used to draw a fresh random scale per *index* — sixty draws for
 * twelve corners — which moved all three corners of every face independently
 * and burst the solid into twenty free-floating triangles. `computeVertexNormals`
 * then gave each shard a flat normal pointing wherever it happened to end up,
 * and about half of them faced away from whatever was lighting the scene and
 * shaded to nothing.
 *
 * That is every rock in the game: the fire ring, the four scatter rocks in the
 * clearing, the curio stones, and the stumps, rootballs and cairn stones in
 * `landmarks.ts`. An art director described the result without seeing any code
 * — "hard-edged angular wedges whose undersides are solid near-black, reading
 * as z-fighting shards or folded card, silhouette all sharp points" — which is
 * exactly what twenty disconnected triangles look like.
 *
 * The fix is one line of principle: **displace by direction, not by index.**
 * Corners that share a position share a direction, so they get the same draw
 * and stay welded, and the hull stays closed. Same rng, same sequence, same
 * character of lump — a rock is still irregular, it is just still a rock.
 */
export function createRockGeometry(seed: number, size = 0.4): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const geometry = new THREE.IcosahedronGeometry(size, 0);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  /*
   * One draw per distinct corner, keyed by its direction.
   *
   * Rounded to three decimals before it is used as a key, because the corner
   * coordinates are computed rather than tabulated and the five copies of a
   * corner are equal to within floating-point noise rather than exactly equal.
   * Three decimals on a unit vector is about a fifth of a degree — far finer
   * than the gap between any two icosahedron corners, and far coarser than the
   * noise.
   */
  const scales = new Map<string, number>();
  const scaleFor = (x: number, y: number, z: number): number => {
    const length = Math.hypot(x, y, z) || 1;
    const key = `${(x / length).toFixed(3)},${(y / length).toFixed(3)},${(z / length).toFixed(3)}`;
    let scale = scales.get(key);
    if (scale === undefined) {
      scale = 0.65 + rng() * 0.6;
      scales.set(key, scale);
    }
    return scale;
  };

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const scale = scaleFor(x, y, z);
    // Squat, because a stone that has been sitting somewhere is wider than it
    // is tall and a tall one reads as a shard.
    position.setXYZ(i, x * scale, y * scale * 0.7, z * scale);
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

    /*
     * The worn ring is not here any more, and that is the point.
     *
     * It used to be a term in this function: a brightening between 1.35 and
     * 3.4 metres, on a mesh whose quads are a metre and three quarters across.
     * Two vertices wide is not a ring, it is a smudge — and it was never drawn
     * at all, because nothing ever attached this attribute to the terrain.
     * `createGroundCoverGeometry` draws it properly now, on its own radial
     * mesh at ten times the vertex density and in its own tile, and it covers
     * every metre this term used to reach. Computing it twice and drawing it
     * once is exactly the pattern this project keeps being bitten by.
     */
    const lift = Math.max(-1, Math.min(1, y * 1.4));

    /*
     * And the fourth thing, which used to be somewhere it could not work.
     *
     * `Campsite` multiplied this whole mesh's material by a flat 0.88 to put
     * it "under the canopy edge rather than under the sky". A material colour
     * is one colour, so what that actually produced was a step at the mat's
     * rim and then nothing: six metres of clearing floor at one value, which
     * is most of the bottom half of most frames and is exactly the "one brown
     * wash" three art directors reported independently. See `clearingShade`.
     */
    const canopy = clearingShade(Math.hypot(x, z));
    const shaded = 1 - (canopy - 1) / CLEARING_LIFT;
    const shadedTone = tone * canopy;
    colors[i * 3] = shadedTone * (1 + lift * 0.05 - shaded * 0.045);
    colors[i * 3 + 1] = shadedTone * (1 + lift * 0.015);
    colors[i * 3 + 2] = shadedTone * (1 - lift * 0.045 + shaded * 0.06);
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
  /*
   * And the tint, which was computed and never attached.
   *
   * `groundTint` was written for this mesh — its own comment says "the
   * terrain is a metre-and-three-quarters to a quad" — and the only caller it
   * ever had was `createRockGeometry`. `Campsite` then built the ground
   * material with `vertexColors: true` and a comment saying "the per-vertex
   * tint `createTerrainGeometry` bakes in", against a geometry that had no
   * colour attribute at all. So the broad patches, the height tilt and the
   * worn ring around the fire were all dead code, and a fourth art review
   * described the ground as one flat field for the fourth time.
   *
   * It is worse than merely absent, too: `MeshStandardMaterial` carries no
   * `defaultAttributeValues`, so a missing `color` attribute leaves the shader
   * reading the generic vertex attribute — whatever the driver last left
   * there, with (0,0,0,1) the specified default. A ground that renders is not
   * evidence that the multiply was 1.
   */
  geometry.setAttribute('color', groundTint(position, seed));
  return geometry;
}

/** How `createTerrainGeometry` was called, so its drawn surface can be sampled. */
export interface TerrainGrid {
  readonly size: number;
  readonly segments: number;
  readonly seed: number;
  readonly amplitude?: number;
  readonly basin?: WaterBasin;
}

/**
 * The height of the ground *as drawn*, which is not the height of the ground.
 *
 * `terrainHeight` is the analytic surface the player walks on; the mesh is a
 * grid of flat triangles through samples of it, and between those samples the
 * two disagree — measured on the shipping campsite at up to 9 cm, with the
 * mesh *above* the function about as often as below.
 *
 * Nine centimetres is nothing to a walk cycle and everything to anything laid
 * on top of the ground. A mat placed at the analytic height and lifted a
 * centimetre and a half is swallowed by the drawn terrain across a good
 * fraction of its area, in patches, which reads as holes torn in the clearing
 * floor. So anything that lies *on* the ground is placed on the surface that
 * is actually there.
 *
 * `PlaneGeometry` splits each quad along the diagonal from its (−x, +z) corner
 * to its (+x, −z) corner — the `a, b, d` / `b, c, d` winding in three's own
 * source — which is what decides the two branches below. That is checked
 * against a ray-cast onto the real mesh rather than trusted.
 */
export function drawnTerrainHeight(x: number, z: number, grid: TerrainGrid): number {
  const step = grid.size / grid.segments;
  const half = grid.size / 2;
  const amplitude = grid.amplitude ?? 0.6;
  const gx = (x + half) / step;
  const gz = (z + half) / step;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const u = gx - i;
  const v = gz - j;
  const x0 = i * step - half;
  const z0 = j * step - half;
  const h = (px: number, pz: number): number =>
    terrainHeight(px, pz, grid.seed, amplitude, grid.basin);
  if (u + v <= 1) {
    const h00 = h(x0, z0);
    return h00 + (h(x0 + step, z0) - h00) * u + (h(x0, z0 + step) - h00) * v;
  }
  const h11 = h(x0 + step, z0 + step);
  return h11 + (h(x0, z0 + step) - h11) * (1 - u) + (h(x0 + step, z0) - h11) * (1 - v);
}

/**
 * The ground you are actually standing on.
 *
 * The terrain mesh is one grid at a metre and three quarters to a quad,
 * stretched over forty-six to seventy metres, and it cannot be both. Detail
 * belongs where the camera is: half of every frame is the ground within about
 * eight metres of the fire, and out past that it should quieten or the whole
 * field turns to mush under the downsample. Making the whole grid finer would
 * spend the entire triangle budget describing ground the player never looks
 * at.
 *
 * So this is a small radial mat laid over the terrain around the fire, in two
 * pieces:
 *
 *   - **the worn ring**, the trodden ground people have flattened by sitting
 *     and walking on it, in its own compacted tile;
 *   - **the duff** outside it, needle litter in its own tile at a coarser
 *     scale.
 *
 * Two pieces rather than a tint across one, because "no variation in grain
 * between the trodden ring and the untrodden ground" is a note about
 * *texture*, and a tint cannot change a grain. They share one jittered
 * boundary polygon so the seam is exact — no gap, no overlap — and the
 * boundary is deliberately ragged: a circle would read as a decal, which is
 * what a worn ring must never do.
 *
 * Radially tessellated so the vertex density is highest where the camera is,
 * which is the whole point: a fifth of the triangles of an equivalent grid,
 * concentrated in the two metres in front of your feet.
 */
export interface GroundCover {
  /** Compacted bare soil, from the fire out to the ragged boundary. */
  readonly worn: THREE.BufferGeometry;
  /** Needle litter, from the boundary out to where the mat fades away. */
  readonly duff: THREE.BufferGeometry;
  /** Triangles in both pieces together, for budgeting. */
  readonly triangles: number;
}

/**
 * How far the burnt ground reaches past the ring stones, in metres.
 *
 * Wide enough to be an apron rather than a rim — a fire that has been lit in
 * the same spot for years sterilises a good stride of ground around itself —
 * and narrow enough that the trodden ring still surrounds it, because the
 * ring only reads as used because of the dark centre it encloses.
 */
const SCORCH_REACH = 1.45;

/**
 * The walk from the middle of the clearing to under the trees, as one number.
 *
 * The middle of a clearing has the sky over it. The ground at the canopy edge
 * is in shade for most of the day and has a deeper, wetter litter on it. That
 * is a property of *where the ground is*, and this is the only place it is
 * written down — which is the point, because the last version of it was a
 * property of *which mesh was drawing it* and that turned out to mean
 * something entirely different.
 *
 * `Campsite` used to paint the terrain material at a flat 0.88 and the duff
 * mat at 1.0, and argue for a three-step ladder from the fire to the treeline.
 * Measured, the ladder was two steps with six flat metres between them, and
 * the reason is geometric: the duff mat's triangles reach about two and a half
 * metres across at its rim against a terrain grid of 0.63, and a mat lifted
 * fifteen millimetres cannot stay above a grid that coarse relative to it. So
 * from roughly five and a half metres outward the mat is buried and the
 * terrain is what you are looking at — flat, because a material colour is the
 * same everywhere.
 *
 * Proven by hiding the mat and re-measuring: the value profile did not move at
 * any radius, and only the grain collapsed, from about 14 to 6, and only
 * between 3.5 and 5 m. The mat draws a band, not a floor.
 *
 * Applied per vertex against world radius, both meshes read the same function,
 * so the seam between them cannot drift. Smoothstepped rather than linear
 * because a kink in a gradient across the largest surface in the game reads as
 * a ring on the ground.
 */
const CLEARING_LIFT = 0.38;

/** Inside this radius the clearing is fully open to the sky. */
const CLEARING_OPEN = 2.6;

/** By this radius the canopy has closed over. Past it the shade holds. */
const CLEARING_EDGE = 13;

/**
 * How much light the clearing's floor gets at a given world radius.
 *
 * `1 + CLEARING_LIFT` in the open middle, falling to exactly 1 under the
 * trees. Multiply it into a vertex tone; do not put it in a material colour,
 * because a material colour cannot vary across the surface it paints and that
 * is the entire bug this replaced.
 *
 * **A lift, never a cut, and that is deliberate.** The obvious way to write
 * this ladder is to darken the ground toward the canopy, and the first version
 * did. But `groundTint` paints the terrain for the whole world, not just the
 * campsite, so a term that falls below 1 past the treeline darkens every metre
 * of the explorable half as well — and the explorable half is already the part
 * a critic measured at 93.6 per cent of pixels below luminance 32 and called
 * crushed rather than dark. Lifting the clearing instead puts the same ladder
 * on screen and leaves the wood exactly where it was. It also happens to be
 * the fix another critic asked for outright: lift the night ground's floor so
 * the firelight has something to fall off *into* instead of off a cliff.
 *
 * **The size of it is set in linear light and read in sRGB, which is not the
 * same number.** The renderer's working space is linear; the value an art
 * director sees, and every measurement in `e2e/ground.spec.ts`, is sRGB. Near
 * the levels this ground sits at — about 0.065 linear, 75 of 255 displayed —
 * the encode curve compresses a change by roughly four to one, so the flat
 * 0.88 this replaced was worth about two display units and read as nothing at
 * all. 0.38 is worth about ten, which is a bit over half the worn ring's step
 * and therefore reads as a gradient rather than as a second material.
 */
export function clearingShade(radius: number): number {
  const t = clamp01((radius - CLEARING_OPEN) / (CLEARING_EDGE - CLEARING_OPEN));
  return 1 + CLEARING_LIFT * (1 - t * t * (3 - 2 * t));
}

/**
 * A path worn out of the clearing toward something worth walking to.
 *
 * `bearing` is the world angle from the fire, `reach` how much further out the
 * trodden ground goes along it in metres, and `width` the half-angle it
 * subtends.
 */
export interface WornLane {
  readonly bearing: number;
  readonly reach: number;
  readonly width: number;
}

/**
 * How trodden the ground is at a given bearing, 0..1.
 *
 * The worn ground was a ring — lobed by two harmonics, but a ring. A camp
 * does not wear evenly: people go to the machine, to the woodpile, and out
 * the way they came in, and the ground between those runs keeps its litter.
 * A panel of three art directors each asked for this in their own words, the
 * clearest being "a paler compacted lane running from fire to log to machine
 * and off toward the creek, deep rust needle-duff banked up where nobody
 * steps".
 *
 * The falloff is Gaussian rather than a cone because a path has no edge — it
 * fades into the litter either side of it, and a hard-edged one would be the
 * decal failure this ground has already had to be rescued from twice.
 */
export function laneInfluence(angle: number, lanes: readonly WornLane[]): number {
  let most = 0;
  for (const lane of lanes) {
    most = Math.max(most, laneFalloff(angle, lane));
  }
  return most;
}

/**
 * How much further out the trodden ground goes at this bearing, in metres.
 *
 * Separate from `laneInfluence` because the two are different questions: how
 * *worn* the ground is here, which is a ratio, and how far the wear *reaches*,
 * which is a distance. Folding them into one number and multiplying by the
 * first lane's reach — as the first version of this did — gives every lane the
 * first one's length and throws outright when there are none.
 */
export function laneReach(angle: number, lanes: readonly WornLane[]): number {
  let most = 0;
  for (const lane of lanes) {
    most = Math.max(most, lane.reach * laneFalloff(angle, lane));
  }
  return most;
}

function laneFalloff(angle: number, lane: WornLane): number {
  // Shortest way round the circle, so a lane at 3.1 rad still reaches a
  // spoke at -3.1.
  let delta = angle - lane.bearing;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  const t = delta / lane.width;
  return Math.exp(-t * t);
}

export function createGroundCoverGeometry(options: {
  seed: number;
  /**
   * Where the mat starts. There is a hole in the middle of it, because the
   * middle of it is the fire: the ash bed is a disc of radius 0.42 sitting
   * five millimetres off the ground and the ring stones stand at 0.4, and a
   * mat laid over the top of those would bury the most looked-at object in
   * the game under a centimetre and a half of dirt.
   */
  innerRadius?: number;
  /** Where the worn ring sits, on average, in metres from the fire. */
  wornRadius?: number;
  /** Where the mat stops and the plain terrain takes over. */
  outerRadius?: number;
  /** Radial spokes. The quality tier's dial: fewer is coarser, not smaller. */
  spokes?: number;
  /** Ground height at a point — the same analytic function the player walks. */
  height: (x: number, z: number) => number;
  /** Metres per texture tile, per piece. */
  wornTile?: number;
  duffTile?: number;
  /** Paths worn out of the clearing. See `laneInfluence`. */
  lanes?: readonly WornLane[];
}): GroundCover {
  const seed = options.seed;
  const innerRadius = options.innerRadius ?? 0.58;
  const wornRadius = options.wornRadius ?? 3.1;
  const outerRadius = options.outerRadius ?? 7.6;
  const spokes = Math.max(8, options.spokes ?? 20);
  const wornTile = options.wornTile ?? 0.85;
  /*
   * The duff mat tiles at exactly the terrain's own scale.
   *
   * It is tempting to make it finer — it is the near ground, after all — and
   * the first attempt did, at 1.25 m against the terrain's 2 m. Rendered, that
   * put a visible ring in the picture where the mat ended: two tile scales of
   * the same texture minify differently under nearest sampling with no
   * mipmaps, so the coarse one aliases pale and the fine one reads its true
   * mean, and the seam between them is a step in *value* rather than in grain.
   * Which is the decal failure again.
   *
   * So the duff mat contributes vertex density and the ragged inner boundary,
   * and the whole of the grain change lives at the worn ring's edge — which is
   * where the art direction wants it, and is the one boundary that is supposed
   * to be visible.
   */
  const duffTile = options.duffTile ?? 2;
  const lanes = options.lanes ?? [];
  const height = options.height;

  /*
   * The boundary. Two harmonics rather than per-spoke noise: a wobble at every
   * spoke reads as a sawtooth, and what a trodden edge actually has is a few
   * long lobes — the sides people come in from are worn further out than the
   * side with the woodpile against it.
   */
  const boundary = new Float64Array(spokes);
  const phaseA = valueNoise2D(seed * 0.017, 3.1, seed) * Math.PI * 2;
  const phaseB = valueNoise2D(seed * 0.031, 7.7, seed ^ 0x2f11) * Math.PI * 2;
  for (let s = 0; s < spokes; s++) {
    const angle = (s / spokes) * Math.PI * 2;
    const lobe = Math.sin(angle * 2 + phaseA) * 0.42 + Math.sin(angle * 3 + phaseB) * 0.26;
    const grain = valueNoise2D(Math.cos(angle) * 4, Math.sin(angle) * 4, seed ^ 0x77a3) - 0.5;
    // And the paths, which is what turns a ring into a camp. The lobes above
    // are still there: a lane is where people go *most*, not the only place
    // the ground is bare.
    boundary[s] = wornRadius * (1 + lobe * 0.22) + grain * 0.5 + laneReach(angle, lanes);
  }

  /** Radii for one piece, packed toward the inside so the near ground is finer. */
  const ringsBetween = (inner: number, outer: number, count: number, bias: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= count; i++) {
      const t = Math.pow(i / count, bias);
      out.push(inner + (outer - inner) * t);
    }
    return out;
  };

  const build = (
    innerAt: (spoke: number) => number,
    outerAt: (spoke: number) => number,
    steps: number,
    bias: number,
    tile: number,
    tone: (x: number, z: number, radial: number, along: number) => Tone,
  ): THREE.BufferGeometry => {
    const surfaces: Surfaces = { positions: [], normals: [], uvs: [], colors: [] };
    const at = (spoke: number, step: number): [number, number, number, Tone, number, number] => {
      const s = spoke % spokes;
      const angle = (s / spokes) * Math.PI * 2;
      const inner = innerAt(s);
      const outer = outerAt(s);
      const radii = ringsBetween(inner, outer, steps, bias);
      const r = radii[step] as number;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      // Lifted a centimetre and a half. Enough to win the depth test against
      // the coarse grid it lies on everywhere between that grid's vertices,
      // small enough that the lip is under a pixel at the distance the mat
      // ends.
      const y = height(x, z) + 0.015;
      return [x, y, z, tone(x, z, step / steps, s / spokes), x / tile, z / tile];
    };

    for (let s = 0; s < spokes; s++) {
      for (let step = 0; step < steps; step++) {
        const a = at(s, step);
        const b = at(s + 1, step);
        const c = at(s + 1, step + 1);
        const d = at(s, step + 1);
        const push = (p: [number, number, number, Tone, number, number]): void => {
          surfaces.positions.push(p[0], p[1], p[2]);
          surfaces.normals.push(0, 1, 0);
          surfaces.uvs.push(p[4], p[5]);
          surfaces.colors.push(p[3][0], p[3][1], p[3][2]);
        };
        /*
         * Wound so the mat faces up, which is the only way it is ever seen.
         *
         * The obvious order — outward, then round — winds these clockwise seen
         * from above, and a clockwise triangle under a `FrontSide` material is
         * not a dark triangle, it is no triangle: the whole mat was culled and
         * the clearing floor looked exactly as it did before. Found by
         * rendering it offline and noticing that the fire lit the terrain
         * showing through the pit hole and nothing else.
         */
        push(a); push(c); push(d);
        push(a); push(b); push(c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surfaces.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(surfaces.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surfaces.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(surfaces.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  };

  /*
   * The tints. Both are centred so that the *outermost* ring of the duff is
   * exactly 1 — the identity under the multiply — because that ring has to
   * disappear into the terrain around it. Anything else and the mat has a
   * visible rim, which is the decal failure again.
   */
  const wornSteps = 6;
  const duffSteps = 4;

  const worn = build(
    () => innerRadius,
    (s) => boundary[s] as number,
    wornSteps,
    /*
     * Biased inward, which this genuinely is now.
     *
     * The exponent is applied as `(i / count) ** bias`, so a value BELOW one
     * lifts every intermediate t and pushes the rings *outward* — the old 0.78
     * crowded them at the rim under a comment claiming it crowded them at the
     * pit. It put exactly one vertex inside a metre and a third, which is the
     * whole width of the burnt ground, so the scorch had nowhere to resolve
     * however hard it was authored. Above one is inward: 1.6 places four of
     * the six rings inside 1.7 m.
     */
    1.6,
    wornTile,
    (x, z) => {
      const grain = valueNoise2D(x / 1.7, z / 1.7, seed ^ 0x51ab) - 0.5;
      const broad = valueNoise2D(x / 5.5, z / 5.5, seed) - 0.5;
      /*
       * Scorch, in metres rather than in mesh parameter.
       *
       * It used to be a fraction of the way along the worn piece, which makes
       * the burnt ground's width depend on how far out the trodden boundary
       * happens to lobe on that spoke — a metre and a half on one side of the
       * pit and half that on the other, for no reason a player could see. The
       * ash bed does not know where people walk. It is a disc, broken at its
       * edge, measured from the stones.
       */
      const r = Math.hypot(x, z);
      const ragged = valueNoise2D(x * 1.9, z * 1.9, seed ^ 0x2c7f) - 0.5;
      const scorch = clamp01(1 - (r - innerRadius) / SCORCH_REACH + ragged * 0.24);
      /*
       * And deep enough to actually be dark, which is the part that was
       * silently false.
       *
       * The trodden tile is normalised to `TRODDEN_LIFT` — 1.7x the reference
       * ground mean — so the worn piece starts 70 per cent brighter than the
       * duff around it before any of this runs. A scorch that took 34 per cent
       * off left the burnt ground at 1.12 of the untrodden floor: still the
       * brightest ground in the clearing. Measured on the shipped build, the
       * value at the stones was 89 against the duff's 74, which is the exact
       * opposite of what a fire does to earth, and is why three art directors
       * asked for "a dark scorched apron immediately around the stones" while
       * looking at one that was already being drawn.
       *
       * 0.6 puts the centre at 0.4 of the tile, which after the lift is about
       * 0.72 of the duff — properly darker. It is safe against the D7
       * legibility floor precisely because it is the ground the fire is
       * standing on: the darkest albedo in the clearing sits under the
       * brightest light in it.
       */
      const value = 1 + grain * 0.16 + broad * 0.14 - scorch * 0.62;
      // Bare soil is greyer than duff, and scorched soil greyer still: the red
      // in a forest floor is the needles, and there are none here.
      return [
        value * (1 - scorch * 0.05),
        value * (1 + 0.015),
        value * (1 + 0.05 + scorch * 0.06),
      ];
    },
  );

  const duff = build(
    (s) => boundary[s] as number,
    () => outerRadius,
    duffSteps,
    1.25,
    duffTile,
    (x, z, radial) => {
      const grain = valueNoise2D(x / 2.2, z / 2.2, seed ^ 0x5bd1) - 0.5;
      const broad = valueNoise2D(x / 7.4, z / 7.4, seed) - 0.5;
      // Faded out at the rim so the mat has no edge, and thickest just outside
      // the worn ring where the sweeping piled it up.
      const fade = 1 - radial * radial;
      /*
       * Litter banked where nobody steps.
       *
       * The complement of the lanes, and the other half of what makes a path
       * read as a path: the ground between the runs is not merely un-swept,
       * it is where the needles that were swept off the runs ended up. Deeper
       * litter is darker and redder, so this both darkens and warms.
       */
      const between = 1 - laneInfluence(Math.atan2(z, x), lanes);
      const bank = clamp01(1 - radial / 0.3) * 0.05 + between * 0.07;
      /*
       * The walk out to the trees, which the floor never had.
       *
       * `Campsite` paints three ground materials at three shades — the worn
       * ring at 1.06, the duff at 1.00, the terrain at `CANOPY_SHADE` 0.88 —
       * and argues at length for the resulting three-step ladder from the fire
       * to the treeline. Two of those steps are real. The third is not on
       * screen: the terrain only begins where the mats end, nine and a half
       * metres out, and by then it is behind the trees and most of the way
       * into distance fog. So the duff carried one flat value across the six
       * metres that are the bottom half of most frames, and measured that way
       * — 75.6, 72.7, 75.9, 73.3, 75.2, 75.2, 75.3 out of 255 at a metre's
       * spacing, which is a wash with noise on it.
       *
       * The ladder belongs inside the mat, as a function of where the ground
       * actually is rather than of which mesh happens to be drawing it. This
       * lands the mat's rim on `CANOPY_SHADE` exactly, so the terrain picks
       * the gradient up where the mat drops it and there is no seam to find.
       *
       * The middle of a clearing has the sky over it; the ground at the canopy
       * edge is in shade most of the day and has a deeper, wetter litter on
       * it. So most of the step is temperature rather than value, for the same
       * reason it is on the terrain: a value step big enough to read as a step
       * reads as two materials with a join, which is the decal failure the
       * worn ring has already had to be rescued from once.
       */
      const canopy = clearingShade(Math.hypot(x, z));
      const shaded = 1 - (canopy - 1) / CLEARING_LIFT;
      const value = (1 + (grain * 0.2 + broad * 0.16 - bank) * fade) * canopy;
      return [
        value * (1 + 0.04 * fade - shaded * 0.035),
        value,
        value * (1 - 0.05 * fade + shaded * 0.045),
      ];
    },
  );

  return {
    worn,
    duff,
    triangles: spokes * (wornSteps + duffSteps) * 2,
  };
}

/**
 * The things lying on the ground, as one shape each so they can be instanced.
 *
 * Two of them, because two is what the eye needs to stop reading a surface as
 * a plane: something hard and pale that catches the light, and something soft
 * and dark that does not. Both are a handful of triangles — the whole point is
 * that there are ninety of them in one draw call, not that any one of them is
 * a model.
 */
export type LitterKind = 'pebble' | 'sprig';

export function createLitterGeometry(kind: LitterKind, seed: number, size = 0.09): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const surfaces: Surfaces = { positions: [], normals: [], uvs: [], colors: [] };

  if (kind === 'pebble') {
    /*
     * A stone half out of the ground: a six-sided plate with the middle
     * lifted. Six triangles. An icosahedron would be twenty for a shape that
     * is four pixels across, and the buried half is never seen.
     */
    const sides = 6;
    const rim: [number, number, number][] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2 + rng() * 0.35;
      const r = size * (0.62 + rng() * 0.55);
      rim.push([Math.cos(angle) * r, size * 0.06 * rng(), Math.sin(angle) * r]);
    }
    const px = (rng() - 0.5) * size * 0.3;
    const py = size * (0.42 + rng() * 0.3);
    const pz = (rng() - 0.5) * size * 0.3;
    for (let i = 0; i < sides; i++) {
      const a = rim[i] as [number, number, number];
      const b = rim[(i + 1) % sides] as [number, number, number];
      // Warm on some faces, cool on the others — a stone with one value is a
      // disc, and a disc is what a pebble must not be.
      const lit = 0.84 + (((i * 2 + 1) % sides) / sides) * 0.46;
      const tone: Tone = [lit * 1.05, lit, lit * 0.95];
      // Peak, then round the rim the *other* way: anticlockwise seen from
      // above is what a `FrontSide` material draws.
      pushTriangle(
        surfaces,
        px, py, pz,
        b[0], b[1], b[2],
        a[0], a[1], a[2],
        0.5, 0.5,
        (i + 1) / sides, 0,
        i / sides, 0,
        [lit * 1.12, lit * 1.06, lit],
        tone,
        tone,
      );
    }
  } else {
    /*
     * A sprig of fallen needles and one small stick, lying flat. Three long
     * thin triangles at different angles: at 426x240 a twig is one or two
     * pixels wide, so what it contributes is a dark directional mark on a
     * surface that otherwise has none.
     */
    const blades = 3;
    for (let i = 0; i < blades; i++) {
      const angle = (i / blades) * Math.PI * 2 + rng() * 1.1;
      const length = size * (1.5 + rng() * 1.6);
      const width = size * (0.16 + rng() * 0.14);
      const lift = size * 0.035;
      const cx = (rng() - 0.5) * size * 0.7;
      const cz = (rng() - 0.5) * size * 0.7;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const value = 0.72 + rng() * 0.5;
      const tone: Tone = [value * 1.1, value, value * 0.86];
      pushTriangle(
        surfaces,
        cx + dz * width, lift, cz - dx * width,
        cx - dz * width, lift, cz + dx * width,
        cx + dx * length, lift + size * 0.02, cz + dz * length,
        0, 0,
        1, 0,
        0.5, 1,
        tone,
        tone,
        // The far end of a stick is the end that catches the light.
        [tone[0] * 1.25, tone[1] * 1.22, tone[2] * 1.18],
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(surfaces.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(surfaces.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surfaces.uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(surfaces.colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
