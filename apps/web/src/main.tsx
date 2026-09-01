/**
 * Entry point.
 *
 * Boots straight into the world (spec §6.2) — no title menu, no account wall,
 * no consent dialog before anything has been seen. A person arrives on a
 * trail in the dark with a fire ahead of them.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getEnvironment, listEnvironments, selectEnvironment } from '@somemore/content';
import {
  arrive,
  beginRoasting,
  SIM_DT,
  bite,
  castLine,
  finishRoasting,
  holdComponent,
  lieBack,
  lookAtSky,
  moveComponent,
  operateMachine,
  placeComponent,
  raiseBinoculars,
  setTorchFocus,
  sitOnSeat,
  skipStone,
  standFromSeat,
  stepRitual,
  strikeLine,
  takeFishingRod,
  takeSandwich,
  skyTargets,
  takeStone,
  takeTorchFromLog,
  tendFire,
  describeArrangement,
  describeArmful,
  gatherFuel,
  layFuel,
  type FuelGrade,
  toggleTorch,
  vec3,
} from '@somemore/sim';
import { App } from './App.js';
import { overlayForBoot } from './net/overlay.js';
import { Store } from './state/store.js';

/**
 * Picks the campsite for this visit.
 *
 * A stable per-device seed means a returning player comes back to *their*
 * campsite, with their own serialized SM-01 (spec §3.3). `?camp=` and `?env=`
 * override it, which is how tests and shared links pin an exact campsite.
 */
