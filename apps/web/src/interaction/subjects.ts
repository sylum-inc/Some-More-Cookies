/**
 * What a photograph is *of*.
 *
 * `photograph(ritual, subjects)` has existed in the simulation since the
 * activities work and has never had a caller, so `presence.photographed` has
 * been permanently empty. Three things read it and have therefore never once
 * fired: the significance model's `photographed` evidence — its single
 * strongest signal at weight 0.16 (`significance.ts`) — the sighting traces
 * that ask whether an animal was photographed (`ritual.ts`), and every
 * discovery condition of kind `photographed`.
 *
 * The missing piece was never the simulation. It was that nothing on the
 * client knew how to answer "what was in the frame", because the sim keeps
 * positions and the renderer keeps the camera and the two had no meeting
 * point. This is that meeting point, and it is deliberately the only thing in
 * here: it reads the camera and the world and returns ids. It does not decide
 * what a photograph means.
 *
 * Subjects are tested as *spheres*, not points, for two reasons. A point test
 * needs a true world height, which for an animal means agreeing with the
 * renderer about terrain — a coupling this module should not have — and which
 * for a landmark does not exist at all, since `PlacedLandmark` carries x and z
 * and no height. A sphere around the ground position is tolerant of both, and
 * it is also the more honest model: a fox half out of frame at the bottom edge
 * is in the photograph.
 *
 * Occlusion is not tested. A fox behind a log still counts if it is in frame,
 * which is wrong in principle and almost never wrong in practice: the draw
 * distance is short, the clearing is open, and the alternative is a raycast
 * per subject on the frame the shutter fires. A photograph in the dark of a
 * thing you could not quite see is also, in this game, a fair description of
 * what happened.
 */

import * as THREE from 'three';
import type { RitualState } from '@somemore/sim';

/* Reused across calls — the shutter can be pressed often, and allocating a
 * frustum per press is the kind of garbage a 60 Hz product does not need. */
const frustum = new THREE.Frustum();
const viewProjection = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const forward = new THREE.Vector3();

/**
 * How far away a thing can be and still count as photographed.
 *
 * Beyond this it is a shape in fog rather than a subject, and counting it
 * would mean a photograph of the dark scores a sighting. Matches the fog's
 * practical legibility rather than the draw distance, which is longer.
 */
const SUBJECT_RANGE_M = 26;

/** Roughly an animal's body, sat on its ground position. */
const ANIMAL_RADIUS_M = 0.8;
const ANIMAL_CENTRE_Y = 0.5;

/** Roughly a snag, a post or a boulder. Landmarks are large and few. */
const LANDMARK_RADIUS_M = 1.6;
const LANDMARK_CENTRE_Y = 1.1;

/** The water's edge is a place rather than an object; a wide, flat target. */
const WATER_RADIUS_M = 2.5;

/**
 * How high above the horizon the camera must be aimed for the sky to be the
 * subject. At the horizon you are photographing the treeline.
 */
const SKYWARD_PITCH = 0.35;

/**
 * Everything identifiable in the current frame.
 *
 * Returns simulation ids: species ids for animals, landmark ids for
 * landmarks, `'water'` for the water's edge, and the sky event's own name
 * when the camera is aimed up during one. Order is stable and duplicates are
 * removed, because `presence.photographed` is a latched list and a second fox
 * of the same species is not a second subject.
 */
export function subjectsInFrame(camera: THREE.Camera, ritual: RitualState): string[] {
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProjection);

  const subjects: string[] = [];
  const add = (id: string): void => {
    if (id.length > 0 && !subjects.includes(id)) subjects.push(id);
  };
  const inFrame = (x: number, y: number, z: number, radius: number): boolean => {
    sphere.center.set(x, y, z);
    sphere.radius = radius;
    if (sphere.center.distanceTo(camera.position) > SUBJECT_RANGE_M + radius) return false;
    return frustum.intersectsSphere(sphere);
  };

  /*
   * Animals, by species rather than by individual.
   *
   * The sighting trace asks `photographed.includes(event.speciesId)`, so the
   * species is the shape the answer has to take. An animal that has left is
   * skipped even though its position lingers for a frame.
   */
  for (const animal of ritual.wildlife.animals) {
    if (animal.phase === 'gone') continue;
    if (inFrame(animal.position.x, ANIMAL_CENTRE_Y, animal.position.z, ANIMAL_RADIUS_M)) {
      add(animal.species.id);
    }
  }

  for (const landmark of ritual.landmarks) {
    if (inFrame(landmark.x, LANDMARK_CENTRE_Y, landmark.z, LANDMARK_RADIUS_M)) add(landmark.id);
  }

  // The water, at the point the shore model already agrees on with the renderer.
  const water = ritual.water;
  if (water) {
    const { bearing, distanceM, surfaceY } = water.shore;
    const x = Math.cos(bearing) * distanceM;
    const z = Math.sin(bearing) * distanceM;
    if (inFrame(x, surfaceY, z, WATER_RADIUS_M)) add('water');
  }

  /*
   * The sky, which has no position — it is wherever you are not looking at
   * the ground. Read off the camera's own forward vector rather than the
   * player's pitch, because photo mode is the one place the two can differ.
   */
  const skyEvent = ritual.weather.skyEvent;
  if (skyEvent !== 'none') {
    camera.getWorldDirection(forward);
    if (forward.y > SKYWARD_PITCH) add(skyEvent);
  }

  return subjects;
}
