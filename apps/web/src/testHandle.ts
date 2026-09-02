/**
 * The window handle the client exposes for inspection and for the end-to-end
 * suite.
 *
 * One type, declared once, in the app that populates it. The Playwright specs
 * used to carry their own looser copy — `store: { state: Record<string,
 * unknown> }`, a `three` with no renderer, no `walkable` — and nothing checked
 * either against the other (IMPLEMENTATION_PLAN S15). Every property here is
 * assigned somewhere in `main.tsx` or `App.tsx`; the specs read them through
 * this file, so a rename in one place is a compile error in the other.
 *
 * These are the *same* functions and objects the interface uses. Anything a
 * test can reach here, a player can reach by touching the world.
 */

import type { PlayerState, WalkableWorld } from '@somemore/sim';
import type { Camera, Scene, WebGLRenderer } from 'three';
import type { Campfire } from './net/campfire.js';
import type { Store } from './state/store.js';

export interface SomeMoreHandle {
  store: Store;
  /** The ritual actions the interface calls. Each takes what that action takes; the suite passes what the interface passes. */
  actions: Record<string, (...args: unknown[]) => unknown>;
  environments: readonly { id: string; name: string }[];
  /** Populated once the canvas exists; used by the screenshot harness. */
  three?: { gl: WebGLRenderer; scene: Scene; camera: Camera };
  /** The player being simulated, for inspection and end-to-end tests. */
  player?: PlayerState;
  walkable?: WalkableWorld;
  /** The shared fire, present only while a link has brought this page to one. */
  campfire?: Campfire | null;
}

declare global {
  interface Window {
    __someMore?: SomeMoreHandle;
  }
}
