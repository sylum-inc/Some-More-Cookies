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

/** A low-poly conifer: two or three stacked cones plus a trunk. */
export function createTreeGeometry(seed: number, height = 4): THREE.BufferGeometry {
  const rng = mulberry(seed);
  const tiers = 2 + Math.floor(rng() * 2);
  const parts: THREE.BufferGeometry[] = [];

  const trunkHeight = height * 0.25;
  const trunk = new THREE.CylinderGeometry(height * 0.035, height * 0.055, trunkHeight, 5, 1);
  trunk.translate(0, trunkHeight / 2, 0);
  parts.push(trunk);

  let y = trunkHeight * 0.8;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const radius = height * (0.3 - t * 0.12) * (0.85 + rng() * 0.3);
    const tierHeight = height * (0.4 - t * 0.08);
    const cone = new THREE.ConeGeometry(radius, tierHeight, 6, 1);
    cone.translate(0, y + tierHeight / 2, 0);
    parts.push(cone);
    y += tierHeight * 0.55;
  }

  return mergeGeometries(parts);
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
  return geometry;
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
  for (const g of geometries) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    totalVertices += (nonIndexed.getAttribute('position') as THREE.BufferAttribute).count;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  let offset = 0;

  for (const g of geometries) {
    const source = g.index ? g.toNonIndexed() : g;
    const p = source.getAttribute('position') as THREE.BufferAttribute;
    const n = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const u = source.getAttribute('uv') as THREE.BufferAttribute | undefined;
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
    }
    offset += p.count;
    if (source !== g) source.dispose();
  }

  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
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
