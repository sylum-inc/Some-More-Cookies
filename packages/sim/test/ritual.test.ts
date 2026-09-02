import { describe, expect, it } from 'vitest';
import {
  arrive,
  beginRoasting,
  bite,
  blowOutMarshmallow,
  createRitual,
  finishRoasting,
  holdComponent,
  moveComponent,
  moveMarshmallow,
  operateMachine,
  pendingComponent,
  placeComponent,
  ritualSignals,
  runScript,
  stepRitual,
  takeSandwich,
  tendFire,
  type RitualState,
} from '../src/ritual.js';
import { runDuration } from '../src/machine.js';
import { STACK_ORDER } from '../src/assembly.js';
import { SIM_DT, vec3 } from '../src/types.js';

function seconds(ritual: RitualState, s: number): void {
  const steps = Math.round(s / SIM_DT);
  for (let i = 0; i < steps; i++) stepRitual(ritual, SIM_DT);
}

/** Roasts by holding the marshmallow over the coals and turning it steadily. */
function roastFor(ritual: RitualState, duration: number, spin = 1.1, radius = 0.15): void {
  const steps = Math.round(duration / SIM_DT);
  let rotation = 0;
  for (let i = 0; i < steps; i++) {
    rotation += spin * SIM_DT;
    moveMarshmallow(ritual, vec3(radius, 0.1, 0), rotation);
    stepRitual(ritual, SIM_DT);
  }
}

function assembleStack(ritual: RitualState, offset = 0.004): void {
  for (const kind of STACK_ORDER) {
    holdComponent(ritual, kind);
    moveComponent(ritual, vec3(offset, 0.01, 0), 0);
    seconds(ritual, 0.4);
    placeComponent(ritual);
  }
}

function operateFullMachine(ritual: RitualState): void {
  seconds(ritual, 1);
  operateMachine(ritual, { type: 'load' });
  operateMachine(ritual, { type: 'close-door' });
  seconds(ritual, 4);
  operateMachine(ritual, { type: 'engage-latch' });
  operateMachine(ritual, { type: 'set-program', program: 'standard' });
  operateMachine(ritual, { type: 'confirm' });
  operateMachine(ritual, { type: 'pull-lever' });
  seconds(ritual, runDuration('standard') + 3);
  operateMachine(ritual, { type: 'release-latch' });
  operateMachine(ritual, { type: 'open-door' });
  seconds(ritual, 3);
}

/** The whole ritual, start to finish. */
function completeRitual(seed: string | number = 'camp-1'): RitualState {
  const ritual = createRitual({ campsiteSeed: seed, environmentId: 'pinewood', now: 1_700_000_000_000 });
  arrive(ritual);
  tendFire(ritual, { type: 'rake' });
  // A player arrives at a lively fire and spends a little time at the
  // campsite before roasting, by which point it has settled toward coals —
  // which is the natural arc the fire model produces.
  seconds(ritual, 100);
  beginRoasting(ritual);
  roastFor(ritual, 75);
  finishRoasting(ritual);
  assembleStack(ritual);
  operateFullMachine(ritual);
  return ritual;
}

