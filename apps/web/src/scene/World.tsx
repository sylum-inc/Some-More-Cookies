/**
 * The world: scene composition, camera direction, and the simulation loop.
 *
 * The simulation is advanced here on a fixed timestep and read directly by
 * scene components each frame. React is not in the hot path — re-rendering a
 * component tree at 60 Hz to move a marshmallow would blow the entire frame
 * budget on reconciliation.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  advance,
  animalsPresent,
  bearingFromFire,
  clamp01,
  createClock,
  createPlayer,
  createWorld,
  distanceFromFire,
  eyePosition,
  focused,
  terrainHeight,
  isEmberBed,
  lookDirection,
  lookAtSky,
  pointTorch,
  setPresence,
  stepPlayer,
  vec3,
  type Interactable,
  type MoveIntent,
  type PlayerState,
  type PresenceInput,
  type RitualStage,
  type RitualState,
  type WalkableWorld,
} from '@somemore/sim';
/*
 * The step, and the actions the world itself offers.
 *
 * Alone at a campsite these are the `@somemore/sim` functions of the same
 * names. With other people at the fire, `stepRitual` hands the tick to the
 * shared timeline — which applies each replicated intent on the tick the
 * server stamped it with — and the rest become intents on the wire rather than
 * direct mutations (ADR-0006). See `net/shared.ts`.
 */
import { beginRoasting, operateMachine, stepRitual, tendFire } from '../net/shared.js';
import { getEnvironment } from '@somemore/content';
import { Campsite } from './Campsite.js';
import { Fire } from './Fire.js';
import { Machine } from './Machine.js';
import { AssemblyTable, RoastingStick, Sandwich } from './RitualObjects.js';
import { Radio } from './Radio.js';
import { Wildlife } from './Wildlife.js';
import { Shore } from './Shore.js';
import { Torch } from './Torch.js';
import { NightSky } from './NightSky.js';
import type { Vec3 } from '@somemore/sim';
import { QUALITY, type QualityTier, type RenderSettings } from '../render/ps1.js';
import { createPs1Material } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import type { Store } from '../state/store.js';
import { applyRoastPose, type RoastController } from '../interaction/roastControl.js';

/** Where everything stands. The fire pit is the origin of the world. */
export const LAYOUT = {
  /** The player's bearing around the fire, radians. */
  playerBearing: 0.42,
  /** How far the player stands from the fire while roasting. */
  playerDistance: 1.5,
  assemblyTable: [1.42, 0.34, 1.32] as [number, number, number],
  /** The log people sit on, and where the radio has been left. */
  logSeat: [-1.5, 0, 0.9] as [number, number, number],
  radio: [-1.72, 0.36, 1.14] as [number, number, number],
  /** The torch, lying on the same log. */
  torch: [-1.34, 0.4, 1.42] as [number, number, number],
  machine: [-2.75, 0, 1.75] as [number, number, number],
  /** Yaw so the machine's face (+Z in its local frame) looks into the clearing. */
  machineRotation: 1.03,
  trailStart: [7.5, 0, 6.2] as [number, number, number],
};

/** Transforms a point in the machine's local frame into world space. */
export function machineToWorld(local: [number, number, number]): [number, number, number] {
  const yaw = LAYOUT.machineRotation;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    LAYOUT.machine[0] + local[0] * cos + local[2] * sin,
    LAYOUT.machine[1] + local[1],
    LAYOUT.machine[2] - local[0] * sin + local[2] * cos,
  ];
}

/**
 * How far the player turns away from the fire to look at the sandwich.
 * Composing it against the flames washed the object out and read as
 * levitation.
 */
export const HOLD_TURN = 1.15;
/** Held high enough that the sight line clears the fire pit entirely. */
const HOLD_HEIGHT = 1.24;
const HOLD_RADIUS = 1.3;
/** Camera offset around the fire, so the pit is never directly behind. */
const HOLD_VIEW_OFFSET = 0.38;

/** Where the sandwich is held while being inspected and eaten. */
export function holdPoint(): [number, number, number] {
  const angle = LAYOUT.playerBearing + HOLD_TURN;
  return [Math.cos(angle) * HOLD_RADIUS, HOLD_HEIGHT, Math.sin(angle) * HOLD_RADIUS];
}

