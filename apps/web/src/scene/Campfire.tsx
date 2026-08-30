/**
 * The other people, drawn.
 *
 * A person at a campfire has to be legible at three distances and it is a
 * different problem at each:
 *
 *  - **Down the trail.** A light moving through the trees, then a shape. Not a
 *    person yet. `ArrivalPath.silhouetteAtMs` says when the shape resolves and
 *    `Roster` turns that into `legibility`; below 1 the figure is drawn dark
 *    and flat, which is what somebody walking in from the dark looks like.
 *  - **At the fire.** Read by silhouette and firelight. Low-poly, code-authored
 *    (ADR-0002), lit by the fire that is already there.
 *  - **Close.** A quiet name, a mic indicator when they are speaking, and
 *    whether their hands are full.
 *
 * ## Two decisions that are budget decisions
 *
 * **No remote player adds a dynamic light.** ARCHITECTURE §10 allows six in
 * the explorable world and the campsite already spends four. Four players each
 * carrying a torch would be eight more, and the budget is not a suggestion —
 * it is why this build runs at sixty. So a carried torch is emissive geometry
 * and an additive glow, not a `SpotLight`: it is visible, it moves, it lights
 * nothing. The one real torch light in the world stays the local player's,
 * which is the one whose beam the wildlife model actually reads.
 *
 * **Six meshes a person, hard.** Legs, torso, arms, head, a name, and a torch
 * when they are carrying one. At the three other players a campsite is
 * specified for (spec §9) that is eighteen draw calls on top of a peak of
 * eighty-three, which `e2e/campfire.spec.ts` measures rather than assumes.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  eyePosition,
  lookDirection,
  terrainHeight,
  vec3,
  type PlayerState,
  type RitualState,
  type WalkableWorld,
} from '@somemore/sim';
import { createPs1Material, releasePs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import { TORCH_OBJECT_ID, type Campfire } from '../net/campfire.js';
import type { RemotePlayer } from '../net/roster.js';
import { VOICE_SPATIAL_OPTIONS } from '../net/voice.js';
import type { AudioBridge } from '../audio/bridge.js';

/** Spec §9: "2–4 players per campsite". Three other people is the ceiling. */
const POOL_SIZE = 3;

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * What somebody looks like, derived from their account id and nothing else.
 *
 * Stable, so the same friend is the same figure on every device and every
 * visit — which is the only way a silhouette can be recognised at distance.
 * The palette is deliberately narrow and desaturated: this is a campsite at
 * night, and a bright jacket would read as a game character.
 */
export interface Build {
  height: number;
  shoulders: number;
  jacket: THREE.Color;
  trousers: THREE.Color;
  skin: THREE.Color;
  hat: boolean;
}

const JACKETS = [0x4a5340, 0x5b4638, 0x39424c, 0x6a4a3a, 0x3f4a44, 0x5a5245, 0x44404f, 0x63513c];
const TROUSERS = [0x2f3238, 0x3a352c, 0x2c3540, 0x413a33];

export function buildFor(accountId: string): Build {
  const h = hash32(`camper:${accountId}`);
  const jacket = JACKETS[h % JACKETS.length] ?? 0x4a5340;
  const trousers = TROUSERS[(h >>> 7) % TROUSERS.length] ?? 0x2f3238;
  // A believable adult range. Height is the strongest silhouette cue there is.
  const height = 1.62 + ((h >>> 11) % 24) / 100;
  return {
    height,
    shoulders: 0.4 + ((h >>> 17) % 9) / 100,
    jacket: new THREE.Color(jacket),
    trousers: new THREE.Color(trousers),
    skin: new THREE.Color().setHSL(0.07, 0.28, 0.34 + ((h >>> 21) % 22) / 100),
    hat: ((h >>> 3) & 3) === 0,
  };
}

