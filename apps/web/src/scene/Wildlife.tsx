/**
 * The animals.
 *
 * They are not pets, not collectibles and not a compendium (spec §7): there is
 * no name plate, no capture, no counter and nothing to feed. What the renderer
 * does is make them *legible* — you can tell something is out there, roughly
 * how big, roughly how close, and whether it is watching you or leaving.
 *
 * Everything about an animal's appearance is derived deterministically from
 * its species id, so the fox at Pine Hollow is the same fox on every visit and
 * on every device, without a single byte of art. Individuals get a small
 * stable offset from their own id, which is the "recognisable detail" the
 * significance model talks about.
 *
 * The strongest cue at night is eyeshine: two points of reflected firelight
 * that appear before the body resolves out of the dark. That is how you
 * actually notice an animal at a campsite, so it is how you notice one here.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  Rng,
  animalsPresent,
  hashString,
  hashToUnit,
  terrainHeight,
  type RitualState,
  type WalkableWorld,
  type WildlifeAnimal,
} from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';

/** As many as the simulation will ever have present at once, plus headroom. */
const POOL_SIZE = 4;

/** A species' silhouette, derived from its id and nothing else. */
export interface AnimalBuild {
  /** Shoulder height, metres. */
  height: number;
  /** Nose to rump, metres. */
  length: number;
  width: number;
  /** Fur colour. */
  color: THREE.Color;
  /** Eyeshine colour — most mammals green, some amber. */
  eyeColor: THREE.Color;
  earHeight: number;
  tailLength: number;
  /** Radians per second of the idle head movement. */
  fidget: number;
}

/**
 * Builds a silhouette from a species id.
 *
 * The catalogue describes behaviour, not anatomy, so the shape is inferred:
 * shy animals skew smaller and darker, curious ones squatter and lighter. It
 * is a guess, but a *stable* guess, and being wrong about the exact size of a
 * fictional campsite animal costs nothing while being inconsistent about it
 * would cost the illusion.
 */
export function buildFor(speciesId: string, shyness: number, curiosity: number): AnimalBuild {
  const rng = new Rng(hashString(`animal:${speciesId}`));
  const bulk = hashToUnit(hashString(`bulk:${speciesId}`), 0x9e37);
  const height = 0.14 + bulk * 0.46 - shyness * 0.05;
  const length = height * (1.5 + curiosity * 0.5 + rng.next() * 0.4);
  const hue = 0.02 + rng.next() * 0.1;
  const saturation = 0.18 + rng.next() * 0.34;
  const lightness = 0.14 + (1 - shyness) * 0.16 + rng.next() * 0.08;
  return {
    height,
    length,
    width: height * (0.5 + rng.next() * 0.24),
    color: new THREE.Color().setHSL(hue, saturation, lightness),
    eyeColor: new THREE.Color().setHSL(rng.chance(0.7) ? 0.26 : 0.11, 0.75, 0.62),
    earHeight: height * (0.12 + rng.next() * 0.3),
    tailLength: length * (0.15 + rng.next() * 0.6),
    fidget: 0.6 + rng.next() * 1.6,
  };
}

interface AnimalSlot {
  group: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Mesh;
  body: THREE.Mesh;
  ears: THREE.Mesh;
  tail: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  eyeMaterial: THREE.MeshBasicMaterial;
  speciesId: string | null;
}

export interface WildlifeProps {
  ritual: RitualState;
  settings: RenderSettings;
  walkable: WalkableWorld;
}

export function Wildlife({ ritual, settings, walkable }: WildlifeProps): React.ReactElement {
  const rootRef = useRef<THREE.Group>(null);

  const furMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('noise', { size: 32 }),
        roughness: 0.95,
        flatShading: true,
      }),
    [settings],
  );

  const slots = useMemo<AnimalSlot[]>(() => {
    const made: AnimalSlot[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const group = new THREE.Group();
      group.visible = false;

      const material = furMaterial.clone();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      const ears = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4), material);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);

      const head = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      skull.name = 'skull';
      head.add(skull);
      head.add(ears);

      // Eyeshine: unlit, additive, and always facing the camera. It is a
      // reflection, so it must not be shaded by the scene's own lights.
      const eyeMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const eyes = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), eyeMaterial);
      head.add(eyes);

      group.add(body, head, tail);
      made.push({ group, head, eyes, body, ears, tail, material, eyeMaterial, speciesId: null });
    }
    return made;
  }, [furMaterial]);

  useEffect(
    () => () => {
      for (const slot of slots) {
        slot.body.geometry.dispose();
        slot.ears.geometry.dispose();
        slot.tail.geometry.dispose();
        slot.eyes.geometry.dispose();
        slot.material.dispose();
        slot.eyeMaterial.dispose();
      }
    },
    [slots],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const slot of slots) root.add(slot.group);
    return () => {
      for (const slot of slots) root.remove(slot.group);
    };
  }, [slots]);

  useFrame((frameState) => {
    const animals = animalsPresent(ritual);
    const time = ritual.elapsed;
    const camera = frameState.camera;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      const animal = animals[i];
      if (!animal || animal.phase === 'gone') {
        slot.group.visible = false;
        continue;
      }
      slot.group.visible = true;
      applyAnimal(slot, animal, time, walkable, camera);
    }
  });

  return <group ref={rootRef} name="wildlife" />;
}

