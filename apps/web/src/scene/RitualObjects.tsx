/**
 * The objects the player handles: the marshmallow on its stick, the assembly
 * table, and the finished sandwich.
 *
 * The sandwich is the only object rendered at `hero` tier (ARCHITECTURE §4.2):
 * no jitter, no affine swim, larger textures, sheen and frost. The post-pass
 * dither and low-resolution target still apply, which is what keeps it part of
 * the world rather than pasted on top of it.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  STACK_ORDER,
  type AssemblyState,
  type BiteState,
  type ComponentKind,
  type MarshmallowState,
  type SandwichRecord,
} from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { createIceCreamTexture, getTexture } from '../render/textures.js';
import { buildSandwichGeometry, createMarshmallowMesh } from '../render/geometry.js';

// --- Marshmallow on a stick ------------------------------------------------

export interface RoastingStickProps {
  marshmallow: MarshmallowState;
  settings: RenderSettings;
  /** Direction the player is standing, radians around the fire. */
  bearing: number;
}

export function RoastingStick({ marshmallow, settings, bearing }: RoastingStickProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const flameRef = useRef<THREE.Points>(null);
  const flameLightRef = useRef<THREE.PointLight>(null);

  const mesh = useMemo(() => createMarshmallowMesh(marshmallow), [marshmallow]);
  useEffect(() => () => mesh.dispose(), [mesh]);

  const marshmallowMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('marshmallow', { size: 64 }),
        vertexColors: true,
        roughness: 0.78,
        flatShading: true,
      }),
    [settings],
  );

  const stickMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('bark', { size: 32 }), roughness: 1 }),
    [settings],
  );

  const flameCount = 16;
  const flameGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flameCount * 3), 3));
    return geometry;
  }, []);

  const flameMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xffa33a,
        size: 0.03,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useFrame((state) => {
    mesh.update(marshmallow);

    const group = groupRef.current;
    if (group) {
      const p = marshmallow.position;
      group.position.set(p.x, p.y, p.z);
      // The stick points back toward the player.
      group.rotation.set(0, -bearing, 0);
    }
    if (meshRef.current) {
      // Spins about its own axis (local Y), inside the group that lays it
      // along the stick.
      meshRef.current.rotation.y = marshmallow.rotation;
    }

    // Fire on the marshmallow: its own light source, which is what makes
    // igniting one feel like an event rather than a state flag.
    const burning = marshmallow.patches.reduce((total, p) => total + p.aflame, 0) / marshmallow.patches.length;
    const flame = flameRef.current;
    if (flame) {
      flameMaterial.opacity = Math.min(1, burning * 3.2);
      flame.visible = burning > 0.005;
      if (burning > 0.005) {
        const t = state.clock.elapsedTime;
        const positions = flameGeometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < flameCount; i++) {
          const phase = (t * 1.6 + i * 0.21) % 1;
          const angle = i * 2.399963229728653;
          const spread = 0.02 * (1 - phase);
          positions.setXYZ(
            i,
            Math.cos(angle) * spread,
            phase * 0.14,
            Math.sin(angle) * spread,
          );
        }
        positions.needsUpdate = true;
      }
    }
    if (flameLightRef.current) {
      flameLightRef.current.intensity = burning * 3.4 * settings.fireBrightness;
    }
  });

  return (
    <group ref={groupRef}>
      {/* The stick, running back toward the player's hand */}
      <mesh
        material={stickMaterial}
        position={[0, 0, 0.34]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      >
        <cylinderGeometry args={[0.007, 0.009, 0.68, 5]} />
      </mesh>

      {/* Two levels on purpose: the outer group lays the marshmallow along the
          stick, the inner mesh spins about its own axis. Combining both into
          one Euler makes the spin wobble off-axis. */}
      <group rotation={[0, 0, Math.PI / 2]}>
        <mesh ref={meshRef} geometry={mesh.geometry} material={marshmallowMaterial} castShadow />
        {/* A small warm light so the browning is legible even when the
            marshmallow is between the camera and the fire. */}
        <pointLight position={[0, 0, 0.06]} distance={0.4} decay={1.5} intensity={0.35} color={0xffd9a8} />
      </group>

      <points ref={flameRef} geometry={flameGeometry} material={flameMaterial} />
      <pointLight ref={flameLightRef} position={[0, 0.05, 0]} distance={2.2} decay={2} color={0xff9a3c} />
    </group>
  );
}

// --- Assembly --------------------------------------------------------------

export interface AssemblyTableProps {
  assembly: AssemblyState;
  settings: RenderSettings;
  position?: [number, number, number];
}

const COMPONENT_SIZE: Record<ComponentKind, [number, number, number]> = {
  'graham-bottom': [0.064, 0.007, 0.064],
  chocolate: [0.055, 0.004, 0.055],
  marshmallow: [0.05, 0.03, 0.05],
  'graham-top': [0.064, 0.007, 0.064],
};

