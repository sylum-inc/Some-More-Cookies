/**
 * The water's edge.
 *
 * Everything to do with the water lives here, because at a campsite everything
 * to do with the water lives in one place: the surface, the rings a thing
 * makes when it touches it, the stones lying about to throw, the one in the
 * air, and the rod somebody left leaning on a log.
 *
 * Rendered only where the environment manifest actually has water — several
 * campsites are a salt flat, a mesa or a rail siding, and at those this
 * component returns nothing at all rather than an empty pond.
 *
 * Draw calls are the constraint here (ARCHITECTURE §10 budgets 120 and the
 * arrival frame is already at the ceiling), so the loose stones and the
 * ripples are each one `InstancedMesh` rather than one object apiece, and the
 * rod, the line and the float only exist while the rod is in somebody's hands.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  clamp01,
  ripplePresence,
  terrainHeight,
  waveHeight,
  type RitualState,
  type WalkableWorld,
  type WaterState,
} from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';

/** How far out the surface is drawn. Fog closes it long before this. */
const SURFACE_M = 70;
/** Grid resolution of the surface. Coarse, because PS1 water was coarse. */
const SURFACE_SEGMENTS = 28;
/** Ripple rings drawn at once. Matches the model's own bound. */
const RIPPLE_POOL = 12;
/** Loose stones drawn on the shingle. */
const STONE_POOL = 5;

export interface ShoreProps {
  ritual: RitualState;
  settings: RenderSettings;
  walkable: WalkableWorld;
  /** Water tint from the environment's night palette, if it has one. */
  waterColour?: string | null;
  /** The stones or the rod, tapped. Gated by reach in the world, not here. */
  onTouch?: (id: 'stones' | 'rod') => void;
}