/** Unit vector pointing out of the machine's face. */
const MACHINE_FRONT: [number, number] = [Math.sin(LAYOUT.machineRotation), Math.cos(LAYOUT.machineRotation)];

/** Field of view while exploring on foot. */
const EXPLORE_FOV = 68;
/** Leaning in over something small. The old anchored roast pose used 44°. */
const CLOSE_WORK_FOV = 48;

/** A player who is mid-interaction takes no movement input. */
const EMPTY_INTENT: MoveIntent = {};

/**
 * Reused presence and places buffers.
 *
 * `setPresence` copies out of these, so nothing here allocates per frame —
 * ARCHITECTURE §10's "zero per-frame allocation in simulation hot paths".
 */
const presenceScratch: Partial<PresenceInput> = {};
const placesScratch: string[] = [];

/** How close to the water counts as being at the water's edge. */
const SHORE_REACH_M = 2.2;

/** How far lying back tips the head up, radians. About fifty degrees. */
const RECLINE_LIFT = 0.9;

function reclineLift(ritual: RitualState): number {
  return ritual.stargazing.posture === 'reclined' ? RECLINE_LIFT : 0;
}

/**
 * The player's facing as a sky azimuth.
 *
 * Azimuth is measured from north, and +Z is north in this scene (the same
 * convention `Campsite.tsx` places the moon with), while a yaw of 0 looks
 * along +X. So the two are a quarter turn apart, and this is that quarter turn
 * written down once instead of three times.
 */
function skyAzimuth(facing: number): number {
  return Math.atan2(Math.cos(facing), Math.sin(facing));
}

/**
 * The named places the player is currently standing in.
 *
 * Only two so far — the fireside and the water's edge — but they are what the
 * discovery model's `at-place` conditions read, and what tells the significance
 * model how long somebody spent by the water.
 */
function placesAt(player: PlayerState, walkable: WalkableWorld, out: string[]): string[] {
  out.length = 0;
  if (distanceFromFire(player) < 2.6) out.push('fireside');
  const basin = walkable.basin;
  if (basin) {
    const along = player.position.x * Math.cos(basin.bearing) + player.position.z * Math.sin(basin.bearing);
    if (along > basin.distanceM - SHORE_REACH_M) out.push('water-edge');
  }
  return out;
}

/** Camera pose per ritual stage. */
interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/**
 * Stages that take the camera away from the player's own eyes.
 *
 * Everything else is explored on foot. The tactile stages keep a composed
 * framing because they are close manipulation of small objects — hunting for
 * a marshmallow with a free camera would be miserable, and the framing here
 * took real work to get right. So: walk the campsite freely, and the camera
 * settles into place when you actually start doing something.
 */
const ANCHORED_STAGES: ReadonlySet<RitualStage> = new Set<RitualStage>([
  'assembling',
  'machine',
  'reveal',
  'eating',
  'after',
]);

/**
 * Stages you do from your knees rather than from a camera that flew there.
 *
 * Roasting used to be an anchored stage: the camera left the player's eyes and
 * eased to a composed pose 0.78 m from the fire at 0.54 m high, and the player
 * became a cursor. The framing was good and the cost was the whole product —
 * with six stages doing this, the game read as a slideshow of screens instead
 * of one campsite, which is the first thing a person said about it.
 *
 * The framing is worth keeping; taking the camera to get it is not. Kneeling
 * buys the same eye height honestly, and you can still look around, walk round
 * the fire, or stand up and leave.
 */
const KNEELING_STAGES: ReadonlySet<RitualStage> = new Set<RitualStage>(['roasting']);

export function isAnchored(stage: RitualStage): boolean {
  return ANCHORED_STAGES.has(stage);
}

