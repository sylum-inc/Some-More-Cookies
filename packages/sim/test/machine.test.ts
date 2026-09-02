import { describe, expect, it } from 'vitest';
import {
  canPerform,
  coldness,
  createMachine,
  deriveMachineIdentity,
  displayText,
  indicatorColor,
  performAction,
  PROGRAMS,
  QUIRK_POOL,
  recordRun,
  runDuration,
  servicePanelLines,
  stepMachine,
  type MachineEvent,
  type MachineState,
} from '../src/machine.js';
import { SIM_DT } from '../src/types.js';

function advance(machine: MachineState, seconds: number, collect?: MachineEvent[]): MachineState {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    stepMachine(machine, SIM_DT);
    if (collect) collect.push(...machine.events);
  }
  return machine;
}

/**
 * Performs an action and drains the events it produced.
 *
 * `stepMachine` clears `events` at the start of every step, so action-emitted
 * events must be collected before the next step or they are lost.
 */
function act(machine: MachineState, action: Parameters<typeof performAction>[1], events: MachineEvent[]): boolean {
  const accepted = performAction(machine, action);
  events.push(...machine.events);
  machine.events.length = 0;
  return accepted;
}

/** Drives the full twelve-stage ritual, returning every event emitted. */
function fullRun(machine: MachineState): MachineEvent[] {
  const events: MachineEvent[] = [];
  advance(machine, 1, events); // door swings open from idle
  act(machine, { type: 'load' }, events);
  act(machine, { type: 'close-door' }, events);
  advance(machine, 4, events);
  act(machine, { type: 'engage-latch' }, events);
  act(machine, { type: 'set-program', program: 'standard' }, events);
  act(machine, { type: 'confirm' }, events);
  act(machine, { type: 'pull-lever' }, events);
  advance(machine, runDuration('standard') + 4, events);
  act(machine, { type: 'release-latch' }, events);
  act(machine, { type: 'open-door' }, events);
  advance(machine, 3, events);
  return events;
}

describe('identity', () => {
  it('is deterministic for a campsite', () => {
    const a = deriveMachineIdentity('camp-7', 'pinewood');
    const b = deriveMachineIdentity('camp-7', 'pinewood');
    expect(a).toEqual(b);
  });

  it('differs between campsites', () => {
    const a = deriveMachineIdentity('camp-7', 'pinewood');
    const b = deriveMachineIdentity('camp-8', 'pinewood');
    expect(a.serial).not.toBe(b.serial);
  });

  it('differs between environments at the same seed', () => {
    const a = deriveMachineIdentity('camp-7', 'pinewood');
    const b = deriveMachineIdentity('camp-7', 'shoreline');
    expect(a.serial).not.toBe(b.serial);
  });

  it('produces a well-formed serial', () => {
    for (let i = 0; i < 200; i++) {
      const id = deriveMachineIdentity(`camp-${i}`, 'pinewood');
      expect(id.serial).toMatch(/^SM01-(199[7-9]|200[0-3])[A-Z]-\d{5}-[A-Z]$/);
    }
  });

  it('builds units in a plausible period', () => {
    for (let i = 0; i < 100; i++) {
      const id = deriveMachineIdentity(`c${i}`, 'x');
      expect(id.built).toBeGreaterThanOrEqual(1997);
      expect(id.built).toBeLessThanOrEqual(2003);
    }
  });

  it('gives worn units more quirks on average', () => {
    let wornQuirks = 0;
    let wornCount = 0;
    let freshQuirks = 0;
    let freshCount = 0;
    for (let i = 0; i < 400; i++) {
      const id = deriveMachineIdentity(`camp-${i}`, 'env');
      if (id.wear > 0.66) {
        wornQuirks += id.quirks.length;
        wornCount++;
      } else if (id.wear < 0.35) {
        freshQuirks += id.quirks.length;
        freshCount++;
      }
    }
    expect(wornCount).toBeGreaterThan(0);
    expect(freshCount).toBeGreaterThan(0);
    expect(wornQuirks / wornCount).toBeGreaterThan(freshQuirks / freshCount);
  });

  it('never repeats a quirk within one unit', () => {
    for (let i = 0; i < 200; i++) {
      const id = deriveMachineIdentity(`camp-${i}`, 'env');
      expect(new Set(id.quirks.map((q) => q.id)).size).toBe(id.quirks.length);
    }
  });

  it('draws quirks only from the pool', () => {
    const ids = new Set(QUIRK_POOL.map((q) => q.id));
    for (let i = 0; i < 100; i++) {
      for (const q of deriveMachineIdentity(`c${i}`, 'e').quirks) expect(ids.has(q.id)).toBe(true);
    }
  });

  it('has maintenance history in chronological order', () => {
    for (let i = 0; i < 100; i++) {
      const entries = deriveMachineIdentity(`c${i}`, 'e').maintenance;
      expect(entries.length).toBeGreaterThan(0);
      for (let j = 1; j < entries.length; j++) {
        expect(entries[j]!.date >= entries[j - 1]!.date).toBe(true);
      }
    }
  });

  it('prints a readable service panel', () => {
    const lines = servicePanelLines(createMachine('camp-1', 'pinewood'));
    expect(lines[0]).toContain('SOME MORE');
    expect(lines.some((l) => l.startsWith('SERIAL SM01-'))).toBe(true);
    expect(lines.some((l) => l.includes('MAINTENANCE'))).toBe(true);
  });
});

