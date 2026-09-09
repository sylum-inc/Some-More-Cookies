/**
 * The small things you find by crouching over them.
 *
 * Twenty-eight of the catalogue's forty-seven secrets are found by looking at
 * something — a shelf of shift entries stopping mid-sentence with the pencil
 * still in the fold, three coffee cans with the lids rusted on, a survey stake
 * whose number does not follow. Every one of them was written, validated and
 * shipped, and none of them could be found, because the condition wants you to
 * be inspecting a thing and there was no thing.
 *
 * These are those things. Deliberately small and deliberately dull: a landmark
 * is something you pick out of the dark from across a clearing, and a curio is
 * the opposite — something you only notice once you are already standing over
 * it with a torch. If one of these reads at twenty metres it is wrong.
 *
 * Four shapes, because four is what the catalogue actually describes, and a
 * fifth would be a shape nobody wrote. They reuse the landmarks' own weathered
 * wood, dulled metal and stone (ADR-0003, and the draw-call budget): nothing
 * here is new, and nothing here is authored.
 */

import * as THREE from 'three';
import { createBoxGeometry, createRockGeometry, mergeGeometries } from './geometry.js';

/** Mirrors `CurioShape` in `@somemore/sim`, which this must not import. */
export type CurioShape = 'tin' | 'board' | 'stake' | 'slab';

/** Deterministic small noise, so one tin is not every tin. */
function wobble(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The same textured, weathered box the landmarks are built from.
 *
 * A curio is looked at from a kneel with a torch on it, which is the one
 * viewing distance at which a 0..1 UV across a fifteen-centimetre face is
 * *most* obviously a wash rather than a surface. It also matters that these
 * carry a colour attribute at all: they wear the landmarks' materials, and
 * those now ask for vertex colours — a part without one reads the generic
 * vertex attribute, which is black.
 */
function box(
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
  tilt = 0,
  seed = 1,
  part = 0,
): THREE.BufferGeometry {
  const geometry = createBoxGeometry(width, height, depth, { seed, index: part, tile: 0.22 });
  if (tilt !== 0) geometry.rotateZ(tilt);
  geometry.translate(x, y + height / 2, z);
  return geometry;
}

/** A can lying on its side, rolled to `yaw` and resting on the ground. */
function can(radius: number, length: number, x: number, z: number, yaw: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 7, 1);
  // Tipped over first, then turned: a can on its side points somewhere.
  geometry.rotateZ(Math.PI / 2);
  geometry.rotateY(yaw);
  geometry.translate(x, radius, z);
  return geometry;
}

/**
 * One curio's shape, in metres, sitting on the ground at the origin.
 *
 * Sized against a hand rather than against a person. The tallest of them comes
 * to the knee.
 */
export function createCurioGeometry(shape: CurioShape, seed: number): THREE.BufferGeometry {
  const r = (i: number): number => wobble(seed, i);
  switch (shape) {
    case 'tin': {
      /*
       * A can or two on their side, lids rusted on, half under the leaf
       * litter. Seven-sided, which is the tree trunk's own budget: at a
       * kneel these fill the torch beam, and cut from boxes they read as two
       * crates rather than as the tin the label promises.
       */
      const parts = [can(0.066, 0.15, 0, 0, (r(1) - 0.5) * 0.6)];
      if (r(2) > 0.45) {
        parts.push(can(0.056, 0.13, 0.15 + r(3) * 0.05, 0.05, (r(4) - 0.5) * 1.4));
      }
      // A stone beside them, because things left outdoors collect a stone.
      const stone = createRockGeometry(seed + 41, 0.09);
      stone.translate(-0.15, 0.04, 0.1);
      parts.push(stone);
      return mergeGeometries(parts);
    }
    case 'board': {
      /*
       * A plank on two blocks — a shelf, or what is left of one. This is the
       * shape that carries writing in this world: the logbook, the register,
       * the pencilled column of dates and one-word conditions.
       */
      const tilt = (r(1) - 0.5) * 0.12;
      return mergeGeometries([
        box(0.62, 0.035, 0.24, 0, 0.17, 0, tilt, seed, 0),
        box(0.09, 0.18, 0.16, -0.22, 0, 0.02, 0, seed, 1),
        box(0.09, 0.18, 0.16, 0.22, 0, -0.02, 0, seed, 2),
        // Something small left on it, which is the reason to look.
        box(0.13, 0.03, 0.1, r(2) * 0.16 - 0.08, 0.2, r(3) * 0.08 - 0.04, tilt, seed, 3),
      ]);
    }
    case 'stake': {
      // A survey stake, driven and then leaned on by thirty winters.
      const lean = 0.12 + r(1) * 0.22;
      return mergeGeometries([
        box(0.05, 0.52, 0.05, 0, 0, 0, lean, seed, 0),
        // The tag, which is the part with the number that does not follow.
        box(0.11, 0.08, 0.012, Math.sin(lean) * -0.34, 0.36, 0.03, lean, seed, 1),
      ]);
    }
    case 'slab':
    default: {
      /*
       * A flat stone with something under it, or a plate set into the rock.
       * Reads as ground until you are on top of it, which is the point.
       */
      const stone = createRockGeometry(seed + 7, 0.3);
      stone.scale(1.25, 0.28, 1.1);
      stone.translate(0, 0.05, 0);
      return mergeGeometries([
        stone,
        box(0.14, 0.014, 0.14, r(1) * 0.1 - 0.05, 0.09, r(2) * 0.1 - 0.05, 0, seed, 0),
      ]);
    }
  }
}

/** Which of the landmarks' three materials each shape wears. */
export function curioMaterial(shape: CurioShape): 'wood' | 'metal' | 'stone' {
  switch (shape) {
    case 'tin':
      return 'metal';
    case 'board':
    case 'stake':
      return 'wood';
    default:
      return 'stone';
  }
}