/** Places and poses one animal. Pure geometry — no allocation per frame. */
function applyAnimal(
  slot: AnimalSlot,
  animal: WildlifeAnimal,
  time: number,
  walkable: WalkableWorld,
  camera: THREE.Camera,
): void {
  const species = animal.species;
  const build = buildFor(species.id, species.shyness, species.curiosity);

  // Rebuilding the boxes only when the slot changes species keeps this at a
  // handful of matrix writes per frame.
  if (slot.speciesId !== species.id) {
    slot.speciesId = species.id;
    slot.body.geometry.dispose();
    slot.body.geometry = new THREE.BoxGeometry(build.length, build.height * 0.72, build.width);
    slot.ears.geometry.dispose();
    slot.ears.geometry = new THREE.ConeGeometry(build.width * 0.3, build.earHeight, 4);
    slot.tail.geometry.dispose();
    slot.tail.geometry = new THREE.BoxGeometry(build.tailLength, build.width * 0.35, build.width * 0.35);
    slot.eyes.geometry.dispose();
    slot.eyes.geometry = new THREE.PlaneGeometry(build.width * 0.62, build.width * 0.2);
    slot.material.color.copy(build.color);
    slot.eyeMaterial.color.copy(build.eyeColor);

    const skull = slot.head.getObjectByName('skull');
    if (skull instanceof THREE.Mesh) {
      skull.geometry.dispose();
      skull.geometry = new THREE.BoxGeometry(build.height * 0.4, build.height * 0.36, build.width * 0.8);
    }
  }

  const ground = terrainHeight(animal.position.x, animal.position.z, walkable.seed, walkable.amplitude);

  // A frightened animal crouches; a settled one stands. This is the read the
  // player actually has to make, so it is the strongest pose signal.
  const crouch = 1 - animal.alarm * 0.35 - (animal.phase === 'watching' ? 0.12 : 0);
  const legs = build.height * 0.28 * crouch;
  slot.group.position.set(animal.position.x, ground + legs + build.height * 0.36, animal.position.z);

  // Facing: toward the fire when interested, away from it when leaving.
  const toFire = Math.atan2(-animal.position.z, -animal.position.x);
  const facing = animal.drive >= 0 ? toFire : toFire + Math.PI;
  slot.group.rotation.y = -facing + Math.PI / 2;

  // Breathing, and a faster flank when alarmed.
  const breathRate = 1.1 + animal.alarm * 2.6;
  const breath = Math.sin(time * breathRate + build.fidget) * 0.012;
  slot.body.scale.set(1, 1 + breath, 1 + breath * 0.6);
  slot.body.position.set(0, 0, 0);

  slot.head.position.set(build.length * 0.5, build.height * 0.24, 0);
  // Head movement: quick flicks when alert, slow sweeps when at ease.
  const alertness = Math.max(animal.alarm, animal.interest);
  slot.head.rotation.y = Math.sin(time * build.fidget * (1 + alertness * 2.2)) * (0.12 + alertness * 0.3);

  slot.ears.position.set(0, build.height * 0.24, 0);
  // Ears go flat with alarm — the clearest "it knows you are there" tell.
  slot.ears.rotation.z = animal.alarm * 1.1;

  slot.tail.position.set(-build.length * 0.5 - build.tailLength * 0.4, build.height * 0.1, 0);
  slot.tail.rotation.z = Math.sin(time * 2.4 + build.fidget) * 0.16 * (1 - animal.alarm);

  // Eyeshine is a reflection: it only exists when the animal is facing you,
  // and it dies away as it turns to leave.
  slot.eyes.position.set(build.height * 0.22, build.height * 0.1, 0);
  slot.eyes.lookAt(camera.position);
  const facingBonus = animal.phase === 'watching' || animal.phase === 'investigating' ? 1 : 0.45;
  const shine = clampUnit(facingBonus * (0.35 + animal.interest * 0.65) * (1 - animal.alarm * 0.5));
  slot.eyeMaterial.opacity = shine;
  slot.eyes.visible = shine > 0.02;
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