/**
 * A name, drawn small on a canvas.
 *
 * Names are present but quiet (this is a campsite, not a lobby): lower case,
 * letter-spaced, low contrast, and it fades out entirely past a few metres.
 * Cached by name, so a fire full of people is a handful of 128×32 textures.
 */
const nameCache = new Map<string, THREE.Texture | null>();

export function nameTexture(name: string): THREE.Texture | null {
  const cached = nameCache.get(name);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') {
    nameCache.set(name, null);
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    nameCache.set(name, null);
    return null;
  }
  ctx.clearRect(0, 0, 128, 32);
  ctx.font = '13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A shadow first, so the name stays readable against the flames as well as
  // against the trees. Nothing here is delivered by colour alone.
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(name.toLowerCase(), 64, 17);
  ctx.fillStyle = 'rgba(228,220,202,0.82)';
  ctx.fillText(name.toLowerCase(), 64, 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  nameCache.set(name, texture);
  return texture;
}

interface Slot {
  group: THREE.Group;
  body: THREE.Group;
  legs: THREE.Mesh;
  torso: THREE.Mesh;
  arms: THREE.Mesh;
  head: THREE.Mesh;
  torch: THREE.Mesh;
  torchGlow: THREE.Sprite;
  lamp: THREE.Sprite;
  plate: THREE.Mesh;
  jacketMaterial: THREE.MeshStandardMaterial;
  trouserMaterial: THREE.MeshStandardMaterial;
  skinMaterial: THREE.MeshStandardMaterial;
  plateMaterial: THREE.MeshBasicMaterial;
  glowMaterial: THREE.SpriteMaterial;
  lampMaterial: THREE.SpriteMaterial;
  accountId: string | null;
}

export interface CampfireSceneProps {
  fire: Campfire;
  ritual: RitualState;
  settings: RenderSettings;
  player: PlayerState;
  walkable: WalkableWorld;
  audio?: React.RefObject<AudioBridge | null>;
  /** Whether the local microphone is muted, for the presence heartbeat. */
  micMuted?: boolean;
}

/**
 * A small round additive sprite, for a torch flame and a flashlight through
 * the trees. Generated once and shared: it is the same eight pixels every time.
 */
function glowTexture(): THREE.Texture | null {
  const cached = nameCache.get('__glow');
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') {
    nameCache.set('__glow', null);
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    nameCache.set('__glow', null);
    return null;
  }
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,236,196,1)');
  gradient.addColorStop(0.35, 'rgba(255,168,72,0.55)');
  gradient.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  nameCache.set('__glow', texture);
  return texture;
}

