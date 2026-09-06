import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRitual, type RitualState, type WildlifeAnimal, type PlacedLandmark } from '@somemore/sim';
import { subjectsInFrame } from '../src/interaction/subjects.js';

/**
 * A camera at eye height looking down -Z, which is three's own default
 * forward. Everything below is positioned relative to that, so "ahead" means
 * negative Z and "behind" means positive Z.
 */
function cameraLookingForward(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** Aims the camera at a world point and refreshes the matrices the frustum reads. */
function aimAt(camera: THREE.PerspectiveCamera, x: number, y: number, z: number): void {
  camera.lookAt(x, y, z);
  camera.updateMatrixWorld();
}

/**
 * Only four fields are read — phase, position and the species id — so the
 * rest of a real animal is noise here. Cast rather than constructed, because
 * building a whole `WildlifeIndividual` would test the constructor, not this.
 */
function animalAt(speciesId: string, x: number, z: number, phase = 'watching'): WildlifeAnimal {
  return { phase, position: { x, y: 0, z }, species: { id: speciesId } } as unknown as WildlifeAnimal;
}

function landmarkAt(id: string, x: number, z: number): PlacedLandmark {
  return { id, x, z } as unknown as PlacedLandmark;
}

function ritualWith(mutate: (ritual: RitualState) => void): RitualState {
  const ritual = createRitual({ campsiteSeed: 'subjects', environmentId: 'pine_hollow', now: 0 });
  ritual.wildlife.animals.length = 0;
  ritual.landmarks.length = 0;
  mutate(ritual);
  return ritual;
}

describe('what a photograph is of', () => {
  it('names an animal standing in front of the camera', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => r.wildlife.animals.push(animalAt('red_fox', 0, -6)));
    expect(subjectsInFrame(camera, ritual)).toEqual(['red_fox']);
  });

  it('does not name one standing behind it', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => r.wildlife.animals.push(animalAt('red_fox', 0, 6)));
    expect(subjectsInFrame(camera, ritual)).toEqual([]);
  });

  it('does not name one out past where the fog makes it a shape', () => {
    // 40 m is inside the far plane and well outside SUBJECT_RANGE_M, so this
    // fails only if the range check is missing rather than if the frustum is.
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => r.wildlife.animals.push(animalAt('red_fox', 0, -40)));
    expect(subjectsInFrame(camera, ritual)).toEqual([]);
  });

  it('does not name one that has already left', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => r.wildlife.animals.push(animalAt('red_fox', 0, -6, 'gone')));
    expect(subjectsInFrame(camera, ritual)).toEqual([]);
  });

  it('counts two of the same species once, because the species is the subject', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => {
      r.wildlife.animals.push(animalAt('red_fox', -2, -7));
      r.wildlife.animals.push(animalAt('red_fox', 2, -7));
    });
    expect(subjectsInFrame(camera, ritual)).toEqual(['red_fox']);
  });

  it('sees an animal at the bottom edge of the frame, which is where a nervous one is', () => {
    /*
     * The reason subjects are spheres rather than points, in numbers.
     *
     * Camera at 1.6 m aimed 20° up; the frustum's bottom plane is therefore
     * 10° below horizontal. A fox 4 m away sits 15.4° below horizontal, so
     * its centre is 0.39 m outside that plane — out of frame as a point, and
     * comfortably inside it as a 0.8 m body. Both margins are wide enough
     * that this fails on a real regression rather than on rounding.
     */
    const camera = cameraLookingForward();
    aimAt(camera, 0, 4.5, -8);
    const ritual = ritualWith((r) => r.wildlife.animals.push(animalAt('red_fox', 0, -4)));
    expect(subjectsInFrame(camera, ritual)).toContain('red_fox');
  });

  it('names a landmark in shot', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith((r) => r.landmarks.push(landmarkAt('the_snag', 0, -9)));
    expect(subjectsInFrame(camera, ritual)).toEqual(['the_snag']);
  });

  it('names the sky event only when the camera is actually aimed up at it', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith(() => {});
    ritual.weather.skyEvent = 'meteor-shower';

    expect(subjectsInFrame(camera, ritual)).toEqual([]);

    aimAt(camera, 0, 30, -10);
    expect(subjectsInFrame(camera, ritual)).toEqual(['meteor-shower']);
  });

  it('says nothing about an empty clearing', () => {
    const camera = cameraLookingForward();
    const ritual = ritualWith(() => {});
    ritual.weather.skyEvent = 'none';
    expect(subjectsInFrame(camera, ritual)).toEqual([]);
  });
});
