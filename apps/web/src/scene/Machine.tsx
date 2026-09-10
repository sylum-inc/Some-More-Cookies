/**
 * The Some More SM-01 transformation freezer (spec §3).
 *
 * Late-1990s industrial refrigeration, early-Y2K technology, restrained
 * functional minimalism. Silver aluminium, chipped institutional enamel,
 * smoked translucent plastic, dark rubber. Colour is functional only: amber
 * while hot and processing, icy blue while freezing and transforming.
 *
 * Every control is a real object the player operates. There is no "run" button
 * anywhere in this file, and there is no readout of anything countable: the
 * machine says what it is doing in words for a screen reader, and in light and
 * motion for everybody else (spec §5.3).
 *
 * The cabinet's shape and its unwrap live in `render/machineShell.ts`, which
 * has no React in it and can therefore be built and photographed offline. That
 * is deliberate: the unwrap is the part of this object most likely to be
 * silently wrong, and a render feature that is silently discarded looks
 * exactly like one that was never written.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { createPs1Material, probeQualityTier, type QualityTier, type RenderSettings } from '../render/ps1.js';
import {
  BODY,
  CHAMBER,
  GASKET,
  PANEL,
  WINDOW,
  buildAluminiumTrim,
  buildDoorLeaf,
  buildEnamelShell,
  buildGrilleSlats,
  buildRubberTrim,
  buildSlabFrame,
} from '../render/machineShell.js';
import {
  MACHINE_ATLAS_SIZE,
  MACHINE_DOOR_ATLAS_SIZE,
  createMachineBodyEmissive,
  createMachineBodyTexture,
  createMachineDecal,
  createMachineDoorTexture,
  getTexture,
} from '../render/textures.js';

export interface MachineProps {
  machine: MachineState;
  settings: RenderSettings;
  onAction: (action: MachineAction) => void;
  /** Highlights whichever control the player should operate next. */
  hintEnabled?: boolean;
  /**
   * The quality tier, for sizing the skin.
   *
   * Optional and probed when absent, because the tier lives in `App` and
   * reaches the scene through `World`, which this change is not allowed to
   * touch. The probe is the same one `App` starts from, so a `low` device gets
   * the half-size atlas either way; what it does *not* get is the adaptive
   * downgrade, so if `World` ever passes its tier down this prop is where it
   * goes.
   */
  quality?: QualityTier;
}

/**
 * How big the painted skin is drawn, by tier.
 *
 * `low` halves it, which halves the texel density to about 71 px/m — still
 * inside the PS1 range this renderer targets, and the tier is already at
 * 180 lines internal so nothing on the cabinet resolves past it anyway.
 */
const ATLAS_SIZE: Record<QualityTier, number> = {
  low: MACHINE_ATLAS_SIZE / 2,
  mid: MACHINE_ATLAS_SIZE,
  high: MACHINE_ATLAS_SIZE,
};
const DOOR_ATLAS_SIZE: Record<QualityTier, number> = {
  low: MACHINE_DOOR_ATLAS_SIZE / 2,
  mid: MACHINE_DOOR_ATLAS_SIZE,
  high: MACHINE_DOOR_ATLAS_SIZE,
};

/**
 * The two colours light leaks from the vents in, per §3.1's table.
 *
 * Built once from hex, which `THREE.Color` reads as sRGB and converts into the
 * renderer's linear working space. Setting `.setRGB` with hand-mixed sRGB
 * ratios instead is the mistake this codebase has now made twice: the numbers
 * look right in the source and arrive about a stop and a half too dark.
 */
const VENT_AMBER = new THREE.Color(0xff8b33);
const VENT_ICE = new THREE.Color(0x9fd8ff);

