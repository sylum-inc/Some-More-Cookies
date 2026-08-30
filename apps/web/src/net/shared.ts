/**
 * The ritual's actions, as expressed at a fire that may have other people at it.
 *
 * Every function here has exactly the signature of the `@somemore/sim` function
 * it shadows, and alone at a campsite every one of them *is* that function.
 * With a shared fire they become intents on the wire instead, applied to the
 * simulation on the tick the server stamps them with, in the same order on
 * every client (ADR-0006).
 *
 * It works by shadowing the import rather than by threading a session object
 * through a hundred call sites. That is a real trade and worth being explicit
 * about: the cost is that `App.tsx` and `World.tsx` no longer say, at each call
 * site, that an action might travel; the benefit is that there is exactly one
 * place where the decision is made, no call site can forget, and the
 * single-player path is provably the same code it always was. The import line
 * is the signpost — anything imported from here is replicated.
 *
 * The binding is module-level because there is exactly one player at exactly
 * one fire per document, which is also why `main.tsx` can hand the same actions
 * to the test harness.
 */

import {
  arrive as simArrive,
  beginRoasting as simBeginRoasting,
  blowOutMarshmallow as simBlowOut,
  finishRoasting as simFinishRoasting,
  holdComponent as simHoldComponent,
  moveComponent as simMoveComponent,
  moveMarshmallow as simMoveMarshmallow,
  operateMachine as simOperateMachine,
  placeComponent as simPlaceComponent,
  stepRitual as simStepRitual,
  takeSandwich as simTakeSandwich,
  tendFire as simTendFire,
  SIM_DT,
  type ComponentKind,
  type MachineAction,
  type RitualState,
  type SandwichRecord,
  type Vec3,
} from '@somemore/sim';
import type { Campfire, FireAction } from './campfire.js';

let current: Campfire | null = null;

/** Point the shared actions at a campfire. Called once, from `App`. */
export function bindCampfire(fire: Campfire | null): void {
  current = fire;
}

/** The campfire these actions are going to, if any. */
export function boundCampfire(): Campfire | null {
  return current;
}

/**
 * One fixed simulation step.
 *
 * Alone this is `stepRitual`. At a shared fire the timeline owns the step — it
 * applies the replicated intents due on this tick and advances only as far as
 * the server has proved is complete. See `timeline.ts`.
 */
export function stepRitual(ritual: RitualState, dt: number = SIM_DT): void {
  if (current === null) {
    simStepRitual(ritual, dt);
    return;
  }
  current.step(ritual, dt);
}

export function arrive(ritual: RitualState): void {
  if (current === null) simArrive(ritual);
  else current.arrive();
}

export function tendFire(ritual: RitualState, action: FireAction): void {
  if (current === null) simTendFire(ritual, action);
  else current.tendFire(action);
}

export function beginRoasting(ritual: RitualState): void {
  if (current === null) simBeginRoasting(ritual);
  else current.beginRoast();
}

export function moveMarshmallow(ritual: RitualState, position: Vec3, rotation: number, blow = 0): void {
  if (current === null) simMoveMarshmallow(ritual, position, rotation, blow);
  else current.moveMarshmallow(position, rotation, blow);
}

export function blowOutMarshmallow(ritual: RitualState): boolean {
  return current === null ? simBlowOut(ritual) : current.blowOut();
}

export function finishRoasting(ritual: RitualState): boolean {
  return current === null ? simFinishRoasting(ritual) : current.finishRoast();
}

export function holdComponent(ritual: RitualState, kind?: ComponentKind): ComponentKind | null {
  if (current === null) return simHoldComponent(ritual, kind);
  current.holdComponent(kind);
  return ritual.assembly.heldKind;
}

export function moveComponent(ritual: RitualState, offset: Vec3, rotation: number): void {
  if (current === null) simMoveComponent(ritual, offset, rotation);
  else current.moveComponent(offset, rotation);
}

export function placeComponent(ritual: RitualState): boolean {
  if (current === null) return simPlaceComponent(ritual);
  current.placeComponent();
  return true;
}

export function operateMachine(ritual: RitualState, action: MachineAction): boolean {
  if (current === null) return simOperateMachine(ritual, action);
  current.machine(action);
  return true;
}

export function takeSandwich(ritual: RitualState): SandwichRecord | null {
  return current === null ? simTakeSandwich(ritual) : current.takeSandwich();
}
