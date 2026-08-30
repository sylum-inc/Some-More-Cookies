/**
 * The client half of ADR-0006: a replicated intent, applied to a simulation.
 *
 * The server replicates inputs and authority and nothing else. That is only
 * useful if a client can turn the stream back into a world, and this is that
 * mapping — one `InputIntent` → one call into `@somemore/sim`.
 *
 * It is deliberately a *pure function of (ritual, intent)*. No clock, no
 * network, no local settings: two clients handed the same ordered stream must
 * make the same calls in the same order, or the whole architecture is a lie.
 *
 * `services/api/test/realtime-replay.ts` contains the same mapping, written for
 * the server's own replay harness. The two must not drift, and
 * `test/integration/campfire-replication.test.ts` asserts they have not by
 * driving both over a long generated intent stream and comparing digests. They
 * are not shared directly because nothing may depend on `apps/web`
 * (ARCHITECTURE §2) and the contract package may not import the simulation.
 */

import {
  beginRoasting,
  blowOutMarshmallow,
  finishRoasting,
  holdComponent,
  moveComponent,
  moveMarshmallow,
  operateMachine,
  placeComponent,
  tendFire,
  type MachineAction,
  type RitualState,
} from '@somemore/sim';
import type { InputIntent, MachineControl, MachineDialProgram } from '@somemore/protocol';

/** The SM-01's wire vocabulary → the machine model's own. */
export function toMachineAction(control: MachineControl, program?: MachineDialProgram): MachineAction | null {
  switch (control) {
    case 'load':
      return { type: 'load' };
    case 'close_door':
      return { type: 'close-door' };
    case 'engage_latch':
      return { type: 'engage-latch' };
    case 'set_program':
      return { type: 'set-program', program: program ?? 'standard' };
    case 'confirm':
      return { type: 'confirm' };
    case 'pull_lever':
      return { type: 'pull-lever' };
    case 'release_latch':
      return { type: 'release-latch' };
    case 'open_door':
      return { type: 'open-door' };
    case 'take_sandwich':
      return { type: 'take-sandwich' };
    case 'reset':
      return { type: 'reset' };
    default:
      return null;
  }
}

/**
 * Apply one replicated intent to a local simulation.
 *
 * Props and gestures are replicated for *presentation* — somebody waving is
 * worth seeing — but they change no simulation state, so a replay that ignores
 * them still lands on an identical world. That asymmetry is why the scene layer
 * reads them from the roster rather than from the ritual.
 */
export function applyIntent(ritual: RitualState, intent: InputIntent): void {
  switch (intent.kind) {
    case 'begin_roast':
      beginRoasting(ritual);
      return;
    case 'move_marshmallow':
      moveMarshmallow(ritual, intent.position, intent.rotation, intent.blow);
      return;
    case 'blow_out':
      blowOutMarshmallow(ritual);
      return;
    case 'finish_roast':
      finishRoasting(ritual);
      return;
    case 'tend_fire':
      if (intent.action.action === 'add_log') {
        tendFire(ritual, { type: 'add-log', woodId: intent.action.woodId, placement: intent.action.placement });
      } else if (intent.action.action === 'rake') {
        tendFire(ritual, { type: 'rake' });
      } else {
        tendFire(ritual, { type: 'fan', strength: intent.action.strength });
      }
      return;
    case 'hold_component':
      // The assist travels with the pick-up (spec §12): magnetic assistance is
      // applied continuously while dragging, so a shared assembly where each
      // client used its own setting would drift apart on the very first frame.
      // Sending it means the holder's accessibility preference is what every
      // client simulates — the assist still only changes the dexterity the
      // *holder* needs, which is exactly what §12 asks of it.
      if (intent.assist !== undefined && intent.assist !== null) ritual.assembly.assist = intent.assist;
      holdComponent(ritual, intent.component ?? undefined);
      return;
    case 'move_component':
      moveComponent(ritual, intent.offset, intent.rotation);
      return;
    case 'place_component':
      placeComponent(ritual);
      return;
    case 'machine_control': {
      const action = toMachineAction(intent.control, intent.program);
      if (action !== null) operateMachine(ritual, action);
      return;
    }
    case 'move_prop':
    case 'gesture':
      return;
    default:
      return;
  }
}

/** Whether this intent changes simulation state at all. */
export function intentTouchesSimulation(intent: InputIntent): boolean {
  return intent.kind !== 'move_prop' && intent.kind !== 'gesture';
}