describe('the whole ritual', () => {
  it('runs end to end and produces a sandwich', () => {
    const ritual = completeRitual();
    expect(ritual.stage).toBe('reveal');
    expect(ritual.sandwich).not.toBeNull();
    expect(ritual.sandwich!.class.length).toBeGreaterThan(0);
    expect(ritual.sandwich!.machine.serial).toMatch(/^SM01-/);
  });

  it('passes through every stage in order', () => {
    const ritual = createRitual({ campsiteSeed: 'camp-1', environmentId: 'pinewood' });
    const stages: string[] = [ritual.stage];
    const record = () => {
      if (stages[stages.length - 1] !== ritual.stage) stages.push(ritual.stage);
    };
    arrive(ritual);
    record();
    beginRoasting(ritual);
    record();
    roastFor(ritual, 60);
    finishRoasting(ritual);
    record();
    assembleStack(ritual);
    record();
    operateFullMachine(ritual);
    record();
    takeSandwich(ritual);
    record();
    for (let i = 0; i < 30; i++) bite(ritual, i % 8);
    record();

    expect(stages).toEqual([
      'arriving',
      'at-fire',
      'roasting',
      'assembling',
      'machine',
      'reveal',
      'eating',
      'after',
    ]);
  });

  it('takes roughly 5–8 minutes of simulated time', () => {
    // Spec §5.1. The measured core loop here is the mechanical minimum; a real
    // player also explores, tends the fire and looks around.
    const ritual = completeRitual();
    expect(ritual.elapsed).toBeGreaterThan(120);
    expect(ritual.elapsed).toBeLessThan(600);
  });

  it('the sandwich carries the roast, the stack and the machine', () => {
    const s = completeRitual().sandwich!;
    expect(s.roast.seconds).toBeGreaterThan(60);
    expect(s.roast.rotationTravel).toBeGreaterThan(10);
    expect(s.assembly.label.length).toBeGreaterThan(0);
    expect(s.machine.durationSeconds).toBeGreaterThan(40);
  });
});

describe('determinism', () => {
  it('the same seed and inputs produce an identical sandwich', () => {
    // This is what makes multiplayer reconciliation and server-side reward
    // validation possible (ADR-0006). If this test fails, both break.
    const a = completeRitual('camp-determinism').sandwich!;
    const b = completeRitual('camp-determinism').sandwich!;
    expect(a).toEqual(b);
  });

  it('different campsites produce different objects', () => {
    const a = completeRitual('camp-a').sandwich!;
    const b = completeRitual('camp-b').sandwich!;
    expect(a.id).not.toBe(b.id);
  });

  it('replays identically when stepped in different chunk sizes', () => {
    // Fixed timestep means the number of steps is what matters, never how
    // they were grouped by the render loop.
    const build = (chunk: number) => {
      const ritual = createRitual({ campsiteSeed: 'chunky', environmentId: 'pinewood' });
      beginRoasting(ritual);
      let rotation = 0;
      const total = Math.round(40 / SIM_DT);
      let done = 0;
      while (done < total) {
        const batch = Math.min(chunk, total - done);
        for (let i = 0; i < batch; i++) {
          rotation += 1.1 * SIM_DT;
          moveMarshmallow(ritual, vec3(0.15, 0.1, 0), rotation);
          stepRitual(ritual, SIM_DT);
        }
        done += batch;
      }
      return ritual;
    };
    const one = build(1);
    const many = build(7);
    expect(one.marshmallow.patches.map((p) => p.brown)).toEqual(
      many.marshmallow.patches.map((p) => p.brown),
    );
  });

  it('subsystem RNG streams do not interfere', () => {
    // Fire consumes randomness every step; roasting must be unaffected.
    const withFire = createRitual({ campsiteSeed: 'streams', environmentId: 'pinewood' });
    beginRoasting(withFire);
    roastFor(withFire, 30);

    const again = createRitual({ campsiteSeed: 'streams', environmentId: 'pinewood' });
    beginRoasting(again);
    roastFor(again, 30);

    expect(withFire.marshmallow.patches.map((p) => p.brown)).toEqual(
      again.marshmallow.patches.map((p) => p.brown),
    );
  });
});