export function AssemblyTable({ assembly, settings, position = [0, 0, 0] }: AssemblyTableProps): React.ReactElement {
  const heldRef = useRef<THREE.Group>(null);

  const materials = useMemo(
    () => ({
      graham: createPs1Material({ settings, map: getTexture('graham', { size: 64 }), roughness: 0.95 }),
      chocolate: createPs1Material({
        settings,
        map: getTexture('chocolate', { size: 64 }),
        roughness: 0.35,
        metalness: 0.05,
      }),
      marshmallow: createPs1Material({
        settings,
        map: getTexture('marshmallow', { size: 64 }),
        roughness: 0.8,
      }),
      plate: createPs1Material({ settings, map: getTexture('aluminium', { size: 64 }), roughness: 0.4, metalness: 0.6 }),
      stump: createPs1Material({ settings, map: getTexture('bark', { size: 64 }), roughness: 1 }),
    }),
    [settings],
  );

  const materialFor = (kind: ComponentKind) =>
    kind === 'chocolate' ? materials.chocolate : kind === 'marshmallow' ? materials.marshmallow : materials.graham;

  useFrame(() => {
    const held = heldRef.current;
    if (held) {
      held.visible = assembly.heldKind !== null;
      if (assembly.heldKind) {
        held.position.set(assembly.heldOffset.x, 0.02 + assembly.heldOffset.y, assembly.heldOffset.z);
        held.rotation.y = assembly.heldRotation;
      }
    }
  });

  // Stacking height for placed components.
  let stackY = 0.005;
  const placed = assembly.components.filter((c) => c.placed);

  return (
    <group position={position} name="assembly-table">
      {/* Stump table */}
      <mesh material={materials.stump} position={[0, -0.16, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.2, 0.22, 0.32, 9]} />
      </mesh>
      {/* Metal plate */}
      <mesh material={materials.plate} position={[0, 0, 0]} receiveShadow>
        <cylinderGeometry args={[0.11, 0.11, 0.006, 14]} />
      </mesh>

      {/* Placed layers */}
      {placed.map((component, i) => {
        const size = COMPONENT_SIZE[component.kind];
        const squishScale = 1 - component.squish * 0.45;
        const height = size[1] * squishScale;
        const y = stackY + height / 2;
        stackY += height;
        return (
          <mesh
            key={`${component.kind}-${i}`}
            material={materialFor(component.kind)}
            position={[component.offset.x, y, component.offset.z]}
            rotation={[component.tilt, component.rotation, component.tilt * 0.5]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[size[0] * (1 + component.squish * 0.12), height, size[2] * (1 + component.squish * 0.12)]} />
          </mesh>
        );
      })}

      {/* The component currently in hand */}
      <group ref={heldRef} visible={false}>
        {assembly.heldKind && (
          <mesh material={materialFor(assembly.heldKind)} castShadow>
            <boxGeometry args={COMPONENT_SIZE[assembly.heldKind]} />
          </mesh>
        )}
      </group>

      {/* The remaining ingredients, laid out beside the plate */}
      {STACK_ORDER.map((kind, i) => {
        const alreadyPlaced = placed.some((c) => c.kind === kind);
        const isHeld = assembly.heldKind === kind;
        if (alreadyPlaced || isHeld) return null;
        const size = COMPONENT_SIZE[kind];
        return (
          <mesh
            key={kind}
            material={materialFor(kind)}
            position={[0.16, 0.006 + i * 0.001, -0.075 + i * 0.05]}
            rotation={[0, i * 0.3, 0]}
            castShadow
          >
            <boxGeometry args={size} />
          </mesh>
        );
      })}
    </group>
  );
}

// --- The finished sandwich -------------------------------------------------

export interface SandwichProps {
  sandwich: SandwichRecord;
  bite: BiteState | null;
  settings: RenderSettings;
  position?: [number, number, number];
  /** Slow rotation for the hero inspection view. */
  spin?: number;
  onBite?: (position: number) => void;
}