export function Machine({ machine, settings, onAction, hintEnabled = true, quality }: MachineProps): React.ReactElement {
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

  const tier = useMemo<QualityTier>(() => {
    if (quality) return quality;
    if (typeof navigator === 'undefined') return 'mid';
    return probeQualityTier({
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    });
  }, [quality]);

  /*
   * The painted cabinet.
   *
   * This used to be `getTexture('enamel')` — a 128 px tile of near-white noise
   * — multiplied by a warm grey, on geometry whose UVs run 0..1 across every
   * box face. Three separate things were wrong with that and only the first
   * was visible in a screenshot.
   *
   * The colour put the machine within a few per cent of the handheld's own
   * cream bezel, so at any distance where the panel detail had gone the SM-01
   * dissolved into the frame around the screen. The tile carried no wear, no
   * graphic and no information about *where* anything was, so the machine the
   * game is named after had no food cue anywhere on it: it read as a kiosk, an
   * ATM, a small appliance. And the 0..1-per-face UVs meant the same tile was
   * stretched over the 0.86 m front and over a 0.03 m corner post, which is
   * the texel-density bug that made the grille slats read as a flat dark
   * rectangle until somebody looked at them.
   *
   * All three are the same fix: unwrap the cabinet onto its own elevations at
   * one honest scale, and paint the elevations.
   */
  const bodyTexture = useMemo(
    () =>
      createMachineBodyTexture({
        serial: machine.identity.serial,
        wear: machine.identity.wear,
        size: ATLAS_SIZE[tier],
      }),
    [machine.identity.serial, machine.identity.wear, tier],
  );
  const ventGlow = useMemo(() => createMachineBodyEmissive(ATLAS_SIZE[tier]), [tier]);
  const doorTexture = useMemo(
    () =>
      createMachineDoorTexture({
        serial: machine.identity.serial,
        wear: machine.identity.wear,
        size: DOOR_ATLAS_SIZE[tier],
      }),
    [machine.identity.serial, machine.identity.wear, tier],
  );

  const enamel = useMemo(
    () =>
      createPs1Material({
        tier: 'ps1Plus',
        settings,
        map: bodyTexture,
        emissive: 0xff8b33,
        emissiveMap: ventGlow,
        // Off at rest. The frame loop raises it while the machine works and
        // swings it from amber to ice as the transformation turns real.
        emissiveIntensity: 0,
        roughness: 0.62,
        metalness: 0.04,
      }),
    [bodyTexture, ventGlow, settings],
  );
  const doorEnamel = useMemo(
    () => createPs1Material({ tier: 'ps1Plus', settings, map: doorTexture, roughness: 0.62, metalness: 0.04 }),
    [doorTexture, settings],
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

  /*
   * The cabinet's static geometry, merged by material.
   *
   * Empty dependency arrays because every input is a module constant: this is
   * built once per mount and the shape never varies by campsite or by
   * settings. Disposed on unmount, because unlike a JSX `<boxGeometry>` —
   * which react-three-fiber owns and cleans up — geometry passed in through
   * the `geometry` prop belongs to whoever made it, and the machine remounts
   * whenever the campsite changes.
   */
  const enamelShell = useMemo(() => buildEnamelShell(), []);
  const aluminiumTrim = useMemo(() => buildAluminiumTrim(), []);
  const rubberTrim = useMemo(() => buildRubberTrim(), []);
  const grilleSlats = useMemo(() => buildGrilleSlats(), []);
  const doorLeaf = useMemo(() => buildDoorLeaf(), []);
  const doorGasket = useMemo(() => buildSlabFrame(GASKET, WINDOW), []);
  /**
   * One material for the seven slats, which used to carry seven identical ones.
   *
   * And a bare `MeshStandardMaterial` with no map, which is the last one in the
   * world scene: every other surface on this cabinet goes through
   * `createPs1Material` and wears a tile, so the grille was the one part of the
   * SM-01 that had no affine swim, no jitter-consistent shading and no grain —
   * a flat dark rectangle in the middle of a textured machine.
   */
  const grillePlastic = useMemo(
    () =>
      createPs1Material({
        tier: 'ps1Plus',
        settings,
        map: getTexture('smokedPlastic', { size: 64 }),
        color: 0x6e737a,
        roughness: 0.9,
      }),
    [settings],
  );
  useEffect(() => {
    const owned = [enamelShell, aluminiumTrim, rubberTrim, grilleSlats, doorLeaf, doorGasket];
    return () => {
      for (const geometry of owned) geometry.dispose();
      grillePlastic.dispose();
    };
  }, [enamelShell, aluminiumTrim, rubberTrim, grilleSlats, doorLeaf, doorGasket, grillePlastic]);

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

    /*
     * --- Vent light -------------------------------------------------------
     *
     * The condenser bay, the drip-tray slot and the plant vents at the back,
     * lit through the emissive mask. This is the machine's only readable state
     * from more than three metres away: a run takes the better part of a
     * minute and, before this, a working SM-01 and a dead one were the same
     * object from across the clearing. It is light and colour, not a bar and
     * not a countdown — §5.3 leaves that as the only honest option, and §3.1's
     * table already says what the two colours mean.
     */
    const cold = coldness(machine);
    const level = Math.max(machine.amber, cold * 0.85);
    // Reduced motion gets the same light, held still (PRODUCT_SPEC §12).
    const shimmer = settings.reducedMotion ? 1 : 0.88 + Math.sin(t * 1.7) * 0.12 * settings.flicker;
    enamel.emissive.lerpColors(VENT_AMBER, VENT_ICE, cold > 0 ? cold / (cold + machine.amber + 1e-6) : 0);
    // `fireBrightness` is the accessibility control for how hard anything in
    // this world is allowed to glow, and this glows.
    enamel.emissiveIntensity = level * 0.85 * settings.fireBrightness * shimmer;

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
      {/*
        The cabinet's static shell, merged.

        This was thirty-seven separate boxes on three shared materials — the
        single largest draw-call spender in the product, at a measured 117 of
        a 120 budget for the arrival frame. Every one of them has a fixed
        transform inside this group and none of them is a pointer target, so
        they are three meshes now. What moves (the door, the latch, the
        lever), what is touched (the tray, the programmes, the confirm) and
        what is transparent (the frost, the window, the hints) is untouched
        below.

        Everything added since — the crown board, the hinges, the drip tray,
        the placard's mounting plate — went into these same three geometries
        for the same reason. The budget the SM-01 has left is triangles, not
        draw calls, so detail is bought with paint and with merged boxes and
        never with another mesh.
      */}
      <mesh material={enamel} geometry={enamelShell} castShadow receiveShadow />
      <mesh material={aluminium} geometry={aluminiumTrim} castShadow />
      <mesh material={rubber} geometry={rubberTrim} />

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

          Its skin is its own texture rather than the body atlas, because the
          leaf swings 120° away from everything else on the cabinet and its UVs
          are in its own frame. Same material count, so it costs nothing — and
          it is where the best wear on the whole object lives, since the door
          is the part the player's own hand is about to be all over.
        */}
        <mesh
          material={doorEnamel}
          geometry={doorLeaf}
          castShadow
          onClick={canClose ? act({ type: 'close-door' }) : canOpen ? act({ type: 'open-door' }) : undefined}
          {...pointerProps('door')}
        />
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
        <mesh material={rubber} geometry={doorGasket} />
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
      <group position={[0, PANEL.y, PANEL.z]}>
        {/*
          Decal plate: brand, model, serial, warnings.

          Sitting on the aluminium mounting plate that is part of the trim
          geometry, and raised clear of the switch row below it — the plate and
          the programme detents used to occupy the same square of panel, so the
          knobs were drawn standing in the middle of the small print.
        */}
        <mesh
          material={decalMaterial}
          position={[
            PANEL.plate.x,
            PANEL.plate.y - PANEL.y,
            BODY.depth / 2 + PANEL.plate.depth - 0.007 + PANEL.decal.standoff - PANEL.z,
          ]}
        >
          <planeGeometry args={[PANEL.decal.width, PANEL.decal.height]} />
        </mesh>

        {/*
          Status indicator.

          Turned to face the player. A `cylinderGeometry` stands on its Y axis,
          so the lamp, the three programme detents and the confirm were all
          drums lying edge-on against a vertical panel — six little bricks
          where there should have been six round faces. It is a quarter turn
          and it is the difference between controls and decoration.
        */}
        <mesh ref={indicatorRef} material={indicatorMaterial} position={[0.24, 0.06, 0.012]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.028, 0.014, 12]} />
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
              position={[-0.28 + i * 0.08, PANEL.switchRowY, 0.012]}
              rotation={[Math.PI / 2, 0, 0]}
              onClick={enabled ? act({ type: 'set-program', program }) : undefined}
              {...pointerProps(`program-${program}`)}
            >
              <cylinderGeometry args={[0.019, 0.019, 0.018, 10]} />
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
          position={[0.02, PANEL.switchRowY, 0.014]}
          rotation={[Math.PI / 2, 0, 0]}
          onClick={canConfirm ? act({ type: 'confirm' }) : undefined}
          {...pointerProps('confirm')}
        >
          <cylinderGeometry args={[0.024, 0.024, 0.02, 12]} />
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
      <mesh geometry={grilleSlats} material={grillePlastic} />

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
