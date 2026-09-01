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
import { fireLightIntensity, fuelGrade, PIT, type FireState } from '@somemore/sim';
import { getTexture } from '../render/textures.js';
import { createPs1Material } from '../render/ps1.js';
import { createLogGeometry, createRockGeometry } from '../render/geometry.js';
import type { RenderSettings } from '../render/ps1.js';

const FLAME_COUNT = 22;
const EMBER_COUNT = 22;
const SPARK_COUNT = 30;
/**
 * How many pieces of fuel can be drawn at once.
 *
 * Higher than the fire wants, because the pit is now somewhere a player parks
 * wet wood to dry as well as somewhere they burn it, and an armful of kindling
 * is five pieces on its own.
 */
const LOG_SLOTS = 12;
const STEAM_COUNT = 14;

/** Half the length of the drawn log, for working out where its raised end is. */
const LOG_HALF_LENGTH = 0.2;

/** The height a dragged piece is carried at — a hand's width above the ash. */
const PIT_PLANE_Y = 0.07;

export interface FireProps {
  fire: FireState;
  settings: RenderSettings;
  maxParticles: number;
  /**
   * Working the bed with your hands, at the point you touched it.
   *
   * `inward` is how far the touch travelled toward the middle of the pit, in
   * metres: positive for a sweep that pulls ash over the coals, negative for
   * one that rakes it back off them, and about zero for a tap. Those are the
   * same two motions with the same tool, told apart the way they are told
   * apart in life — by which way you moved your hand.
   *
   * What each of them means is the caller's business, because it also depends
   * on what is in the player's other hand. The pit reports the gesture and
   * takes no view.
   */
  onWorkBed?: (work: { x: number; z: number; inward: number }) => void;
  /**
   * Arranging: dragging one piece of fuel across the pit.
   *
   * Position only. What the wood does when it gets there — lie flat, or ride
   * up on what is already in the pit — is the simulation's business, not the
   * renderer's, and certainly not a control the player has to find.
   */
  onMoveLog?: (logId: string, x: number, z: number) => void;
  /** Shared with the input layer so a drag on a log is not also a look. */
  grabbedRef?: React.MutableRefObject<string | null>;
  /**
   * Whether the player is close enough to put a hand in the pit.
   *
   * A function rather than a prop because it is read on a pointer event and
   * changes as the player walks: making it state would re-render the scene on
   * every step across the clearing. It has to gate the *grab* and not just the
   * effect — a press on a log two metres away that took hold of nothing still
   * swallowed the tap that was trying to walk the player over to it.
   */
  canTouch?: () => boolean;
}