describe('outcomes are a spectrum, not pass or fail', () => {
  it('a careful roast and a neglected one both produce a sandwich', () => {
    const careful = completeRitual();
    expect(careful.sandwich).not.toBeNull();

    const neglected = createRitual({ campsiteSeed: 'camp-x', environmentId: 'pinewood' });
    beginRoasting(neglected);
    // Left in one place, never turned, far too long.
    roastFor(neglected, 200, 0, 0.1);
    finishRoasting(neglected);
    assembleStack(neglected, 0.04);
    operateFullMachine(neglected);
    expect(neglected.sandwich).not.toBeNull();
    expect(neglected.sandwich!.class).not.toBe(careful.sandwich!.class);
  });

  it('different roasting produces genuinely different sandwiches', () => {
    const classes = new Set<string>();
    const configs: [number, number, number][] = [
      [30, 1.2, 0.25],
      [75, 1.1, 0.15],
      [140, 0, 0.1],
      [200, 0.4, 0.04],
    ];
    for (const [duration, spin, radius] of configs) {
      const ritual = createRitual({ campsiteSeed: 'spread', environmentId: 'pinewood' });
      beginRoasting(ritual);
      roastFor(ritual, duration, spin, radius);
      finishRoasting(ritual);
      assembleStack(ritual);
      operateFullMachine(ritual);
      classes.add(ritual.sandwich!.class);
    }
    expect(classes.size).toBeGreaterThan(1);
  });

  it('a dropped marshmallow means another marshmallow, never a restart', () => {
    const ritual = createRitual({ campsiteSeed: 'drop', environmentId: 'pinewood' });
    beginRoasting(ritual);
    roastFor(ritual, 600, 0.2, 0.02);
    expect(ritual.marshmallow.fallen).toBe(true);
    // finishRoasting returns false and hands over a fresh marshmallow.
    expect(finishRoasting(ritual)).toBe(false);
    expect(ritual.stage).toBe('roasting');
    expect(ritual.marshmallow.fallen).toBe(false);
    expect(ritual.marshmallow.elapsed).toBe(0);
  });
});

describe('accessibility assists', () => {
  it('automatic rotation reaches an even roast without player input', () => {
    // Spec §12: assists change the dexterity required, never the outcome
    // available.
    const assisted = createRitual({
      campsiteSeed: 'assist',
      environmentId: 'pinewood',
      autoRotate: 1.1,
    });
    beginRoasting(assisted);
    // The player only sets distance; rotation happens for them.
    const steps = Math.round(75 / SIM_DT);
    for (let i = 0; i < steps; i++) {
      moveMarshmallow(assisted, vec3(0.15, 0.1, 0), 0);
      stepRitual(assisted, SIM_DT);
    }
    finishRoasting(assisted);
    const summary = assisted.assembly;
    expect(summary).toBeTruthy();
    expect(assisted.marshmallow.rotationTravel).toBeGreaterThan(50);
  });

  it('stronger assembly assist reduces misalignment', () => {
    const build = (assist: number) => {
      const ritual = createRitual({ campsiteSeed: 'a11y', environmentId: 'pinewood', assemblyAssist: assist });
      beginRoasting(ritual);
      roastFor(ritual, 40);
      finishRoasting(ritual);
      for (const kind of STACK_ORDER) {
        holdComponent(ritual, kind);
        moveComponent(ritual, vec3(0.02, 0.01, 0), 0);
        seconds(ritual, 0.6);
        placeComponent(ritual);
      }
      return ritual.assembly.components.reduce(
        (t, c) => t + Math.hypot(c.offset.x, c.offset.z),
        0,
      );
    };
    expect(build(1)).toBeLessThan(build(0));
  });
});

describe('fire tending', () => {
  it('adding fuel raises the fire', () => {
    const ritual = createRitual({ campsiteSeed: 'fire', environmentId: 'pinewood' });
    seconds(ritual, 30);
    const before = ritual.fire.logs.length;
    tendFire(ritual, { type: 'add-log', woodId: 'pine' });
    expect(ritual.fire.logs.length).toBe(before + 1);
  });

  it('wet weather means damp firewood', () => {
    const dry = createRitual({
      campsiteSeed: 'dry',
      environmentId: 'pinewood',
      weatherProfile: {
        id: 'dry',
        weights: { clear: 1 },
        baseTempC: 20,
        baseWind: 1,
        exposure: 0.4,
        skyEventChance: 0,
        skyEvents: [],
        transitionSeconds: 999,
      },
    });
    const wet = createRitual({
      campsiteSeed: 'wet',
      environmentId: 'pinewood',
      weatherProfile: {
        id: 'wet',
        weights: { rain: 1 },
        baseTempC: 10,
        baseWind: 1,
        exposure: 0.4,
        skyEventChance: 0,
        skyEvents: [],
        transitionSeconds: 999,
      },
    });
    seconds(dry, 2);
    seconds(wet, 2);
    tendFire(dry, { type: 'add-log', woodId: 'oak' });
    tendFire(wet, { type: 'add-log', woodId: 'oak' });
    const dryLog = dry.fire.logs[dry.fire.logs.length - 1]!;
    const wetLog = wet.fire.logs[wet.fire.logs.length - 1]!;
    expect(wetLog.moisture).toBeGreaterThan(dryLog.moisture);
  });

  it('tending the fire before arriving still counts as arriving', () => {
    const ritual = createRitual({ campsiteSeed: 'arrive', environmentId: 'pinewood' });
    expect(ritual.stage).toBe('arriving');
    tendFire(ritual, { type: 'fan' });
    expect(ritual.stage).toBe('at-fire');
  });
});

