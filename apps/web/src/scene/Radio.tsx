/**
 * The camp radio.
 *
 * A scuffed portable receiver on the log by the fire: pressed-steel case,
 * perforated speaker grille, a telescopic aerial that leans, and a lit dial
 * that is the only warm thing in the object. It is `ps1Plus` rather than
 * `ps1` for the same reason the SM-01 is — it is a machine you operate, and
 * an operable machine has to read cleanly at arm's length.
 *
 * Nothing here is a UI. The needle moves because the dial is turned, the
 * scale lights because the set is on, and the aerial's angle is the campsite's
 * own — a seed-derived quirk, like the SM-01's stickers.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { hashString, hashToUnit, type RadioState } from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';

/** Case dimensions, metres. A 1970s portable, roughly. */
const CASE = { width: 0.19, height: 0.115, depth: 0.055 };

export interface RadioProps {
  radio: RadioState;
  settings: RenderSettings;
  campsiteSeed: string;
  position: readonly [number, number, number];
  /** Radians. Whichever way it happens to have been left facing. */
  rotationY?: number;
}

export function Radio({
  radio,
  settings,
  campsiteSeed,
  position,
  rotationY = 0,
}: RadioProps): React.ReactElement {
  const needleRef = useRef<THREE.Mesh>(null);
  const scaleLightRef = useRef<THREE.Mesh>(null);
  const dialKnobRef = useRef<THREE.Mesh>(null);
  const scaleMaterialRef = useRef<THREE.MeshBasicMaterial>(null);

  // The aerial's lean and the case's wear are this campsite's, not generic.
  const quirk = useMemo(() => {
    const seed = hashString(`radio:${campsiteSeed}`);
    return {
      aerialLean: (hashToUnit(seed, 1) - 0.5) * 0.5,
      aerialExtension: 0.42 + hashToUnit(seed, 2) * 0.34,
      wear: hashToUnit(seed, 3),
    };
  }, [campsiteSeed]);

  const caseMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        tier: 'ps1Plus',
        map: getTexture('smokedPlastic', { size: 64 }),
        roughness: 0.55 + quirk.wear * 0.3,
        metalness: 0.12,
      }),
    [settings, quirk.wear],
  );

  const grilleMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        tier: 'ps1Plus',
        map: getTexture('aluminium', { size: 64 }),
        roughness: 0.42,
        metalness: 0.7,
      }),
    [settings],
  );

  // The dial scale is drawn once, as a real printed face with real numbers.
  // Redrawn when the band changes: a set's face shows one band at a time.
  const scaleTexture = useMemo(() => createDialFace(radio), [radio, radio.band]);
  useEffect(() => () => scaleTexture.dispose(), [scaleTexture]);

  useFrame(() => {
    const plan = radio.bands[radio.band];
    const span = Math.max(1e-6, plan.max - plan.min);
    const t = clampUnit((radio.dial + radio.drift - plan.min) / span);

    if (needleRef.current) {
      // The needle travels the printed width of the scale, and only that.
      needleRef.current.position.x = (t - 0.5) * CASE.width * 0.62;
    }
    if (dialKnobRef.current) {
      // Three and a bit turns end to end, the way a real tuning capacitor is
      // geared: fine control is what makes finding a weak station feel earned.
      dialKnobRef.current.rotation.x = t * Math.PI * 6.4;
    }
    const material = scaleMaterialRef.current;
    if (material) {
      // The scale lamp is dim, warm and slightly unsteady — one small bulb.
      const flicker = 0.94 + Math.sin(radio.elapsed * 7.3) * 0.03 + Math.sin(radio.elapsed * 2.1) * 0.03;
      material.opacity = radio.on ? 0.85 * flicker : 0.06;
    }
    if (scaleLightRef.current) scaleLightRef.current.visible = radio.on;
  });

  return (
    <group position={position as unknown as THREE.Vector3Tuple} rotation={[0, rotationY, 0]} name="radio">
      {/* Case */}
      <mesh castShadow receiveShadow material={caseMaterial}>
        <boxGeometry args={[CASE.width, CASE.height, CASE.depth]} />
      </mesh>

      {/* Speaker grille, front left */}
      <mesh position={[-CASE.width * 0.26, 0, CASE.depth / 2 + 0.001]} material={grilleMaterial}>
        <boxGeometry args={[CASE.width * 0.4, CASE.height * 0.66, 0.002]} />
      </mesh>

      {/* Dial face, front right — the lit part */}
      <mesh ref={scaleLightRef} position={[CASE.width * 0.2, CASE.height * 0.12, CASE.depth / 2 + 0.002]}>
        <planeGeometry args={[CASE.width * 0.46, CASE.height * 0.36]} />
        <meshBasicMaterial
          ref={scaleMaterialRef}
          map={scaleTexture}
          transparent
          opacity={0.85}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* The needle */}
      <mesh
        ref={needleRef}
        position={[CASE.width * 0.2, CASE.height * 0.12, CASE.depth / 2 + 0.004]}
      >
        <planeGeometry args={[0.0016, CASE.height * 0.34]} />
        <meshBasicMaterial color={0xff5a3c} toneMapped={false} />
      </mesh>

      {/* Tuning knob, right-hand end */}
      <mesh
        ref={dialKnobRef}
        position={[CASE.width / 2 + 0.008, 0, 0]}
        rotation={[0, 0, Math.PI / 2]}
        material={caseMaterial}
      >
        <cylinderGeometry args={[0.017, 0.017, 0.016, 10]} />
      </mesh>

      {/* Volume knob, below it */}
      <mesh
        position={[CASE.width / 2 + 0.008, -CASE.height * 0.3, 0]}
        rotation={[0, 0, Math.PI / 2]}
        material={caseMaterial}
      >
        <cylinderGeometry args={[0.012, 0.012, 0.014, 8]} />
      </mesh>

      {/* Telescopic aerial, leaning the way this campsite's does */}
      <mesh
        position={[-CASE.width * 0.42, CASE.height / 2 + quirk.aerialExtension / 2, -CASE.depth * 0.3]}
        rotation={[0.06, 0, quirk.aerialLean]}
        material={grilleMaterial}
      >
        <cylinderGeometry args={[0.0016, 0.0028, quirk.aerialExtension, 5]} />
      </mesh>
    </group>
  );
}