export function Sandwich({ sandwich, bite, settings, position = [0, 0, 0], spin = 0, onBite }: SandwichProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const frostRef = useRef<THREE.Mesh>(null);

  // Rebuilt whenever a bite changes the geometry — the object really does get
  // smaller (spec deviation D3).
  const layers = useMemo(
    () => buildSandwichGeometry(sandwich, bite),
    // `bite.bites` changes on every bite; depths mutate in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sandwich, bite?.bites],
  );

  useEffect(() => () => layers.forEach((layer) => layer.geometry.dispose()), [layers]);

  const creamTexture = useMemo(
    () =>
      createIceCreamTexture({
        creamColor: sandwich.appearance.creamColor,
        swirlColor: sandwich.appearance.swirlColor,
        swirlStrength: sandwich.appearance.swirlStrength,
        fleckDensity: sandwich.appearance.fleckDensity,
        seed: sandwich.seed,
      }),
    [sandwich],
  );

  const materials = useMemo(() => {
    const a = sandwich.appearance;
    return {
      graham: createPs1Material({
        tier: 'hero',
        settings,
        map: getTexture('graham', { size: 256, seed: sandwich.seed }),
        // Darker than the ice cream on purpose: a baked cookie, not a wafer.
        // The contrast against the pale ice cream is what makes the object
        // read as an ice cream sandwich rather than a bread roll.
        color: 0x8a5a2c,
        roughness: 0.88,
      }),
      chocolate: createPs1Material({
        tier: 'hero',
        settings,
        map: getTexture('chocolate', { size: 256, seed: sandwich.seed }),
        color: 0x5a3520,
        // Chocolate sheen is the fidelity bump's signature.
        roughness: Math.max(0.08, 0.42 - a.sheen * 0.3),
        metalness: 0.12 + a.sheen * 0.14,
      }),
      cream: createPs1Material({
        tier: 'hero',
        settings,
        map: creamTexture,
        // Left bright: the ice cream is the lightest element and the one the
        // eye should land on first. High roughness because a specular hotspot
        // on ice cream reads as plastic and blows the colour out to grey.
        roughness: 0.86,
        metalness: 0,
      }),
    };
  }, [sandwich, settings, creamTexture]);

  const frostMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: getTexture('frost', { size: 128, seed: sandwich.seed }),
        transparent: true,
        opacity: sandwich.appearance.frost * 0.6,
        roughness: 0.2,
        depthWrite: false,
      }),
    [sandwich],
  );

  useFrame((state, delta) => {
    if (groupRef.current && spin !== 0) groupRef.current.rotation.y += spin * delta;
    if (frostRef.current) {
      // Frost sublimates slowly once it is out in the warm air.
      const material = frostRef.current.material as THREE.MeshStandardMaterial;
      material.opacity = Math.max(0, material.opacity - delta * 0.006);
    }
    void state;
  });

  const totalHeight = layers.reduce((t, l) => t + l.thickness, 0);

  const handleBite = (event: { stopPropagation: () => void; point: THREE.Vector3 }) => {
    if (!onBite || !groupRef.current) return;
    event.stopPropagation();
    // Which side was clicked becomes which side is bitten.
    const local = groupRef.current.worldToLocal(event.point.clone());
    const angle = Math.atan2(local.z, local.x);
    const normalised = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    onBite(Math.round((normalised / (Math.PI * 2)) * 8) % 8);
  };

  return (
    <group ref={groupRef} position={position} rotation={[0, 0, sandwich.appearance.lean]} name="sandwich">
      {layers.map((layer, i) => (
        <mesh
          key={i}
          geometry={layer.geometry}
          material={materials[layer.kind]}
          position={[layer.offsetX, layer.y, layer.offsetZ]}
          castShadow
          receiveShadow
          onClick={onBite ? handleBite : undefined}
        />
      ))}

      {/* Frost bloom over the whole object */}
      {sandwich.appearance.frost > 0.05 && (
        <mesh ref={frostRef} material={frostMaterial} position={[0, totalHeight / 2, 0]}>
          <boxGeometry args={[0.069, totalHeight + 0.002, 0.069]} />
        </mesh>
      )}

      {/* Local lighting is part of the fidelity bump (spec §2.1). Without it
          the sandwich reads as a dark silhouette against the fire, which is
          the one thing this object may never be. A warm key from the fire
          side, a cool fill from the other, and a soft top light that makes
          the frost and the chocolate sheen read. */}
      {/* A real key/fill/rim rather than three even lights: lighting an object
          evenly from all sides is what makes it read flat. */}
      <pointLight position={[0.17, 0.11, 0.15]} distance={0.8} decay={1.6} intensity={0.5} color={0xffd2a0} />
      <pointLight position={[-0.15, 0.02, -0.13]} distance={0.6} decay={2} intensity={0.11} color={0x9dc4e8} />
      <pointLight position={[-0.02, 0.21, -0.05]} distance={0.55} decay={1.9} intensity={0.26} color={0xfff4e4} />

      {/* Condensation beads catch the light — small, but it is what makes a
          cold object read as cold rather than merely pale. */}
      {sandwich.appearance.condensation > 0.2 && (
        <mesh position={[0, totalHeight / 2, 0]}>
          <boxGeometry args={[0.0705, totalHeight * 0.9, 0.0705]} />
          <meshStandardMaterial
            color={0xffffff}
            transparent
            opacity={sandwich.appearance.condensation * 0.12}
            roughness={0.05}
            metalness={0.3}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