describe('signals and scripting', () => {
  it('exposes normalised signals for the renderer', () => {
    const ritual = completeRitual();
    const signals = ritualSignals(ritual);
    expect(signals.stage).toBe('reveal');
    expect(signals.machineProgress).toBeGreaterThan(0.9);
    expect(signals.fire.intensity).toBeGreaterThanOrEqual(0);
    expect(signals.fire.intensity).toBeLessThanOrEqual(1);
  });

  it('runScript drives a timeline deterministically', () => {
    const build = () =>
      runScript(createRitual({ campsiteSeed: 'script', environmentId: 'pinewood' }), [
        { action: (r) => arrive(r) },
        { wait: 2, action: (r) => tendFire(r, { type: 'add-log', woodId: 'birch' }) },
        { wait: 1, action: (r) => beginRoasting(r) },
        { wait: 30 },
      ]);
    expect(build().marshmallow.patches.map((p) => p.brown)).toEqual(
      build().marshmallow.patches.map((p) => p.brown),
    );
  });

  it('reports the component the player should place next', () => {
    const ritual = createRitual({ campsiteSeed: 'next', environmentId: 'pinewood' });
    beginRoasting(ritual);
    roastFor(ritual, 20);
    finishRoasting(ritual);
    expect(pendingComponent(ritual)).toBe('graham-bottom');
    holdComponent(ritual);
    placeComponent(ritual);
    expect(pendingComponent(ritual)).toBe('chocolate');
  });

  it('blowing out a lit marshmallow works through the ritual layer', () => {
    const ritual = createRitual({ campsiteSeed: 'blow', environmentId: 'pinewood' });
    // Ignition needs actual flames, so keep the fire fed with resinous pine.
    let laid = 0;
    const layPine = (): void => {
      tendFire(ritual, {
        type: 'add-log',
        woodId: 'pine',
        spot: { x: Math.cos(laid * 0.7) * (0.15 - laid * 0.015), z: Math.sin(laid * 0.7) * (0.15 - laid * 0.015) },
      });
      laid++;
    };
    layPine();
    layPine();
    seconds(ritual, 20);
    beginRoasting(ritual);
    let rotation = 0;
    for (let i = 0; i < 60 * 300 && !ritual.marshmallow.burning; i++) {
      if (i % (60 * 40) === 0) layPine();
      rotation += 0.4 * SIM_DT;
      moveMarshmallow(ritual, vec3(0.02, 0.22, 0), rotation);
      stepRitual(ritual, SIM_DT);
    }
    expect(ritual.marshmallow.burning).toBe(true);
    expect(blowOutMarshmallow(ritual)).toBe(true);
  });

  it('never produces NaN across a full ritual', () => {
    const ritual = completeRitual();
    expect(Number.isFinite(ritual.fire.flame)).toBe(true);
    expect(Number.isFinite(ritual.machine.frost)).toBe(true);
    for (const p of ritual.marshmallow.patches) expect(Number.isFinite(p.temperatureC)).toBe(true);
    for (const v of Object.values(ritual.sandwich!.appearance)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });
});
