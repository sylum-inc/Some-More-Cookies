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

/** Body dimensions in metres — roughly an upright freezer on rubber feet. */
const BODY = { width: 0.86, height: 1.02, depth: 0.62 };

/** The chamber mouth cut into the front face, and the shell around it. */
const CHAMBER = {
  width: 0.52,
  height: 0.42,
  /** Height of the opening's centre above the floor. */
  centreY: 0.56,
  /** Wall thickness of the cabinet shell. */
  shell: 0.06,
  /** Depth of the front frame. */
  frontDepth: 0.06,
};

/** A rectangle in the door's own frame: centre, extent, and where it sits in depth. */
interface Slab {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  depth: number;
}

/** The door leaf, hinged at the group origin on its left edge. */
const DOOR: Slab = { x: 0.29, y: 0, width: 0.58, height: 0.48, z: 0.012, depth: 0.055 };
/** The rubber seal on its inner face. */
const GASKET: Slab = { x: 0.29, y: 0, width: 0.56, height: 0.46, z: -0.016, depth: 0.012 };
/** The smoked window cut through both. */
const WINDOW = { x: 0.29, y: 0.03, width: 0.34, height: 0.24 };

/**
 * A slab with a rectangular hole in it, as four boxes: a band above the hole,
 * a band below, and a jamb either side between them.
 */
function doorFrame(
  slab: Slab,
  hole: { x: number; y: number; width: number; height: number },
): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
  const top = slab.y + slab.height / 2;
  const bottom = slab.y - slab.height / 2;
  const left = slab.x - slab.width / 2;
  const right = slab.x + slab.width / 2;
  const holeTop = hole.y + hole.height / 2;
  const holeBottom = hole.y - hole.height / 2;
  const holeLeft = hole.x - hole.width / 2;
  const holeRight = hole.x + hole.width / 2;
  return [
    { x: slab.x, y: (top + holeTop) / 2, width: slab.width, height: top - holeTop },
    { x: slab.x, y: (bottom + holeBottom) / 2, width: slab.width, height: holeBottom - bottom },
    { x: (left + holeLeft) / 2, y: hole.y, width: holeLeft - left, height: hole.height },
    { x: (right + holeRight) / 2, y: hole.y, width: right - holeRight, height: hole.height },
  ];
}

