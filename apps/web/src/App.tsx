/**
 * Application shell.
 *
 * Boot goes toward the world, never toward a menu (spec §6.2). The player
 * lands on a trail in the dark with a fire ahead of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas } from '@react-three/fiber';
import type * as THREE from 'three';
import { Vector3 as ThreeVector3 } from 'three';
import {
  approachPoint,
  basinFor,
  bearingFromFire,
  surveySurroundings,
  castLine,
  clamp01,
  createPlayer,
  describeTorch,
  eyePosition,
  lieBack,
  lookDirection,
  createWorld,
  focused,
  raiseBinoculars,
  releaseCatch,
  setTorchFocus,
  shoreFor,
  sitOnSeat,
  skipStone,
  standFromSeat,
  strikeLine,
  takeFishingRod,
  takeStone,
  takeTorchFromLog,
  terrainHeight,
  toggleTorch,
  bite as takeBiteAction,
  nightEpoch,
  toggleRadio,
  vec3,
  canPerform,
  type Interactable,
  type MachineAction,
  type MachineEvent,
  type MoveIntent,
  type RitualState,
} from '@somemore/sim';
/*
 * The ritual's replicated actions.
 *
 * Same signatures as the `@somemore/sim` functions they shadow, and alone at a
 * campsite they *are* those functions. With other people at the fire they
 * become intents on the wire, applied on the tick the server stamps them with
 * so that every client walks the same timeline (ADR-0006). The import line is
 * the signpost: anything from here may travel. See `net/shared.ts`.
 */
import {
  arrive as arriveAction,
  beginRoasting as beginRoastingAction,
  blowOutMarshmallow,
  finishRoasting,
  holdComponent,
  moveComponent,
  operateMachine,
  placeComponent,
  takeSandwich as takeSandwichAction,
  tendFire,
} from './net/shared.js';
import { World, LAYOUT, hashSeed, isAnchored } from './scene/World.js';
import { KeyboardMovement, MovementController, marchToGround } from './interaction/movementControl.js';
import { getEnvironment } from '@somemore/content';
import { Hud } from './ui/Hud.js';
import { Passport } from './ui/Passport.js';
import { Settings } from './ui/Settings.js';
import { Terminal } from './ui/Terminal.js';
import { RadioDial } from './ui/RadioDial.js';
import { GLOBAL_CSS, TOKENS, FONT_STACK } from './ui/styles.js';
import { Store } from './state/store.js';
import { AdaptiveQuality, applyRenderSettings, probeQualityTier, QUALITY, type QualityTier } from './render/ps1.js';
import {
  applyRoastPose,
  BlowGestureDetector,
  RoastController,
  screenToTableOffset,
} from './interaction/roastControl.js';
import { capturePhoto } from './interaction/photo.js';
import { AudioBridge, type AudioCue } from './audio/bridge.js';
import { defaultApiBaseUrl } from './net/client.js';
import { SyncEngine } from './net/sync.js';
import { Scan } from './ui/Scan.js';
import {
  CodeKeyring,
  ScanFlow,
  keysFromBuild,
  readCachedKeys,
  writeCachedKeys,
} from './net/codes.js';
import { liveApplicable, refreshOverlay } from './net/overlay.js';
import { Campfire } from './net/campfire.js';
import { bindCampfire } from './net/shared.js';
import { parseJoin, realtimeUrl } from './net/join.js';
import { CampfireScene } from './scene/Campfire.js';
import { CampfirePanel } from './ui/Campfire.js';
import { PwaNotices } from './pwa/PwaNotices.js';
import { pwa } from './pwa/register.js';
import { useViewportSize, useWakeLock } from './pwa/viewport.js';

export interface AppProps {
  store: Store;
}

