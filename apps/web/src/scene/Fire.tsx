/**
 * The campfire.
 *
 * Crunchy and PS1 on the surface, driven entirely by the simulation
 * underneath. Fire is one of the places the spec explicitly allows modern
 * rendering, so the flames are additive billboard sprites with animated
 * vertex colours rather than flat quads — but they are still quantised and
 * dithered by the post pass, which is what keeps them of this world.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { fireLightIntensity, type FireState } from '@somemore/sim';
import { getTexture } from '../render/textures.js';
import { createPs1Material } from '../render/ps1.js';
import { createLogGeometry, createRockGeometry } from '../render/geometry.js';
import type { RenderSettings } from '../render/ps1.js';

const FLAME_COUNT = 14;
const EMBER_COUNT = 22;
const SPARK_COUNT = 30;

export interface FireProps {
  fire: FireState;
  settings: RenderSettings;
  maxParticles: number;
  /** Raking the coals — reached by touching the bed itself. */
  onRake?: () => void;
}

export function Fire({ fire, settings, maxParticles, onRake }: FireProps): React.ReactElement {
  const flamesRef = useRef<THREE.InstancedMesh>(null);
  const embersRef = useRef<THREE.InstancedMesh>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const emberLightRef = useRef<THREE.PointLight>(null);
  const logsRef = useRef<THREE.Group>(null);

  const flameCount = Math.min(FLAME_COUNT, Math.max(4, Math.floor(maxParticles / 12)));
  const emberCount = Math.min(EMBER_COUNT, Math.max(6, Math.floor(maxParticles / 8)));
  const sparkCount = Math.min(SPARK_COUNT, Math.max(8, Math.floor(maxParticles / 6)));

  const flameGeometry = useMemo(() => new THREE.PlaneGeometry(0.22, 0.34), []);
  // Flattened: coals are a bed, not a pile of marbles.
  const emberGeometry = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(0.021, 0);
    geometry.scale(1, 0.45, 1);
    return geometry;
  }, []);
  const logGeometry = useMemo(() => createLogGeometry(0.4, 0.048), []);

  const flameMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: getTexture('ember', { size: 32, seed: 'flame' }),
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const emberMaterial = useMemo(
    () => createPs1Material({ map: getTexture('ember', { size: 32 }), settings, emissive: 0xff5a12, emissiveIntensity: 1.6 }),
    [settings],
  );

  const logMaterial = useMemo(
    () => createPs1Material({ map: getTexture('bark', { size: 64 }), settings, roughness: 1 }),
    [settings],
  );

  const stoneMaterial = useMemo(
    // Darkened: raw stone albedo next to a fire blows out to paper white.
    () => createPs1Material({ map: getTexture('stone', { size: 64 }), settings, color: 0x46433d, roughness: 1 }),
    [settings],
  );

  const sparkGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3));
    return geometry;
  }, [sparkCount]);

  const sparkMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xffb257,
        size: 0.022,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  // Per-particle phase offsets, stable across frames.
  const phases = useMemo(
    () =>
      Array.from({ length: Math.max(flameCount, emberCount, sparkCount) }, (_, i) => ({
        offset: (i * 2.399963229728653) % (Math.PI * 2),
        radius: 0.04 + ((i * 37) % 100) / 100 * 0.14,
        speed: 0.6 + ((i * 53) % 100) / 100 * 0.9,
        angle: ((i * 71) % 100) / 100 * Math.PI * 2,
      })),
    [flameCount, emberCount, sparkCount],
  );

  const ringStones = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => {
        const angle = (i / 9) * Math.PI * 2;
        const geometry = createRockGeometry(1000 + i, 0.088);
        // Fire-ring stones sit low and rounded; tall spiky ones read as paper.
        geometry.scale(1, 0.62, 1);
        return {
          geometry,
          x: Math.cos(angle) * 0.4,
          z: Math.sin(angle) * 0.4,
          rotation: angle,
        };
      }),
    [],
  );

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const flicker = settings.flicker;
    const brightness = settings.fireBrightness;
    const intensity = fire.flame;
    const emberGlow = Math.min(1, fire.emberMass);

    // --- Flames -----------------------------------------------------------
    const flames = flamesRef.current;
    if (flames) {
      for (let i = 0; i < flameCount; i++) {
        const p = phases[i] ?? { offset: 0, radius: 0.1, speed: 1, angle: 0 };
        // Each flame tongue rises, shrinks and recycles.
        const life = ((t * p.speed * (0.5 + intensity) + p.offset) % 1);
        const height = life * fire.flameHeight * 1.15;
        const shrink = Math.max(0, 1 - life);
        const sway = Math.sin(t * 3 * flicker + p.offset) * 0.05 * (0.3 + fire.windSpeed * 0.2);
        const lean = fire.windSpeed * 0.06 * height;

        dummy.position.set(
          Math.cos(p.angle) * p.radius * (1 - life * 0.5) + sway + Math.cos(fire.windDirection) * lean,
          height + 0.02,
          Math.sin(p.angle) * p.radius * (1 - life * 0.5) + Math.sin(fire.windDirection) * lean,
        );
        const scale = shrink * (0.45 + intensity * 0.85) * (0.85 + Math.sin(t * 9 + p.offset) * 0.15 * flicker);
        dummy.scale.setScalar(Math.max(0.001, scale));
        // Billboard toward the camera.
        dummy.quaternion.copy(state.camera.quaternion);
        dummy.updateMatrix();
        flames.setMatrixAt(i, dummy.matrix);

        // Hot yellow at the base, deep orange at the tip.
        const heat = (1 - life) * intensity * brightness;
        color.setRGB(1 * heat, (0.45 + (1 - life) * 0.35) * heat, 0.12 * heat);
        flames.setColorAt(i, color);
      }
      flames.instanceMatrix.needsUpdate = true;
      if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
      flames.visible = intensity > 0.02;
    }

    // --- Ember bed --------------------------------------------------------
    const embers = embersRef.current;
    if (embers) {
      for (let i = 0; i < emberCount; i++) {
        const p = phases[i] ?? { offset: 0, radius: 0.1, speed: 1, angle: 0 };
        const r = p.radius * 1.9;
        dummy.position.set(Math.cos(p.angle) * r * 0.85, 0.012, Math.sin(p.angle) * r * 0.85);
        dummy.rotation.set(0, p.angle, 0);
        dummy.scale.setScalar(0.75 + emberGlow * 0.5);
        dummy.updateMatrix();
        embers.setMatrixAt(i, dummy.matrix);

        // Coals pulse slowly and independently — the bed is never uniform.
        const pulse = 0.55 + Math.sin(t * 1.4 * flicker + p.offset * 3) * 0.25;
        const glow = emberGlow * pulse * brightness;
        color.setRGB(glow * 1.1, glow * 0.32, glow * 0.06);
        embers.setColorAt(i, color);
      }
      embers.instanceMatrix.needsUpdate = true;
      if (embers.instanceColor) embers.instanceColor.needsUpdate = true;
      embers.visible = emberGlow > 0.01;
    }

    // --- Sparks -----------------------------------------------------------
    const sparks = sparksRef.current;
    if (sparks) {
      const positions = sparkGeometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < sparkCount; i++) {
        const p = phases[i] ?? { offset: 0, radius: 0.1, speed: 1, angle: 0 };
        const life = (t * p.speed * 0.35 + p.offset) % 1;
        const rise = life * (1.4 + fire.flame * 1.2);
        const drift = life * fire.windSpeed * 0.35;
        positions.setXYZ(
          i,
          Math.cos(p.angle) * p.radius * (1 + life) + Math.cos(fire.windDirection) * drift,
          0.1 + rise,
          Math.sin(p.angle) * p.radius * (1 + life) + Math.sin(fire.windDirection) * drift,
        );
      }
      positions.needsUpdate = true;
      sparkMaterial.opacity = 0.75 * intensity * brightness;
      sparks.visible = intensity > 0.08;
    }

    // --- Light ------------------------------------------------------------
    // One dynamic light for flame plus one low warm light for the coals: the
    // budget allows few dynamic lights, and these two carry the whole scene.
    const light = lightRef.current;
    if (light) {
      const base = fireLightIntensity(fire) * 11 * brightness;
      const jitter = 1 + Math.sin(t * 11) * 0.06 * flicker + Math.sin(t * 23.3) * 0.035 * flicker;
      light.intensity = base * jitter;
      light.position.y = 0.28 + fire.flameHeight * 0.35;
      light.color.setRGB(1, 0.52 + intensity * 0.16, 0.2);
    }
    const emberLight = emberLightRef.current;
    if (emberLight) {
      emberLight.intensity = emberGlow * 3.2 * brightness;
      emberLight.color.setRGB(1, 0.3, 0.08);
    }

    // --- Logs -------------------------------------------------------------
    const logs = logsRef.current;
    if (logs) {
      logs.children.forEach((child, i) => {
        const log = fire.logs[i];
        child.visible = Boolean(log);
        if (log) {
          const mesh = child as THREE.Mesh;
          mesh.scale.set(0.4 + log.mass * 0.6, 1, 1);
          // Logs char visibly as they burn.
          const material = mesh.material as THREE.MeshStandardMaterial;
          const charAmount = Math.min(1, log.burnedFor / 260);
          material.color.setRGB(1 - charAmount * 0.78, 1 - charAmount * 0.84, 1 - charAmount * 0.88);
          material.emissive.setRGB(log.ignition * 0.25, log.ignition * 0.07, 0);
        }
      });
    }
  });

  return (
    <group>
      {/* Stone ring */}
      {ringStones.map((stone, i) => (
        <mesh
          key={i}
          geometry={stone.geometry}
          material={stoneMaterial}
          position={[stone.x, 0.04, stone.z]}
          rotation={[0, stone.rotation, 0]}
          castShadow
          receiveShadow
        />
      ))}

      {/* Ash bed. Also the rake target: you poke the coals by reaching into
          them, not by pressing a control labelled "rake". */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.005, 0]}
        receiveShadow
        onClick={
          onRake
            ? (event) => {
                event.stopPropagation();
                onRake();
              }
            : undefined
        }
        onPointerOver={(event) => {
          if (!onRake) return;
          event.stopPropagation();
          if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
        }}
      >
        <circleGeometry args={[0.42, 12]} />
        {/* Tinted well down: raw ash albedo this close to the fire light
            blows out to white paper and swallows the coals. */}
        <meshStandardMaterial map={getTexture('ash', { size: 64 })} color={0x4a453e} roughness={1} />
      </mesh>

      {/* Fuel */}
      <group ref={logsRef}>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh
            key={i}
            geometry={logGeometry}
            material={logMaterial}
            position={[Math.cos((i / 6) * Math.PI * 2) * 0.09, 0.055 + (i % 2) * 0.035, Math.sin((i / 6) * Math.PI * 2) * 0.09]}
            rotation={[0, (i / 6) * Math.PI * 2 + 0.4, (i % 2) * 0.12]}
            castShadow
          />
        ))}
      </group>

      <instancedMesh ref={embersRef} args={[emberGeometry, emberMaterial, emberCount]} />
      <instancedMesh ref={flamesRef} args={[flameGeometry, flameMaterial, flameCount]} />
      <points ref={sparksRef} geometry={sparkGeometry} material={sparkMaterial} />

      <pointLight ref={lightRef} position={[0, 0.35, 0]} distance={26} decay={1.35} castShadow={false} />
      <pointLight ref={emberLightRef} position={[0, 0.06, 0]} distance={5} decay={2} />
    </group>
  );
}