/**
 * Draws the printed dial face.
 *
 * Real numbers, real ticks, and the station names actually printed on it —
 * the way a set from 1974 has three local stations screened onto the glass and
 * everything else is bare scale. Which is exactly the feeling wanted: the
 * campsite's stations are named here, the strange ones are not.
 */
function createDialFace(radio: RadioState): THREE.CanvasTexture {
  const width = 256;
  const height = 96;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.fillStyle = '#f0d79a';
  ctx.fillRect(0, 0, width, height);

  const plan = radio.bands[radio.band];
  const span = Math.max(1e-6, plan.max - plan.min);

  ctx.strokeStyle = '#3a2a16';
  ctx.fillStyle = '#3a2a16';
  ctx.lineWidth = 2;
  const ticks = 22;
  for (let i = 0; i <= ticks; i++) {
    const x = 8 + ((width - 16) * i) / ticks;
    const major = i % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(x, height * 0.42);
    ctx.lineTo(x, height * 0.42 + (major ? 16 : 8));
    ctx.stroke();
    if (major) {
      const value = plan.min + (span * i) / ticks;
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(value.toFixed(radio.band === 'fm' ? 1 : 0), x, height * 0.36);
    }
  }

  // Station names, printed only for the ones a set would have been marked for.
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  for (const station of radio.profile.stations) {
    if (station.band !== radio.band) continue;
    if (station.reception < 0.45) continue; // faint ones were never printed
    const x = 8 + ((width - 16) * (station.dial - plan.min)) / span;
    if (x < 0 || x > width) continue;
    ctx.fillStyle = '#7a2318';
    ctx.fillText(station.name.slice(0, 10).toUpperCase(), x, height * 0.9);
  }

  ctx.fillStyle = '#3a2a16';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(radio.band.toUpperCase(), 8, height * 0.2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
