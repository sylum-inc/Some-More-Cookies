/**
 * The client half of ADR-0006.
 *
 * The server replicates inputs and authority and nothing else, which is only
 * useful if a client can turn that stream back into a world. This is that
 * mapping — `InputIntent` → a call into `@somemore/sim` — plus a mirror that
 * advances a ritual tick by tick.
 *
 * It lives in the tests rather than in `packages/protocol` on purpose: the
 * contract package depends on nothing, and the simulation must not leak into
 * the wire format. The real client will have exactly this file.
 */

import {
  SIM_DT,
  beginRoasting,
  blowOutMarshmallow,
  createRitual,
  finishRoasting,
  holdComponent,
  moveComponent,
  moveMarshmallow,
  operateMachine,
  placeComponent,
  stepRitual,
  takeSandwich,
  summariseRoast,
  tendFire,
  type MachineAction,
  type RitualState,
} from '@somemore/sim';
import { compareStampedInputs, type InputIntent, type StampedInput } from '@somemore/protocol';

function toMachineAction(control: string, program: string | undefined): MachineAction | null {
  switch (control) {
    case 'load':
      return { type: 'load' };
    case 'close_door':
      return { type: 'close-door' };
    case 'engage_latch':
      return { type: 'engage-latch' };
    case 'set_program':
      return { type: 'set-program', program: (program ?? 'standard') as 'standard' | 'soft-set' | 'deep-freeze' };
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

/** Apply one replicated intent to a local simulation. */
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
      holdComponent(ritual, intent.component ?? undefined);
      return;
    case 'move_component':
      moveComponent(ritual, intent.offset, intent.rotation);
      return;
    case 'place_component':
      placeComponent(ritual);
      return;
    case 'machine_control': {
      /*
       * `take_sandwich` is a *ritual* intent, not a machine control.
       *
       * `operateMachine` moves the machine and nothing else: the bite state is
       * never created, `sandwichAge` never resets, and the stage never becomes
       * `eating`. Both mappings had the same gap, so they agreed with each
       * other and the drift test passed — but a player taking their own
       * sandwich calls `takeSandwich`, so the acting client did one thing and
       * every other client did another, at exactly the moment the ritual
       * hands the product over. ADR-0006 replicates intents; this is one.
       */
      if (intent.control === 'take_sandwich') {
        takeSandwich(ritual);
        return;
      }
      const action = toMachineAction(intent.control, intent.program);
      if (action !== null) operateMachine(ritual, action);
      return;
    }
    // Props and gestures are replicated for presentation but change no
    // simulation state, so a replay ignores them and still matches exactly.
    case 'move_prop':
    case 'gesture':
      return;
  }
}

/**
 * A client-side simulation driven purely by the replicated input stream.
 *
 * Inputs are queued and applied on the tick the server stamped them with, then
 * the ritual is stepped once per tick. Two mirrors fed the same stamped inputs
 * — one incrementally from live relays, one in a batch from a late joiner's
 * snapshot — must end up identical. That is the whole claim of ADR-0006.
 */
export class SimMirror {
  readonly ritual: RitualState;
  private readonly queue: StampedInput[] = [];
  tick = 0;

  constructor(seed: number, environmentId: string) {
    this.ritual = createRitual({ campsiteSeed: seed, environmentId });
  }

  enqueue(...inputs: StampedInput[]): this {
    this.queue.push(...inputs);
    this.queue.sort(compareStampedInputs);
    return this;
  }

  /** Advance to `targetTick`, applying each input on the tick it belongs to. */
  advanceTo(targetTick: number): this {
    while (this.tick <= targetTick) {
      while (this.queue.length > 0 && (this.queue[0] as StampedInput).tick === this.tick) {
        applyIntent(this.ritual, (this.queue.shift() as StampedInput).intent);
      }
      stepRitual(this.ritual, SIM_DT);
      this.tick += 1;
    }
    return this;
  }

  /** Anything still queued for a tick we have already passed. */
  get pending(): number {
    return this.queue.length;
  }
}

/**
 * A comparable fingerprint of a simulated world.
 *
 * Log ids come from a process-global counter, so they differ between two
 * rituals constructed at different moments and are deliberately excluded; every
 * value that the *player* can see is included, patch by patch.
 */
export function digest(ritual: RitualState): unknown {
  return {
    stage: ritual.stage,
    elapsed: round(ritual.elapsed),
    marshmallow: {
      rotation: ritual.marshmallow.rotation,
      angularVelocity: ritual.marshmallow.angularVelocity,
      position: ritual.marshmallow.position,
      melt: ritual.marshmallow.melt,
      sag: ritual.marshmallow.sag,
      fallen: ritual.marshmallow.fallen,
      burning: ritual.marshmallow.burning,
      elapsed: round(ritual.marshmallow.elapsed),
      rotationTravel: ritual.marshmallow.rotationTravel,
      flameSeconds: ritual.marshmallow.flameSeconds,
      ignitionCount: ritual.marshmallow.ignitionCount,
      patches: ritual.marshmallow.patches.map((patch) => ({
        row: patch.row,
        column: patch.column,
        temperatureC: patch.temperatureC,
        moisture: patch.moisture,
        brown: patch.brown,
        char: patch.char,
        blister: patch.blister,
        aflame: patch.aflame,
        fuel: patch.fuel,
      })),
    },
    roast: summariseRoast(ritual.marshmallow),
    fire: {
      emberMass: ritual.fire.emberMass,
      emberTemp: ritual.fire.emberTemp,
      oxygen: ritual.fire.oxygen,
      combustion: ritual.fire.combustion,
      flame: ritual.fire.flame,
      flameHeight: ritual.fire.flameHeight,
      smoke: ritual.fire.smoke,
      windSpeed: ritual.fire.windSpeed,
      elapsed: round(ritual.fire.elapsed),
      logs: ritual.fire.logs.map((log) => ({
        woodId: log.woodId,
        mass: log.mass,
        moisture: log.moisture,
        ignition: log.ignition,
        placement: log.placement,
        burnedFor: log.burnedFor,
      })),
    },
    machine: { stage: ritual.machine.stage, progress: ritual.machine.progress },
  };
}

/** Floating-point accumulation of `elapsed` is not the thing under test. */
function round(value: number): number {
  return Number(value.toFixed(6));
}
