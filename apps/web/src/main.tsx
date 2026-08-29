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
  bite,
  finishRoasting,
  holdComponent,
  moveComponent,
  operateMachine,
  placeComponent,
  takeSandwich,
  tendFire,
  vec3,
} from '@somemore/sim';
import { App } from './App.js';
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
const environment = getEnvironment(environmentId);
const store = new Store({
  environmentId,
  campsiteSeed,
  ...(environment ? { weatherProfile: environment.weather } : {}),
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
        tendFire(store.state.ritual, { type: 'add-log', woodId: woodId as string, placement: 0.8 }),
      ),
      rake: wrap(() => tendFire(store.state.ritual, { type: 'rake' })),
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
