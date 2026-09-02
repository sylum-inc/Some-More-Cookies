/**
 * The named things that make a campsite that campsite.
 *
 * Every environment in the catalogue lists three or four landmarks and
 * describes each one precisely — site post 11 with its violet laminated card,
 * an olive-drab bear box dented on the top left, a dead pine caught in the
 * crotch of a living one at fifteen degrees, three flat stones across the
 * narrow point with the middle one wobbling. Forty-odd handcrafted props, and
 * not one of them had ever been drawn. Twelve campsites described as distinct
 * places, rendered as the same clearing with a machine in it.
 *
 * They cannot be modelled individually — that is forty-eight bespoke meshes,
 * and this project builds its world out of procedural kits by rule (ADR-0003).
 * So each *kind* gets a silhouette that is unmistakably a post, a box, a
 * ruined frame, a leaning snag, a stack of flat stones, and the seed and the
 * label do the rest. What makes it the bear box rather than a box is that you
 * can walk to it and it tells you, in the words the catalogue wrote for it.
 */

import * as THREE from 'three';
import { createRockGeometry, createLogGeometry, mergeGeometries } from './geometry.js';

/** Mirrors `LandmarkKind` in `@somemore/content`, which this must not import. */
export type LandmarkShape = 'natural' | 'built' | 'abandoned' | 'signage' | 'water' | 'sky' | 'camp';

/** Deterministic small noise, so one landmark is not every landmark. */
function wobble(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function box(width: number, height: number, depth: number, x = 0, y = 0, z = 0, tilt = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  if (tilt !== 0) geometry.rotateZ(tilt);
  geometry.translate(x, y + height / 2, z);
  return geometry;
}

/**
 * One landmark's shape, in metres, standing on the ground at the origin.
 *
 * Sized against a person: the post comes to the chest, the bear box to the
 * hip, the snag goes up past the treeline. A landmark you cannot pick out of
 * the dark from across a clearing is not a landmark.
 */
export function createLandmarkGeometry(kind: LandmarkShape, seed: number): THREE.BufferGeometry {
  const r = (i: number) => wobble(seed, i);
  switch (kind) {
    case 'signage': {
      // A post with a board on it. The one shape in a wood that is obviously
      // not of the wood.
      const post = box(0.09, 1.32, 0.09);
      const board = box(0.34, 0.26, 0.03, 0, 0.92, 0.04);
      const reflector = box(0.06, 0.1, 0.02, 0.11, 0.74, 0.06);
      return mergeGeometries([post, board, reflector]);
    }
    case 'built': {
      // A container of some kind: a bear box, a hut, a locker. Squat, lidded,
      // and standing on feet so it does not read as a crate half buried.
      const body = box(0.94, 0.62, 0.58);
      const lid = box(1.02, 0.07, 0.64, 0, 0.62, 0);
      const latch = box(0.08, 0.14, 0.05, 0.4, 0.36, 0.3);
      const feet = [
        box(0.1, 0.09, 0.1, -0.38, -0.09, -0.2),
        box(0.1, 0.09, 0.1, 0.38, -0.09, -0.2),
        box(0.1, 0.09, 0.1, -0.38, -0.09, 0.2),
        box(0.1, 0.09, 0.1, 0.38, -0.09, 0.2),
      ];
      return mergeGeometries([body, lid, latch, ...feet]);
    }
    case 'abandoned': {
      // The same silhouette with the life gone out of it: leaning, open, and
      // missing a wall. Read from a distance as "somebody was here once".
      const lean = 0.12 + r(1) * 0.16;
      const back = box(0.86, 0.74, 0.06, 0, 0, -0.3, lean);
      const left = box(0.06, 0.68, 0.54, -0.42, 0, 0, lean);
      const floor = box(0.86, 0.05, 0.6, 0, 0, 0);
      const post = box(0.07, 0.9, 0.07, 0.4, 0, 0.28, -lean * 0.6);
      return mergeGeometries([back, left, floor, post]);
    }
    case 'natural': {
      // A dead trunk caught on the way down, which is the commonest landmark
      // in the catalogue and the most legible from anywhere in a clearing.
      const trunk = createLogGeometry(4.6 + r(2) * 1.8, 0.17 + r(3) * 0.05);
      // Along +X and tipped up: `createLogGeometry` runs along X already.
      trunk.rotateZ(1.16 + r(4) * 0.16);
      trunk.translate(0, 2.1, 0);
      const stump = createRockGeometry(seed + 11, 0.42);
      stump.scale(1, 0.7, 1);
      const rootball = createRockGeometry(seed + 29, 0.3);
      rootball.scale(1.2, 0.5, 1.2);
      rootball.translate(0.5, 0.05, 0.2);
      return mergeGeometries([trunk, stump, rootball]);
    }
    case 'water': {
      // Flat stones, laid the way stepping stones are laid: in a line, with
      // the gaps that make crossing them a decision.
      const stones: THREE.BufferGeometry[] = [];
      const count = 3 + Math.floor(r(5) * 2);
      for (let i = 0; i < count; i++) {
        const stone = createRockGeometry(seed + i * 7, 0.34 + r(6 + i) * 0.12);
        stone.scale(1.1, 0.28, 1.1);
        stone.translate((i - (count - 1) / 2) * 0.78, 0.06, (r(20 + i) - 0.5) * 0.3);
        stones.push(stone);
      }
      return mergeGeometries(stones);
    }
    case 'camp': {
      // Something somebody built to put things on: a rack, a bench, a table.
      const top = box(1.24, 0.07, 0.5, 0, 0.62, 0);
      const legs = [
        box(0.08, 0.62, 0.08, -0.52, 0, -0.16),
        box(0.08, 0.62, 0.08, 0.52, 0, -0.16),
        box(0.08, 0.62, 0.08, -0.52, 0, 0.16),
        box(0.08, 0.62, 0.08, 0.52, 0, 0.16),
      ];
      const rail = box(1.1, 0.05, 0.05, 0, 0.3, -0.2);
      return mergeGeometries([top, rail, ...legs]);
    }
    case 'sky':
    default: {
      // A thing you look at rather than walk to. It gets no shape, and the
      // placement code never asks for one — this branch exists so that adding
      // a kind to the catalogue cannot crash a campsite.
      return new THREE.BufferGeometry();
    }
  }
}

/** Whether this kind is a thing standing somewhere, or a thing overhead. */
export function isPlaceable(kind: LandmarkShape): boolean {
  return kind !== 'sky';
}
