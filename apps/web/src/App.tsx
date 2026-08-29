/**
 * Application shell.
 *
 * Boot goes toward the world, never toward a menu (spec §6.2). The player
 * lands on a trail in the dark with a fire ahead of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas } from '@react-three/fiber';
import type * as THREE from 'three';
import {
  bite as takeBiteAction,
  blowOutMarshmallow,
  finishRoasting,
  arrive as arriveAction,
  holdComponent,
  moveComponent,
  placeComponent,
  takeSandwich as takeSandwichAction,
  tendFire,
  vec3,
  type MachineEvent,
  type RitualState,
} from '@somemore/sim';
import { World, LAYOUT } from './scene/World.js';
import { Hud } from './ui/Hud.js';
import { Passport } from './ui/Passport.js';
import { Settings } from './ui/Settings.js';
import { Terminal } from './ui/Terminal.js';
import { GLOBAL_CSS, TOKENS, FONT_STACK } from './ui/styles.js';
import { Store } from './state/store.js';
import { AdaptiveQuality, applyRenderSettings, probeQualityTier, QUALITY, type QualityTier } from './render/ps1.js';
import { BlowGestureDetector, RoastController, screenToTableOffset } from './interaction/roastControl.js';
import { capturePhoto } from './interaction/photo.js';
import { AudioBridge } from './audio/bridge.js';

export interface AppProps {
  store: Store;
}

export function App({ store }: AppProps): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const ritual = state.ritual;

  const roastControl = useMemo(() => new RoastController({}, LAYOUT.playerBearing), []);
  const blowDetector = useMemo(() => new BlowGestureDetector(), []);
  const arrivalRef = useRef(0);
  const arrivingRef = useRef(false);
  /**
   * The renderer, scene and camera.
   *
   * Photo mode needs all three: a WebGL drawing buffer is cleared once the
   * browser composites it, so reading the canvas at an arbitrary moment yields
   * black. Re-rendering immediately before the read, in the same task, is what
   * makes the capture work without paying `preserveDrawingBuffer` on every
   * frame of the whole session.
   */
  const rendererRef = useRef<{
    gl: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
  } | null>(null);
  const audioRef = useRef<AudioBridge | null>(null);

  const [quality, setQuality] = useState<QualityTier>(() =>
    probeQualityTier({
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
    }),
  );
  const adaptive = useMemo(() => new AdaptiveQuality(quality), []);

  // Inject the global stylesheet once.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // Push settings into every PS1 material whenever they change.
  useEffect(() => {
    applyRenderSettings(state.render);
  }, [state.render]);

  // --- Audio -------------------------------------------------------------
  useEffect(() => {
    const bridge = new AudioBridge();
    audioRef.current = bridge;
    return () => bridge.dispose();
  }, []);

  useEffect(() => {
    audioRef.current?.applySettings(state.audio);
  }, [state.audio]);

  const unlockAudio = useCallback(() => {
    if (state.audioReady) return;
    void audioRef.current?.unlock().then((ok: boolean) => {
      if (ok) store.set({ audioReady: true });
    });
  }, [state.audioReady, store]);

  // --- Arrival walk ------------------------------------------------------
  const beginArrival = useCallback(() => {
    if (arrivingRef.current || ritual.stage !== 'arriving') return;
    arrivingRef.current = true;
    const started = performance.now();
    const duration = 5200;
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / duration);
      arrivalRef.current = easeInOut(t);
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        arriveAction(ritual);
        store.touch();
      }
    };
    requestAnimationFrame(tick);
  }, [ritual, store]);

  // --- Pointer handling --------------------------------------------------
  const dragging = useRef(false);
  const pointerStart = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      unlockAudio();
      if (state.overlay !== 'none') return;

      if (ritual.stage === 'arriving') {
        beginArrival();
        return;
      }
      if (ritual.stage === 'roasting') {
        dragging.current = true;
        pointerStart.current = { x: event.clientX, y: event.clientY };
        roastControl.begin(event.clientX, event.clientY);
        blowDetector.reset();
        (event.target as Element).setPointerCapture?.(event.pointerId);
      }
      if (ritual.stage === 'assembling') {
        dragging.current = true;
        pointerStart.current = { x: event.clientX, y: event.clientY };
        if (!ritual.assembly.heldKind) {
          holdComponent(ritual);
          store.touch();
        }
        (event.target as Element).setPointerCapture?.(event.pointerId);
      }
    },
    [state.overlay, ritual, roastControl, blowDetector, beginArrival, unlockAudio, store],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging.current) return;
      if (ritual.stage === 'roasting') {
        roastControl.move(event.clientX, event.clientY);
        // A shake while it is alight blows it out — no microphone required.
        if (ritual.marshmallow.burning && blowDetector.sample(event.clientX, performance.now())) {
          if (blowOutMarshmallow(ritual)) {
            audioRef.current?.playFoley('blow-out');
            store.touch();
          }
        }
      }
      if (ritual.stage === 'assembling' && ritual.assembly.heldKind) {
        const offset = screenToTableOffset(
          event.clientX,
          event.clientY,
          pointerStart.current.x,
          pointerStart.current.y,
        );
        moveComponent(ritual, offset, ritual.assembly.heldRotation);
      }
    },
    [ritual, roastControl, blowDetector, store],
  );

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    roastControl.end();
    if (ritual.stage === 'assembling' && ritual.assembly.heldKind) {
      placeComponent(ritual);
      audioRef.current?.playFoley(ritual.assembly.placedThisStep === 'graham-top' ? 'squish' : 'graham-snap');
      store.touch();
    }
  }, [ritual, roastControl, store]);

  // --- Keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        store.setOverlay('none');
        return;
      }
      if (state.overlay !== 'none') return;
      if (ritual.stage === 'arriving' && (event.key === 'Enter' || event.key === ' ')) {
        beginArrival();
      }
      // Keyboard alternative to the roasting drag (spec §12).
      if (ritual.stage === 'roasting') {
        if (event.key === 'ArrowUp') roastControl.nudge(-0.04, 0);
        if (event.key === 'ArrowDown') roastControl.nudge(0.04, 0);
        if (event.key === 'ArrowLeft') roastControl.nudge(0, -0.22);
        if (event.key === 'ArrowRight') roastControl.nudge(0, 0.22);
        if (event.key === 'b' && blowOutMarshmallow(ritual)) store.touch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.overlay, ritual, roastControl, beginArrival, store]);

  // --- Simulation-driven audio and subtitles ------------------------------
  const lastSubtitle = useRef<{ text: string; at: number } | null>(null);
  const onSimStep = useCallback(
    (r: RitualState) => {
      const bridge = audioRef.current;
      if (bridge) bridge.update(r);

      // Subtitles for information-bearing sounds (spec §12: nothing is
      // delivered through a single channel).
      const events = r.machine.events;
      if (events.length > 0) {
        const described = describeMachineEvent(events);
        if (described) {
          lastSubtitle.current = { text: described, at: performance.now() };
          store.setSubtitle(described);
        }
      }
      if (r.marshmallow.ignitedThisStep) {
        lastSubtitle.current = { text: '[the marshmallow catches fire]', at: performance.now() };
        store.setSubtitle('[the marshmallow catches fire]');
      }
      if (lastSubtitle.current && performance.now() - lastSubtitle.current.at > 2600) {
        lastSubtitle.current = null;
        store.setSubtitle(null);
      }
    },
    [store],
  );

  // --- Actions -----------------------------------------------------------
  const handleFinishRoasting = useCallback(() => {
    finishRoasting(ritual);
    store.touch();
  }, [ritual, store]);

  const handleTakeSandwich = useCallback(() => {
    const sandwich = takeSandwichAction(ritual);
    if (sandwich) store.saveSandwich(sandwich);
    store.touch();
  }, [ritual, store]);

  const handleBite = useCallback(
    (position: number) => {
      takeBiteAction(ritual, position);
      audioRef.current?.playFoley('bite');
      if (state.accessibility.haptics && typeof navigator.vibrate === 'function') navigator.vibrate(18);
      store.touch();
    },
    [ritual, state.accessibility.haptics, store],
  );

  const handlePhoto = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Re-render synchronously so the drawing buffer holds a frame to read.
    renderer.gl.render(renderer.scene, renderer.camera);
    const canvas = renderer.gl.domElement;
    const photo = capturePhoto(canvas, {
      environmentId: state.environmentId,
      stage: ritual.stage,
      caption: ritual.sandwich ? ritual.sandwich.caption : describeMoment(ritual),
    });
    if (photo) {
      store.addPhoto(photo);
      store.setOverlay('passport');
    }
  }, [state.environmentId, ritual, store]);

  const handleAddLog = useCallback(() => {
    tendFire(ritual, { type: 'add-log', woodId: 'oak', placement: 0.75 });
    store.touch();
  }, [ritual, store]);

  const handleRake = useCallback(() => {
    tendFire(ritual, { type: 'rake' });
    store.touch();
  }, [ritual, store]);

  // Adaptive quality from measured frame time.
  const onFrame = useCallback(
    (frameMs: number) => {
      const next = adaptive.sample(frameMs);
      if (next !== quality) setQuality(next);
    },
    [adaptive, quality],
  );

  const dpr = useMemo(() => {
    // Low internal resolution, upscaled with nearest by the browser
    // (ADR-0003). This is the single largest performance lever in the build.
    const height = QUALITY[quality].internalHeight * state.render.resolutionScale;
    const viewport = typeof window !== 'undefined' ? window.innerHeight : 800;
    return Math.max(0.12, Math.min(1, height / viewport));
  }, [quality, state.render.resolutionScale]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: TOKENS.night }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Canvas
        dpr={dpr}
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false }}
        camera={{ position: LAYOUT.trailStart, fov: 62, near: 0.05, far: 200 }}
        onCreated={({ gl, scene, camera }) => {
          rendererRef.current = { gl, scene, camera };
          gl.setClearColor(0x070a0f, 1);
          // Exposed for the visual-inspection harness and the browser console.
          const handle = window.__someMore;
          if (handle) handle.three = { gl, scene, camera };
        }}
        shadows
      >
        <World
          store={store}
          roastControl={roastControl}
          quality={quality}
          onFrame={onFrame}
          arrivalRef={arrivalRef}
          onSimStep={onSimStep}
        />
      </Canvas>

      <Hud
        ritual={ritual}
        stage={state.stage}
        subtitle={state.subtitle}
        textScale={state.accessibility.textScale}
        highContrast={state.accessibility.highContrast}
        subtitlesEnabled={state.accessibility.subtitles}
        onOpenPassport={() => store.setOverlay('passport')}
        onOpenSettings={() => store.setOverlay('settings')}
        onFinishRoasting={handleFinishRoasting}
        onTakeSandwich={handleTakeSandwich}
        onPhoto={handlePhoto}
        onOpenTerminal={() => store.setOverlay('terminal')}
      />

      {/* Fire tending affordances, shown only where they make sense */}
      {(state.stage === 'at-fire' || state.stage === 'roasting' || state.stage === 'after') && state.overlay === 'none' && (
        <div
          style={{
            position: 'fixed',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            zIndex: 25,
          }}
        >
          <SideButton label="Add wood" onClick={handleAddLog} textScale={state.accessibility.textScale} />
          <SideButton label="Rake coals" onClick={handleRake} textScale={state.accessibility.textScale} />
        </div>
      )}

      {/* Bite targets while eating */}
      {(state.stage === 'eating' || state.stage === 'after') && ritual.sandwich && state.overlay === 'none' && (
        <BiteRing onBite={handleBite} textScale={state.accessibility.textScale} finished={ritual.bite.finished} />
      )}

      {state.overlay === 'passport' && (
        <Passport
          passport={state.passport}
          textScale={state.accessibility.textScale}
          onClose={() => store.setOverlay('none')}
          onLink={(provider) => {
            // Linking is a server operation; the client only records intent
            // until the identity service is reachable.
            store.set({ passport: { ...state.passport, linkedProvider: provider } });
          }}
        />
      )}

      {state.overlay === 'settings' && (
        <Settings
          render={state.render}
          accessibility={state.accessibility}
          audio={state.audio}
          onRender={(partial) => store.updateRender(partial)}
          onAccessibility={(partial) => store.updateAccessibility(partial)}
          onAudio={(partial) => store.updateAudio(partial)}
          onClose={() => store.setOverlay('none')}
        />
      )}

      {state.overlay === 'terminal' && ritual.sandwich && (
        <Terminal
          sandwich={ritual.sandwich}
          textScale={state.accessibility.textScale}
          onClose={() => store.setOverlay('none')}
        />
      )}

      {/* The opening image: a trail in the dark. */}
      {state.stage === 'arriving' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: '12vh',
            pointerEvents: 'none',
            zIndex: 15,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: FONT_STACK.serif,
                fontSize: `${34 * state.accessibility.textScale}px`,
                letterSpacing: '0.22em',
                color: 'rgba(232,224,205,0.9)',
                textShadow: '0 2px 20px rgba(0,0,0,0.9)',
              }}
            >
              SOME MORE
            </div>
            <div
              style={{
                fontFamily: FONT_STACK.mono,
                fontSize: `${11 * state.accessibility.textScale}px`,
                letterSpacing: '0.28em',
                marginTop: 12,
                color: 'rgba(232,224,205,0.55)',
                animation: 'none',
              }}
            >
              {arrivingRef.current ? '' : 'TAP TO WALK IN'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SideButton({ label, onClick, textScale }: { label: string; onClick: () => void; textScale: number }): React.ReactElement {
  return (
    <button
      className="sm-focus"
      onClick={onClick}
      style={{
        background: 'rgba(8,10,14,0.6)',
        color: 'rgba(232,224,205,0.9)',
        border: '1px solid rgba(232,224,205,0.22)',
        padding: `${7 * textScale}px ${12 * textScale}px`,
        fontSize: `${11 * textScale}px`,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        borderRadius: 2,
      }}
    >
      {label}
    </button>
  );
}

/** Eight bite targets arranged around the sandwich, matching the model. */
function BiteRing({
  onBite,
  textScale,
  finished,
}: {
  onBite: (position: number) => void;
  textScale: number;
  finished: boolean;
}): React.ReactElement {
  if (finished) {
    return (
      <div
        style={{
          position: 'fixed',
          left: '50%',
          bottom: '10%',
          transform: 'translateX(-50%)',
          fontFamily: FONT_STACK.hand,
          fontSize: `${18 * textScale}px`,
          color: 'rgba(232,224,205,0.85)',
          zIndex: 25,
        }}
      >
        Nothing left but crumbs.
      </div>
    );
  }
  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '9%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 6,
        zIndex: 25,
      }}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <button
          key={i}
          className="sm-focus"
          aria-label={`Bite from side ${i + 1}`}
          onClick={() => onBite(i)}
          style={{
            width: `${26 * textScale}px`,
            height: `${26 * textScale}px`,
            borderRadius: '50%',
            background: 'rgba(8,10,14,0.55)',
            border: '1px solid rgba(232,224,205,0.3)',
            color: 'rgba(232,224,205,0.8)',
            fontSize: `${11 * textScale}px`,
          }}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function describeMachineEvent(events: readonly MachineEvent[]): string | null {
  if (events.includes('completion-tone')) return '[the machine finishes]';
  if (events.includes('compressor-start')) return '[the compressor starts]';
  if (events.includes('latch-clunk')) return '[the latch clunks shut]';
  if (events.includes('vapour-release')) return '[cold vapour spills out]';
  if (events.includes('stage-blue')) return '[the light turns blue]';
  if (events.includes('door-seal')) return '[the door seals]';
  return null;
}

function describeMoment(ritual: RitualState): string {
  switch (ritual.stage) {
    case 'at-fire':
      return 'By the fire';
    case 'roasting':
      return 'Roasting';
    default:
      return 'The campsite';
  }
}

export { vec3 };