export function Shore({ ritual, settings, walkable, waterColour, onTouch }: ShoreProps): React.ReactElement | null {
  const water = ritual.water;

  const surfaceRef = useRef<THREE.Mesh>(null);
  const rippleRef = useRef<THREE.InstancedMesh>(null);
  const stoneRef = useRef<THREE.InstancedMesh>(null);
  const flyingRef = useRef<THREE.Mesh>(null);
  const floatRef = useRef<THREE.Mesh>(null);
  const lineRef = useRef<THREE.LineSegments>(null);
  const rodRef = useRef<THREE.Group>(null);

  /**
   * The surface material.
   *
   * Self-lit, and that is not a shortcut. There is no light out at the shore —
   * the fire is eight metres away and falls off — so a purely lit surface
   * rendered as pure black, which at 5-bit quantisation means *nothing at
   * all*, not "very dark" (ARCHITECTURE §4.1). It was screenshotted looking
   * exactly like a missing mesh.
   *
   * A lake at night is also, in fact, the brightest thing in a landscape,
   * because it is a mirror pointed at the sky. So the emissive term is the sky
   * it is reflecting, driven per frame by the stargazing model's own moon and
   * starlight — which is why an overcast night dims the water and a full moon
   * lights it up.
   */
  const surfaceMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('water', { size: 64, seed: water ? water.seed : 1 }),
        color: waterColour ?? '#16242c',
        emissive: waterColour ?? '#243a4a',
        emissiveIntensity: 1,
        roughness: 0.24,
        metalness: 0.3,
        transparent: true,
        opacity: 0.96,
        flatShading: true,
      }),
    [settings, water, waterColour],
  );

  const shingleMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('stone', { size: 64 }), roughness: 1 }),
    [settings],
  );

  /**
   * The surface mesh.
   *
   * A plane centred out past the shore line, displaced per frame from the
   * simulation's own `waveHeight`. The displacement is what makes chop
   * *visible*: a mirror and a blown lake have to look different, because the
   * whole of stone skipping turns on the difference.
   */
  const surfaceGeometry = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(SURFACE_M, SURFACE_M, SURFACE_SEGMENTS, SURFACE_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }, []);
  useEffect(() => () => surfaceGeometry.dispose(), [surfaceGeometry]);

  const rippleGeometry = useMemo(() => new THREE.RingGeometry(0.85, 1, 14), []);
  useEffect(() => () => rippleGeometry.dispose(), [rippleGeometry]);
  const rippleMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  const stoneGeometry = useMemo(() => new THREE.DodecahedronGeometry(0.05, 0), []);
  useEffect(() => () => stoneGeometry.dispose(), [stoneGeometry]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const rippleColour = useMemo(() => new THREE.Color(), []);

  /** Where the shore is, in world space. */
  const shore = useMemo(() => {
    if (!water) return null;
    const cos = Math.cos(water.shore.bearing);
    const sin = Math.sin(water.shore.bearing);
    return {
      cos,
      sin,
      x: cos * water.shore.distanceM,
      z: sin * water.shore.distanceM,
      surfaceY: water.shore.surfaceY,
    };
  }, [water]);

  // The loose stones are laid out once: the same handful on every visit, in
  // the same places, because that is what a shore is.
  useEffect(() => {
    const mesh = stoneRef.current;
    if (!mesh || !water || !shore) return;
    for (let i = 0; i < STONE_POOL; i++) {
      const spread = (i - (STONE_POOL - 1) / 2) * 0.34;
      const x = shore.x - shore.sin * spread - shore.cos * 0.55;
      const z = shore.z + shore.cos * spread - shore.sin * 0.55;
      dummy.position.set(x, terrainHeight(x, z, walkable.seed, walkable.amplitude, walkable.basin) + 0.03, z);
      dummy.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      dummy.scale.setScalar(0.8 + (i % 3) * 0.22);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [water, shore, walkable, dummy]);

  useFrame(() => {
    if (!water || !shore) return;

    // --- How much sky is there to reflect ----------------------------------
    // Moonlight plus starlight, cut by cloud. A mirror shows what is above it.
    const sky = ritual.stargazing.sky;
    const clear = 1 - clamp01(ritual.weather.cloudCover) * 0.82;
    const moon = sky.moon.visible ? sky.moon.illumination * Math.max(0, Math.sin(sky.moon.altitude)) : 0;
    // The floor is the same dark-adaptation floor the moonlight rig uses: a
    // person who has been sitting by a fire can see the water, and a surface
    // that renders as literal black is a defect rather than a dark night.
    const reflected = 0.55 + (moon * 1.5 + sky.starVisibility * 0.5) * clear;
    // Chop breaks the reflection up, so a blown lake is duller than a mirror.
    surfaceMaterial.emissiveIntensity = reflected * (1 - water.chop * 0.45);

    // --- Surface ----------------------------------------------------------
    const surface = surfaceRef.current;
    if (surface) {
      surface.position.set(
        shore.cos * (water.shore.distanceM + SURFACE_M / 2 - 1.5),
        shore.surfaceY,
        shore.sin * (water.shore.distanceM + SURFACE_M / 2 - 1.5),
      );
      const position = surfaceGeometry.getAttribute('position') as THREE.BufferAttribute;
      const worldX = surface.position.x;
      const worldZ = surface.position.z;
      for (let i = 0; i < position.count; i++) {
        position.setY(i, waveAt(water, worldX + position.getX(i), worldZ + position.getZ(i)));
      }
      position.needsUpdate = true;
      surfaceGeometry.computeVertexNormals();
    }

    // --- Rings ------------------------------------------------------------
    const ripples = rippleRef.current;
    if (ripples) {
      let used = 0;
      for (const ripple of water.ripples) {
        if (used >= RIPPLE_POOL) break;
        const presence = ripplePresence(ripple);
        if (presence <= 0.01) continue;
        // A ring spreads and fades. Both follow the age, so one number does.
        const radius = 0.25 + ripple.age * 1.35;
        // Riding the surface, not sunk into it: at any real chop the wavelets
        // are taller than a fixed offset and cut the rings into arcs.
        dummy.position.set(
          ripple.x,
          shore.surfaceY + waveAt(water, ripple.x, ripple.z) + 0.035,
          ripple.z,
        );
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        ripples.setMatrixAt(used, dummy.matrix);
        // Instanced meshes cannot vary opacity per instance, so the fade is
        // done in colour: the ring dims toward the water it is sitting on.
        rippleColour.setRGB(presence * 0.75, presence * 0.84, presence * 0.9);
        ripples.setColorAt(used, rippleColour);
        used++;
      }
      // Anything unused is scaled to nothing rather than left where it was.
      for (let i = used; i < RIPPLE_POOL; i++) {
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        ripples.setMatrixAt(i, dummy.matrix);
      }
      ripples.instanceMatrix.needsUpdate = true;
      if (ripples.instanceColor) ripples.instanceColor.needsUpdate = true;
      ripples.count = RIPPLE_POOL;
      ripples.visible = used > 0;
    }

    // --- The stone in the air --------------------------------------------
    const flying = flyingRef.current;
    if (flying) {
      const skipping = ritual.skipping;
      flying.visible = skipping.phase === 'flying';
      if (flying.visible) {
        flying.position.set(skipping.position.x, skipping.position.y, skipping.position.z);
        // Spin is visible, and it is the thing a player is trying to produce.
        flying.rotation.y += skipping.spin * 0.016;
        flying.rotation.z = skipping.tilt;
      }
    }

    // --- The rod, the line and the float ----------------------------------
    const fishing = ritual.fishing;
    const out = fishing.phase !== 'stowed' && fishing.phase !== 'ready';
    const rod = rodRef.current;
    if (rod) {
      // Always there, whether or not anybody has picked it up: a rod leaning
      // on the bank is how you know there is fishing here at all.
      rod.visible = water.spec.fishable;
      if (rod.visible) {
        const x = shore.x - shore.cos * 0.35;
        const z = shore.z - shore.sin * 0.35;
        rod.position.set(x, terrainHeight(x, z, walkable.seed, walkable.amplitude, walkable.basin), z);
        rod.rotation.y = -water.shore.bearing;
      }
    }
    const bobber = floatRef.current;
    if (bobber) {
      bobber.visible = out;
      if (bobber.visible) {
        // The float rides the surface, and dips when something is interested.
        const dip = fishing.bob * 0.09;
        bobber.position.set(
          fishing.floatX,
          shore.surfaceY + waveAt(water, fishing.floatX, fishing.floatZ) + 0.05 - dip,
          fishing.floatZ,
        );
      }
    }
    const line = lineRef.current;
    if (line && bobber) {
      line.visible = out;
      if (line.visible && rod) {
        const geometry = line.geometry as THREE.BufferGeometry;
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;
        position.setXYZ(0, rod.position.x, rod.position.y + 1.35, rod.position.z);
        position.setXYZ(1, bobber.position.x, bobber.position.y, bobber.position.z);
        position.needsUpdate = true;
        geometry.computeBoundingSphere();
      }
    }
  });

  if (!water || !shore) return null;

  return (
    <group name="shore">
      <mesh ref={surfaceRef} geometry={surfaceGeometry} material={surfaceMaterial} receiveShadow />

      <instancedMesh
        ref={rippleRef}
        args={[rippleGeometry, rippleMaterial, RIPPLE_POOL]}
        frustumCulled={false}
      />

      {/* The stones on the shingle. Picking one up is a matter of reaching
          down at the water's edge, not of choosing from a list. */}
      <instancedMesh
        onClick={(event) => {
          event.stopPropagation();
          onTouch?.('stones');
        }}
        
        ref={stoneRef}
        args={[stoneGeometry, shingleMaterial, STONE_POOL]}
        castShadow
      />

      {/* The one in the air */}
      <mesh ref={flyingRef} geometry={stoneGeometry} material={shingleMaterial} visible={false} />

      {/* The rod, leaning where somebody left it */}
      <group ref={rodRef}>
        <mesh
          position={[0, 0.78, 0]}
          rotation={[0.36, 0, 0]}
          material={shingleMaterial}
          onClick={(event) => {
            event.stopPropagation();
            onTouch?.('rod');
          }}
        >
          <cylinderGeometry args={[0.006, 0.013, 1.7, 5]} />
        </mesh>
      </group>

      <mesh ref={floatRef} visible={false}>
        <sphereGeometry args={[0.045, 6, 5]} />
        <meshBasicMaterial color={0xd8452c} toneMapped={false} />
      </mesh>

      {/* The line. One segment, rod tip to float, rewritten each frame. */}
      <lineSegments ref={lineRef} visible={false} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(6), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={0xdfe6ea} transparent opacity={0.5} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/**
 * Surface height at a world point.
 *
 * The simulation's own function, not a decorative one, so the wavelet a stone
 * bounces off is the wavelet the player can see — the same discipline that
 * makes the terrain analytic.
 */
function waveAt(water: WaterState, x: number, z: number): number {
  return waveHeight(water, x, z);
}
