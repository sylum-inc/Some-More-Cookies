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
  beginRoasting,
  createClock,
  isEmberBed,
  operateMachine,
  stepRitual,
  type RitualStage,
  type RitualState,
} from '@somemore/sim';
import { Campsite } from './Campsite.js';
import { Fire } from './Fire.js';
import { Machine } from './Machine.js';
import { AssemblyTable, RoastingStick, Sandwich } from './RitualObjects.js';
import { QUALITY, type QualityTier, type RenderSettings } from '../render/ps1.js';
import { createPs1Material } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import type { Store } from '../state/store.js';
import type { RoastController } from '../interaction/roastControl.js';

/** Where everything stands. The fire pit is the origin of the world. */
export const LAYOUT = {
  /** The player's bearing around the fire, radians. */
  playerBearing: 0.42,
  /** How far the player stands from the fire while roasting. */
  playerDistance: 1.5,
  assemblyTable: [1.42, 0.34, 1.32] as [number, number, number],
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

/** Camera pose per ritual stage. */
interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

function poseFor(stage: RitualStage, arrivalProgress: number): CameraPose {
  const bearing = LAYOUT.playerBearing;
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
    case 'roasting':
      // Over the shoulder and slightly down, so both the coals and the
      // marshmallow are in frame at once — the two things being related is
      // the whole skill of it.
      return {
        position: [px * 1.15, 1.02, pz * 1.15],
        target: [px * 0.2, 0.28, pz * 0.2],
        fov: 48,
      };
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
      // Closer, lower, framed on the open chamber.
      const chamber = machineToWorld([0, 0.44, 0.2]);
      return {
        position: [
          LAYOUT.machine[0] + MACHINE_FRONT[0] * 0.92,
          0.82,
          LAYOUT.machine[2] + MACHINE_FRONT[1] * 0.92,
        ],
        target: chamber,
        fov: 42,
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
}

export function World({ store, roastControl, quality, onFrame, arrivalRef, onSimStep }: WorldProps): React.ReactElement {
  const { camera, gl } = useThree();
  const clock = useMemo(() => createClock(), []);
  const state = store.state;
  const ritual = state.ritual;
  const settings = state.render;
  const qualitySettings = QUALITY[quality];

  const targetRef = useRef(new THREE.Vector3(0, 0.32, 0));
  const lastStage = useRef<RitualStage>(ritual.stage);
  const shake = useRef(0);
  const seedNumber = useMemo(() => hashSeed(state.campsiteSeed), [state.campsiteSeed]);

  // Shadows are a quality-tier decision, applied once.
  useEffect(() => {
    gl.shadowMap.enabled = qualitySettings.enableShadows;
    gl.shadowMap.type = THREE.BasicShadowMap; // hard edges — crunchy, and cheap
  }, [gl, qualitySettings.enableShadows]);

  const marshmallowBagMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('canvas', { size: 64 }), roughness: 1 }),
    [settings],
  );

  useFrame((_, delta) => {
    const frameStart = typeof performance !== 'undefined' ? performance.now() : 0;

    // --- Simulation ------------------------------------------------------
    advance(clock, delta, (dt) => {
      if (ritual.stage === 'roasting') {
        const pose = roastControl.pose();
        ritual.roastInput.position.x = pose.position.x;
        ritual.roastInput.position.y = pose.position.y;
        ritual.roastInput.position.z = pose.position.z;
        if (state.accessibility.autoRotate <= 0) ritual.roastInput.rotation = pose.rotation;
      }
      stepRitual(ritual, dt);
      onSimStep?.(ritual);
    });

    if (ritual.stage !== lastStage.current) {
      lastStage.current = ritual.stage;
      store.setStageFromRitual();
    }

    // --- Camera ----------------------------------------------------------
    const pose = poseFor(ritual.stage, arrivalRef.current);
    const perspective = camera as THREE.PerspectiveCamera;
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

  const px = Math.cos(LAYOUT.playerBearing);
  const pz = Math.sin(LAYOUT.playerBearing);

  return (
    <>
      <Campsite
        seed={seedNumber}
        weather={ritual.weather}
        settings={settings}
        drawDistance={qualitySettings.drawDistance}
      />

      <Fire fire={ritual.fire} settings={settings} maxParticles={qualitySettings.maxParticles} />

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
        <RoastingStick marshmallow={ritual.marshmallow} settings={settings} bearing={LAYOUT.playerBearing} />
      )}

      {showAssembly && <AssemblyTable assembly={ritual.assembly} settings={settings} position={LAYOUT.assemblyTable} />}

      {showSandwichOnTray && ritual.sandwich && (
        <group position={machineToWorld([0, 0.395, 0.15])}>
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

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