export function CampfireScene({
  fire,
  ritual,
  settings,
  player,
  walkable,
  audio,
  micMuted = true,
}: CampfireSceneProps): React.ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const torchHeld = useRef(false);
  const listenerScratch = useMemo(() => ({ eye: vec3(), look: vec3() }), []);
  const speakersScratch = useMemo<{ accountId: string; position: { x: number; y: number; z: number } }[]>(() => [], []);

  const slots = useMemo<Slot[]>(() => {
    const made: Slot[] = [];
    const cloth = getTexture('canvas', { size: 32 });
    const glow = glowTexture();
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const group = new THREE.Group();
      group.visible = false;

      /*
       * A little emissive on every surface, for the reason recorded as D7 in
       * the spec: the PS1 pass quantises to five bits a channel, so anything
       * lit below about 8/255 renders as pure black rather than as very dark.
       * A person standing outside the ring of firelight would be a hole in the
       * picture. This floor is what makes them a silhouette instead.
       */
      const jacketMaterial = createPs1Material({ settings, map: cloth, roughness: 0.95, flatShading: true });
      const trouserMaterial = createPs1Material({ settings, map: cloth, roughness: 1, flatShading: true });
      const skinMaterial = createPs1Material({ settings, roughness: 0.9, flatShading: true });

      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.82, 0.24), trouserMaterial);
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.6, 0.26), jacketMaterial);
      const arms = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.14, 0.15), jacketMaterial);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.2), skinMaterial);
      legs.castShadow = true;
      torso.castShadow = true;

      const torch = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.34, 5), trouserMaterial);
      torch.visible = false;

      const glowMaterial = new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      });
      const torchGlow = new THREE.Sprite(glowMaterial);
      torchGlow.scale.set(0.5, 0.5, 0.5);

      const lampMaterial = new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      });
      const lamp = new THREE.Sprite(lampMaterial);
      lamp.scale.set(1.4, 1.4, 1.4);

      /*
       * A quad turned toward the camera, not a `Sprite`.
       *
       * The same thing the eyeshine in `Wildlife.tsx` does, and for the same
       * reason: it is the pattern in this renderer that is known to come
       * through the PS1 pass. `fog: false` because a name is a label rather
       * than a thing in the world, and the campsite's short exponential fog was
       * taking it away at exactly the distance across a fire.
       */
      const plateMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        fog: false,
        opacity: 0,
      });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.29), plateMaterial);
      // Named so the end-to-end suite can assert a name is actually legible
      // rather than take a picture and hope.
      plate.name = 'nameplate';

      const body = new THREE.Group();
      body.add(legs, torso, arms, head, torch, torchGlow);
      group.add(body, lamp, plate);
      made.push({
        group,
        body,
        legs,
        torso,
        arms,
        head,
        torch,
        torchGlow,
        lamp,
        plate,
        jacketMaterial,
        trouserMaterial,
        skinMaterial,
        plateMaterial,
        glowMaterial,
        lampMaterial,
        accountId: null,
      });
    }
    return made;
  }, [settings]);

  useEffect(
    () => () => {
      for (const slot of slots) {
        slot.legs.geometry.dispose();
        slot.torso.geometry.dispose();
        slot.arms.geometry.dispose();
        slot.head.geometry.dispose();
        slot.torch.geometry.dispose();
        slot.plate.geometry.dispose();
        for (const material of [slot.jacketMaterial, slot.trouserMaterial, slot.skinMaterial]) {
          releasePs1Material(material);
          material.dispose();
        }
        slot.plateMaterial.dispose();
        slot.glowMaterial.dispose();
        slot.lampMaterial.dispose();
      }
    },
    [slots],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    for (const slot of slots) root.add(slot.group);
    return () => {
      for (const slot of slots) root.remove(slot.group);
    };
  }, [slots]);

  /*
   * Voice goes through the audio engine's own panner, on the voice bus.
   *
   * Wired from the frame loop rather than from an effect, because the engine
   * does not exist until somebody touches the screen — browsers will not start
   * an `AudioContext` without a gesture — and an effect whose dependency is a
   * ref never re-runs when that ref is finally filled in. Written as an effect
   * first, this silently meant spatial voice was never attached to anything.
   */
  const voiceWired = useRef(false);
  useEffect(
    () => () => {
      voiceWired.current = false;
      fire.voice.useAudio(null);
    },
    [fire],
  );

  useFrame((frameState, delta) => {
    const dt = Math.min(0.1, delta);
    const tick = fire.tick;

    // Tell the fire where we are. Throttled inside; presence is lossy by design.
    fire.reportPresence({
      position: player.position,
      facingY: player.facing,
      activity: activityFor(ritual),
      micMuted,
    });
    // Somebody carrying the campsite's torch is carrying it in front of
    // everybody, so where it is goes on the wire as a prop rather than as a
    // private fact. There is no "my torch is lit" field on this protocol and
    // inventing one would be worse than using the one that fits.
    if (ritual.torch.held && ritual.torch.on) {
      // Reach for it once. Every intent naming an object needs the lease on it,
      // so without this the torch never moves for anybody else.
      if (!torchHeld.current) {
        torchHeld.current = true;
        fire.grab(TORCH_OBJECT_ID, 'prop');
      }
      fire.moveTorch(
        { x: player.position.x, y: player.position.y + 1.1, z: player.position.z },
        player.facing,
      );
    } else if (torchHeld.current) {
      torchHeld.current = false;
      fire.release(TORCH_OBJECT_ID, 'prop');
    }

    fire.roster.step(tick, dt, (x, z) => terrainHeight(x, z, walkable.seed, walkable.amplitude));

    const people = fire.roster.visible;
    speakersScratch.length = 0;
    const camera = frameState.camera;

    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      if (slot === undefined) continue;
      const person = people[i];
      if (person === undefined) {
        slot.group.visible = false;
        slot.accountId = null;
        continue;
      }
      slot.group.visible = true;
      pose(slot, person, camera, ritual);
      speakersScratch.push({ accountId: person.accountId, position: person.position });
    }

    // Spatial voice: `proximityGain` decides how loud, the panner decides from
    // where. See the note at the top of `net/voice.ts`.
    const bridge = audio?.current ?? null;
    const engine = bridge?.engine ?? null;
    if (engine !== null && !voiceWired.current) {
      voiceWired.current = true;
      fire.voice.useAudio({
        createEmitter: () => engine.createEmitter('voice', VOICE_SPATIAL_OPTIONS),
        releaseEmitter: (emitter) => engine.releaseEmitter(emitter),
      });
    }
    if (bridge !== null) {
      eyePosition(player, listenerScratch.eye);
      lookDirection(player, listenerScratch.look);
      fire.voice.update(listenerScratch.eye, speakersScratch);
    }
  });

  return <group ref={rootRef} name="campfire-people" />;
}

