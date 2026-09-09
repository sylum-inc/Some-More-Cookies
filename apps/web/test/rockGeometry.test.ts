import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { createRockGeometry } from '../src/render/geometry.js';

/**
 * That a rock is one solid, and not twenty triangles that used to be one.
 *
 * `IcosahedronGeometry` is non-indexed — twenty faces stored as sixty separate
 * corners, so each of the twelve corners of the solid appears five times. The
 * first version of this function drew a fresh random scale per index, which
 * moved all five copies of a corner to five different places and burst the
 * hull. Every rock in the game was a pile of loose shards with half their
 * faces pointing away from the light, and it shipped: an art director found it
 * from a screenshot, describing "hard-edged angular wedges whose undersides
 * are solid near-black... silhouette all sharp points".
 *
 * Checked as a property of the mesh rather than as a pixel, because it is a
 * property of the mesh, and because the failure is invisible in a still until
 * something lights it from the side.
 */
describe('a rock', () => {
  const corners = (geometry: THREE.BufferGeometry) => {
    const position = geometry.getAttribute('position');
    const byDirection = new Map<string, number[]>();
    for (let i = 0; i < position.count; i++) {
      const v = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i));
      const length = v.length();
      const key = v
        .clone()
        .normalize()
        .toArray()
        .map((n) => n.toFixed(2))
        .join(',');
      const seen = byDirection.get(key);
      if (seen) seen.push(length);
      else byDirection.set(key, [length]);
    }
    return byDirection;
  };

  it('keeps its shared corners shared, so the hull stays closed', () => {
    for (const seed of [1, 7, 1234, 90210, 0x9e37]) {
      const byDirection = corners(createRockGeometry(seed, 0.4));
      // An icosahedron has twelve corners however it is stored.
      expect(byDirection.size, `seed ${seed}`).toBe(12);
      for (const [direction, lengths] of byDirection) {
        const spread = Math.max(...lengths) - Math.min(...lengths);
        expect(spread, `seed ${seed}, corner ${direction} split into ${lengths.length} radii`).toBeLessThan(1e-4);
      }
    }
  });

  it('is still an irregular lump and not a ball', () => {
    // The fix must not quietly turn every rock into a sphere: the whole point
    // of the displacement is that no two corners are the same distance out.
    const byDirection = corners(createRockGeometry(1234, 0.4));
    const radii = [...byDirection.values()].map((lengths) => lengths[0]!);
    const spread = Math.max(...radii) - Math.min(...radii);
    expect(spread, 'every corner ended up at the same radius').toBeGreaterThan(0.05);
  });

  it('is squat, because a stone that has been sitting somewhere is', () => {
    const geometry = createRockGeometry(1234, 0.4);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const height = box.max.y - box.min.y;
    const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    expect(height).toBeLessThan(width);
  });

  it('has no face whose normal disagrees with its winding', () => {
    // The other half of the shatter: shards got flat normals pointing wherever
    // they landed. On a closed hull every face normal points outward.
    const geometry = createRockGeometry(1234, 0.4);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    for (let t = 0; t < position.count; t += 3) {
      const a = new THREE.Vector3(position.getX(t), position.getY(t), position.getZ(t));
      const b = new THREE.Vector3(position.getX(t + 1), position.getY(t + 1), position.getZ(t + 1));
      const c = new THREE.Vector3(position.getX(t + 2), position.getY(t + 2), position.getZ(t + 2));
      const face = b.clone().sub(a).cross(c.clone().sub(a));
      const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      expect(face.dot(centre), `triangle ${t / 3} faces inward`).toBeGreaterThan(0);
      const stored = new THREE.Vector3(normal.getX(t), normal.getY(t), normal.getZ(t));
      expect(stored.dot(centre), `triangle ${t / 3} has an inward normal`).toBeGreaterThan(0);
    }
  });
});
