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
  describeArmful,
  distanceFromFire,
  eyePosition,
  gatherFuel,
  offered,
  patchAt,
  visitLandmark,
  terrainHeight,
  isEmberBed,
  lookDirection,
  lookAtSky,
  pointTorch,
  setPresence,
  stepPlayer,
  vec3,
  WOOD_TYPES,
  type Interactable,
  type MoveIntent,
  type PlayerState,
  type PresenceInput,
  type RitualStage,
  type RitualState,
  type WalkableWorld,
  tonightsUndergrowth,
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
import { beginRoasting, layFuel, operateMachine, stepRitual, tendFire } from '../net/shared.js';
import { getEnvironment } from '@somemore/content';
import { LAYOUT, machineToWorld, hashSeed, campFurniture, treesForCover } from './layout.js';
// Re-exported because half the app imports them from here and the split is a
// tidying, not a change of address.
export { LAYOUT, machineToWorld, hashSeed, campFurniture };
import { Campsite } from './Campsite.js';
import { Fire } from './Fire.js';
import { Machine } from './Machine.js';
import { AssemblyTable, RoastingStick, Sandwich } from './RitualObjects.js';
import { Radio } from './Radio.js';
import { Wildlife } from './Wildlife.js';
import { Shore } from './Shore.js';
import { Torch } from './Torch.js';
import { NightSky } from './NightSky.js';
import { reclineLift, skyAzimuth } from './skyAim.js';
import type { Vec3 } from '@somemore/sim';
import { QUALITY, type QualityTier, type RenderSettings } from '../render/ps1.js';
import { createPs1Material } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import type { Store } from '../state/store.js';
import { applyRoastPose, type RoastController } from '../interaction/roastControl.js';

/**
 * How close you have to come to the pit before you get down to it.
 *
 * Proximity rather than whatever the reach prompt currently offers: the stump
 * of marshmallows sits nearer the landing spot than the fire does, so a player
 * standing right over the coals was being told they were at the marshmallows
 * and left standing up straight over them.
 */
const CROUCH_AT_THE_FIRE = 1.4;

/**
 * How far a hand has to travel in toward the middle of the pit before it is
 * banking the fire rather than poking it.
 *
 * Twelve centimetres across a pit forty-two across: comfortably more than a
 * tap wanders and comfortably less than the width of the bed, so neither
 * gesture can be performed by accident while trying for the other.
 */
const BANK_SWEEP = 0.12;

/**
 * How close you have to be to pick a stick up off the ground.
 *
 * Matches the reach the walkable world gives a fuel patch, so what the prompt
 * offers and what a tap on the wood itself does are the same thing.
 */
const GATHER_REACH = 1.3;

/**
 * True when the player is close enough to put a hand in the pit.
 *
 * The same distance decides whether you are crouched over the fire and whether
 * you can touch it, because they are the same fact. Tapping the fire from
 * across the clearing is a *walk* — it is how you come to it — and until this
 * was checked that same tap also raked the coals, from two and a half metres
 * away, before the player had taken a step.
 */
function atThePit(player: PlayerState): boolean {
  return Math.hypot(player.position.x, player.position.z) < CROUCH_AT_THE_FIRE;
}

/**
 * Whether the player's hands are free to be put in the fire.
 *
 * Adding a second pointer surface to the pit — drag a log, sweep the ash —
 * put it in competition with every other drag in the product, and the pit won:
 * a press that landed on the ash bed while a marshmallow was on the stick took
 * the gesture, stopped it reaching the roasting control, and left seventy
 * seconds of turning the stick doing nothing at all. You cannot rake a fire
 * you are holding a roasting stick over, and now the fire knows it.
 */