describe('the ritual', () => {
  it('runs through every stage in order', () => {
    const machine = createMachine('camp-1', 'pinewood');
    const stages: string[] = [];
    advance(machine, 1);
    stages.push(machine.stage);
    performAction(machine, { type: 'load' });
    stages.push(machine.stage);
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    stages.push(machine.stage);
    performAction(machine, { type: 'engage-latch' });
    stages.push(machine.stage);
    performAction(machine, { type: 'confirm' });
    stages.push(machine.stage);
    performAction(machine, { type: 'pull-lever' });
    stages.push(machine.stage);
    advance(machine, PROGRAMS.standard.processSeconds + 0.5);
    stages.push(machine.stage);
    advance(machine, PROGRAMS.standard.freezeSeconds);
    stages.push(machine.stage);
    advance(machine, PROGRAMS.standard.transformSeconds);
    stages.push(machine.stage);
    performAction(machine, { type: 'release-latch' });
    stages.push(machine.stage);
    performAction(machine, { type: 'open-door' });
    advance(machine, 2);
    stages.push(machine.stage);

    expect(stages).toEqual([
      'idle',
      'loaded',
      'door-closed',
      'latched',
      'armed',
      'processing',
      'freezing',
      'transforming',
      'complete',
      'unlatched',
      'revealed',
    ]);
  });

  it('emits the full mechanical audio sequence', () => {
    const events = fullRun(createMachine('camp-1', 'pinewood'));
    for (const expected of [
      'latch-clunk',
      'beep-confirm',
      'lever-throw',
      'relay-1',
      'relay-2',
      'compressor-start',
      'fan-ramp',
      'stage-amber',
      'stage-blue',
      'refrigerant-flow',
      'frost-crackle',
      'completion-tone',
      'latch-release',
      'door-open',
      'vapour-release',
    ] as MachineEvent[]) {
      expect(events, `missing ${expected}`).toContain(expected);
    }
  });

  it('emits the completion tone exactly once', () => {
    const events = fullRun(createMachine('camp-2', 'pinewood'));
    expect(events.filter((e) => e === 'completion-tone')).toHaveLength(1);
  });

  it('goes amber while hot, then blue while freezing', () => {
    const machine = createMachine('camp-1', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    performAction(machine, { type: 'confirm' });
    performAction(machine, { type: 'pull-lever' });

    advance(machine, PROGRAMS.standard.processSeconds - 1);
    expect(machine.amber).toBeGreaterThan(0.7);
    expect(machine.blue).toBeLessThan(0.2);

    advance(machine, PROGRAMS.standard.freezeSeconds);
    expect(machine.blue).toBeGreaterThan(0.7);
    expect(machine.amber).toBeLessThan(0.2);
  });

  it('never lights amber and blue at full together', () => {
    const machine = createMachine('camp-1', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    performAction(machine, { type: 'confirm' });
    performAction(machine, { type: 'pull-lever' });
    for (let i = 0; i < 60 * 60; i++) {
      stepMachine(machine, SIM_DT);
      expect(Math.min(machine.amber, machine.blue)).toBeLessThan(0.75);
    }
  });

  it('grows frost during freezing and keeps it after', () => {
    const machine = createMachine('camp-1', 'pinewood');
    fullRun(machine);
    expect(machine.frost).toBeGreaterThan(0.3);
  });

  it('drops the chamber below freezing', () => {
    const machine = createMachine('camp-1', 'pinewood');
    fullRun(machine);
    expect(machine.chamberTempC).toBeLessThan(0);
  });

  it('produces a sandwich only after a complete run', () => {
    const machine = createMachine('camp-1', 'pinewood');
    expect(machine.hasSandwich).toBe(false);
    fullRun(machine);
    expect(machine.hasSandwich).toBe(true);
  });

  it('takes between 45 and 75 seconds on standard', () => {
    // Spec §3.2: long enough to feel like real refrigeration work, short
    // enough to want to do again.
    const total = runDuration('standard');
    expect(total).toBeGreaterThanOrEqual(45);
    expect(total).toBeLessThanOrEqual(75);
  });

  it('offers a meaningfully different deep freeze and soft set', () => {
    expect(runDuration('deep-freeze')).toBeGreaterThan(runDuration('standard'));
    expect(runDuration('soft-set')).toBeLessThan(runDuration('standard'));
    expect(PROGRAMS['deep-freeze'].firmness).toBeGreaterThan(PROGRAMS['soft-set'].firmness);
  });
});

describe('control legality', () => {
  it('will not run without a s’more loaded', () => {
    const machine = createMachine('camp-1', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    performAction(machine, { type: 'confirm' });
    expect(performAction(machine, { type: 'pull-lever' })).toBe(false);
    expect(machine.stage).not.toBe('processing');
  });

  it('will not run unconfirmed', () => {
    const machine = createMachine('camp-1', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    expect(performAction(machine, { type: 'pull-lever' })).toBe(false);
  });

  it('clears confirmation when the program changes', () => {
    const machine = createMachine('camp-1', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    performAction(machine, { type: 'confirm' });
    expect(machine.confirmed).toBe(true);
    performAction(machine, { type: 'set-program', program: 'deep-freeze' });
    expect(machine.confirmed).toBe(false);
  });

  it('answers an illegal action with a reject beep, not an error', () => {
    const machine = createMachine('camp-1', 'pinewood');
    expect(performAction(machine, { type: 'engage-latch' })).toBe(false);
    expect(machine.events).toContain('beep-reject');
  });

  it('reset always works', () => {
    const machine = createMachine('camp-1', 'pinewood');
    fullRun(machine);
    expect(canPerform(machine, 'reset')).toBe(true);
    performAction(machine, { type: 'reset' });
    expect(machine.stage).toBe('idle');
    expect(machine.hasSandwich).toBe(false);
  });
});

describe('quirks', () => {
  it('a sticky door takes longer to close but still closes', () => {
    const sticky = createMachine('camp-1', 'pinewood');
    const normal = createMachine('camp-1', 'pinewood');
    (sticky.identity as { quirks: unknown }).quirks = [QUIRK_POOL.find((q) => q.id === 'sticky-door')!];
    (normal.identity as { quirks: unknown }).quirks = [];
    for (const m of [sticky, normal]) {
      // Loaded first: an *empty* machine that is shut goes back to `idle`,
      // because a closed freezer with nothing in it is not waiting to be
      // latched. `door-closed` is the loaded-and-shut state, so that is the
      // one this quirk has to be measured in.
      advance(m, 20);
      performAction(m, { type: 'load' });
      performAction(m, { type: 'close-door' });
    }
    advance(sticky, 0.4);
    advance(normal, 0.4);
    expect(sticky.door).toBeGreaterThan(normal.door);
    advance(sticky, 5);
    expect(sticky.stage).toBe('door-closed');
  });

  it('a double-relay unit clicks relay 2 twice', () => {
    const machine = createMachine('camp-1', 'pinewood');
    (machine.identity as { quirks: unknown }).quirks = [QUIRK_POOL.find((q) => q.id === 'double-relay')!];
    const events = fullRun(machine);
    expect(events.filter((e) => e === 'relay-2').length).toBeGreaterThanOrEqual(2);
  });

  it('quirks never prevent a successful run', () => {
    // Spec §3.3: quirks are flavour, never a difficulty tax.
    for (const quirk of QUIRK_POOL) {
      const machine = createMachine('camp-1', 'pinewood');
      (machine.identity as { quirks: unknown }).quirks = [quirk];
      fullRun(machine);
      expect(machine.hasSandwich, `${quirk.id} blocked a run`).toBe(true);
    }
  });
});

describe('readouts', () => {
  it('indicator colour runs amber to blue', () => {
    const machine = createMachine('camp-1', 'pinewood');
    machine.amber = 1;
    machine.blue = 0;
    const [ar, , ab] = indicatorColor(machine);
    machine.amber = 0;
    machine.blue = 1;
    const [br, , bb] = indicatorColor(machine);
    expect(ar).toBeGreaterThan(ab);
    expect(bb).toBeGreaterThan(br);
  });

  it('indicator colour is dark when nothing is lit', () => {
    const machine = createMachine('camp-1', 'pinewood');
    machine.amber = 0;
    machine.blue = 0;
    expect(indicatorColor(machine).every((c) => c === 0)).toBe(true);
  });

  it('display text tracks the stage', () => {
    const machine = createMachine('camp-1', 'pinewood');
    expect(displayText(machine)).toBe('READY');
    advance(machine, 1);
    expect(displayText(machine)).toBe('OPEN');
    performAction(machine, { type: 'load' });
    expect(displayText(machine)).toBe('LOADED');
  });

  it('coldness rises through the run', () => {
    const machine = createMachine('camp-1', 'pinewood');
    const before = coldness(machine);
    fullRun(machine);
    expect(coldness(machine)).toBeGreaterThan(before);
  });

  it('records run telemetry for provenance', () => {
    const machine = createMachine('camp-9', 'pinewood');
    fullRun(machine);
    const record = recordRun(machine);
    expect(record.serial).toBe(machine.identity.serial);
    expect(record.program).toBe('standard');
    expect(record.durationSeconds).toBeGreaterThan(40);
    expect(record.peakFrost).toBeGreaterThan(0);
    expect(record.firmness).toBe(PROGRAMS.standard.firmness);
  });
});

describe('frost growth', () => {
  it('never retreats during a run', () => {
    // Frost that shrinks mid-run reads as the machine losing its grip.
    const machine = createMachine('camp-frost', 'pinewood');
    advance(machine, 1);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    advance(machine, 4);
    performAction(machine, { type: 'engage-latch' });
    performAction(machine, { type: 'confirm' });
    performAction(machine, { type: 'pull-lever' });
    let previous = machine.frost;
    for (let i = 0; i < 60 * (runDuration('standard') + 2); i++) {
      stepMachine(machine, SIM_DT);
      expect(machine.frost).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = machine.frost;
    }
    expect(machine.frost).toBeCloseTo(PROGRAMS.standard.frostTarget, 2);
  });

  it('reaches a heavier target on deep freeze', () => {
    const run = (program: 'soft-set' | 'standard' | 'deep-freeze') => {
      const machine = createMachine('camp-frost', 'pinewood');
      advance(machine, 1);
      performAction(machine, { type: 'load' });
      performAction(machine, { type: 'close-door' });
      advance(machine, 4);
      performAction(machine, { type: 'engage-latch' });
      performAction(machine, { type: 'set-program', program });
      performAction(machine, { type: 'confirm' });
      performAction(machine, { type: 'pull-lever' });
      advance(machine, runDuration(program) + 2);
      return machine.frost;
    };
    expect(run('deep-freeze')).toBeGreaterThan(run('soft-set'));
  });
});

describe('a unit that belongs to its campsite', () => {
  /**
   * The catalogue has always said what each site's SM-01 tends to be like —
   * "damp gets into the door gasket, so the first close of the night rarely
   * takes" — and weighted its quirks accordingly. Every unit picked uniformly
   * from the pool regardless, so the site that says its doors stick was no
   * more likely to have a sticky door than a salt flat was.
   */
  it('leans toward the quirks its campsite says it has', () => {
    const withWeights = { 'sticky-door': 40 };
    let weightedSticky = 0;
    let plainSticky = 0;
    for (let i = 0; i < 120; i++) {
      const weighted = deriveMachineIdentity(`camp-${i}`, 'pine_hollow', { quirkWeights: withWeights });
      const plain = deriveMachineIdentity(`camp-${i}`, 'pine_hollow');
      if (weighted.quirks.some((q) => q.id === 'sticky-door')) weightedSticky++;
      if (plain.quirks.some((q) => q.id === 'sticky-door')) plainSticky++;
    }
    expect(weightedSticky).toBeGreaterThan(plainSticky * 1.8);
    // But never a template: an unlisted quirk is still possible.
    const anyOther = Array.from({ length: 60 }, (_, i) =>
      deriveMachineIdentity(`other-${i}`, 'pine_hollow', { quirkWeights: withWeights }),
    ).some((identity) => identity.quirks.some((q) => q.id !== 'sticky-door'));
    expect(anyOther).toBe(true);
  });

  it('carries the sticker its campsite says it carries, first', () => {
    const hint = 'CAMPGROUND INSPECTION 08, half peeled';
    const identity = deriveMachineIdentity('sticker-camp', 'pine_hollow', { stickerHint: hint });
    expect(identity.stickers[0]).toBe(hint);
    // And it is still a used machine with other stickers on it.
    expect(identity.stickers.length).toBeGreaterThan(1);
  });

  it('is the same unit every time you come back to it', () => {
    const flavour = { quirkWeights: { 'slow-amber': 5 }, stickerHint: 'LOT 14' };
    const a = deriveMachineIdentity('same', 'pine_hollow', flavour);
    const b = deriveMachineIdentity('same', 'pine_hollow', flavour);
    expect(a.serial).toBe(b.serial);
    expect(a.quirks.map((q) => q.id)).toEqual(b.quirks.map((q) => q.id));
    expect(a.stickers).toEqual(b.stickers);
  });
});