export function App({ store }: AppProps): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const ritual = state.ritual;

  const roastControl = useMemo(() => new RoastController({}, LAYOUT.playerBearing), []);
  const blowDetector = useMemo(() => new BlowGestureDetector(), []);
  const movement = useMemo(() => new MovementController(), []);
  const keyboard = useMemo(() => new KeyboardMovement(), []);
  const intentRef = useRef<MoveIntent>({});

  /**
   * The walkable campsite.
   *
   * Obstacles and interactables are placed from the same LAYOUT the scene
   * uses, so what you can walk into and what you can reach are derived from
   * where things actually are rather than maintained separately.
   */
  const walkable = useMemo(() => {
    const environment = getEnvironment(state.environmentId);
    const seed = hashSeed(state.campsiteSeed);
    const radius = Math.max(8, Math.min(16, environment?.scene.walkableRadiusM ?? 13));
    // Where the water is, if this campsite has any. Everything at the water —
    // the shore you walk to, the stones you reach down for, the rod leaning on
    // the bank — hangs off this one point, and it is derived from the seed so
    // it is in the same place on every visit.
    const spec = environment?.scene.water;
    const shore = spec ? shoreFor(seed, radius) : null;
    const basin = spec && shore ? basinFor(spec, shore) : null;
    const shoreX = shore ? Math.cos(shore.bearing) * (shore.distanceM - 0.7) : 0;
    const shoreZ = shore ? Math.sin(shore.bearing) * (shore.distanceM - 0.7) : 0;

    return createWorld({
      seed,
      radius,
      ...(basin ? { basin } : {}),
      obstacles: [
        { id: 'fire', x: 0, z: 0, radius: 0.62, soft: true },
        { id: 'machine', x: LAYOUT.machine[0], z: LAYOUT.machine[2], radius: 0.62 },
        { id: 'stump', x: LAYOUT.assemblyTable[0], z: LAYOUT.assemblyTable[2], radius: 0.3 },
        { id: 'log', x: -1.5, z: 0.9, radius: 0.4 },
        { id: 'woodpile', x: 1.7, z: -0.9, radius: 0.35 },
      ],
      interactables: [
        { id: 'fire', x: 0, z: 0, reach: 1.45 },
        { id: 'woodpile', x: 1.7, z: -0.9, reach: 1.15 },
        { id: 'machine', x: LAYOUT.machine[0], z: LAYOUT.machine[2], reach: 1.5 },
        { id: 'marshmallows', x: LAYOUT.assemblyTable[0] - 0.16, z: LAYOUT.assemblyTable[2] - 0.16, reach: 1.1 },
        { id: 'plate', x: LAYOUT.assemblyTable[0], z: LAYOUT.assemblyTable[2], reach: 1.1 },
        { id: 'log-seat', x: -1.5, z: 0.9, reach: 1.0 },
        { id: 'radio', x: LAYOUT.radio[0], z: LAYOUT.radio[2], reach: 0.95 },
        // The torch lives on the log with the radio. You pick it up by
        // reaching for it, the same as everything else here.
        // A little more reach than the radio: the torch lies low on the log,
        // and at 0.9 m you are standing over it and looking past it.
        { id: 'torch', x: LAYOUT.torch[0], z: LAYOUT.torch[2], reach: 1.35 },
        // Everything at the water only exists where there is water.
        ...(shore && spec
          ? ([
              { id: 'water-edge', x: shoreX, z: shoreZ, reach: 1.9 },
              ...(spec.skippable
                ? [
                    {
                      id: 'stones',
                      x: shoreX - Math.sin(shore.bearing) * 0.6,
                      z: shoreZ + Math.cos(shore.bearing) * 0.6,
                      reach: 1.2,
                    },
                  ]
                : []),
              ...(spec.fishable
                ? [
                    {
                      id: 'rod',
                      x: shoreX + Math.sin(shore.bearing) * 0.7,
                      z: shoreZ - Math.cos(shore.bearing) * 0.7,
                      reach: 1.2,
                    },
                  ]
                : []),
            ] as Interactable[])
          : []),
      ],
    });
  }, [state.environmentId, state.campsiteSeed]);

  const player = useMemo(() => {
    // Starts out on the trail, walking in.
    const start = LAYOUT.trailStart;
    const p = createPlayer(
      { x: start[0], y: terrainHeight(start[0], start[2], walkable.seed, walkable.amplitude), z: start[2] },
      Math.atan2(-start[2], -start[0]),
    );
    return p;
  }, [walkable]);

  const [reach, setReach] = useState<Interactable | null>(null);
  /** The shared fire, when a link brought us to one. Null for a campsite of one. */
  const [campfire, setCampfire] = useState<Campfire | null>(null);

  /**
   * How the stone is being held, 0..1 on each axis.
   *
   * Not a menu and not a slider panel: the drag at the water's edge writes
   * `power`, `tilt` and `spin`, the camera's own pitch supplies the elevation,
   * and the arrow keys nudge the same numbers for the keyboard path (§12).
   * `skipping.ts` turns them into a speed, an angle and a wrist.
   */
  const throwRef = useRef({ power: 0.72, tilt: 0.36, spin: 0.6 });
  /** The live throwing gesture, or null. */
  const throwGesture = useRef<{
    x0: number;
    y0: number;
    lastX: number;
    lastAt: number;
    flick: number;
  } | null>(null);

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
  const syncRef = useRef<SyncEngine | null>(null);
  const campsiteIdRef = useRef<string | null>(null);
  /**
   * The code keyring and the scan flow.
   *
   * The keyring starts from whatever this build shipped and whatever this
   * device has cached — both synchronous, both public data — so the very first
   * code somebody types can be refused offline without waiting for anything.
   */
  const keyringRef = useRef<CodeKeyring>(new CodeKeyring([...keysFromBuild(import.meta.env), ...readCachedKeys()]));
  const scanRef = useRef<ScanFlow | null>(null);

  const [quality, setQuality] = useState<QualityTier>(() =>
    probeQualityTier({
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
    }),
  );
  const adaptive = useMemo(() => new AdaptiveQuality(quality), []);

  // Publish the player for the inspection harness and the console. The E2E
  // suite asserts on real movement, so it needs the same object the
  // simulation is stepping.
  useEffect(() => {
    const handle = window.__someMore;
    if (handle) {
      handle.player = player;
      handle.walkable = walkable;
    }
  }, [player, walkable]);

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

  // --- Sync ----------------------------------------------------------------
  // Local-first: this establishes an anonymous account and a server-side
  // campsite in the background. Nothing in the ritual waits for it, and a
  // failure means the player carries on with a device-local Passport.
  useEffect(() => {
    const baseUrl = import.meta.env['VITE_API_URL'] ?? defaultApiBaseUrl();
    const sync = new SyncEngine({ baseUrl: String(baseUrl) });
    syncRef.current = sync;
    void (async () => {
      const environment = getEnvironment(state.environmentId);
      const id = await sync.ensureCampsite(
        environment?.name ?? 'Camp',
        state.environmentId,
        hashSeed(state.campsiteSeed) % 2_147_483_647,
      );
      campsiteIdRef.current = id;
      /*
       * Once a photograph's bytes are somewhere better than `localStorage`,
       * the device stops carrying them — which is what lifts the twenty-four
       * cap off the Passport rather than merely raising it.
       */
      sync.onPhotoUploaded = (localId, remoteId, url) => store.markPhotoUploaded(localId, remoteId, url);
      /*
       * And the campsite's memory goes with it. A place that has met you is
       * device-local until this call: lose the phone and it has never met you.
       * Local-first as everything in `net/` is — a failure returns null and the
       * local memory is left byte-identical, so nobody notices.
       */
      if (id !== null) {
        const merged = await sync.syncCampsiteMemory(id, store.campsiteMemory());
        if (merged !== null) store.applyCampsiteMemory(merged);
      }
      void sync.drain();
    })();

    /*
     * Live ops and the code keyring, after the world is already running.
     *
     * Both are strictly background. The campsite was built from the compiled
     * catalogue and the overlay cache before this component mounted, so
     * everything here is about *next* time — plus the one thing that is safe
     * to change mid-session, which is the weather profile the model rolls
     * against (see `net/overlay.ts`). A failure of any kind leaves a campsite
     * that is identical to the one a player with no signal gets.
     */
    scanRef.current = new ScanFlow(sync.api, {
      keyring: keyringRef.current,
      onRedeemed: (result) => {
        store.recordRedeemedCode({
          id: result.redemption.id,
          awarded: result.awarded,
          batchId: result.batchId,
          redeemedAt: Date.parse(result.redemption.redeemedAt) || Date.now(),
        });
      },
    });

    void (async () => {
      const keys = await sync.api.fetchCodeKeys();
      if (keys.ok) {
        keyringRef.current.add(keys.value.keys);
        writeCachedKeys(keys.value.keys, keys.value.mintingKeyId);
      }
    })();

    void (async () => {
      const { result } = await refreshOverlay({
        environmentId: state.environmentId,
        baseUrl: String(baseUrl),
      });
      const live = liveApplicable(result);
      store.applyLiveContent({
        events: result.events,
        source: result.source,
        ...(live ? { weather: live.weather } : {}),
      });
    })();

    return () => sync.dispose();
  }, [state.environmentId, state.campsiteSeed, store]);

  /* --- A shared campfire -------------------------------------------------
   *
   * Only when a link says so. There is no lobby and no "multiplayer" mode
   * (spec §9): a campsite of one constructs nothing here and keeps calling the
   * simulation directly, which is why single-player behaviour is unchanged
   * rather than merely equivalent. A link with a `fire=` on it opens a socket,
   * and everything downstream — the shared timeline, the people, voice —
   * exists only for the life of that socket.
   *
   * Nothing in the ritual waits for any of it (ARCHITECTURE §1.5). If the
   * socket never opens, or opens and drops, the fire is still lit.
   */
  useEffect(() => {
    const intent = parseJoin(typeof location === 'undefined' ? '' : location.search);
    if (intent === null) return;

    const baseUrl = String(import.meta.env['VITE_API_URL'] ?? defaultApiBaseUrl());
    const token = intent.token ?? persistedAuthToken();
    if (token === null) return;

    let subtitleTimer: ReturnType<typeof setTimeout> | null = null;

    const fire = new Campfire({
      transport: {
        url: intent.wsUrl ?? realtimeUrl(baseUrl),
        token,
        sessionId: intent.sessionId,
        ...(intent.join === undefined ? {} : { join: intent.join }),
      },
      // Every value here is derived from the session or the environment, so
      // that two clients rebuilding the same world rebuild the same world.
      ritualOptionsFor: (environmentId, sessionOriginMs) => {
        const environment = getEnvironment(environmentId);
        return {
          now: sessionOriginMs,
          skyEpochMs: nightEpoch(new Date(sessionOriginMs), -73),
          ...(environment ? { weatherProfile: environment.weather } : {}),
          ...(environment
            ? {
                world: {
                  wildlife: environment.wildlife,
                  radio: environment.radio,
                  secrets: environment.secrets,
                  ...(environment.scene.water ? { water: environment.scene.water } : {}),
                  skyOpenness: environment.scene.skyOpenness,
                },
                walkableRadiusM: environment.scene.walkableRadiusM,
              }
            : {}),
        };
      },
      assists: () => ({
        autoRotate: store.state.accessibility.autoRotate,
        assemblyAssist: store.state.accessibility.assemblyAssist,
      }),
      onAdopt: (shared, seed, environmentId) => store.adoptRitual(shared, seed, environmentId),
      /*
       * Everything the fire says out loud, said in text as well (spec §12) —
       * and then taken away again. The simulation's own cues expire on a timer
       * inside `onSimStep`; these arrive from the socket, outside that loop, so
       * they need their own. Without it "somebody is coming down the trail"
       * stayed on screen for the rest of the night.
       */
      onSubtitle: (line) => {
        store.setSubtitle(line);
        if (subtitleTimer !== null) clearTimeout(subtitleTimer);
        subtitleTimer = setTimeout(() => {
          subtitleTimer = null;
          if (store.state.subtitle === line) store.setSubtitle(null);
        }, 3_200);
      },
      onChange: () => {
        /*
         * Republish the stage as well as nudging React.
         *
         * `setStageFromRitual` is otherwise only called by the render loop when
         * it *observes a transition*, and adopting a shared world swaps the
         * ritual out from under a ref that may already have consumed one. The
         * symptom was a joining player looking at a live campsite with the
         * title card still over it, invited to tap to walk in to a fire they
         * were already sitting at. It is idempotent, so calling it on every
         * campfire event costs a comparison.
         */
        store.setStageFromRitual();
        store.touch();
      },
    });

    bindCampfire(fire);
    store.campfire = fire;
    setCampfire(fire);
    fire.connect();
    const handle = window.__someMore;
    if (handle) (handle as { campfire?: Campfire }).campfire = fire;

    return () => {
      if (subtitleTimer !== null) clearTimeout(subtitleTimer);
      bindCampfire(null);
      store.campfire = null;
      setCampfire(null);
      fire.dispose();
    };
  }, [store]);

  useEffect(() => {
    audioRef.current?.applySettings(state.audio);
  }, [state.audio]);

  /**
   * Folds the night back into this campsite's memory.
   *
   * On a slow cadence rather than every frame: everything it merges is
   * idempotent, and a campsite that remembers you is worth a write every half
   * minute. `pagehide` rather than `unload` because iOS never fires `unload`,
   * and a player who closes the tab from the app switcher is the ordinary
   * case, not the exception.
   */
  useEffect(() => {
    /*
     * The same cadence carries the memory to the service, because the merge is
     * idempotent and a snapshot is cheap. `void` rather than `await`: a slow
     * or missing service must not delay the local write, which is the one that
     * actually keeps the campsite.
     */
    const push = (memory: ReturnType<Store['rememberCampsite']>): void => {
      const campsiteId = campsiteIdRef.current;
      const sync = syncRef.current;
      if (campsiteId === null || sync === null) return;
      void sync.syncCampsiteMemory(campsiteId, memory).then((merged) => {
        if (merged !== null) store.applyCampsiteMemory(merged);
      });
    };
    const timer = setInterval(() => push(store.rememberCampsite()), 30_000);
    const remember = (): void => {
      push(store.rememberCampsite());
    };
    window.addEventListener('pagehide', remember);
    document.addEventListener('visibilitychange', remember);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', remember);
      document.removeEventListener('visibilitychange', remember);
      remember();
    };
  }, [store]);

  const unlockAudio = useCallback(() => {
    if (state.audioReady) return;
    void audioRef.current?.unlock().then((ok: boolean) => {
      if (!ok) return;
      // The campsite layout is the scene's business, so the positions are
      // pushed in from here rather than guessed by the audio engine.
      audioRef.current?.placeEmitters({
        fire: [0, 0.2, 0],
        machine: LAYOUT.machine,
        radio: LAYOUT.radio,
      });
      store.set({ audioReady: true });
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
        // World places the player at the fireside on the stage change, so
        // every route in lands identically.
        arriveAction(ritual);
        store.touch();
      }
    };
    requestAnimationFrame(tick);
  }, [ritual, store]);

  /**
   * Throws the stone in hand.
   *
   * The hand is where the player is standing, at chest height, and the bearing
   * is where they are facing — so you throw at the water you are looking at,
   * not at a designated spot.
   */
  const throwHeldStone = useCallback(() => {
    const water = ritual.water;
    if (!water) return;
    const eye = eyePosition(player);
    const held = throwRef.current;
    const thrown = skipStone(
      ritual,
      {
        power: held.power,
        // Elevation comes from where the player is actually looking. Down at
        // the water is a flat throw; up over it is a lob, and the physics
        // punishes a lob exactly as it should.
        elevation: clamp01((player.pitch + 0.24) / 0.62),
        tilt: held.tilt,
        spin: held.spin,
        bearing: player.facing,
      },
      vec3(eye.x, eye.y - 0.22, eye.z),
    );
    if (thrown) audioRef.current?.playFoley('stick');
    store.touch();
  }, [ritual, player, store]);

  /** Acts on whatever is within reach. The world offers; it never menus. */
  const handleUse = useCallback(() => {
    const target = focused(player, walkable);
    if (!target) return;
    switch (target.id) {
      case 'woodpile': {
        const environment = getEnvironment(state.environmentId);
        const woodId = environment?.fuel.sources[0]?.woodId ?? 'oak';
        tendFire(ritual, { type: 'add-log', woodId });
        audioRef.current?.playFoley('stick');
        break;
      }
      case 'fire':
        tendFire(ritual, { type: 'rake' });
        break;
      case 'marshmallows':
        if (ritual.stage === 'at-fire' || ritual.stage === 'after') beginRoastingAction(ritual);
        break;
      case 'machine':
        if (ritual.stage === 'at-fire' || ritual.stage === 'after') store.setSubtitle('[the SM-01 is idle]');
        break;
      case 'log-seat':
        // Sitting down is the least flashy thing here and possibly the most
        // important: it is the strongest generator of stillness in the
        // product, which is what the wildlife and the discovery models read.
        intentRef.current.sit = !player.seated;
        if (player.seated) standFromSeat(ritual);
        else sitOnSeat(ritual, 'log-seat');
        break;
      case 'torch':
        if (ritual.torch.held) {
          toggleTorch(ritual);
          store.setSubtitle(describeTorch(ritual.torch));
        } else {
          takeTorchFromLog(ritual);
          store.setSubtitle('[you pick the torch up off the log]');
        }
        audioRef.current?.playFoley('stick');
        break;
      case 'stones': {
        const stone = takeStone(ritual);
        if (stone) store.setSubtitle(`[${stone.note}]`);
        break;
      }
      case 'water-edge':
        // Standing at the water with a stone in hand, the thing to do is throw
        // it. With nothing in hand, you reach down for one.
        if (ritual.skipping.held) throwHeldStone();
        else {
          const stone = takeStone(ritual);
          if (stone) store.setSubtitle(`[${stone.note}]`);
        }
        break;
      case 'rod':
        if (ritual.fishing.phase === 'stowed') {
          takeFishingRod(ritual);
          store.setSubtitle('[you pick up the rod]');
        } else if (ritual.fishing.phase === 'nibble') {
          strikeLine(ritual);
        } else if (ritual.fishing.phase === 'landed') {
          releaseCatch(ritual);
        } else {
          castLine(ritual, throwRef.current.power, bearingFromFire(player) + Math.PI);
        }
        break;
      case 'radio':
        // Picking it up switches it on. Nobody crouches over a dead radio.
        if (!ritual.radio.on) toggleRadio(ritual, true);
        store.setOverlay('radio');
        audioRef.current?.playFoley('stick');
        break;
      default:
        break;
    }
    store.touch();
  }, [player, walkable, ritual, state.environmentId, store, throwHeldStone]);

  // --- Pointer handling --------------------------------------------------
  const dragging = useRef(false);
  const pointerStart = useRef({ x: 0, y: 0 });

  /*
   * How far the stick has been pulled back, for the guidance line only.
   *
   * Kept out of the store: it changes on every pointer move of a drag, and the
   * store notifies every subscriber. The ref is what the guard reads so a
   * render only happens when the *rounded* value moves — which is roughly ten
   * times across a whole pull rather than once per pointer event.
   */
  const [withdraw, setWithdraw] = useState(0);
  const withdrawRef = useRef(0);
  const reportWithdraw = useCallback((value: number) => {
    const rounded = Math.round(value * 10) / 10;
    if (rounded === withdrawRef.current) return;
    withdrawRef.current = rounded;
    setWithdraw(rounded);
  }, []);

  /*
   * Taking the marshmallow off the fire.
   *
   * Above the pointer handlers because they call it: the pull that carries the
   * stick to the plate is a drag, not a button, so this is now part of the
   * interaction rather than something the HUD does afterwards.
   */
  const handleFinishRoasting = useCallback(() => {
    reportWithdraw(0);
    finishRoasting(ritual);
    store.touch();
  }, [ritual, store, reportWithdraw]);

  /**
   * Set by the fire pit while a piece of fuel is being dragged.
   *
   * The pit's own handlers run first — they are native listeners on the canvas
   * and these are React handlers on the element around it — so by the time a
   * pointer event reaches here, this already says whether the gesture belongs
   * to the wood.
   */
  const grabbedFuel = useRef<string | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      unlockAudio();
      if (state.overlay !== 'none') return;
      store.setControls('pointer');

      if (ritual.stage === 'arriving') {
        beginArrival();
        return;
      }

      // A piece of wood in hand. The drag belongs to the fire.
      if (grabbedFuel.current !== null) return;

      // A stone in hand at the water's edge: the drag *is* the throw. It
      // takes priority over looking and walking, the same way the roasting
      // drag takes priority once there is a marshmallow on the stick.
      if (!isAnchored(ritual.stage) && ritual.skipping.held && atTheWater(reach)) {
        throwGesture.current = {
          x0: event.clientX,
          y0: event.clientY,
          lastX: event.clientX,
          lastAt: performance.now(),
          flick: 0,
        };
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }

      // Exploring: one finger serves both looking and walking. The gesture
      // stays undecided until it either travels (look) or lifts (tap).
      if (!isAnchored(ritual.stage)) {
        movement.useJoystick = state.accessibility.virtualJoystick;
        movement.begin(event.clientX, event.clientY, performance.now());
        (event.target as Element).setPointerCapture?.(event.pointerId);
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
    [state.overlay, ritual, roastControl, blowDetector, beginArrival, unlockAudio, store, reach],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (grabbedFuel.current !== null) return;
      const gesture = throwGesture.current;
      if (gesture) {
        // Pull back for power, across for how the stone is cocked in the hand.
        const held = throwRef.current;
        held.power = clamp01((event.clientY - gesture.y0) / 190);
        held.tilt = clamp01(0.36 + (event.clientX - gesture.x0) / 420);
        // Spin is a flick, so it is measured from speed rather than distance —
        // which is what it is in a real hand.
        const now = performance.now();
        const dt = Math.max(1, now - gesture.lastAt);
        const speed = Math.abs(event.clientX - gesture.lastX) / dt;
        gesture.flick = Math.max(gesture.flick * 0.86, speed);
        gesture.lastX = event.clientX;
        gesture.lastAt = now;
        held.spin = clamp01(gesture.flick / 1.6);
        return;
      }
      if (!isAnchored(ritual.stage) && ritual.stage !== 'arriving') {
        const look = movement.move(event.clientX, event.clientY);
        if (look) intentRef.current.look = look;
        if (movement.gesture === 'joystick') intentRef.current.move = movement.joystick();
        return;
      }
      if (!dragging.current) return;
      if (ritual.stage === 'roasting') {
        roastControl.move(event.clientX, event.clientY);
        // Pulled all the way back past the fire: it is off the heat and on its
        // way to the plate. See `withdrawToPlate` — this used to be a button.
        if (roastControl.withdrawProgress >= 1) {
          roastControl.resetWithdraw();
          roastControl.end();
          dragging.current = false;
          handleFinishRoasting();
          return;
        }
        reportWithdraw(roastControl.withdrawProgress);
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
    [ritual, roastControl, blowDetector, store, handleFinishRoasting, reportWithdraw],
  );

  const onPointerUp = useCallback(() => {
    if (throwGesture.current) {
      throwGesture.current = null;
      throwHeldStone();
      return;
    }
    if (!isAnchored(ritual.stage) && ritual.stage !== 'arriving') {
      const wasJoystick = movement.gesture === 'joystick';
      const tap = movement.end(performance.now());
      if (wasJoystick) intentRef.current.move = { forward: 0, strafe: 0 };
      if (tap) handleTap(tap.x, tap.y);
      return;
    }
    if (!dragging.current) return;
    dragging.current = false;
    roastControl.end();
    if (ritual.stage === 'assembling' && ritual.assembly.heldKind) {
      placeComponent(ritual);
      audioRef.current?.playFoley(ritual.assembly.placedThisStep === 'graham-top' ? 'squish' : 'graham-snap');
      store.touch();
    }
  }, [ritual, roastControl, store, throwHeldStone]);

  // --- Keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        store.setOverlay('none');
        return;
      }
      if (state.overlay !== 'none') return;
      // Whatever they last used is what the guidance line should describe.
      // Escape is excluded on purpose: dismissing an overlay is not a
      // statement about how somebody intends to play.
      store.setControls('keyboard');
      /*
       * What is around me (audit A5).
       *
       * Everything else the interface says is about something that just
       * changed. This is the one thing you can *ask*, and the campsite is a
       * place rather than a sequence of prompts partly because of it. It never
       * volunteers — a world that describes itself unprompted is one nobody is
       * standing in — and it is delivered on the screen as well as to the live
       * region, because a survey that only some people can have is the §12 rule
       * broken by the feature written to keep it.
       */
      if (event.key === 'q') {
        // `store.state` rather than the `state` this handler closed over: the
        // effect does not re-register when the survey changes, so the captured
        // copy still says `null` after the first press and the toggle would
        // only ever open.
        store.setSurvey(
          store.state.survey === null
            ? surveySurroundings(ritual, player, walkable, { places: ritual.presence.places })
            : null,
        );
        return;
      }
      // Who is at the fire. A key as well as a button, because every social
      // act at a shared fire needs a non-gestural path (spec §12).
      if (event.key === 'k' && campfire !== null) {
        store.setOverlay('campfire');
        return;
      }
      if (ritual.stage === 'arriving' && (event.key === 'Enter' || event.key === ' ')) {
        beginArrival();
      }
      /*
       * Walking and looking on the keyboard, as an alternate control scheme
       * (spec §12). WASD walks; the arrows look.
       *
       * The look half is the one that was missing, and it was missing
       * completely: `player.facing` only ever moved from a pointer look delta
       * or from walking toward a tapped point, so on the keyboard alone a
       * player could translate around the campsite and never turn — no sky, no
       * aiming the torch, no facing the water to fish, no looking at an
       * animal. Every one of §5.2's activities was behind a pointer.
       *
       * A held key is a *rate*, not a delta, so it goes in `lookRate` and the
       * simulation multiplies it by `dt`. Putting it in `look` would have made
       * one keypress turn the player once per fixed step — which is the bug
       * the pointer path had.
       */
      if (!isAnchored(ritual.stage) && ritual.stage !== 'arriving') {
        const before = keyboard.active;
        keyboard.down(event.key);
        if (keyboard.active || before) {
          intentRef.current.move = keyboard.intent();
          // A stone in the hand borrows the arrows to wind itself up, exactly
          // as a stone in the hand borrows the drag. Looking resumes the
          // moment it leaves.
          intentRef.current.lookRate = ritual.skipping.held ? NO_LOOK : keyboard.look();
        }
        if (event.key === 'e' || event.key === 'Enter' || event.key === ' ') handleUse();
      }
      // Keyboard alternatives for the secondary activities (spec §12). Every
      // one of them reaches the same intent the gesture does; none of them
      // opens a menu.
      if (!isAnchored(ritual.stage) && ritual.stage !== 'arriving') {
        if (event.key === 'f') {
          if (ritual.torch.held) toggleTorch(ritual);
          else takeTorchFromLog(ritual);
          store.setSubtitle(describeTorch(ritual.torch));
          store.touch();
        }
        if (event.key === 'g' && ritual.torch.held) {
          // Twisting the head, in two steps. Flood for close in, spot for the
          // treeline — and the spot is what scares things off from further away.
          setTorchFocus(ritual, ritual.torch.focus > 0.5 ? 0.15 : 0.9);
          store.setSubtitle(describeTorch(ritual.torch));
          store.touch();
        }
        if (event.key === 'c') {
          // Lying back. The camera stays the player's own eyes; what changes
          // is that the sky is steady enough to actually look at.
          const reclined = ritual.stargazing.posture !== 'reclined';
          lieBack(ritual, reclined);
          if (reclined) intentRef.current.sit = true;
          store.touch();
        }
        if (event.key === 'v') {
          raiseBinoculars(ritual, !ritual.stargazing.binoculars);
          store.touch();
        }
        // Winding the stone up on the keyboard: the same three numbers the
        // drag writes.
        if (ritual.skipping.held) {
          const held = throwRef.current;
          if (event.key === 'ArrowUp') held.power = clamp01(held.power + 0.08);
          if (event.key === 'ArrowDown') held.power = clamp01(held.power - 0.08);
          if (event.key === 'ArrowLeft') held.tilt = clamp01(held.tilt - 0.05);
          if (event.key === 'ArrowRight') held.tilt = clamp01(held.tilt + 0.05);
          if (event.key === '[') held.spin = clamp01(held.spin - 0.12);
          if (event.key === ']') held.spin = clamp01(held.spin + 0.12);
          if (event.key === 't') throwHeldStone();
        }
        if (event.key === 'r' && ritual.fishing.phase !== 'stowed') {
          // One key for the whole rod: cast, strike, put it back. There is
          // nothing else you can do with a fishing rod.
          if (ritual.fishing.phase === 'nibble') strikeLine(ritual);
          else if (ritual.fishing.phase === 'landed') releaseCatch(ritual);
          else castLine(ritual, throwRef.current.power, player.facing);
          store.touch();
        }
      }
      // Keyboard alternative to the roasting drag (spec §12).
      if (ritual.stage === 'roasting') {
        if (event.key === 'ArrowUp') roastControl.nudge(-0.04, 0);
        if (event.key === 'ArrowDown') roastControl.nudge(0.04, 0);
        if (event.key === 'ArrowLeft') roastControl.nudge(0, -0.22);
        if (event.key === 'ArrowRight') roastControl.nudge(0, 0.22);
        // Applied here rather than left for the next frame: see
        // `applyRoastPose`. Presses that arrive between two frames must all
        // reach the marshmallow, not just the last one.
        applyRoastPose(
          roastControl,
          ritual,
          bearingFromFire(player),
          state.accessibility.autoRotate <= 0,
        );
        // Holding "further away" past the end of the band carries the stick to
        // the plate, exactly as a drag does. No second mechanism.
        if (roastControl.withdrawProgress >= 1) {
          roastControl.resetWithdraw();
          handleFinishRoasting();
        } else {
          reportWithdraw(roastControl.withdrawProgress);
        }
        if (event.key === 'b' && blowOutMarshmallow(ritual)) store.touch();
      }

      /*
       * Assembly, on the keyboard.
       *
       * This stage was reachable by pointer drag and by nothing else: pick up
       * happens on `pointerdown`, the offset comes from pointer travel, and
       * set-down happens on `pointerup`. Roasting and exploring both had a
       * keyboard alternative from the start; assembly never did, which meant
       * the ritual simply stopped here for anyone who cannot drag — and §12
       * asks for an alternate control scheme, not a shorter ritual.
       *
       * It reaches the same three calls the drag reaches, so placement still
       * genuinely matters: what you set down where is recorded and shows up on
       * the finished sandwich. This is not a "Build" button (§1.3).
       */
      if (ritual.stage === 'assembling') {
        const assembly = ritual.assembly;
        if (event.key === 'Enter' || event.key === ' ') {
          if (assembly.heldKind) {
            placeComponent(ritual);
            audioRef.current?.playFoley(
              ritual.assembly.placedThisStep === 'graham-top' ? 'squish' : 'graham-snap',
            );
          } else {
            holdComponent(ritual);
          }
          store.touch();
        } else if (assembly.heldKind) {
          // A step small enough that the stack still comes out handmade: the
          // drag writes offsets of a few millimetres and so does this.
          const step = 0.003;
          const offset = vec3(assembly.heldOffset.x, assembly.heldOffset.y, assembly.heldOffset.z);
          let rotation = assembly.heldRotation;
          let moved = true;
          switch (event.key) {
            case 'ArrowUp':
              offset.z -= step;
              break;
            case 'ArrowDown':
              offset.z += step;
              break;
            case 'ArrowLeft':
              offset.x -= step;
              break;
            case 'ArrowRight':
              offset.x += step;
              break;
            case '[':
              rotation -= 0.08;
              break;
            case ']':
              rotation += 0.08;
              break;
            default:
              moved = false;
          }
          if (moved) {
            moveComponent(ritual, offset, rotation);
            store.touch();
          }
        }
      }

      /*
       * The SM-01, on the keyboard.
       *
       * Its controls are meshes inside the canvas, so until now the whole of
       * §3.2 — the door, the latch, the program, the confirm, the lever — was
       * a pointer-only sequence. One key per control, never one key for the
       * run: the twelve stages are the product, and a single "go" key would be
       * the canned-video substitution §1.3 rules out. `canPerform` decides
       * what a key means where a control does two things, which is exactly
       * what the mesh under the pointer does.
       */
      if (ritual.stage === 'machine' || ritual.stage === 'reveal') {
        const machine = ritual.machine;
        const operate = (action: MachineAction): void => {
          if (operateMachine(ritual, action)) store.touch();
        };
        switch (event.key) {
          case 'l':
            operate({ type: 'load' });
            break;
          case 'd':
            operate(canPerform(machine, 'close-door') ? { type: 'close-door' } : { type: 'open-door' });
            break;
          case 'x':
            operate(
              canPerform(machine, 'engage-latch') ? { type: 'engage-latch' } : { type: 'release-latch' },
            );
            break;
          case '1':
            operate({ type: 'set-program', program: 'soft-set' });
            break;
          case '2':
            operate({ type: 'set-program', program: 'standard' });
            break;
          case '3':
            operate({ type: 'set-program', program: 'deep-freeze' });
            break;
          case 'Enter':
          case ' ':
            operate({ type: 'confirm' });
            break;
          case 'p':
            operate({ type: 'pull-lever' });
            break;
          default:
            break;
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keyboard.up(event.key);
      intentRef.current.move = keyboard.intent();
      intentRef.current.lookRate = ritual.skipping.held ? NO_LOOK : keyboard.look();
    };
    // Losing focus mid-stride must not leave the player walking forever — or,
    // worse, turning forever, which a rate very much would.
    const onBlur = () => {
      keyboard.clear();
      intentRef.current.move = { forward: 0, strafe: 0 };
      intentRef.current.lookRate = NO_LOOK;
      movement.cancel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    state.overlay,
    state.accessibility.autoRotate,
    ritual,
    roastControl,
    beginArrival,
    // Both are called from the roasting branch: the pull to the plate is a
    // keyboard act as well as a drag, so a stale closure here would be a stale
    // `ritual` inside it.
    handleFinishRoasting,
    reportWithdraw,
    store,
    keyboard,
    movement,
    handleUse,
    player,
    throwHeldStone,
    campfire,
  ]);

  // --- Simulation-driven audio and subtitles ------------------------------
  const lastSubtitle = useRef<{ text: string; at: number } | null>(null);
  const listenerScratch = useRef({ eye: vec3(), look: vec3() });
  const onSimStep = useCallback(
    (r: RitualState) => {
      const bridge = audioRef.current;
      let cue: AudioCue | null = null;
      if (bridge) {
        // The listener has to move with the player or nothing is anywhere: the
        // radio on the log and an animal behind you both depend on it.
        const scratch = listenerScratch.current;
        bridge.listener(eyePosition(player, scratch.eye), lookDirection(player, scratch.look));
        cue = bridge.update(r);
      }

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
      // The radio and the wildlife say what they are: the copy comes from the
      // simulation (`describeReception`, `describeSighting`), never from here.
      if (cue && cue.text !== lastSubtitle.current?.text) {
        lastSubtitle.current = { text: cue.text, at: performance.now() };
        store.setSubtitle(cue.text);
      }
      if (lastSubtitle.current && performance.now() - lastSubtitle.current.at > 2600) {
        lastSubtitle.current = null;
        store.setSubtitle(null);
      }
    },
    [player, store],
  );

  /**
   * Turns a tap into either a destination or an interaction.
   *
   * The ground point is found by marching the camera ray against the terrain
   * height function rather than raycasting the mesh: the same analytic
   * function the simulation walks on, so where you tap and where you arrive
   * cannot disagree.
   */
  const handleTap = useCallback(
    (screenX: number, screenY: number) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const canvas = renderer.gl.domElement;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((screenY - rect.top) / rect.height) * 2 - 1);

      const ground = groundPointAt(renderer.camera, ndcX, ndcY, walkable);
      if (!ground) return;

      // Tapping on or beside a thing walks you to it rather than through it.
      let nearest: Interactable | null = null;
      let nearestDistance = Infinity;
      for (const candidate of walkable.interactables) {
        const distance = Math.hypot(candidate.x - ground.x, candidate.z - ground.z);
        if (distance < Math.max(0.9, candidate.reach * 0.8) && distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }

      if (nearest) {
        const point = approachPoint(nearest, player, Math.max(0.7, nearest.reach * 0.62));
        intentRef.current.target = point;
      } else {
        intentRef.current.target = ground;
      }
      intentRef.current.sit = false;
    },
    [walkable, player],
  );

  // --- Actions -----------------------------------------------------------
  const handleTakeSandwich = useCallback(() => {
    const sandwich = takeSandwichAction(ritual);
    if (sandwich) {
      store.saveSandwich(sandwich);
      // Queued, never awaited. The Passport already has it.
      const campsiteId = campsiteIdRef.current;
      if (campsiteId) {
        try {
          syncRef.current?.enqueueSandwich(sandwich, campsiteId);
        } catch {
          // A mapping failure must never cost the player their sandwich.
        }
      }
    }
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
      // The photograph is already in the Passport as a data URL, which is what
      // the player is looking at. Whether it also reaches object storage is a
      // background fact they are never asked to care about, and the queue
      // survives a reload if it does not happen tonight.
      syncRef.current?.enqueuePhoto(photo, campsiteIdRef.current);
    }
  }, [state.environmentId, ritual, store]);

  /*
   * What the fire is asking for, if anything.
   *
   * Read from the simulation rather than from a timer, so the prompt appears
   * because the fire is genuinely dying back or genuinely smothered — which is
   * also the moment a person would look up from the marshmallow and notice.
   */
  const fireWantsWood = ritual.fire.flame < 0.34;
  const fireWantsRaking = ritual.fire.oxygen < 0.55 && ritual.fire.emberMass > 0.2;

  const handleAddLog = useCallback(() => {
    tendFire(ritual, { type: 'add-log', woodId: 'oak' });
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

  // --- Installed, and on a phone ------------------------------------------
  /**
   * The live viewport, the worker, and the screen staying awake.
   *
   * The viewport is read continuously rather than once, because `dpr` below is
   * derived from its height: a phone turned on its side halves the height and
   * would otherwise keep rendering at the internal resolution it chose in
   * portrait, which on a 390x844 screen is about twice the pixels it should be.
   * That is a frame-rate defect only a rotating device ever shows.
   */
  const viewport = useViewportSize();

  useEffect(() => {
    // Not in dev: a worker holding a cache-first copy of an unbundled module
    // graph is a debugging session nobody asked for. `vite.config.ts` serves a
    // self-unregistering worker there instead.
    if (import.meta.env.PROD) pwa.register();
  }, []);

  // Forty-five seconds of watching a machine work, with both hands off the
  // glass, is exactly when a phone decides nobody is there.
  useWakeLock(
    ritual.machine.stage === 'processing' ||
      ritual.machine.stage === 'freezing' ||
      ritual.machine.stage === 'transforming',
  );

  /**
   * Comes back with the sound still on.
   *
   * iOS moves an `AudioContext` to `interrupted` when the app goes to the
   * background — a phone call, the app switcher, a notification — and does not
   * bring it back on its own. Without this, taking a call during a machine run
   * and returning finds a silent campfire, which for a product whose whole
   * machine narrative is carried by sound is the same as it being broken.
   * `unlock()` is safe to call again: it reuses the engine and only starts the
   * beds once.
   */
  useEffect(() => {
    if (!state.audioReady) return;
    const resume = (): void => {
      if (document.visibilityState !== 'visible') return;
      void audioRef.current?.unlock();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [state.audioReady]);

  const dpr = useMemo(() => {
    // Low internal resolution, upscaled with nearest by the browser
    // (ADR-0003). This is the single largest performance lever in the build.
    const height = QUALITY[quality].internalHeight * state.render.resolutionScale;
    return Math.max(0.12, Math.min(1, height / Math.max(1, viewport.height)));
  }, [quality, state.render.resolutionScale, viewport.height]);

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
          /*
           * The world, named (spec §12, audit A5).
           *
           * Everything a player does out here is pixels as far as assistive
           * technology is concerned, and an unlabelled canvas is announced as
           * nothing at all. This does not pretend to make a 3D campsite
           * navigable without sight — the HUD's live regions carry the state
           * changes, and what is still missing is any way to *survey* what is
           * there, which is recorded as open in the audit. What it does is
           * stop the largest element on the page being anonymous.
           */
          gl.domElement.setAttribute('role', 'img');
          gl.domElement.setAttribute(
            'aria-label',
            'The campsite, in three dimensions. What happens here is described in the lines above and below it.',
          );
          // Exposed for the visual-inspection harness and the browser console.
          const handle = window.__someMore;
          if (handle) handle.three = { gl, scene, camera };
        }}
        shadows
      >
        <World
          store={store}
          roastControl={roastControl}
          onLiftSandwich={handleTakeSandwich}
          quality={quality}
          onFrame={onFrame}
          arrivalRef={arrivalRef}
          onSimStep={onSimStep}
          player={player}
          intentRef={intentRef}
          walkable={walkable}
          onReachChange={setReach}
          grabbedFuelRef={grabbedFuel}
        />

        {/* The other people, when there are any. Nothing is constructed and
            nothing is drawn at a campsite of one. */}
        {campfire !== null && (
          <CampfireScene
            fire={campfire}
            ritual={ritual}
            settings={state.render}
            player={player}
            walkable={walkable}
            audio={audioRef}
            micMuted={campfire.voice.muted}
          />
        )}
      </Canvas>

      <Hud
        ritual={ritual}
        reach={reach}
        grip={throwRef.current}
        seated={player.seated}
        onUse={handleUse}
        /*
         * Nothing is offered while your hands are full of sandwich.
         *
         * Eating used to be an anchored stage, so the player had no position
         * worth speaking of and no reach prompt could appear. Freeing the camera
         * left them standing wherever the ritual finished — which is at the
         * machine — and the campsite politely offered them "The SM-01" while
         * they were biting into a s'more, on top of the bite targets. The
         * collision is how it was found; the nonsense is the actual defect.
         */
        exploring={
          !isAnchored(state.stage) &&
          state.stage !== 'arriving' &&
          !(ritual.sandwich !== null && !ritual.bite.finished)
        }
        stage={state.stage}
        subtitle={state.subtitle}
        controls={state.controls}
        notice={state.notice}
        withdraw={withdraw}
        survey={state.survey}
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

      {/* "Keep this campsite" and "there is a newer one" — both quiet, both
          dismissible, and neither of them allowed anywhere near the ritual. */}
      <PwaNotices
        stage={state.stage}
        overlayOpen={state.overlay !== 'none'}
        textScale={state.accessibility.textScale}
        highContrast={state.accessibility.highContrast}
      />

      {/* Fire tending affordances, shown only where they make sense */}
      {/* Kept as an accessibility fallback for anyone who cannot walk to the
          woodpile or aim a tap; the diegetic route is to reach for them. */}
      {/*
        Offered when they would do something, not for the whole roast.

        These two sat on screen for every second of roasting, which is the
        opposite of the spec's ethos -- you are supposed to reach for the
        woodpile, not press a button labelled with what pressing it does. They
        cannot simply go: while roasting your hands are on the stick and
        movement is locked, so there is no route to the woodpile without
        abandoning the marshmallow, and a fire you cannot feed is worse than a
        button.

        So they appear when the fire actually wants them. A flame dying back
        wants wood; a bed of coals that has gone quiet under ash wants raking.
        The rest of the time the frame belongs to the fire. Simplified gestures
        keeps both permanently, because for somebody relying on that setting a
        control that comes and goes is worse than one that is always there.
      */}
      {/*
        Raking is a thing you can do with a stick in your hand. Feeding the
        fire is not.
        
        "Add wood" was the shortcut that let a player skip the only genuinely
        consequential decision at the campsite. The woodpile has always handed
        back the species of the log you reached for, and the six woods differ
        by a factor of three in how fast they burn and by more than that in the
        bed they leave -- so a button that picks for you is a button that plays
        the fire game on your behalf and then hands you a worse sandwich for
        reasons you cannot see.
        
        Taking it away is what makes the rhythm real: you set the marshmallow
        down, walk to the pile, choose, and come back. Nothing is lost by
        leaving the fire for a minute -- the ember bed has a quarter of an hour
        in it -- and that is exactly the slack the night is supposed to have.
        
        Simplified gestures keeps both controls, because for somebody relying
        on that setting a walk to the woodpile is not a rhythm, it is a wall.
      */}
      {((state.stage === 'roasting' && fireWantsRaking) ||
        state.accessibility.simplifiedGestures) &&
        state.overlay === 'none' && (
        <div
          style={{
            position: 'fixed',
            // In landscape on a notched phone the left inset is 59 pixels, and
            // without this both of these sit under the camera housing.
            left: 'calc(14px + env(safe-area-inset-left, 0px))',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            zIndex: 25,
          }}
        >
          {state.accessibility.simplifiedGestures && (
            <SideButton label="Add wood" onClick={handleAddLog} textScale={state.accessibility.textScale} />
          )}
          {(fireWantsRaking || state.accessibility.simplifiedGestures) && (
            <SideButton label="Rake coals" onClick={handleRake} textScale={state.accessibility.textScale} />
          )}
        </div>
      )}

      {/* Bite targets while eating */}
      {(state.stage === 'eating' || state.stage === 'after') && ritual.sandwich && state.overlay === 'none' && (
        <BiteRing onBite={handleBite} textScale={state.accessibility.textScale} finished={ritual.bite.finished} />
      )}

      {state.overlay === 'passport' && (
        <Passport
          passport={state.passport}
          campsiteSeed={state.campsiteSeed}
          textScale={state.accessibility.textScale}
          onClose={() => store.setOverlay('none')}
          onAddCode={() => store.setOverlay('scan')}
          onLink={(provider) => {
            /*
             * Optimistic, and then honest.
             *
             * The Passport is already this device's, so linking uploads it
             * rather than replacing it (spec §6.1) and showing it linked
             * immediately is the right first move. What was missing is the
             * second one: the service can refuse — a deployment with no Apple
             * or Google credentials answers `service_not_configured` rather
             * than trusting an id token nobody verified — and the booklet went
             * on saying "Linked with google" anyway. A Passport that claims an
             * account exists when none does is the one lie this object may not
             * tell.
             */
            const previous = state.passport.linkedProvider;
            store.set({ passport: { ...state.passport, linkedProvider: provider } });
            void syncRef.current?.link(provider, `dev-credential:${provider}`).then((linked) => {
              if (linked) return;
              store.set({ passport: { ...store.state.passport, linkedProvider: previous } });
              // Not a transcript of a sound, so not a subtitle: this has to
              // arrive whether or not subtitles are switched on.
              store.setNotice('This campsite cannot sign you in yet. Your Passport stays on this device.');
            });
          }}
        />
      )}

      {/*
        The wrapper code panel (spec §14, ADR-0008).

        Opened from the Passport, never on the boot path, and never constructed
        before somebody asks for it — the camera in particular is only reached
        by pressing a button that says so.
      */}
      {state.overlay === 'scan' && scanRef.current && (
        <Scan
          flow={scanRef.current}
          textScale={state.accessibility.textScale}
          onClose={() => store.setOverlay('none')}
          onCampInvite={(token) => {
            /*
             * The seam. A `camp` code is a campfire invitation, and its
             * signature has already been checked on this device — so a forged
             * QR never reaches the invite table. What happens next (opening a
             * session, presenting the token on the realtime handshake, showing
             * somebody else's fire) belongs to the multiplayer client, which is
             * being built separately. Recording it is where this stops.
             */
            store.setSubtitle('[an invitation to someone else’s fire]');
            if (typeof console !== 'undefined') {
              console.info('[some-more] verified camp invite token', token.slice(0, 8), '…');
            }
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

      {/* Who is at the fire, what to say, and how to leave. Reachable with the
          `k` key or this button, because every social act here needs a path
          that is not a gesture (spec §12). */}
      {campfire !== null && state.overlay === 'none' && (
        <button
          className="sm-focus"
          onClick={() => store.setOverlay('campfire')}
          aria-label="Who is at the fire"
          style={{
            position: 'fixed',
            /*
             * Top left, which is the one corner nothing else uses. Bottom left
             * is the HUD's own action button — "take the plate" and "at the
             * fire · 2" printed on top of each other during a roast.
             */
            left: 'calc(14px + env(safe-area-inset-left, 0px))',
            top: 'calc(14px + env(safe-area-inset-top, 0px))',
            zIndex: 26,
            background: 'rgba(8,10,14,0.6)',
            color: 'rgba(232,224,205,0.9)',
            border: '1px solid rgba(232,224,205,0.22)',
            padding: `${6 * state.accessibility.textScale}px ${11 * state.accessibility.textScale}px`,
            fontSize: `${10 * state.accessibility.textScale}px`,
            fontFamily: FONT_STACK.mono,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            borderRadius: 2,
          }}
        >
          {campfire.roster.visible.length > 0
            ? `At the fire · ${campfire.roster.visible.length + 1}`
            : campfireStatusWord(campfire.status)}
        </button>
      )}

      {campfire !== null && state.overlay === 'campfire' && (
        <CampfirePanel
          fire={campfire}
          textScale={state.accessibility.textScale}
          highContrast={state.accessibility.highContrast}
          onClose={() => store.setOverlay('none')}
        />
      )}

      {state.overlay === 'radio' && (
        <RadioDial
          ritual={ritual}
          textScale={state.accessibility.textScale}
          onChange={() => store.touch()}
          onClose={() => store.setOverlay('none')}
        />
      )}

      {state.overlay === 'terminal' && ritual.sandwich && (
        <Terminal
          sandwich={ritual.sandwich}
          textScale={state.accessibility.textScale}
          sync={syncRef.current}
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

/** Shared, never mutated: the simulation only ever reads a look rate. */
const NO_LOOK = { yaw: 0, pitch: 0 } as const;

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
          bottom: 'calc(10% + env(safe-area-inset-bottom, 0px))',
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
        /*
         * Nine per cent up, *plus* the home indicator.
         *
         * Without the inset the ring is fine on a laptop and lands within a
         * pixel of the "Make this real" corner on a notched phone, because
         * that corner rises by thirty-four and the ring does not. Both have to
         * move or neither does.
         */
        bottom: 'calc(9% + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)',
        display: 'flex',
        /*
         * No gap. The spacing between the dots comes from the touch targets
         * being larger than the dots they contain, which is the point: eight
         * 44px targets are 352px, and they have to fit a 375px phone.
         */
        gap: 0,
        maxWidth: '100vw',
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
            /*
             * The button is the *target*; the circle inside it is the picture.
             *
             * These were 26px square, which is what they look like and well
             * under both Apple's 44pt and Android's 48dp minimum. Making the
             * visible dot bigger was not an option — eight 44px circles in a
             * row do not fit a 375px screen — so the tappable box grew and the
             * dot did not, which is the ordinary answer and costs nothing
             * visually. Never below 44 even at a reduced text scale: a
             * minimum that scales is not a minimum.
             */
            width: `${Math.max(44, 30 * textScale)}px`,
            height: `${Math.max(44, 30 * textScale)}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            background: 'transparent',
            border: 'none',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
          </span>
        </button>
      ))}
    </div>
  );
}

/** Screen NDC → a walkable ground point, via the shared height function. */
function groundPointAt(
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
  walkable: { seed: number; amplitude: number; radius: number },
): { x: number; y: number; z: number } | null {
  const direction = new ThreeVector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const hit = marchToGround(
    camera.position.x,
    camera.position.y,
    camera.position.z,
    direction.x,
    direction.y,
    direction.z,
    (x, z) => terrainHeight(x, z, walkable.seed, walkable.amplitude),
  );
  if (!hit) return null;
  // Never accept a destination outside the campsite.
  const distance = Math.hypot(hit.x, hit.z);
  if (distance > walkable.radius) {
    const scale = (walkable.radius - 0.4) / distance;
    return { x: hit.x * scale, y: hit.y, z: hit.z * scale };
  }
  return hit;
}

/** True when the thing in reach is the water or the stones beside it. */
function atTheWater(reach: Interactable | null): boolean {
  return reach !== null && (reach.id === 'water-edge' || reach.id === 'stones');
}

/**
 * The bearer token this device already has.
 *
 * `SyncEngine` writes the session here when it bootstraps an anonymous
 * account, and the socket needs the same one — the realtime edge shares an
 * auth model with the REST API rather than having a second one. Read rather
 * than plumbed so that a campsite of one constructs nothing.
 */
function persistedAuthToken(): string | null {
  try {
    const raw = localStorage.getItem('some-more/session/v1');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { auth?: { token?: unknown } };
    const token = parsed.auth?.token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function campfireStatusWord(status: string): string {
  switch (status) {
    case 'joined':
      return 'At the fire';
    case 'joining':
    case 'connecting':
      return 'Walking in';
    case 'reconnecting':
      return 'Trail quiet';
    default:
      return 'Your own fire';
  }
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