function resolveCampsite(): { environmentId: string; campsiteSeed: string } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const KEY = 'some-more/campsite/v1';

  let campsiteSeed = params.get('camp') ?? '';
  if (!campsiteSeed) {
    try {
      campsiteSeed = localStorage.getItem(KEY) ?? '';
      if (!campsiteSeed) {
        campsiteSeed = `camp-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(KEY, campsiteSeed);
      }
    } catch {
      campsiteSeed = 'camp-default';
    }
  }

  // An explicit `?env=` wins; otherwise the campsite seed decides which
  // environment this visit lands in. Region is not read here: it may only
  // weight discovery, never lock it (spec §5.4), and the weighting lives in
  // the content package where it can be tested.
  const requested = params.get('env');
  const environment =
    (requested ? getEnvironment(requested) : undefined) ??
    selectEnvironment({ seed: campsiteSeed });

  return { environmentId: environment.id, campsiteSeed };
}

const { environmentId, campsiteSeed } = resolveCampsite();

/*
 * The live-ops overlay, folded onto the compiled catalogue (ADR-0007).
 *
 * Synchronous, and that is the whole design. `overlayForBoot` reads one
 * `localStorage` entry and a zod parse — no network, no promise, nothing to
 * await — so the campsite is built at exactly the speed it was before this
 * existed. A first-ever launch has no cache and gets the twelve compiled
 * environments, which is correct: the world is complete without the service.
 *
 * The network refresh happens later, from `App`, after the fire is already
 * burning. It leaves a better cache behind for next time and applies the one
 * thing that is safe to change mid-session.
 */
const overlay = overlayForBoot(environmentId);
const environment = overlay.environment;
const store = new Store({
  environmentId,
  campsiteSeed,
  liveEvents: overlay.events,
  overlaySource: overlay.source,
  ...(environment ? { weatherProfile: environment.weather } : {}),
  // The manifest's own types satisfy the simulation's, so the catalogue is
  // handed straight to the world systems with no adapter in between.
  ...(environment
    ? {
        world: {
          wildlife: environment.wildlife,
          radio: environment.radio,
          secrets: environment.secrets,
          // Several campsites have no water at all, and `scene.water` is
          // omitted for those — which every activity that needs water checks.
          ...(environment.scene.water ? { water: environment.scene.water } : {}),
          skyOpenness: environment.scene.skyOpenness,
          // Where the firewood at this campsite is, in the catalogue's own words.
          fuel: environment.fuel.sources,
        },
        walkableRadiusM: environment.scene.walkableRadiusM,
      }
    : {}),
});

/**
 * Exposed for the end-to-end tests and for the browser console.
 *
 * These are the *same* functions the interface calls — the tests drive the
 * real ritual through the real simulation, they do not stub it. Anything a
 * test can do here, a player can do by touching the world.
 */
declare global {
  interface Window {
    __someMore?: {
      store: Store;
      actions: Record<string, (...args: never[]) => unknown>;
      /** Populated once the canvas exists; used by the screenshot harness. */
      three?: { gl: unknown; scene: unknown; camera: unknown };
      /** The player being simulated, for inspection and end-to-end tests. */
      player?: import('@somemore/sim').PlayerState;
      walkable?: import('@somemore/sim').WalkableWorld;
      environments: readonly { id: string; name: string }[];
    };
  }
}
if (typeof window !== 'undefined') {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      store.touch();
      return result;
    };
  window.__someMore = {
    environments: listEnvironments().map((e) => ({ id: e.id, name: e.name })),
    store,
    actions: {
      arrive: wrap(() => arrive(store.state.ritual)),
      addLog: wrap((woodId = 'oak') =>
        tendFire(store.state.ritual, { type: 'add-log', woodId: woodId as string }),
      ),
      rake: wrap(() => tendFire(store.state.ritual, { type: 'rake' })),
      bank: wrap((strength = 1) =>
        tendFire(store.state.ritual, { type: 'bank', strength: strength as number }),
      ),
      fan: wrap((strength = 1) =>
        tendFire(store.state.ritual, { type: 'fan', strength: strength as number }),
      ),
      /**
       * Lays a named piece of fuel at a named place in the pit.
       *
       * Exists so a test can set a pit up before exercising the part that
       * matters — dragging the wood around with a finger, which no bridge can
       * stand in for. It is deliberately not how anything in the interface
       * puts wood on a fire.
       */
      layFuel: wrap((woodId = 'oak', grade = 'log', radius = 0.12, bearing = 0) =>
        tendFire(store.state.ritual, {
          type: 'add-log',
          woodId: woodId as string,
          grade: grade as FuelGrade,
          spot: {
            x: Math.cos(bearing as number) * (radius as number),
            z: Math.sin(bearing as number) * (radius as number),
          },
        }),
      ),
      moveFuel: wrap((logId: unknown, x = 0, z = 0) =>
        tendFire(store.state.ritual, {
          type: 'move-log',
          logId: logId as string,
          spot: { x: x as number, z: z as number },
        }),
      ),
      arrangement: () => describeArrangement(store.state.ritual.fire),
      // --- Firewood, and going to get it ------------------------------------
      // The same entry points the interface calls when a player walks out to a
      // fallen limb and reaches for a stick.
      gather: wrap((patchId: unknown) => {
        const result = gatherFuel(store.state.ritual, patchId as string);
        return { taken: result.taken, introduction: result.introduction, full: result.full, empty: result.empty };
      }),
      layCarried: wrap((id?: unknown, x?: unknown, z?: unknown) =>
        layFuel(
          store.state.ritual,
          x === undefined || z === undefined
            ? id === undefined
              ? {}
              : { id: id as string }
            : { ...(id === undefined ? {} : { id: id as string }), spot: { x: x as number, z: z as number } },
        ) !== null,
      ),
      armful: () => ({
        pieces: store.state.ritual.gathering.armful.map((p) => ({ id: p.id, woodId: p.woodId, grade: p.grade, moisture: p.moisture })),
        described: describeArmful(store.state.ritual.gathering),
      }),
      fuelPatches: () =>
        store.state.ritual.gathering.patches.map((p) => ({
          id: p.id,
          woodId: p.woodId,
          grade: p.grade,
          x: p.x,
          z: p.z,
          moisture: p.moisture,
          remaining: p.remaining,
          foundAs: p.foundAs,
        })),
      // --- Secondary activities (spec §5.2) --------------------------------
      // The same entry points the interface calls when a player walks up to
      // the log, the shore or the water and touches something.
      takeTorch: wrap(() => takeTorchFromLog(store.state.ritual)),
      toggleTorch: wrap((on?: unknown) =>
        toggleTorch(store.state.ritual, on as boolean | undefined),
      ),
      focusTorch: wrap((focus = 0.5) => setTorchFocus(store.state.ritual, focus as number)),
      takeStone: wrap((id?: unknown) => takeStone(store.state.ritual, id as string | undefined)),
      skipStone: wrap((power = 0.9, elevation = 0.08, tilt = 0.32, spin = 0.85, bearing = 0) => {
        const ritual = store.state.ritual;
        const water = ritual.water;
        if (!water) return false;
        const from = vec3(
          Math.cos(water.shore.bearing) * (water.shore.distanceM - 0.6),
          1.2,
          Math.sin(water.shore.bearing) * (water.shore.distanceM - 0.6),
        );
        return skipStone(
          ritual,
          {
            power: power as number,
            elevation: elevation as number,
            tilt: tilt as number,
            spin: spin as number,
            bearing: (bearing as number) || water.shore.bearing,
          },
          from,
        );
      }),
      /**
       * Sitting down.
       *
       * Locomotion owns `seated` and the ritual mirrors it, so both are set —
       * exactly what the interface does when somebody reaches for the log.
       * Setting only the ritual's would be undone on the next frame, when the
       * client writes the player's own flag back into presence.
       */
      sit: wrap(() => {
        const player = window.__someMore?.player;
        if (player) player.seated = true;
        sitOnSeat(store.state.ritual);
      }),
      stand: wrap(() => {
        const player = window.__someMore?.player;
        if (player) player.seated = false;
        standFromSeat(store.state.ritual);
      }),
      lieBack: wrap((back = true) => {
        // Lying back is a posture, so the player takes it too: the eye drops
        // and the camera tips up, exactly as when somebody sits.
        const player = window.__someMore?.player;
        if (player) player.seated = back as boolean;
        if (back) sitOnSeat(store.state.ritual);
        else standFromSeat(store.state.ritual);
        return lieBack(store.state.ritual, back as boolean);
      }),
      binoculars: wrap((up = true) => raiseBinoculars(store.state.ritual, up as boolean)),
      lookAtSky: wrap((azimuth = 0, altitude = 1) =>
        lookAtSky(store.state.ritual, azimuth as number, altitude as number),
      ),
      takeRod: wrap(() => takeFishingRod(store.state.ritual)),
      cast: wrap((power = 0.6) => {
        const ritual = store.state.ritual;
        return castLine(ritual, power as number, ritual.water ? ritual.water.shore.bearing : 0);
      }),
      strike: wrap(() => strikeLine(store.state.ritual)),
      /**
       * Tonight's constellations, where they actually are.
       *
       * The same readout `NightSky.tsx` draws from, exposed so a test can aim
       * at something real rather than at a hard-coded direction — the sky
       * turns, so any fixed bearing would be a coin flip.
       */
      skyTargets: () =>
        skyTargets(store.state.ritual.stargazing, store.state.ritual.weather.cloudCover),
      beginRoasting: wrap(() => beginRoasting(store.state.ritual)),
      finishRoasting: wrap(() => finishRoasting(store.state.ritual)),
      holdComponent: wrap(() => holdComponent(store.state.ritual)),
      moveComponent: wrap((x = 0, z = 0) =>
        moveComponent(store.state.ritual, vec3(x as number, 0.01, z as number), 0),
      ),
      placeComponent: wrap(() => placeComponent(store.state.ritual)),
      machine: wrap((action: unknown) => operateMachine(store.state.ritual, action as never)),
      takeSandwich: wrap(() => {
        const sandwich = takeSandwich(store.state.ritual);
        if (sandwich) store.saveSandwich(sandwich);
        return sandwich;
      }),
      bite: wrap((position = 0) => bite(store.state.ritual, position as number)),
      /**
       * Advances the simulation by N seconds without waiting for N seconds of
       * frames.
       *
       * This runs the *real* `stepRitual` at the real fixed timestep — it is
       * fast-forward, not a stub. It exists because the fixed-timestep clamp
       * deliberately lets simulated time fall behind wall-clock on slow
       * hardware (so a stalled tab resumes rather than freezing), which means
       * a test waiting in wall-clock for the fire to burn down would be
       * waiting on the renderer, not on the model.
       */
      advanceSeconds: wrap((seconds = 1) => {
        const steps = Math.round((seconds as number) / SIM_DT);
        for (let i = 0; i < steps; i++) stepRitual(store.state.ritual, SIM_DT);
        return store.state.ritual.elapsed;
      }),
    } as unknown as Record<string, (...args: never[]) => unknown>,
  };
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