export function Fire({
  fire,
  settings,
  maxParticles,
  onWorkBed,
  onMoveLog,
  grabbedRef,
  canTouch,
}: FireProps): React.ReactElement {
  const flamesRef = useRef<THREE.InstancedMesh>(null);
  const embersRef = useRef<THREE.InstancedMesh>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const emberLightRef = useRef<THREE.PointLight>(null);
  const logsRef = useRef<THREE.Group>(null);
  const steamRef = useRef<THREE.InstancedMesh>(null);
  const ashRef = useRef<THREE.Mesh>(null);
  /** The piece currently under a finger, if any. */
  const dragging = useRef<string | null>(null);
  /** Where a hand went into the ash, so a sweep can be told from a tap. */
  const sweep = useRef<{ radius: number; x: number; z: number } | null>(null);

  const flameCount = Math.min(FLAME_COUNT, Math.max(4, Math.floor(maxParticles / 12)));
  const emberCount = Math.min(EMBER_COUNT, Math.max(6, Math.floor(maxParticles / 8)));
  const sparkCount = Math.min(SPARK_COUNT, Math.max(8, Math.floor(maxParticles / 6)));
  const steamCount = Math.min(STEAM_COUNT, Math.max(4, Math.floor(maxParticles / 14)));

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
        map: getTexture('flame', { size: 48, seed: 'flame' }),
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

  /**
   * One material per slot, not one shared between them.
   *
   * Charring and the glow of a piece catching are written onto the material
   * every frame, so a single shared material meant the whole pit took whatever
   * the last log in the list happened to be — six logs, one appearance, and no
   * way to see that the piece you just laid on is not yet alight.
   */
  const logMaterials = useMemo(
    () =>
      Array.from({ length: LOG_SLOTS }, () =>
        createPs1Material({ map: getTexture('bark', { size: 64 }), settings, roughness: 1 }),
      ),
    [settings],
  );

  const stoneMaterial = useMemo(
    // Darkened: raw stone albedo next to a fire blows out to paper white.
    () => createPs1Material({ map: getTexture('stone', { size: 64 }), settings, color: 0x46433d, roughness: 1 }),
    [settings],
  );

  const steamGeometry = useMemo(() => new THREE.PlaneGeometry(0.2, 0.28), []);
  const steamMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: getTexture('steam', { size: 32, seed: 'steam' }),
        transparent: true,
        opacity: 0.55,
        /*
         * Additive, because instanced meshes can vary colour and not opacity.
         *
         * A wisp is faded here by darkening its instance colour, and under
         * normal blending that paints a *dark* smudge over the fire instead of
         * a fainter pale one. Steam off wet wood at the edge of a fire is lit
         * by the fire and is brighter than the night behind it, so adding it
         * is both the honest look and the one the instancing can express.
         */
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
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
      Array.from({ length: Math.max(flameCount, emberCount, sparkCount, steamCount) }, (_, i) => ({
        offset: (i * 2.399963229728653) % (Math.PI * 2),
        radius: 0.04 + ((i * 37) % 100) / 100 * 0.14,
        speed: 0.6 + ((i * 53) % 100) / 100 * 0.9,
        angle: ((i * 71) % 100) / 100 * Math.PI * 2,
      })),
    [flameCount, emberCount, sparkCount, steamCount],
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
    // Ash over the coals is a blanket, and it is opaque. A banked bed shows a
    // faint red in the cracks and nothing else, which is exactly why a player
    // arriving at one needs telling that there is anything alive in it.
    const buried = 1 - fire.ashCover * 0.92;
    const emberGlow = Math.min(1, fire.emberMass) * buried;

    // --- Flames -----------------------------------------------------------
    const flames = flamesRef.current;
    if (flames) {
      for (let i = 0; i < flameCount; i++) {
        const p = phases[i] ?? { offset: 0, radius: 0.1, speed: 1, angle: 0 };
        // Each flame tongue rises, shrinks and recycles.
        const life = (t * p.speed * (0.5 + intensity) + p.offset) % 1;
        /*
         * Tongues linger near the fuel and go out quickly once they leave it.
         *
         * A linear rise spread fourteen sprites evenly up a flame column more
         * than a metre tall, which from a kneeling position read as a handful
         * of separate little fires hanging in the air above the pit rather
         * than as one fire. Weighting the rise keeps most of them down in the
         * wood where a flame actually is, and the faster taper stops the last
         * one being a bright speck at head height.
         */
        const height = Math.pow(life, 1.5) * fire.flameHeight * 0.92;
        const shrink = Math.pow(Math.max(0, 1 - life), 0.85);
        const sway = Math.sin(t * 3 * flicker + p.offset) * 0.05 * (0.3 + fire.windSpeed * 0.2);
        const lean = fire.windSpeed * 0.06 * height;

        dummy.position.set(
          Math.cos(p.angle) * p.radius * (1 - life * 0.5) + sway + Math.cos(fire.windDirection) * lean,
          height + 0.02,
          Math.sin(p.angle) * p.radius * (1 - life * 0.5) + Math.sin(fire.windDirection) * lean,
        );
        const scale = shrink * (0.55 + intensity * 0.9) * (0.85 + Math.sin(t * 9 + p.offset) * 0.15 * flicker);
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

    // --- Ash ---------------------------------------------------------------
    const ash = ashRef.current;
    if (ash) {
      const material = ash.material as THREE.MeshStandardMaterial;
      // Grey and dead-looking when the fire is put away; scorched and dark
      // when it has been raked back off the coals.
      const grey = 0.29 + fire.ashCover * 0.34;
      material.color.setRGB(grey, grey * 0.96, grey * 0.88);
      ash.scale.setScalar(1 + fire.ashCover * 0.06);
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

    // --- Fuel --------------------------------------------------------------
    // Drawn where the simulation says it is. Until this existed, every log in
    // the pit was drawn at a fixed slot on a ring of six and the only thing a
    // player could learn about arranging a fire was that it made no difference.
    const logs = logsRef.current;
    let steamIndex = 0;
    if (logs) {
      logs.children.forEach((child, i) => {
        const log = fire.logs[i];
        child.visible = Boolean(log);
        if (!log) return;
        const mesh = child as THREE.Mesh;
        const grade = fuelGrade(log.grade);
        const spot = log.spot;

        // A leaned piece has its inner end up on the pile. The geometry runs
        // along local +X, and `spot.angle` already points that end inward as
        // the lean rises, so tilting about Z lifts the right end of it.
        const tilt = spot.lean * 0.62;
        mesh.position.set(
          spot.x,
          0.048 + Math.sin(tilt) * LOG_HALF_LENGTH * 0.9,
          spot.z,
        );
        mesh.rotation.set(0, spot.angle, tilt, 'YZX');

        // Thin fuel is thin. A handful of tinder should not read as a log.
        const girth = log.grade === 'log' ? 1 : log.grade === 'kindling' ? 0.42 : 0.26;
        const length = log.grade === 'log' ? 0.4 + log.mass * 0.6 : log.grade === 'kindling' ? 0.62 : 0.4;
        mesh.scale.set(length, girth, girth);

        const material = mesh.material as THREE.MeshStandardMaterial;
        // Fuel chars visibly as it burns, and thin fuel gets there far sooner.
        const charAmount = Math.min(1, log.burnedFor / (260 / grade.burns));
        material.color.setRGB(1 - charAmount * 0.78, 1 - charAmount * 0.84, 1 - charAmount * 0.88);
        material.emissive.setRGB(log.ignition * 0.25, log.ignition * 0.07, 0);

        // Steam off whatever is drying, so moisture is something you can see
        // rather than a number nobody is shown.
        if (log.steam > 0.06) {
          // Two wisps per piece, out of phase, so it reads as a plume coming
          // off the wood rather than as a single sprite blinking on and off.
          for (let w = 0; w < 2 && steamIndex < steamCount; w++) {
            const p = phases[steamIndex] ?? { offset: 0, radius: 0.1, speed: 1, angle: 0 };
            const life = (t * 0.42 * p.speed + p.offset) % 1;
            dummy.position.set(
              spot.x + Math.sin(t * 0.9 + p.offset) * 0.035 * (0.4 + life),
              0.09 + life * 0.4,
              spot.z + Math.cos(t * 0.7 + p.offset) * 0.035 * (0.4 + life),
            );
            dummy.quaternion.copy(state.camera.quaternion);
            dummy.scale.setScalar((0.6 + life * 1.1) * (0.45 + log.steam * 0.55));
            dummy.updateMatrix();
            steamRef.current?.setMatrixAt(steamIndex, dummy.matrix);
            const fade = log.steam * Math.pow(1 - life, 0.7) * 0.8;
            color.setRGB(fade, fade, fade * 0.97);
            steamRef.current?.setColorAt(steamIndex, color);
            steamIndex++;
          }
        }
      });
    }

    const steam = steamRef.current;
    if (steam) {
      // Park the unused wisps out of sight rather than leaving last frame's.
      for (let i = steamIndex; i < steamCount; i++) {
        dummy.position.set(0, -10, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        steam.setMatrixAt(i, dummy.matrix);
      }
      steam.instanceMatrix.needsUpdate = true;
      if (steam.instanceColor) steam.instanceColor.needsUpdate = true;
      steam.visible = steamIndex > 0;
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

      {/*
        The ash bed, and the two things a person does to one with their hands.

        You poke the coals by reaching into them, not by pressing a control
        labelled "rake" — and you bank the fire by sweeping the ash back over
        them, not by pressing one labelled "bank". Same hand, same tool, told
        apart by which way it moved: out to open the bed, in to bury it.
      */}
      <mesh
        ref={ashRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.005, 0]}
        receiveShadow
        onPointerDown={
          onWorkBed
            ? (event) => {
                // Out of reach this is a tap on a fire across the clearing,
                // which means "walk me over there" — so it has to be left
                // alone to bubble out to the movement layer.
                if (canTouch && !canTouch()) return;
                event.stopPropagation();
                sweep.current = {
                  radius: Math.hypot(event.point.x, event.point.z),
                  x: event.point.x,
                  z: event.point.z,
                };
                // Say the pit has the gesture, or a sweep across the coals
                // would turn the player's head at the same time.
                if (grabbedRef) grabbedRef.current = '__bed';
                try {
                  (event.target as Element | null)?.setPointerCapture(event.pointerId);
                } catch {
                  /* Older Safari. The sweep still works while over the bed. */
                }
              }
            : undefined
        }
        onPointerUp={
          onWorkBed
            ? (event) => {
                const started = sweep.current;
                sweep.current = null;
                if (grabbedRef) grabbedRef.current = null;
                try {
                  (event.target as Element | null)?.releasePointerCapture(event.pointerId);
                } catch {
                  /* Nothing to release. */
                }
                if (!started || (canTouch && !canTouch())) return;
                event.stopPropagation();
                const ended = Math.hypot(event.point.x, event.point.z);
                onWorkBed({ x: started.x, z: started.z, inward: started.radius - ended });
              }
            : undefined
        }
        onPointerOver={(event) => {
          if (!onWorkBed || (canTouch && !canTouch())) return;
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

      {/*
        Fuel.

        Twelve slots, each parked on the spot the simulation gives it, and each
        one draggable. Dragging is the arranging verb in full: there is no lean
        control, no stack menu and no button — you pick a piece of wood up and
        you put it somewhere else, and where you put it decides whether it
        breathes, whether it lights, and whether it dries.
      */}
      <group ref={logsRef}>
        {Array.from({ length: LOG_SLOTS }, (_, i) => (
          <mesh
            key={i}
            geometry={logGeometry}
            material={logMaterials[i]}
            castShadow
            onPointerDown={
              onMoveLog
                ? (event) => {
                    const log = fire.logs[i];
                    if (!log || (canTouch && !canTouch())) return;
                    event.stopPropagation();
                    dragging.current = log.id;
                    if (grabbedRef) grabbedRef.current = log.id;
                    // Without capture the drag dies the instant the pointer
                    // leaves a piece of wood five centimetres across, which on
                    // a phone is immediately.
                    try {
                      (event.target as Element | null)?.setPointerCapture(event.pointerId);
                    } catch {
                      /* Older Safari. The drag still works while over the log. */
                    }
                  }
                : undefined
            }
            onPointerMove={
              onMoveLog
                ? (event) => {
                    const log = fire.logs[i];
                    if (!log || dragging.current !== log.id) return;
                    // A pointer-up that landed somewhere this mesh never heard
                    // about would otherwise leave the wood stuck to the finger.
                    if (event.buttons === 0 && event.pointerType === 'mouse') {
                      dragging.current = null;
                      if (grabbedRef) grabbedRef.current = null;
                      return;
                    }
                    event.stopPropagation();
                    // The pit is the origin of the world and its floor is flat,
                    // so the drag target is wherever the ray crosses it.
                    const ray = event.ray;
                    if (Math.abs(ray.direction.y) < 1e-4) return;
                    const distance = (PIT_PLANE_Y - ray.origin.y) / ray.direction.y;
                    if (distance <= 0) return;
                    const x = ray.origin.x + ray.direction.x * distance;
                    const z = ray.origin.z + ray.direction.z * distance;
                    const r = Math.hypot(x, z);
                    // Let go of it outside the ring and it stays on the stones:
                    // the pit has no opinion about wood beyond them.
                    const scale = r > PIT.ringRadius ? PIT.ringRadius / r : 1;
                    onMoveLog(log.id, x * scale, z * scale);
                  }
                : undefined
            }
            onPointerUp={(event) => {
              if (dragging.current === null) return;
              dragging.current = null;
              if (grabbedRef) grabbedRef.current = null;
              try {
                (event.target as Element | null)?.releasePointerCapture(event.pointerId);
              } catch {
                /* Nothing to release. */
              }
            }}
            onPointerOver={(event) => {
              if (!onMoveLog || !fire.logs[i] || (canTouch && !canTouch())) return;
              event.stopPropagation();
              if (typeof document !== 'undefined') document.body.style.cursor = 'grab';
            }}
            onPointerOut={() => {
              if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
            }}
          />
        ))}
      </group>

      <instancedMesh ref={steamRef} args={[steamGeometry, steamMaterial, steamCount]} />

      <instancedMesh ref={embersRef} args={[emberGeometry, emberMaterial, emberCount]} />
      <instancedMesh ref={flamesRef} args={[flameGeometry, flameMaterial, flameCount]} />
      <points ref={sparksRef} geometry={sparkGeometry} material={sparkMaterial} />

      <pointLight ref={lightRef} position={[0, 0.35, 0]} distance={26} decay={1.35} castShadow={false} />
      <pointLight ref={emberLightRef} position={[0, 0.06, 0]} distance={5} decay={2} />
    </group>
  );
}