export function Machine({ machine, settings, onAction, hintEnabled = true }: MachineProps): React.ReactElement {
  const doorRef = useRef<THREE.Group>(null);
  const leverRef = useRef<THREE.Group>(null);
  const latchRef = useRef<THREE.Group>(null);
  const indicatorRef = useRef<THREE.Mesh>(null);
  const indicatorLightRef = useRef<THREE.PointLight>(null);
  const frostRef = useRef<THREE.Mesh>(null);
  const windowFrostRef = useRef<THREE.Mesh>(null);
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
        // Smoked, not opaque: the file's own first line says you can watch
        // the transformation happen, and at 0.72 the s'more on the tray was
        // invisible behind it for the whole run.
        opacity: 0.55,
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

  const windowFrostMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: getTexture('frost', { size: 64, seed: `${machine.identity.serial}-window` }),
        transparent: true,
        opacity: 0,
        roughness: 0.9,
        metalness: 0,
        depthWrite: false,
      }),
    [machine.identity.serial],
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
      // Hinged at the left edge and swung wide — about 120°, the way an
      // upright freezer actually opens. At 90° the door sits square across
      // the opening and hides the chamber from anyone standing in front of
      // it, which is exactly where the player stands for the reveal.
      door.rotation.y = -machine.door * 2.15;
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
      // Capped: a full-strength frost sheet over the whole shell washes the
      // machine out to a white slab and buries the chamber behind it.
      material.opacity = Math.min(0.5, machine.frost * 0.62);
      frostRef.current.visible = machine.frost > 0.01;
    }
    if (windowFrostRef.current) {
      const material = windowFrostRef.current.material as THREE.MeshStandardMaterial;
      material.opacity = Math.min(0.88, machine.frost * 1.25);
      windowFrostRef.current.visible = machine.frost > 0.01;
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
  /*
   * Putting the s'more in, which had no pointer target at all.
   *
   * Every other control on this cabinet is a mesh you click: the door, the
   * latch, the three programmes, the confirm, the lever. Loading was the one
   * step of twelve that existed solely as the `L` key, so on a touchscreen the
   * ritual simply stopped at "Put it in." with nothing to put it in with. The
   * first person to play this said, in as many words, that they did not know
   * how to get the sandwich into the machine. They were right: there was no
   * way.
   *
   * It went unnoticed because every end-to-end test -- acceptance, access, and
   * `mobile.spec.ts`, whose whole subject is whether the ritual fits in the
   * hand -- performs this step through `window.__someMore.actions`, the debug
   * bridge. A suite that reaches around the interaction it is testing will
   * report that the ritual works right up until somebody tries it.
   */
  const canLoad = canPerform(machine, 'load');

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
      {/* --- Body -------------------------------------------------------
          Built as a shell with a real opening rather than one solid box.
          A single box has no hole in it, so opening the door revealed the
          machine's own front panel with the sandwich sealed inside the
          geometry — the reveal could not work until the chamber had a
          mouth. */}
      {/* Back, sides, top and bottom */}
      <mesh material={enamel} position={[0, BODY.height / 2, -BODY.depth / 2 + CHAMBER.shell / 2]} castShadow receiveShadow>
        <boxGeometry args={[BODY.width, BODY.height, CHAMBER.shell]} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          material={enamel}
          position={[side * (BODY.width / 2 - CHAMBER.shell / 2), BODY.height / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[CHAMBER.shell, BODY.height, BODY.depth]} />
        </mesh>
      ))}
      <mesh material={enamel} position={[0, BODY.height - CHAMBER.shell / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[BODY.width, CHAMBER.shell, BODY.depth]} />
      </mesh>
      <mesh material={enamel} position={[0, CHAMBER.shell / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[BODY.width, CHAMBER.shell, BODY.depth]} />
      </mesh>

      {/* Front face, as a frame around the chamber mouth */}
      {(() => {
        const z = BODY.depth / 2 - CHAMBER.frontDepth / 2;
        const sideWidth = (BODY.width - CHAMBER.width) / 2;
        const above = BODY.height - (CHAMBER.centreY + CHAMBER.height / 2);
        const below = CHAMBER.centreY - CHAMBER.height / 2;
        return (
          <group>
            {[-1, 1].map((side) => (
              <mesh
                key={side}
                material={enamel}
                position={[side * (BODY.width / 2 - sideWidth / 2), BODY.height / 2, z]}
                castShadow
              >
                <boxGeometry args={[sideWidth, BODY.height, CHAMBER.frontDepth]} />
              </mesh>
            ))}
            <mesh material={enamel} position={[0, BODY.height - above / 2, z]} castShadow>
              <boxGeometry args={[CHAMBER.width, above, CHAMBER.frontDepth]} />
            </mesh>
            <mesh material={enamel} position={[0, below / 2, z]} castShadow>
              <boxGeometry args={[CHAMBER.width, below, CHAMBER.frontDepth]} />
            </mesh>
          </group>
        );
      })()}

      {/* Aluminium plinth and top cap */}
      <mesh material={aluminium} position={[0, 0.045, 0]} castShadow>
        <boxGeometry args={[BODY.width + 0.03, 0.09, BODY.depth + 0.03]} />
      </mesh>
      <mesh material={aluminium} position={[0, BODY.height + 0.025, 0]} castShadow>
        <boxGeometry args={[BODY.width + 0.04, 0.05, BODY.depth + 0.04]} />
      </mesh>

      {/* --- Relief ------------------------------------------------------
          The front used to be one large enamel plane with everything on it
          lying flush: the decal, the readout, the door. A flat plane facing
          the camera has no internal form no matter how it is lit or what
          material it wears — which is why this cabinet rendered as a single
          beige silhouette despite being built from twenty-three boxes in four
          materials, and why relighting the campsite did nothing for it.

          Everything below faces a different way from the panel behind it, or
          is made of something with a different roughness, or both. That is
          what a surface needs in order to be read as a surface. */}

      {/* A bezel standing proud around the chamber mouth, so the door reads
          as set into a frame rather than painted onto a wall. */}
      {(() => {
        const lip = 0.038;
        const z = BODY.depth / 2 + 0.014;
        const halfW = CHAMBER.width / 2 + lip / 2;
        const halfH = CHAMBER.height / 2 + lip / 2;
        const outerW = CHAMBER.width + lip * 2;
        return (
          <group>
            {[1, -1].map((sy) => (
              <mesh key={`h${sy}`} material={aluminium} position={[0, CHAMBER.centreY + sy * halfH, z]} castShadow>
                <boxGeometry args={[outerW, lip, 0.03]} />
              </mesh>
            ))}
            {[1, -1].map((sx) => (
              <mesh key={`v${sx}`} material={aluminium} position={[sx * halfW, CHAMBER.centreY, z]} castShadow>
                <boxGeometry args={[lip, CHAMBER.height, 0.03]} />
              </mesh>
            ))}
          </group>
        );
      })()}

      {/* Condenser fins, low on the front where the cold plant would sit.
          Horizontal edges against a vertical panel: the one arrangement that
          catches a low moon and a fire at the same time. */}
      {Array.from({ length: 7 }, (_, i) => (
        <mesh
          key={`fin${i}`}
          material={aluminium}
          position={[0, 0.15 + i * 0.026, BODY.depth / 2 + 0.009]}
          castShadow
        >
          <boxGeometry args={[0.34, 0.011, 0.022]} />
        </mesh>
      ))}

      {/* Corner posts down the front edges. They break the silhouette, which
          is the only thing that reads at all once you are more than a couple
          of metres away and the panel detail has gone. */}
      {[-1, 1].map((sx) => (
        <mesh
          key={`post${sx}`}
          material={aluminium}
          position={[sx * (BODY.width / 2 - 0.012), BODY.height / 2 + 0.03, BODY.depth / 2 - 0.012]}
          castShadow
        >
          <boxGeometry args={[0.03, BODY.height - 0.14, 0.03]} />
        </mesh>
      ))}

      {/* A shadow gap under the top cap. A recess reads as a seam between two
          pressings; without one the cabinet is a single extrusion. */}
      <mesh material={rubber} position={[0, BODY.height - 0.055, BODY.depth / 2 - 0.006]}>
        <boxGeometry args={[BODY.width - 0.05, 0.014, 0.02]} />
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
      <mesh position={[0, CHAMBER.centreY, BODY.depth / 2 - 0.2]}>
        <boxGeometry args={[CHAMBER.width - 0.005, CHAMBER.height - 0.005, 0.34]} />
        <meshStandardMaterial color={0x14181c} side={THREE.BackSide} roughness={1} />
      </mesh>

      {/* Tray. Also the target for setting the s'more down inside. */}
      <mesh
        material={aluminium}
        position={[0, CHAMBER.centreY - CHAMBER.height / 2 + 0.015, BODY.depth / 2 - 0.18]}
        receiveShadow
        onClick={canLoad ? act({ type: 'load' }) : undefined}
        {...(canLoad ? pointerProps('tray') : {})}
      >
        <boxGeometry args={[CHAMBER.width - 0.06, 0.012, 0.3]} />
      </mesh>

      {/*
        A lit pad on the tray while it is waiting to be loaded.
        
        The tray is a thin aluminium shelf inside a dark box, and "click the
        shelf" is not a thing anybody guesses. This is the same hint treatment
        the lever and the latch get, on the one control that needed it most and
        did not have it.
      */}
      {canLoad && (
        <mesh
          position={[0, CHAMBER.centreY - CHAMBER.height / 2 + 0.023, BODY.depth / 2 - 0.18]}
          rotation={[-Math.PI / 2, 0, 0]}
          onClick={act({ type: 'load' })}
          {...pointerProps('tray')}
        >
          <planeGeometry args={[CHAMBER.width - 0.09, 0.26]} />
          <meshBasicMaterial
            color={0xffd9a0}
            transparent
            opacity={hintEnabled ? (hovered === 'tray' ? 0.3 : 0.14) : 0.06}
            toneMapped={false}
          />
        </mesh>
      )}

      <group ref={doorRef} position={[-0.29, 0.56, BODY.depth / 2 + 0.005]}>
        {/*
          The door is a frame around the window, not a slab with a pane glued
          to its face.

          It was a slab. The smoked pane sat proud of an unbroken 55 mm of
          enamel, so nothing behind it could ever show: the s'more on the tray
          was drawn every frame of the run and seen in none of them, and the
          pane's own comment -- "you can watch the transformation happen" --
          was a description of an intention. The same is true of the gasket
          behind it, which was a second solid sheet. Both are cut the way the
          chamber mouth is cut into the front face above.
        */}
        {doorFrame(DOOR, WINDOW).map((piece, i) => (
          <mesh
            key={`door-${i}`}
            material={enamel}
            position={[piece.x, piece.y, DOOR.z]}
            castShadow
            onClick={canClose ? act({ type: 'close-door' }) : canOpen ? act({ type: 'open-door' }) : undefined}
            {...pointerProps('door')}
          >
            <boxGeometry args={[piece.width, piece.height, DOOR.depth]} />
          </mesh>
        ))}
        {/* Smoked window, set into the hole: you can watch the transformation happen */}
        <mesh
          material={smokedPlastic}
          position={[WINDOW.x, WINDOW.y, 0.024]}
          onClick={canClose ? act({ type: 'close-door' }) : canOpen ? act({ type: 'open-door' }) : undefined}
          {...pointerProps('door')}
        >
          <boxGeometry args={[WINDOW.width, WINDOW.height, 0.048]} />
        </mesh>
        {/* Rime on the glass. The shell's frost sheet is capped so the
            cabinet does not wash out to a white slab, which left "complete"
            indistinguishable from "freezing" except for the readout. The
            window is where frost is legible, and where it grows first. */}
        <mesh ref={windowFrostRef} material={windowFrostMaterial} position={[WINDOW.x, WINDOW.y, 0.0495]}>
          <planeGeometry args={[WINDOW.width, WINDOW.height]} />
        </mesh>
        {/* Door gasket, a rubber frame with the same hole in it */}
        {doorFrame(GASKET, WINDOW).map((piece, i) => (
          <mesh key={`gasket-${i}`} material={rubber} position={[piece.x, piece.y, GASKET.z]}>
            <boxGeometry args={[piece.width, piece.height, GASKET.depth]} />
          </mesh>
        ))}
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
        position={[0, CHAMBER.centreY + 0.13, BODY.depth / 2 - 0.14]}
        distance={1.1}
        decay={2}
        intensity={machine.door * 0.9}
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