/** What the presence heartbeat should call what the local player is doing. */
function activityFor(ritual: RitualState): 'idle' | 'roasting' | 'assembling' | 'machine' | 'eating' {
  switch (ritual.stage) {
    case 'roasting':
      return 'roasting';
    case 'assembling':
      return 'assembling';
    case 'machine':
    case 'reveal':
      return 'machine';
    case 'eating':
    case 'after':
      return 'eating';
    default:
      return 'idle';
  }
}

/** Place and pose one person. Pure geometry; nothing allocates per frame. */
function pose(slot: Slot, person: RemotePlayer, camera: THREE.Camera, ritual: RitualState): void {
  const build = buildFor(person.accountId);

  if (slot.accountId !== person.accountId) {
    slot.accountId = person.accountId;
    slot.jacketMaterial.color.copy(build.jacket);
    slot.trouserMaterial.color.copy(build.trousers);
    slot.skinMaterial.color.copy(build.hat ? build.jacket : build.skin);
    // See the emissive note where the materials are built: without a floor a
    // person outside the firelight quantises to pure black.
    slot.jacketMaterial.emissive.copy(build.jacket).multiplyScalar(0.22);
    slot.trouserMaterial.emissive.copy(build.trousers).multiplyScalar(0.2);
    slot.skinMaterial.emissive.copy(build.skin).multiplyScalar(0.16);
    slot.plateMaterial.map = nameTexture(person.name);
    slot.plateMaterial.needsUpdate = true;

    const legHeight = build.height * 0.47;
    const torsoHeight = build.height * 0.34;
    slot.legs.geometry.dispose();
    slot.legs.geometry = new THREE.BoxGeometry(build.shoulders * 0.72, legHeight, 0.24);
    slot.torso.geometry.dispose();
    slot.torso.geometry = new THREE.BoxGeometry(build.shoulders, torsoHeight, 0.26);
    slot.arms.geometry.dispose();
    slot.arms.geometry = new THREE.BoxGeometry(build.shoulders * 1.5, 0.13, 0.14);
    slot.head.geometry.dispose();
    slot.head.geometry = new THREE.BoxGeometry(0.2, build.height * 0.13, 0.2);

    slot.legs.position.set(0, legHeight * 0.5, 0);
    slot.torso.position.set(0, legHeight + torsoHeight * 0.5, 0);
    slot.arms.position.set(0, legHeight + torsoHeight * 0.78, 0);
    slot.head.position.set(0, legHeight + torsoHeight + build.height * 0.07, 0);
    slot.torch.position.set(build.shoulders * 0.62, legHeight + torsoHeight * 0.6, 0.1);
    slot.torchGlow.position.set(build.shoulders * 0.62, legHeight + torsoHeight * 0.6 + 0.2, 0.1);
    slot.plate.position.set(0, build.height + 0.28, 0);
  }

  slot.group.position.set(person.position.x, person.position.y, person.position.z);
  // +X is a yaw of zero for the player model, the same convention locomotion
  // uses, so a remote figure faces the way `facingY` says it faces.
  slot.body.rotation.y = -person.facingY + Math.PI / 2;

  /*
   * Walking. The keyframe rate is deliberately low (spec §2.1: "restrained
   * animation with low keyframe rates") — the legs swing on a quantised phase
   * rather than a smooth sine, which is what stops a PS1 figure looking like a
   * modern one wearing a filter.
   */
  const stride = person.speed > 0.15 ? 1 : 0;
  const phase = Math.round(ritual.elapsed * 9) / 9;
  const swing = Math.sin(phase * 5.2) * 0.16 * stride;
  slot.legs.rotation.x = swing;
  slot.arms.rotation.x = -swing * 0.7;
  // Settling: a person at a fire is not a statue, so the torso breathes.
  slot.torso.position.y += 0;
  slot.torso.rotation.z = Math.sin(ritual.elapsed * 0.8 + build.height) * 0.012;

  const legible = person.legibility;
  const dim = 0.15 + 0.85 * legible;
  slot.jacketMaterial.opacity = 1;
  slot.jacketMaterial.emissive.copy(build.jacket).multiplyScalar(0.22 * dim);
  slot.trouserMaterial.emissive.copy(build.trousers).multiplyScalar(0.2 * dim);

  // A light on the trail, before the figure resolves. Additive geometry, never
  // a real light: see the budget note at the top of this file.
  const lampOn = person.flashlight && legible < 1;
  slot.lamp.visible = lampOn;
  if (lampOn) {
    const bob = Math.sin(ritual.elapsed * 4.6) * 0.06;
    slot.lamp.position.set(0, 1.1 + bob, 0);
    slot.lampMaterial.opacity = 0.55 * (1 - legible * 0.4);
  }

  const carrying = person.carryingTorch && person.phase === 'here';
  slot.torch.visible = carrying;
  slot.torchGlow.visible = carrying;
  if (carrying) {
    slot.glowMaterial.opacity = 0.62 + Math.sin(ritual.elapsed * 11) * 0.08;
  }

  /*
   * The name. Present but quiet: it fades in only when somebody is close
   * enough that you would read it, and it is gone entirely at distance so a
   * campsite never reads as a lobby with floating tags.
   */
  const dx = camera.position.x - person.position.x;
  const dz = camera.position.z - person.position.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  /*
   * Full strength across the ring of light, gone by the treeline.
   *
   * The first version faded from 2.2 m and was invisible by five, which meant
   * the name was unreadable at exactly the distance people sit from each other
   * at a fire — the only distance it was for. A campfire is about seven metres
   * across, so that is the band the name has to survive.
   */
  const nearness = 1 - Math.min(1, Math.max(0, (distance - 4) / 7));
  slot.plateMaterial.opacity = nearness * 0.85 * legible;
  slot.plate.visible = slot.plateMaterial.opacity > 0.03;
  // Face the camera, and stay upright: a name that rolls with the view is a
  // billboard, and one that tips with the terrain is unreadable.
  slot.plate.quaternion.copy(camera.quaternion);
  // Speaking is a *visible* thing too (spec §12): the name brightens rather
  // than a microphone icon appearing, which is quieter and needs no legend.
  if (person.speaking) slot.plateMaterial.opacity = Math.min(1, slot.plateMaterial.opacity + 0.25);
}
