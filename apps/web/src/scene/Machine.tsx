/**
 * The Some More SM-01 transformation freezer (spec §3).
 *
 * Late-1990s industrial refrigeration, early-Y2K technology, restrained
 * functional minimalism. Silver aluminium, industrial white enamel, smoked
 * translucent plastic, dark rubber. Colour is functional only: amber while
 * hot and processing, icy blue while freezing and transforming.
 *
 * Every control is a real object the player operates. There is no "run" button
 * anywhere in this file.
 */

import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  canPerform,
  coldness,
  displayText,
  indicatorColor,
  type MachineAction,
  type MachineState,
} from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { createMachineDecal, getTexture } from '../render/textures.js';

export interface MachineProps {
  machine: MachineState;
  settings: RenderSettings;
  onAction: (action: MachineAction) => void;
  /** Highlights whichever control the player should operate next. */
  hintEnabled?: boolean;
}

/** Body dimensions in metres — roughly a chest freezer on castors. */
const BODY = { width: 0.86, height: 1.02, depth: 0.62 };

export function Machine({ machine, settings, onAction, hintEnabled = true }: MachineProps): React.ReactElement {
  const doorRef = useRef<THREE.Group>(null);
  const leverRef = useRef<THREE.Group>(null);
  const latchRef = useRef<THREE.Group>(null);
  const indicatorRef = useRef<THREE.Mesh>(null);
  const indicatorLightRef = useRef<THREE.PointLight>(null);
  const frostRef = useRef<THREE.Mesh>(null);
  const vapourRef = useRef<THREE.Points>(null);
  const displayRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const enamel = useMemo(
    () => createPs1Material({ tier: 'ps1Plus', settings, map: getTexture('enamel', { size: 128 }), color: 0xb2afa7, roughness: 0.55, metalness: 0.05 }),
    [settings],
  );
  const aluminium = useMemo(
    () => createPs1Material({ tier: 'ps1Plus', settings, map: getTexture('aluminium', { size: 128 }), color: 0x8e9195, roughness: 0.35, metalness: 0.75 }),
    [settings],
  );
  const rubber = useMemo(
    () => createPs1Material({ tier: 'ps1Plus', settings, map: getTexture('rubber', { size: 64 }), roughness: 0.95 }),
    [settings],
  );
  const smokedPlastic = useMemo(
    () =>
      createPs1Material({
        tier: 'ps1Plus',
        settings,
        map: getTexture('smokedPlastic', { size: 64 }),
        roughness: 0.3,
        metalness: 0.1,
        transparent: true,
        opacity: 0.72,
      }),
    [settings],
  );

  const decalTexture = useMemo(
    () =>
      createMachineDecal({
        serial: machine.identity.serial,
        built: machine.identity.built,
        wear: machine.identity.wear,
        decalFade: machine.identity.decalFade,
        stickers: machine.identity.stickers,
      }),
    [machine.identity],
  );

  const decalMaterial = useMemo(
    () => createPs1Material({ tier: 'ps1Plus', settings, map: decalTexture, roughness: 0.6 }),
    [decalTexture, settings],
  );

  const frostMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: getTexture('frost', { size: 128, seed: machine.identity.serial }),
        transparent: true,
        opacity: 0,
        roughness: 0.25,
        metalness: 0,
        depthWrite: false,
      }),
    [machine.identity.serial],
  );

  const indicatorMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false }),
    [],
  );

  const displayMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: 0x0a1410, toneMapped: false }),
    [],
  );

  // Cold vapour that spills out when the door opens.
  const vapourCount = 40;
  const vapourGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vapourCount * 3), 3));
    return geometry;
  }, []);
  const vapourMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xd8ecf8,
        size: 0.07,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [],
  );

  const displayCanvas = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture } | null>(null);
  const lastDisplayText = useRef('');

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    // --- Door -------------------------------------------------------------
    const door = doorRef.current;
    if (door) {
      // Hinged at the left edge, swinging toward the player.
      door.rotation.y = -machine.door * 1.35;
    }

    // --- Latch and lever --------------------------------------------------
    const latch = latchRef.current;
    if (latch) latch.rotation.z = -machine.latch * 1.15;
    const lever = leverRef.current;
    if (lever) lever.rotation.x = machine.lever * 1.05;

    // --- Indicator --------------------------------------------------------
    const [r, g, b] = indicatorColor(machine);
    // The amber lamp is an incandescent: it breathes rather than switching.
    const breathe = machine.amber > 0.1 ? 0.92 + Math.sin(t * 2.2) * 0.08 * settings.flicker : 1;
    if (indicatorRef.current) {
      (indicatorRef.current.material as THREE.MeshBasicMaterial).color.setRGB(
        r * breathe,
        g * breathe,
        b * breathe,
      );
    }
    if (indicatorLightRef.current) {
      indicatorLightRef.current.color.setRGB(
        r || 0.001,
        g || 0.001,
        b || 0.001,
      );
      indicatorLightRef.current.intensity = Math.max(r, g, b) * 2.4;
    }

    // --- Frost ------------------------------------------------------------
    if (frostRef.current) {
      const material = frostRef.current.material as THREE.MeshStandardMaterial;
      material.opacity = machine.frost * 0.85;
      frostRef.current.visible = machine.frost > 0.01;
    }

    // --- Vapour -----------------------------------------------------------
    const vapour = vapourRef.current;
    if (vapour) {
      const strength = machine.vapour;
      vapourMaterial.opacity = strength * 0.55;
      vapour.visible = strength > 0.01;
      if (strength > 0.01) {
        const positions = vapourGeometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < vapourCount; i++) {
          const phase = (t * 0.4 + i * 0.137) % 1;
          const spread = phase * 0.55;
          const angle = i * 2.399963229728653;
          // Cold vapour falls and spreads along the ground.
          positions.setXYZ(
            i,
            Math.cos(angle) * spread * 0.7,
            Math.max(0.02, 0.42 - phase * 0.45),
            0.35 + Math.sin(angle) * spread * 0.5 + phase * 0.3,
          );
        }
        positions.needsUpdate = true;
      }
    }

    // --- VFD display ------------------------------------------------------
    const text = displayText(machine);
    if (displayRef.current && text !== lastDisplayText.current) {
      lastDisplayText.current = text;
      updateDisplay(displayCanvas, displayRef.current, text, machine);
    }
    void delta;
  });

  const act = (action: MachineAction) => () => onAction(action);
  const highlight = (id: string, enabled: boolean): number =>
    hintEnabled && enabled && hovered === id ? 0.35 : hintEnabled && enabled ? 0.12 : 0;

  const canClose = canPerform(machine, 'close-door');
  const canLatch = canPerform(machine, 'engage-latch');
  const canConfirm = canPerform(machine, 'confirm');
  const canPull = canPerform(machine, 'pull-lever');
  const canRelease = canPerform(machine, 'release-latch');
  const canOpen = canPerform(machine, 'open-door');

  const pointerProps = (id: string) => ({
    onPointerOver: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      setHovered(id);
      if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      setHovered((current) => (current === id ? null : current));
      if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
    },
  });

  return (
    <group name="sm-01">
      {/* --- Body ------------------------------------------------------- */}
      <mesh material={enamel} position={[0, BODY.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[BODY.width, BODY.height, BODY.depth]} />
      </mesh>

      {/* Aluminium plinth and top cap */}
      <mesh material={aluminium} position={[0, 0.045, 0]} castShadow>
        <boxGeometry args={[BODY.width + 0.03, 0.09, BODY.depth + 0.03]} />
      </mesh>
      <mesh material={aluminium} position={[0, BODY.height + 0.025, 0]} castShadow>
        <boxGeometry args={[BODY.width + 0.04, 0.05, BODY.depth + 0.04]} />
      </mesh>

      {/* Rubber feet */}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}${sz}`}
            material={rubber}
            position={[sx * (BODY.width / 2 - 0.08), 0.012, sz * (BODY.depth / 2 - 0.08)]}
          >
            <cylinderGeometry args={[0.04, 0.045, 0.024, 8]} />
          </mesh>
        )),
      )}

      {/* Frost shell, grown during freezing */}
      <mesh ref={frostRef} material={frostMaterial} position={[0, BODY.height / 2, 0]}>
        <boxGeometry args={[BODY.width + 0.012, BODY.height + 0.012, BODY.depth + 0.012]} />
      </mesh>

      {/* --- Chamber and door ------------------------------------------- */}
      {/* Dark interior so the reveal reads against it */}
      <mesh position={[0, 0.56, BODY.depth / 2 - 0.16]}>
        <boxGeometry args={[0.52, 0.42, 0.3]} />
        <meshStandardMaterial color={0x0a0c0e} side={THREE.BackSide} roughness={1} />
      </mesh>

      {/* Tray */}
      <mesh material={aluminium} position={[0, 0.38, BODY.depth / 2 - 0.16]} receiveShadow>
        <boxGeometry args={[0.46, 0.012, 0.28]} />
      </mesh>

      <group ref={doorRef} position={[-0.29, 0.56, BODY.depth / 2 + 0.005]}>
        <mesh
          material={enamel}
          position={[0.29, 0, 0.012]}
          castShadow
          onClick={canClose ? act({ type: 'close-door' }) : canOpen ? act({ type: 'open-door' }) : undefined}
          {...pointerProps('door')}
        >
          <boxGeometry args={[0.58, 0.48, 0.055]} />
        </mesh>
        {/* Smoked window — you can watch the transformation happen */}
        <mesh material={smokedPlastic} position={[0.29, 0.03, 0.042]}>
          <boxGeometry args={[0.34, 0.24, 0.012]} />
        </mesh>
        {/* Door gasket */}
        <mesh material={rubber} position={[0.29, 0, -0.016]}>
          <boxGeometry args={[0.56, 0.46, 0.012]} />
        </mesh>
        {/* Handle */}
        <mesh material={aluminium} position={[0.53, 0, 0.06]} castShadow>
          <boxGeometry args={[0.035, 0.2, 0.035]} />
        </mesh>
        {(canClose || canOpen) && hintEnabled && (
          <mesh position={[0.29, 0, 0.05]}>
            <boxGeometry args={[0.6, 0.5, 0.005]} />
            <meshBasicMaterial
              color={0xbfe6ff}
              transparent
              opacity={highlight('door', true)}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )}
      </group>

      {/* --- Latch ------------------------------------------------------- */}
      <group ref={latchRef} position={[0.33, 0.56, BODY.depth / 2 + 0.055]}>
        <mesh
          material={aluminium}
          position={[0, -0.06, 0]}
          castShadow
          onClick={canLatch ? act({ type: 'engage-latch' }) : canRelease ? act({ type: 'release-latch' }) : undefined}
          {...pointerProps('latch')}
        >
          <boxGeometry args={[0.05, 0.14, 0.045]} />
        </mesh>
        {(canLatch || canRelease) && hintEnabled && (
          <mesh position={[0, -0.06, 0.03]}>
            <boxGeometry args={[0.07, 0.16, 0.005]} />
            <meshBasicMaterial color={0xbfe6ff} transparent opacity={highlight('latch', true)} depthWrite={false} toneMapped={false} />
          </mesh>
        )}
      </group>

      {/* --- Control panel ----------------------------------------------- */}
      <group position={[0, 0.86, BODY.depth / 2 + 0.002]}>
        {/* Decal plate: brand, model, serial, warnings */}
        <mesh material={decalMaterial} position={[-0.2, 0.02, 0.004]}>
          <planeGeometry args={[0.4, 0.2]} />
        </mesh>

        {/* Status indicator */}
        <mesh ref={indicatorRef} material={indicatorMaterial} position={[0.24, 0.06, 0.008]}>
          <cylinderGeometry args={[0.028, 0.028, 0.012, 12]} />
        </mesh>
        <pointLight ref={indicatorLightRef} position={[0.24, 0.06, 0.1]} distance={1.4} decay={2} />

        {/* VFD display */}
        <mesh ref={displayRef} material={displayMaterial} position={[0.24, -0.02, 0.006]}>
          <planeGeometry args={[0.2, 0.055]} />
        </mesh>

        {/* Program selector — three detented positions */}
        {(['soft-set', 'standard', 'deep-freeze'] as const).map((program, i) => {
          const selected = machine.program === program;
          const enabled = canPerform(machine, 'set-program');
          return (
            <mesh
              key={program}
              position={[-0.28 + i * 0.08, -0.07, 0.01]}
              onClick={enabled ? act({ type: 'set-program', program }) : undefined}
              {...pointerProps(`program-${program}`)}
            >
              <cylinderGeometry args={[0.019, 0.019, 0.016, 10]} />
              <meshStandardMaterial
                color={selected ? 0xe8e5de : 0x8b8880}
                emissive={selected ? 0x554422 : 0x000000}
                emissiveIntensity={selected ? 0.35 : 0}
                roughness={0.5}
              />
            </mesh>
          );
        })}

        {/* Confirm */}
        <mesh
          position={[0.02, -0.07, 0.012]}
          onClick={canConfirm ? act({ type: 'confirm' }) : undefined}
          {...pointerProps('confirm')}
        >
          <cylinderGeometry args={[0.024, 0.024, 0.018, 12]} />
          <meshStandardMaterial
            color={machine.confirmed ? 0xd8d4c8 : 0x9a968c}
            emissive={canConfirm && hintEnabled ? 0x335544 : 0x000000}
            emissiveIntensity={canConfirm ? 0.4 : 0}
            roughness={0.45}
          />
        </mesh>
      </group>

      {/* --- Lever: the commitment moment -------------------------------- */}
      <group ref={leverRef} position={[0.46, 0.72, BODY.depth / 2 - 0.02]}>
        <mesh
          material={aluminium}
          position={[0, 0.09, 0.06]}
          castShadow
          onClick={canPull ? act({ type: 'pull-lever' }) : undefined}
          {...pointerProps('lever')}
        >
          <boxGeometry args={[0.028, 0.2, 0.028]} />
        </mesh>
        <mesh material={rubber} position={[0, 0.19, 0.06]}>
          <sphereGeometry args={[0.032, 8, 6]} />
        </mesh>
        {canPull && hintEnabled && (
          <mesh position={[0, 0.14, 0.06]}>
            <boxGeometry args={[0.07, 0.28, 0.07]} />
            <meshBasicMaterial color={0xffcc88} transparent opacity={highlight('lever', true)} depthWrite={false} toneMapped={false} />
          </mesh>
        )}
      </group>

      {/* --- Grille and service panel ------------------------------------ */}
      <mesh material={aluminium} position={[0, 0.16, -BODY.depth / 2 - 0.004]}>
        <boxGeometry args={[0.6, 0.2, 0.012]} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} position={[0, 0.09 + i * 0.026, -BODY.depth / 2 - 0.012]}>
          <boxGeometry args={[0.56, 0.008, 0.006]} />
          <meshStandardMaterial color={0x2c2e31} roughness={0.9} />
        </mesh>
      ))}

      {/* Chamber lamp. A freezer lights its own interior when the door opens —
          functional, diegetic, and the only reason the tray and the sandwich
          are legible standing in a dark campsite. */}
      <pointLight
        position={[0, 0.62, BODY.depth / 2 - 0.16]}
        distance={1.5}
        decay={1.7}
        intensity={machine.door * 1.9}
        color={0xfff4e2}
      />

      {/* Panel work light over the controls, on whenever the unit is awake. */}
      <spotLight
        position={[0, 1.42, BODY.depth / 2 + 0.42]}
        target-position={[0, 0.86, BODY.depth / 2]}
        angle={0.85}
        penumbra={0.9}
        distance={2.4}
        decay={1.5}
        intensity={1.5}
        color={0xe8ecf2}
      />

      {/* Cold pool of light on the floor while the machine runs */}
      <pointLight
        position={[0, 0.06, BODY.depth / 2 + 0.2]}
        distance={2.4}
        decay={2}
        intensity={coldness(machine) * 1.6}
        color={0x9fd8ff}
      />

      <points ref={vapourRef} geometry={vapourGeometry} material={vapourMaterial} position={[0, 0, 0]} />
    </group>
  );
}

/** Draws the vacuum-fluorescent display text onto a small canvas texture. */
function updateDisplay(
  ref: React.MutableRefObject<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture } | null>,
  mesh: THREE.Mesh,
  text: string,
  machine: MachineState,
): void {
  if (typeof document === 'undefined') return;
  if (!ref.current) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    ref.current = { canvas, ctx, texture };
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
  }

  const { ctx, texture } = ref.current;
  ctx.fillStyle = '#08120e';
  ctx.fillRect(0, 0, 256, 64);
  // A dim seven-segment ghost, the way a real VFD shows unlit segments.
  ctx.fillStyle = 'rgba(90,255,190,0.08)';
  ctx.font = 'bold 40px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('█'.repeat(9), 128, 34);

  ctx.fillStyle = '#5affbe';
  const flickers = machine.identity.quirks.some((q) => q.id === 'flicker-segment');
  ctx.globalAlpha = flickers && Math.random() < 0.08 ? 0.35 : 1;
  ctx.fillText(text, 128, 32);
  ctx.globalAlpha = 1;
  texture.needsUpdate = true;
}