function poseFor(
  stage: RitualStage,
  arrivalProgress: number,
  marshmallow?: Vec3,
  playerBearing = LAYOUT.playerBearing,
): CameraPose {
  const bearing = playerBearing;
  const px = Math.cos(bearing);
  const pz = Math.sin(bearing);

  switch (stage) {
    case 'arriving': {
      // Walking in along the trail — the whole opening image of the product.
      const t = arrivalProgress;
      const start = LAYOUT.trailStart;
      const end: [number, number, number] = [px * 2.4, 1.55, pz * 2.4];
      return {
        position: [
          start[0] + (end[0] - start[0]) * t,
          1.6 + Math.sin(t * 22) * 0.022 * (1 - t * 0.4),
          start[2] + (end[2] - start[2]) * t,
        ],
        target: [0, 0.35, 0],
        fov: 62,
      };
    }
    case 'at-fire':
      return { position: [px * 2.1, 1.42, pz * 2.1], target: [0, 0.32, 0], fov: 60 };
    case 'roasting': {
      // Leaning right in over the coals. Roasting is the tactile heart of the
      // product, so the marshmallow has to be large enough to read its
      // browning patch by patch — framed at arm's length, not surveyed from
      // standing height. The camera follows it, so moving it in and out keeps
      // both it and the coals beneath it in shot.
      const target: [number, number, number] = marshmallow
        ? [marshmallow.x * 0.82, marshmallow.y * 0.86, marshmallow.z * 0.82]
        : [px * 0.22, 0.14, pz * 0.22];
      return { position: [px * 0.78, 0.54, pz * 0.78], target, fov: 44 };
    }
    case 'assembling':
      return {
        position: [LAYOUT.assemblyTable[0] + 0.26, 0.86, LAYOUT.assemblyTable[2] + 0.34],
        target: [LAYOUT.assemblyTable[0], LAYOUT.assemblyTable[1], LAYOUT.assemblyTable[2]],
        fov: 42,
      };
    case 'machine':
      // Standing squarely in front of the unit, close enough that its controls
      // are reachable and its decals legible.
      return {
        position: [
          LAYOUT.machine[0] + MACHINE_FRONT[0] * 1.55,
          1.12,
          LAYOUT.machine[2] + MACHINE_FRONT[1] * 1.55,
        ],
        target: [LAYOUT.machine[0], 0.68, LAYOUT.machine[2]],
        fov: 50,
      };
    case 'reveal': {
      // Square on the open chamber, slightly to the free-edge side and low
      // enough to see onto the tray. The door swings wide (see Machine.tsx),
      // so it no longer stands across this sight line.
      /*
       * Framed on the sandwich, not on the chamber.
       *
       * This was aimed at the geometric centre of the opening — 0.13 m above
       * where the sandwich actually sits — from 1.15 m at 36°, which put the
       * most important object in the product at about eight per cent of the
       * frame's width, low and small in a large grey box. The reveal is the
       * one shot the whole ritual is building to, and "does the sandwich look
       * delicious?" is not a question a picture can answer at that size.
       *
       * Pushed in and aimed down onto the tray, which also reads better: you
       * are looking *into* a freezer at something on a shelf. Deliberately not
       * pushed all the way in — the chamber mouth still frames it, because the
       * beat here is that it is in the machine. It is in your hands one beat
       * later, and that shot is the close-up.
       */
      const sandwich = machineToWorld([0, 0.4, 0.14]);
      return {
        position: machineToWorld([0.05, 0.6, 0.95]),
        target: sandwich,
        fov: 28,
      };
    }
    case 'eating':
    case 'after': {
      // Framed against the dark treeline. The camera sits off the sandwich's
      // own bearing and at nearly its height, so the line of sight passes
      // above and to one side of the pit rather than straight through it.
      const hold = holdPoint();
      const view = LAYOUT.playerBearing + HOLD_TURN + HOLD_VIEW_OFFSET;
      return {
        position: [Math.cos(view) * 1.62, HOLD_HEIGHT + 0.035, Math.sin(view) * 1.62],
        target: hold,
        fov: 19,
      };
    }
    default:
      return { position: [px * 2.2, 1.5, pz * 2.2], target: [0, 0.3, 0], fov: 60 };
  }
}

export interface WorldProps {
  store: Store;
  roastControl: RoastController;
  quality: QualityTier;
  onFrame?: (frameMs: number) => void;
  /** Set while the arrival walk is playing. */
  arrivalRef: React.MutableRefObject<number>;
  onSimStep?: (ritual: RitualState) => void;
  /** The player. Owned by the app so input handlers can steer it. */
  player: PlayerState;
  /** Movement intent for the current frame, refreshed by the app. */
  intentRef: React.MutableRefObject<MoveIntent>;
  /** Walkable world, derived from the environment manifest. */
  walkable: WalkableWorld;
  /** Reports what the player can act on, so the interface can offer it. */
  onReachChange?: (interactable: Interactable | null) => void;
  /**
   * Lifting the finished sandwich off the tray.
   *
   * Passed down because the act happens *on the sandwich*, in the chamber,
   * where the player is already looking — not on a button in the corner. It
   * used to be the latter, which is the same species of thing as the "Build"
   * button the product exists to not have (spec §1.3).
   */
  onLiftSandwich?: () => void;
}