function handsFreeForTheFire(stage: RitualStage): boolean {
  return stage === 'at-fire' || stage === 'after';
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
/** How far out in front of the eye a thing you are looking at is held. */
const HOLD_REACH = 0.33;
/** And how far below it, and to which side. Hands are not on your forehead. */
const HOLD_BELOW_EYE = 0.12;
const HOLD_ASIDE = 0.07;
/** Camera offset around the fire, so the pit is never directly behind. */
const HOLD_VIEW_OFFSET = 0.38;

/**
 * Where the sandwich is held while being inspected and eaten.
 *
 * In your hands, which sounds obvious and was not the case. It used to be a
 * fixed point in the world, a metre and a third out from the pit on a fixed
 * bearing — chosen when the camera was flown to a composed shot that framed
 * exactly that spot. The camera is the player's eyes now, and the player
 * finishes the machine standing at the machine: so the finished sandwich, the
 * whole point of the product, was hanging in the air across the clearing
 * behind them while they stood looking into an empty freezer.
 *
 * It goes in front of the person holding it, a little below the eye and a
 * little to one side, which is where a thing you are holding and looking at
 * actually is. Eating then happens wherever you happen to be standing, which
 * is what the design always said it did.
 */
export function holdPointFor(player: PlayerState): [number, number, number] {
  const eye = eyePosition(player, holdScratch);
  const forward = Math.cos(player.facing);
  const forwardZ = Math.sin(player.facing);
  return [
    eye.x + forward * HOLD_REACH - forwardZ * HOLD_ASIDE,
    eye.y - HOLD_BELOW_EYE,
    eye.z + forwardZ * HOLD_REACH + forward * HOLD_ASIDE,
  ];
}

/** Reused so holding a sandwich allocates nothing per frame. */
const holdScratch = vec3(0, 0, 0);

/** Unit vector pointing out of the machine's face. */
const MACHINE_FRONT: [number, number] = [Math.sin(LAYOUT.machineRotation), Math.cos(LAYOUT.machineRotation)];

/** Field of view while exploring on foot. */
const EXPLORE_FOV = 68;
/**
 * Leaning in over something small. The old anchored roast pose used 44°.
 *
 * Per stage rather than one number, because the four close-work stages are not
 * looking at the same thing. Roasting, assembling and loading the machine are
 * done with your hands, and a hand needs the room around it in shot. The
 * reveal is not a task at all — it is one small object on a shelf, and it is
 * the shot the whole ritual builds to.
 *
 * That distinction had been lost. `poseFor`'s reveal case still carries the
 * composed pose that fixed defect #36 — "0.95 m at 28°, aimed down onto the
 * tray" — and since the camera stopped leaving the player's eyes (#27) that
 * pose has been dead for this stage, so the sandwich went back to being seen
 * from wherever the body happened to be standing, through the same 48° lens as
 * everything else. Measured: **3.4% of the frame's width**, where 8% was the
 * figure #36 called a defect. Nobody re-measured after removing the cuts, and
 * the plan still recorded #36 as fixed.
 *
 * The lens is the right instrument for it — the comment on the branch below
 * already says so: it "can do that part on its own while the camera stays
 * where it belongs, on the player's eyes". A body cannot get closer than the
 * machine's own collision radius allows, so the distance is fixed at about a
 * metre and a quarter and the lens has to carry the rest.
 */
const CLOSE_WORK_FOV = 48;
/** The reveal's own lens. See the note above; chosen by looking, not by arithmetic. */
const REVEAL_FOV = 30;
const STAGE_FOV: Readonly<Partial<Record<RitualStage, number>>> = { reveal: REVEAL_FOV };
/**
 * How close to the fire's centre you kneel to roast.
 *
 * The anchored camera this replaces sat at 0.78 m. A body cannot: the fire is a
 * soft obstacle of radius 0.55 and walking into it is meant to cost you. This
 * is as close as someone would actually kneel — near enough to read the
 * browning, far enough that the coals are not in your lap.
 */
const ROASTING_STAND_DISTANCE = 0.95;

/** A player who is mid-interaction takes no movement input. */
/**
 * Movement ignored, posture still honoured.
 *
 * Replaces a frozen empty intent: the hands-busy stages must still be able to
 * kneel, so the one field that is not movement has to get through. Reused
 * rather than rebuilt so no frame allocates.
 */
const restingIntent: MoveIntent = {};

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
 * Stages where the pointer belongs to the task instead of to looking around.
 *
 * Two of them, and both for the same reason: a drag means something other than
 * looking around. Roasting pulls the marshmallow over the coals; the reveal
 * lifts the sandwich off the tray with both hands. Everything else — placing
 * the assembly pieces, the machine's door and lever, eating — is a click on
 * something in front of you, and none of that needs movement taken away.
 *
 * A first pass at this listed roasting alone, on the strength of a grep saying
 * only `interaction/roastControl.ts` handled a drag. That was true and
 * misleading: the lift is a pointer handler on the sandwich mesh itself rather
 * than a named controller, so it did not turn up, and unanchoring the reveal
 * quietly set the lift fighting free-look over the same gesture — the identical
 * defect that splitting this predicate in two was supposed to have retired.
 * The grep answered "where are the drag controllers", which is not the same
 * question as "where does a drag mean something".
 *
 * The set used to hold six stages, and that was the whole reason the game read
 * as a slideshow: five sixths of the ritual was spent as a cursor in a composed
 * shot. Two is what is actually load-bearing.
 */
const ANCHORED_STAGES: ReadonlySet<RitualStage> = new Set<RitualStage>(['roasting', 'reveal']);

/**
 * How low the body goes for each task, as a posture rather than a camera move.
 *
 * These heights are the ones the old composed poses used, because that framing
 * was good and worth keeping — 0.54 m over the coals, 0.86 m over the assembly
 * table, and enough of a stoop at the machine to see onto its tray. What has
 * changed is who is doing it: the camera used to fly to those heights, and now
 * the player's own body arrives at them, which means you can look up, walk
 * round, or stand and leave at any point in any of them.
 */
const STAGE_STANCE: Readonly<Partial<Record<RitualStage, 'kneel' | 'crouch'>>> = {
  // Over the coals, at arm's length from the marshmallow.
  roasting: 'kneel',
  // The assembly table is a 0.34 m stump; you work at it from a squat.
  assembling: 'crouch',
  // The chamber's mouth is at 0.56 m, so seeing onto the tray is a stoop.
  reveal: 'crouch',
};

/**
 * Where the body has to be for each task, and how close.
 *
 * Removing a cut is not just leaving the camera alone: the ritual used to
 * advance the stage and fly the camera to whatever the next task was, so the
 * player was never required to be anywhere. Now they are, which means the
 * approach has to be walked. These are the spots to walk to, offset out from
 * each object toward the clearing so you end up facing it.
 */
function approachFor(
  stage: RitualStage,
  bearing: number,
): { x: number; z: number } | null {
  switch (stage) {
    case 'roasting':
      return { x: Math.cos(bearing) * ROASTING_STAND_DISTANCE, z: Math.sin(bearing) * ROASTING_STAND_DISTANCE };
    case 'assembling': {
      // Beside the table on the fire side, close enough to reach across it.
      const [tx, , tz] = LAYOUT.assemblyTable;
      const length = Math.hypot(tx, tz) || 1;
      return { x: tx - (tx / length) * 0.62, z: tz - (tz / length) * 0.62 };
    }
    case 'machine':
    case 'reveal': {
      /*
       * In front of the unit and off to the door's free side.
       *
       * Standing dead centre put the open door across the sight line and the
       * reveal became a picture of a grey panel with the sandwich nowhere in
       * frame. The pose this replaces knew that — its comment says "slightly to
       * the free-edge side... the door swings wide, so it no longer stands
       * across this sight line" — and the offset was the whole reason it was
       * written that way. Removing the camera was never a reason to throw away
       * what the camera had learned.
       *
       * The door hinges at local x = -0.29 and opens to that side, so the free
       * edge is local +x. A body has arms, so it stands closer than the old
       * camera's 1.55 m.
       */
      const [x, , z] = machineToWorld([0.34, 0, 1.1]);
      return { x, z };
    }
    default:
      // Eating and everything after it are done on your feet, wherever you
      // happen to be standing. A s'more is not a task with a location.
      return null;
  }
}

/**
 * What the player turns to look at when they arrive at a task.
 *
 * Walking to the right spot is only half of replacing a composed shot. The
 * pose that used to be flown to carried a *target* as well as a position, and
 * dropping it left the reveal facing the machine's open door with the sandwich
 * out of frame entirely — the same class of mistake as unanchoring the roast
 * and leaving the marshmallow a dozen pixels away, which is to say: keeping the
 * part of the old framing that was easy and discarding the part that was doing
 * the work.
 *
 * This is eased into over the approach walk rather than snapped, and any look
 * input from the player abandons it immediately. Turning to face the thing you
 * have just walked up to is something a body does; being unable to look away
 * from it is not.
 */
function focusFor(stage: RitualStage): [number, number, number] | null {
  switch (stage) {
    case 'assembling':
      return LAYOUT.assemblyTable;
    case 'machine':
      // The controls, not the whole cabinet: the lever and the readout are what
      // you are there to work, and they sit above the chamber.
      return machineToWorld([0, 0.66, 0.32]);
    case 'reveal':
      // Onto the tray, where the sandwich actually is.
      return machineToWorld([0, 0.4, 0.16]);
    default:
      return null;
  }
}

/** Tasks framed on something small and close, so the lens narrows for them. */
const CLOSE_WORK_STAGES: ReadonlySet<RitualStage> = new Set<RitualStage>([
  'roasting',
  'assembling',
  'machine',
  'reveal',
]);

/**
 * Whether the pointer belongs to the task rather than to looking around.
 *
 * Two different questions were being answered by this one predicate: "are the
 * player's hands busy" and "has the camera left the player's eyes". They used
 * to have the same answer everywhere, so one name did both jobs — and then
 * unanchoring roasting silently changed the input model too, which set the
 * withdraw gesture fighting free-look over the same drag. Two names now.
 *
 * This is the input one, and it is what every call site in `App.tsx` means:
 * while you are holding a roasting stick, a drag pulls the marshmallow, not
 * your head.
 */
export function isAnchored(stage: RitualStage): boolean {
  return ANCHORED_STAGES.has(stage);
}

/**
 * Whether the camera has left the player's eyes. It no longer ever does.
 *
 * Kept as a named function rather than deleted because the answer being
 * permanently `false` is the point of this pass, and a reader coming to
 * `poseFor` and the composed poses it still contains deserves to find the
 * statement rather than infer it from an absence. Those poses are retained for
 * the arrival dolly, which is a title sequence and the one place a scripted
 * camera is honest.
 */
export function isCameraAnchored(_stage: RitualStage): boolean {
  return false;
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
      // The composed pose is retained for the arrival dolly only; the hold it
      // frames is the old fixed one, and nothing flies to it any more.
      const angle = LAYOUT.playerBearing + HOLD_TURN;
      const hold: [number, number, number] = [
        Math.cos(angle) * HOLD_RADIUS,
        HOLD_HEIGHT,
        Math.sin(angle) * HOLD_RADIUS,
      ];
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
  /**
   * The piece of fuel currently under a finger, or null.
   *
   * Written here, read by the input layer. Arranging the fire is a drag on a
   * five-centimetre object inside a scene where a drag otherwise turns your
   * head, and the two would fight over every gesture: r3f's `stopPropagation`
   * settles arguments between three.js objects, not between a canvas listener
   * and a React handler on the element around it. So the pit says out loud
   * when it has hold of something.
   */
  grabbedFuelRef?: React.MutableRefObject<string | null>;
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
  grabbedFuelRef,
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
  const spectating = store.campfire?.spectating ?? false;
  /** Hands busy: the pointer drives the task, so movement intent is ignored. */
  const anchored = isAnchored(ritual.stage) && !spectating;
  /** Camera taken off the player entirely. Kneeling stages are deliberately not. */
  const cameraAnchored = isCameraAnchored(ritual.stage) && !spectating;
  const lastReach = useRef<string | null>(null);
  /** Where a hand closed on the sandwich, while it is being lifted out. */
  const liftFrom = useRef<{ x: number; y: number } | null>(null);
  const lastStage = useRef<RitualStage>(ritual.stage);
  /** The sandwich in the player's hands, moved every frame. */
  const heldSandwichRef = useRef<THREE.Group>(null);
  /** What the player is turning to look at, or null once they have arrived. */
  const lookGoal = useRef<[number, number, number] | null>(null);
  const shake = useRef(0);
  const seedNumber = useMemo(() => hashSeed(state.campsiteSeed), [state.campsiteSeed]);
  const environment = useMemo(() => getEnvironment(state.environmentId), [state.environmentId]);
  /*
   * How thick the low scatter is tonight, from the ritual's own roll.
   *
   * The understorey is drawn and never simulated, so the multiplier has to
   * come back out of the simulation to reach it — the roll itself stays in
   * `packages/sim`, where it is deterministic and shared between two clients
   * at one fire (ADR-0006).
   */
  const undergrowth = useMemo(() => tonightsUndergrowth(ritual.variations), [ritual.variations]);

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

  /**
   * Arriving puts the player at the fireside wherever they were before, so
   * every route into the campsite lands the same way — including tests and
   * links that skip the walk.
   *
   * Called from inside the step, *before* the world is asked where the player
   * is. It used to run after the step, so the first step at the fire ran with
   * the player still at the trail head: the place model read a position
   * twenty metres out, decided you had just walked somewhere new, and put its
   * remark about the lie of the land across the fire on the very first
   * frame — every session.
   */
  const landed = useRef(false);
  const landAtTheFire = (): void => {
    const bearing = LAYOUT.playerBearing;
    player.position.x = Math.cos(bearing) * 2.4;
    player.position.z = Math.sin(bearing) * 2.4;
    player.position.y = terrainHeight(player.position.x, player.position.z, walkable.seed, walkable.amplitude);
    player.facing = Math.atan2(-player.position.z, -player.position.x);
    /*
     * Looking at the fire, not over it.
     *
     * At a level pitch the pit sits on the very bottom edge of the frame
     * from the landing spot — the opening image was trees and sky with the
     * one thing you came for cut off at the chin, and the ground between
     * you and it was off screen entirely, so a tap could not even walk you
     * in. The eye is at one metre and a half and the fire is two and a
     * half metres out; this is roughly where a person would be looking.
     */
    player.pitch = -0.32;
    player.velocity.x = 0;
    player.velocity.z = 0;
    player.moveTarget = null;
  };

  useFrame((_, delta) => {
    const frameStart = typeof performance !== 'undefined' ? performance.now() : 0;

    // --- Simulation ------------------------------------------------------
    advance(clock, delta, (dt) => {
      if (ritual.stage === 'arriving') landed.current = false;
      else if (!landed.current) {
        landed.current = true;
        landAtTheFire();
      }
      // The player moves in every stage; the anchored stages simply stop
      // taking movement input, so the world keeps simulating around them.
      /*
       * Posture is decided by what the player is doing, not by a key they hold:
       * starting to roast kneels you down, finishing stands you back up.
       *
       * It has to survive the hands-busy branch, which is the whole point --
       * roasting ignores movement intent and still needs the body to lower, so
       * the resting intent carries posture and nothing else.
       */
      const stance = STAGE_STANCE[ritual.stage];
      /*
       * And squatting down at the fire, which is not a stage but a place you
       * are standing.
       *
       * The pit is eighty centimetres across and the eye is at one metre six.
       * From up there the whole of the fire — how the wood is stacked, what is
       * steaming, whether the coals are under ash — is a smudge at the bottom
       * of the frame, and every one of those is now something the player is
       * meant to read and act on. Nobody tends a fire standing over it. This
       * gets them down to it, and eases back up the moment they step away.
       */
      const atTheFire = (ritual.stage === 'at-fire' || ritual.stage === 'after') && atThePit(player);
      intentRef.current.kneel = stance === 'kneel';
      intentRef.current.crouch = stance === 'crouch' || atTheFire;
      restingIntent.kneel = stance === 'kneel';
      restingIntent.crouch = stance === 'crouch' || atTheFire;
      stepPlayer(player, walkable, anchored ? restingIntent : intentRef.current, dt);

      /*
       * Turn toward the task, unless the player is already looking somewhere.
       *
       * Eased rather than snapped: a head that jumps to a new heading is a cut
       * by another name, and cuts are what this whole pass exists to remove.
       * Any look input at all abandons the goal, so this can steer you toward
       * the machine and never away from wherever you decide to look instead.
       */
      /*
       * While it is in your hands, the thing you are looking at is your hands.
       *
       * Refreshed rather than snapshotted: the machine is worked from a stoop
       * and the sandwich comes out of it as you stand up, so a heading taken at
       * the moment the stage changed was aimed at where your hands were when
       * you were forty centimetres lower — and left you looking at the ground
       * in front of the freezer. Any look input still abandons it below, so
       * this steers your head onto the sandwich once and never holds it there.
       */
      if (ritual.stage === 'eating' && lookGoal.current !== null) {
        lookGoal.current = holdPointFor(player);
      }
      const goal = lookGoal.current;
      if (goal) {
        const look = intentRef.current.look;
        if (look && (look.yaw !== 0 || look.pitch !== 0)) {
          lookGoal.current = null;
        } else {
          const eye = eyePosition(player, eyeScratch);
          const wantFacing = Math.atan2(goal[2] - eye.z, goal[0] - eye.x);
          const flat = Math.hypot(goal[0] - eye.x, goal[2] - eye.z);
          const wantPitch = Math.atan2(goal[1] - eye.y, Math.max(0.05, flat));
          const rate = 1 - Math.exp(-5 * dt);
          let turn = wantFacing - player.facing;
          while (turn > Math.PI) turn -= Math.PI * 2;
          while (turn < -Math.PI) turn += Math.PI * 2;
          player.facing += turn * rate;
          player.pitch += (wantPitch - player.pitch) * rate;
          if (Math.abs(turn) < 0.02 && Math.abs(wantPitch - player.pitch) < 0.02) {
            lookGoal.current = null;
          }
        }
      }

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

    // The sandwich goes where the hands go.
    const held = heldSandwichRef.current;
    if (held) {
      const [hx, hy, hz] = holdPointFor(player);
      held.position.set(hx, hy, hz);
      // Turned to face whoever is holding it, so it reads as a sandwich rather
      // than as a slab seen edge on.
      held.rotation.y = player.facing + Math.PI / 2;
    }

    // A look delta is consumed once, not once per simulation step.
    intentRef.current.look = undefined;

    // Offer whatever is in reach. Only pushed to React when it changes, so
    // walking around does not re-render the tree every frame.
    if (!anchored) {
      const target = offered(ritual, player, walkable);
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
      // Capture where the player was standing as the interaction begins.
      if (isAnchored(ritual.stage) && !isAnchored(lastStage.current)) {
        anchorBearing.current = bearingFromFire(player);
      }

      /*
       * Kneeling down is not enough on its own: you have to come closer.
       *
       * The first attempt at removing the anchored roast camera lowered the eye
       * and left the player standing where they were, two metres out, and the
       * marshmallow became a dozen pixels over a distant pit. The old composed
       * pose was 0.78 m from the fire, and that proximity was doing as much
       * work as the height was.
       *
       * So the body closes the distance too, by walking: a move target on the
       * player's own bearing, near enough to work over the coals but outside
       * the fire's soft obstacle. Locomotion carries them in and collision
       * still applies, which is what keeps this a movement rather than the
       * teleport it is replacing.
       */
      if (ritual.stage !== lastStage.current) {
        const approach = approachFor(ritual.stage, bearingFromFire(player));
        if (approach) player.moveTarget = vec3(approach.x, 0, approach.z);
        // And what to turn toward once there. Cleared the moment the player
        // looks anywhere themselves.
        lookGoal.current = focusFor(ritual.stage);
        /*
         * And look at what you have just taken out.
         *
         * `focusFor` cannot answer this one, because where the sandwich is
         * depends on where you are standing: you finish the machine with your
         * head down in its chamber, and the thing you came for is now in your
         * hands. Snapshotted rather than followed — the ease only has to bring
         * your head up off the freezer, and after that you are looking at it.
         */
        if (ritual.stage === 'eating') lookGoal.current = holdPointFor(player);
      }
      lastStage.current = ritual.stage;
      store.setStageFromRitual();
    }

    // --- Camera ----------------------------------------------------------
    const perspective = camera as THREE.PerspectiveCamera;

    if (!cameraAnchored && ritual.stage !== 'arriving') {
      // The camera is the player's own eyes. No easing — a first person view
      // that lags its own head is nauseating. This branch now also carries the
      // kneeling stages, where the hands are busy but the body is still the
      // player's own: the eye height comes down through `stance`, so leaning in
      // over the coals is a movement rather than a cut to a composed pose.
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
      const fovTarget = CLOSE_WORK_STAGES.has(ritual.stage)
        ? (STAGE_FOV[ritual.stage] ?? CLOSE_WORK_FOV)
        : EXPLORE_FOV;
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
        fuelPatches={ritual.gathering.patches}
        landmarks={ritual.landmarks}
        onVisitLandmark={(id) => {
          // Reachable only from where you are standing, for the same reason
          // the firewood is: a tap on something across the clearing is a walk.
          const landmark = ritual.landmarks.find((l) => l.id === id);
          if (!landmark) return;
          const reach = landmark.kind === 'natural' ? 2 : 1.5;
          if (Math.hypot(player.position.x - landmark.x, player.position.z - landmark.z) > reach) return;
          const met = visitLandmark(ritual, id);
          if (!met) return;
          if (met.telling) store.setNotice(met.telling);
          store.touch();
        }}
        onGather={(patchId) => {
          /*
           * Same act as reaching for it on foot — but only if you are on foot
           * and there.
           *
           * A tap on a stick across the clearing is a *walk*, the same as a
           * tap on the fire is. Without this check it was also a pickup, so
           * the armful filled itself on the way over and the walk that was
           * meant to be the cost of the wood cost nothing at all.
           */
          const patch = patchAt(ritual.gathering, patchId);
          if (!patch) return;
          if (Math.hypot(player.position.x - patch.x, player.position.z - patch.z) > GATHER_REACH) return;
          const result = gatherFuel(ritual, patchId);
          if (result.full) store.setNotice('Your arms are full. Take it back to the fire first.');
          else if (result.empty) store.setNotice('Nothing left here worth carrying.');
          else if (result.taken) store.setNotice(result.introduction ?? describeArmful(ritual.gathering));
          store.touch();
        }}
        onTakeWood={(woodId) => {
          tendFire(ritual, { type: 'add-log', woodId });
          /*
           * The wood introduces itself, once, as you put it on.
           *
           * Which log you take has always decided how the next ten minutes of
           * fire behave -- pine catches from almost nothing and leaves almost
           * nothing, mesquite will not light on a cold fire and leaves a bed
           * worth roasting over -- and the player was never told any of it. The
           * line is sensory rather than numeric on purpose: the point is to end
           * up knowing that the heavy dark one makes the better coals, and to
           * know it from having handled it rather than from having read a burn
           * rate off a panel.
           */
          const wood = WOOD_TYPES[woodId];
          if (wood) store.setNotice(`${wood.label}. ${wood.note}`);
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
              // Which wood this campsite offers, in the order the pile shows it.
              fuelIds: environment.fuel.sources.map((source) => source.woodId),
              /*
               * How closed the horizon is, from the axis the catalogue grades
               * campsites on rather than from a sum over the kit list.
               *
               * The old rule summed the density of every vegetation kit over
               * 2.5 m and drew that many trees, which read as sensible and was
               * wrong wherever it mattered: the cedar switchback is authored
               * `canopy` — the densest cover in the catalogue, sky openness
               * 0.08 — and was drawn with half the trees of a `moderate` lake
               * shore. The kits still decide where in a cover band a campsite
               * sits, so two dense woods are still two different woods.
               */
              treeCount: treesForCover(
                environment.character.treeCover,
                environment.scene.vegetation
                  .filter((kit) => kit.heightRange.max >= 2.5)
                  .reduce((total, kit) => total + kit.density, 0),
              ),
              /*
               * And everything below that line, which used to be thrown away.
               *
               * The filter above answers "what is a tree", and its complement
               * was answering "what is nothing at all". Sword fern at seventy
               * per hundred square metres, Spanish moss at thirty-four,
               * bracken, heather, devil's club, cryptobiotic crust — all of it
               * specified, none of it drawn, which is most of why walking away
               * from the fire found six cones and four rocks.
               */
              understorey: environment.scene.vegetation
                .filter((kit) => kit.heightRange.max < 2.5)
                .map((kit) => ({
                  kitId: kit.kitId,
                  /*
                   * Thicker or thinner tonight (§5.4).
                   *
                   * Seven campsites declare a variation that is about exactly
                   * this — bracken density, grass height, Spanish moss
                   * coverage, the wrack line's contents, leaf fall on the
                   * platform, foxglove spires, how far the thermal moss rings
                   * reach — and the meltwater cirque declares its inverse, in
                   * snow lying over the ground. All of them rolled the same
                   * number every visit until now.
                   */
                  density: kit.density * undergrowth,
                  minHeight: kit.heightRange.min,
                  maxHeight: kit.heightRange.max,
                  lowTierDrop: kit.lowTierDrop,
                })),
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
        onWorkBed={({ x, z, inward }) => {
          if (!atThePit(player)) return;
          /*
           * Which way your hand went, and what is in the other one.
           *
           * Swept inward, you are pulling ash over the coals: that is banking,
           * and it is the answer to rain coming and to going to bed. Raked
           * outward — or just poked — you are opening the bed back up. And if
           * your arms are full of wood, touching the fire means putting a
           * piece down exactly where you pointed. No modes, no controls: the
           * gesture and your hands say everything.
           */
          if (inward > BANK_SWEEP) {
            tendFire(ritual, { type: 'bank' });
            store.setNotice('Ash over the coals. They will keep.');
          } else if (ritual.gathering.armful.length > 0) {
            if (layFuel(ritual, { spot: { x, z } })) store.setNotice(describeArmful(ritual.gathering));
          } else {
            tendFire(ritual, { type: 'rake' });
          }
          store.touch();
        }}
        onMoveLog={(logId, x, z) => {
          if (!atThePit(player)) return;
          tendFire(ritual, { type: 'move-log', logId, spot: { x, z } });
          store.touch();
        }}
        canTouch={() => atThePit(player) && handsFreeForTheFire(ritual.stage)}
        {...(environment ? { glow: environment.scene.nightPalette.fireGlow } : {})}
        {...(grabbedFuelRef ? { grabbedRef: grabbedFuelRef } : {})}
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
           * it and it comes away.
           *
           * The capture below is the thing this comment already claimed and the
           * code did not do. Without it `onPointerMove` only arrives while the
           * cursor is still over the sandwich, so a lift has to travel 34 px
           * without leaving an object that is about 30 px tall on screen — it
           * worked only because the composed shot this replaces framed the
           * sandwich enormous. The first frame of the reveal from a standing
           * body made it small enough to expose the bug, which is a fair
           * description of what a smaller screen would have done anyway.
           */
          onPointerDown={(event) => {
            event.stopPropagation();
            liftFrom.current = { x: event.clientX, y: event.clientY };
            try {
              (event.target as Element | null)?.setPointerCapture(event.pointerId);
            } catch {
              // Capture is a convenience; the lift still works while the
              // pointer happens to stay over the sandwich.
            }
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
          onPointerUp={(event) => {
            liftFrom.current = null;
            try {
              (event.target as Element | null)?.releasePointerCapture(event.pointerId);
            } catch {
              /* Nothing was captured. */
            }
          }}
        >
          <Sandwich sandwich={ritual.sandwich} bite={null} settings={settings} />
        </group>
      )}

      {/*
        In your hands, and following them.

        Positioned in the frame loop rather than from a prop: a React render
        happens when the store says something changed, and a thing you are
        holding has to keep up with your feet, not with the store.
      */}
      {showSandwichInHand && ritual.sandwich && (
        <group ref={heldSandwichRef}>
          <Sandwich
            sandwich={ritual.sandwich}
            bite={ritual.bite}
            settings={settings}
            spin={settings.reducedMotion ? 0 : 0.18}
          />
        </group>
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