export function World({
  store,
  roastControl,
  onLiftSandwich,
  quality,
  onFrame,
  arrivalRef,
  onSimStep,
  player,
  intentRef,
  walkable,
  onReachChange,
}: WorldProps): React.ReactElement {
  const { camera, gl } = useThree();
  const clock = useMemo(() => createClock(), []);
  const state = store.state;
  const ritual = state.ritual;
  const settings = state.render;
  const qualitySettings = QUALITY[quality];

  const targetRef = useRef(new THREE.Vector3(0, 0.32, 0));
  const eyeScratch = useMemo(() => vec3(), []);
  const lookScratch = useMemo(() => vec3(), []);
  /**
   * The bearing the anchored framing uses. Captured when an interaction
   * begins and held for its duration, so the composed shot does not swing
   * around if the player happens to turn while roasting.
   */
  const anchorBearing = useRef(LAYOUT.playerBearing);
  /*
   * The composed close-ups are framings of *your* hands.
   *
   * The ritual's stage is shared — it is part of the world — but the camera is
   * not, and without the second half of this condition one person starting a
   * roast dragged every other client into an arm's-length shot of somebody
   * else's marshmallow: no fire, no machine, no person, just a stranger's
   * stick. Alone at a campsite there is no campfire session and this is exactly
   * `isAnchored(stage)`, as it always was.
   */
  const anchored = isAnchored(ritual.stage) && !(store.campfire?.spectating ?? false);
  const lastReach = useRef<string | null>(null);
  /** Where a hand closed on the sandwich, while it is being lifted out. */
  const liftFrom = useRef<{ x: number; y: number } | null>(null);
  const lastStage = useRef<RitualStage>(ritual.stage);
  const shake = useRef(0);
  const seedNumber = useMemo(() => hashSeed(state.campsiteSeed), [state.campsiteSeed]);
  const environment = useMemo(() => getEnvironment(state.environmentId), [state.environmentId]);

  // Shadows are a quality-tier decision, applied once.
  useEffect(() => {
    gl.shadowMap.enabled = qualitySettings.enableShadows;
    gl.shadowMap.type = THREE.BasicShadowMap; // hard edges — crunchy, and cheap
  }, [gl, qualitySettings.enableShadows]);

  /*
   * Tone mapping.
   *
   * There was none, which means three.js clipped every value above 1.0 straight
   * to white — and next to a fire, a great deal is above 1.0. Measured: a
   * marshmallow the model had browned to 0.68 rendered as a *white* ball,
   * because golden albedo times a close point light clips to (1,1,1) and white
   * has no hue left to lose. Seventy seconds of browning, invisible.
   *
   * It had already cost the project once without being diagnosed: the fire-ring
   * stones carry a hand-darkened albedo and a comment reading "raw stone albedo
   * next to a fire blows out to paper white", which is this bug, worked around
   * one object at a time.
   *
   * Reinhard rather than ACES on purpose. ACES is the filmic default and it
   * deliberately desaturates highlights toward white, which is exactly the
   * thing being fixed here. Reinhard's x/(1+x) roll-off compresses the range
   * while holding hue, so a brightly lit golden marshmallow stays golden.
   *
   * The PS1 quantise and dither run at `dithering_fragment`, which is after
   * tone mapping in three's chain — so the 5-bit palette is applied to the
   * mapped image rather than to raw clipped values, which is the right order
   * and was accidentally correct before.
   */
  useEffect(() => {
    gl.toneMapping = THREE.ReinhardToneMapping;
    gl.toneMappingExposure = 1.35;
  }, [gl]);

  const marshmallowBagMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('canvas', { size: 64 }), roughness: 1 }),
    [settings],
  );

  useFrame((_, delta) => {
    const frameStart = typeof performance !== 'undefined' ? performance.now() : 0;

    // --- Simulation ------------------------------------------------------
    advance(clock, delta, (dt) => {
      // The player moves in every stage; the anchored stages simply stop
      // taking movement input, so the world keeps simulating around them.
      // Posture is decided by what the player is doing, not by a key they hold:
      // starting to roast kneels you down, finishing stands you back up.
      intentRef.current.kneel = KNEELING_STAGES.has(ritual.stage);
      stepPlayer(player, walkable, anchored ? EMPTY_INTENT : intentRef.current, dt);

      if (ritual.stage === 'roasting') {
        // The marshmallow is held from wherever the player is standing, so
        // walking round the fire genuinely changes the roast.
        applyRoastPose(
          roastControl,
          ritual,
          bearingFromFire(player),
          state.accessibility.autoRotate <= 0,
        );
      }
      // The torch is aimed where the player is looking. This is the *real*
      // light sweep: the model measures how fast the beam is moving and the
      // wildlife feel that. `lightSweep` used to be invented here from walking
      // speed, which meant walking about with no torch at all emptied the
      // treeline, and holding a lit torch perfectly still cost nothing.
      pointTorch(ritual, player.facing, player.pitch);

      // And looking at the sky is looking at the sky. Lying back tips the head
      // up — that is what lying back *is* — so the aim the stargazing model
      // reads is the player's own facing and pitch plus the recline. Without
      // this, "lie back and look up" left the camera staring at the fire and
      // the constellations were unreachable except through a test hook.
      lookAtSky(ritual, skyAzimuth(player.facing), player.pitch + reclineLift(ritual));

      // What the client knows and the simulation cannot see: where the player
      // is, how fast, whether they are sitting down, and which named places
      // they are standing in. The world systems read this — it is what makes
      // standing still matter, and what makes sitting down matter more.
      presenceScratch.speed = player.speed;
      presenceScratch.position = player.position;
      presenceScratch.seated = player.seated;
      presenceScratch.seatId = player.seated ? 'log-seat' : null;
      presenceScratch.places = placesAt(player, walkable, placesScratch);
      setPresence(ritual, presenceScratch);
      stepRitual(ritual, dt);
      onSimStep?.(ritual);
    });

    // A look delta is consumed once, not once per simulation step.
    intentRef.current.look = undefined;

    // Offer whatever is in reach. Only pushed to React when it changes, so
    // walking around does not re-render the tree every frame.
    if (!anchored) {
      const target = focused(player, walkable);
      const id = target?.id ?? null;
      if (id !== lastReach.current) {
        lastReach.current = id;
        onReachChange?.(target);
      }
    } else if (lastReach.current !== null) {
      lastReach.current = null;
      onReachChange?.(null);
    }

    if (ritual.stage !== lastStage.current) {
      // Arriving puts the player at the fireside wherever they were before.
      // Done here rather than at the end of the walk-in animation so that
      // every route into the campsite lands the same way — including tests
      // and links that skip the walk.
      if (lastStage.current === 'arriving' && ritual.stage !== 'arriving') {
        const bearing = LAYOUT.playerBearing;
        player.position.x = Math.cos(bearing) * 2.4;
        player.position.z = Math.sin(bearing) * 2.4;
        player.position.y = terrainHeight(player.position.x, player.position.z, walkable.seed, walkable.amplitude);
        player.facing = Math.atan2(-player.position.z, -player.position.x);
        player.pitch = -0.1;
        player.velocity.x = 0;
        player.velocity.z = 0;
        player.moveTarget = null;
      }
      // Capture where the player was standing as the interaction begins.
      if (isAnchored(ritual.stage) && !isAnchored(lastStage.current)) {
        anchorBearing.current = bearingFromFire(player);
      }
      lastStage.current = ritual.stage;
      store.setStageFromRitual();
    }

    // --- Camera ----------------------------------------------------------
    const perspective = camera as THREE.PerspectiveCamera;

    if (!anchored && ritual.stage !== 'arriving') {
      // Exploring: the camera is the player's own eyes. No easing — a first
      // person view that lags its own head is nauseating.
      eyePosition(player, eyeScratch);
      lookDirection(player, lookScratch);
      // Lying back: the same head, tipped up. The pitch limits in locomotion
      // are a standing neck's, so the recline is added here rather than there.
      const lift = reclineLift(ritual);
      if (lift > 0) {
        const pitch = Math.min(1.45, player.pitch + lift);
        const cosPitch = Math.cos(pitch);
        lookScratch.x = Math.cos(player.facing) * cosPitch;
        lookScratch.y = Math.sin(pitch);
        lookScratch.z = Math.sin(player.facing) * cosPitch;
      }
      camera.position.set(eyeScratch.x, eyeScratch.y, eyeScratch.z);
      targetRef.current.set(
        eyeScratch.x + lookScratch.x,
        eyeScratch.y + lookScratch.y,
        eyeScratch.z + lookScratch.z,
      );
      /*
       * Close work narrows the lens, and nothing else.
       *
       * The old anchored roast pose bought its readability with a 44° framing
       * the camera flew to. The lens can do that part on its own while the
       * camera stays where it belongs — on the player's eyes — so what is left
       * of that composed shot is the part that never needed to cost agency.
       */
      const fovTarget = KNEELING_STAGES.has(ritual.stage) ? CLOSE_WORK_FOV : EXPLORE_FOV;
      if (Math.abs(perspective.fov - fovTarget) > 0.05) {
        perspective.fov += (fovTarget - perspective.fov) * (1 - Math.exp(-4 * delta));
        perspective.updateProjectionMatrix();
      }
      camera.lookAt(targetRef.current);
      if (onFrame && typeof performance !== 'undefined') onFrame(performance.now() - frameStart);
      return;
    }

    const pose = poseFor(ritual.stage, arrivalRef.current, ritual.marshmallow.position, anchorBearing.current);
    // Reduced motion damps the ease rather than removing it — an instant cut
    // between stages is more disorienting, not less.
    const ease = settings.reducedMotion ? 6 : 2.6;
    const factor = 1 - Math.exp(-ease * delta);

    camera.position.x += (pose.position[0] - camera.position.x) * factor;
    camera.position.y += (pose.position[1] - camera.position.y) * factor;
    camera.position.z += (pose.position[2] - camera.position.z) * factor;

    targetRef.current.x += (pose.target[0] - targetRef.current.x) * factor;
    targetRef.current.y += (pose.target[1] - targetRef.current.y) * factor;
    targetRef.current.z += (pose.target[2] - targetRef.current.z) * factor;

    if (Math.abs(perspective.fov - pose.fov) > 0.05) {
      perspective.fov += (pose.fov - perspective.fov) * factor;
      perspective.updateProjectionMatrix();
    }

    // A small shake when the compressor kicks in — physical, never violent.
    if (ritual.machine.events.includes('compressor-start')) shake.current = 1;
    shake.current = Math.max(0, shake.current - delta * 2.2);
    if (shake.current > 0 && !settings.reducedMotion) {
      const s = shake.current * 0.006;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
    }

    camera.lookAt(targetRef.current);

    if (onFrame && typeof performance !== 'undefined') onFrame(performance.now() - frameStart);
  });

  const showStick = ritual.stage === 'roasting';
  const showAssembly = ritual.stage === 'assembling';
  const showSandwichOnTray = ritual.stage === 'reveal' && ritual.sandwich !== null;
  const showSandwichInHand = (ritual.stage === 'eating' || ritual.stage === 'after') && ritual.sandwich !== null;
  const embers = isEmberBed(ritual.fire);

  const px = Math.cos(anchorBearing.current);
  const pz = Math.sin(anchorBearing.current);

  return (
    <>
      <Campsite
        seed={seedNumber}
        weather={ritual.weather}
        settings={settings}
        // The environment's own draw distance, capped by the quality tier so
        // a generous site cannot blow the budget on a weak device.
        drawDistance={Math.min(qualitySettings.drawDistance, environment?.scene.drawDistanceM ?? 30)}
        onTakeWood={(woodId) => {
          tendFire(ritual, { type: 'add-log', woodId, placement: 0.78 });
          store.touch();
        }}
        {...(walkable.basin ? { basin: walkable.basin } : {})}
        {...(environment
          ? {
              palette: {
                ground: environment.scene.nightPalette.ground,
                foliage: environment.scene.nightPalette.foliage,
                fog: environment.scene.fog.colour,
                sky: environment.scene.nightPalette.zenith,
              },
              // Only canopy kits become trees. Summing *all* vegetation would
              // plant a forest on a heather moor, whose density is grass.
              // Which wood this campsite offers, in the order the pile shows it.
              fuelIds: environment.fuel.sources.map((source) => source.woodId),
              treeCount: Math.min(
                88,
                Math.round(
                  environment.scene.vegetation
                    .filter((kit) => kit.heightRange.max >= 2.5)
                    .reduce((total, kit) => total + kit.density, 0) * 1.8,
                ),
              ),
            }
          : {})}
      />

      <Radio
        radio={ritual.radio}
        settings={settings}
        campsiteSeed={state.campsiteSeed}
        position={LAYOUT.radio}
        rotationY={-0.7}
      />

      {/* The water, where the manifest actually has any. Absent entirely at a
          salt flat, a mesa or a rail siding. */}
      <Shore
        ritual={ritual}
        settings={settings}
        walkable={walkable}
        waterColour={environment?.scene.nightPalette.water ?? null}
      />

      {/* The named constellations, at the real altitude and azimuth for the
          session's date, and whatever is streaking across them. */}
      <NightSky ritual={ritual} />

      {/* The torch. One spot light, and only while it is lit. */}
      <Torch
        torch={ritual.torch}
        player={player}
        settings={settings}
        restPosition={LAYOUT.torch}
      />

      <Wildlife ritual={ritual} settings={settings} walkable={walkable} />

      <Fire
        fire={ritual.fire}
        settings={settings}
        maxParticles={qualitySettings.maxParticles}
        onRake={() => {
          tendFire(ritual, { type: 'rake' });
          store.touch();
        }}
      />

      <group position={LAYOUT.machine} rotation={[0, LAYOUT.machineRotation, 0]}>
        <Machine
          machine={ritual.machine}
          settings={settings}
          onAction={(action) => {
            // Synchronous: a control the player physically operates must
            // respond within the same frame (ARCHITECTURE §10).
            operateMachine(ritual, action);
            store.touch();
          }}
          hintEnabled={ritual.stage === 'machine' || ritual.stage === 'reveal'}
        />
      </group>

      {/* The bag of marshmallows — where roasting begins */}
      <group position={[LAYOUT.assemblyTable[0] - 0.16, LAYOUT.assemblyTable[1] + 0.02, LAYOUT.assemblyTable[2] - 0.16]}>
        <mesh
          material={marshmallowBagMaterial}
          castShadow
          onClick={(event) => {
            event.stopPropagation();
            if (ritual.stage === 'at-fire' || ritual.stage === 'after') {
              beginRoasting(ritual);
              store.touch();
            }
          }}
          onPointerOver={() => {
            if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
          }}
        >
          <boxGeometry args={[0.11, 0.07, 0.08]} />
        </mesh>
      </group>

      {showStick && (
        <RoastingStick marshmallow={ritual.marshmallow} settings={settings} bearing={anchorBearing.current} />
      )}

      {showAssembly && <AssemblyTable assembly={ritual.assembly} settings={settings} position={LAYOUT.assemblyTable} />}

      {showSandwichOnTray && ritual.sandwich && (
        <group
          position={machineToWorld([0, 0.372, 0.14])}
          /*
           * Picked up by taking hold of it and lifting.
           *
           * `onPointerDown` and not `onClick`, because a click is a press and a
           * release in the same place and this is a *lift*: the hand closes on
           * it and it comes away. The pointer is captured so the drag out of
           * the chamber belongs to the sandwich rather than to whatever it
           * passes over.
           */
          onPointerDown={(event) => {
            event.stopPropagation();
            liftFrom.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            const from = liftFrom.current;
            if (from === null) return;
            // Far enough that a tap on it is not a lift, close enough that
            // nobody has to drag it across the room.
            if (Math.hypot(event.clientX - from.x, event.clientY - from.y) < 34) return;
            liftFrom.current = null;
            onLiftSandwich?.();
          }}
          onPointerUp={() => {
            liftFrom.current = null;
          }}
        >
          <Sandwich sandwich={ritual.sandwich} bite={null} settings={settings} />
        </group>
      )}

      {showSandwichInHand && ritual.sandwich && (
        <Sandwich
          sandwich={ritual.sandwich}
          bite={ritual.bite}
          settings={settings}
          position={holdPoint()}
          spin={settings.reducedMotion ? 0 : 0.18}
        />
      )}

      {/* Ember glow reflected on the ground: a quiet cue that the coals are
          ready, which is the roasting discovery the spec wants unlabelled. */}
      {embers && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.008, 0]}>
          <circleGeometry args={[0.9, 16]} />
          <meshBasicMaterial color={0xff5f18} transparent opacity={0.06} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/** Stable numeric seed from a campsite id. Shared with the app. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
