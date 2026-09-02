import { describe, expect, it } from 'vitest';
import {
  createWildlife,
  createWildlifeInput,
  drainWildlifeEvents,
  describeSighting,
  presentAnimals,
  residents,
  speciesAppearanceRate,
  stepWildlife,
  stillnessGate,
  wildlifeEvidence,
  wildlifeSignals,
  type WildlifeEvent,
  type WildlifeInput,
  type WildlifeSpecies,
  type WildlifeState,
} from '../src/wildlife.js';
import { decideTrace } from '../src/significance.js';
import { Rng } from '../src/rng.js';
import { SIM_DT, vec3 } from '../src/types.js';

/**
 * A two-species roster in the shape the content package emits: one bold
 * scavenger and one very shy visitor. `WildlifeEntry` from `@somemore/content`
 * has exactly these fields, so a manifest roster drops straight in.
 */
const SQUIRREL: WildlifeSpecies = {
  id: 'squirrel',
  label: 'Pine squirrel',
  shyness: 0.3,
  curiosity: 0.9,
  window: ['early-night'],
  attractedBy: ['crumbs', 'food-smell'],
  repelledBy: ['sudden-movement'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['a stripped cone on the table', 'scattered cone scales'],
  note: '',
};

const FLYING_SQUIRREL: WildlifeSpecies = {
  id: 'flying_squirrel',
  label: 'Northern flying squirrel',
  shyness: 0.9,
  curiosity: 0.5,
  window: ['early-night'],
  attractedBy: ['stillness', 'quiet'],
  repelledBy: ['voices', 'flashlight'],
  canPersist: true,
  investigatesObjects: false,
  traces: ['a soft thump on the bear box lid'],
  note: '',
};

const ROSTER: readonly WildlifeSpecies[] = [SQUIRREL, FLYING_SQUIRREL];

function stillInput(overrides: Partial<WildlifeInput> = {}): WildlifeInput {
  return createWildlifeInput({
    playerSpeed: 0,
    noise: 0,
    lightSweep: 0,
    cues: { crumbs: 1, 'food-smell': 1, firelight: 0.6 },
    window: 'early-night',
    ...overrides,
  });
}

function noisyInput(overrides: Partial<WildlifeInput> = {}): WildlifeInput {
  return createWildlifeInput({
    playerSpeed: 1.6,
    noise: 0.55,
    lightSweep: 0.4,
    cues: { crumbs: 1, 'food-smell': 1, firelight: 0.6 },
    window: 'early-night',
    ...overrides,
  });
}

function run(seed: number, seconds: number, input: WildlifeInput, roster = ROSTER): WildlifeEvent[] {
  const state = createWildlife({ campsiteSeed: 0xc0ffee, roster });
  const rng = new Rng(seed);
  const events: WildlifeEvent[] = [];
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    stepWildlife(state, input, SIM_DT, rng);
    events.push(...drainWildlifeEvents(state));
  }
  return events;
}

function appearances(events: readonly WildlifeEvent[], speciesId: string): number {
  return events.filter((event) => event.kind === 'appeared' && event.speciesId === speciesId).length;
}

describe('wildlife determinism', () => {
  it('replays identically for a seed', () => {
    const a = run(11, 900, stillInput());
    const b = run(11, 900, stillInput());
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('differs for a different seed', () => {
    const a = run(11, 600, stillInput());
    const b = run(12, 600, stillInput());
    expect(a).not.toEqual(b);
  });
});

describe('stillness reveals rarer wildlife', () => {
  it('gates shy species on calm far harder than bold ones', () => {
    // Bold animals turn up whatever you are doing; shy ones do not.
    expect(stillnessGate(0.3, 0)).toBeGreaterThan(0.4);
    expect(stillnessGate(0.9, 0)).toBeLessThan(0.02);
    // And every species is helped by stillness, monotonically.
    for (const shyness of [0.1, 0.3, 0.6, 0.9]) {
      let previous = -1;
      for (const calm of [0, 0.25, 0.5, 0.75, 1]) {
        const gate = stillnessGate(shyness, calm);
        expect(gate).toBeGreaterThanOrEqual(previous);
        previous = gate;
      }
      expect(stillnessGate(shyness, 1)).toBeCloseTo(1, 6);
    }
    // The *ratio* of rare to common opportunity rises with stillness, which is
    // the actual spec claim.
    const quietRatio = stillnessGate(0.9, 1) / stillnessGate(0.3, 1);
    const loudRatio = stillnessGate(0.9, 0) / stillnessGate(0.3, 0);
    expect(quietRatio).toBeGreaterThan(loudRatio * 10);
  });

  it('raises the shy species appearance rate as stillness accumulates', () => {
    const state = createWildlife({ campsiteSeed: 1, roster: ROSTER });
    const rng = new Rng(5);
    const input = stillInput();
    const rates: number[] = [];
    for (let i = 0; i < Math.round(300 / SIM_DT); i++) {
      stepWildlife(state, input, SIM_DT, rng);
      if (i % Math.round(60 / SIM_DT) === 0) rates.push(speciesAppearanceRate(state, FLYING_SQUIRREL, input));
    }
    expect(state.calm).toBeGreaterThan(0.9);
    const first = rates[0] as number;
    const last = rates[rates.length - 1] as number;
    expect(last).toBeGreaterThan(first * 10);
  });

  /*
   * Sixty paired 300-second sessions: 2.16 million simulation steps, and about
   * 2.3 seconds on an idle machine. Under a full parallel suite it went past
   * vitest's 5-second default and failed as a timeout, which reads like a
   * broken model and is not one.
   *
   * Raised rather than trimmed. The claim here is statistical — that stillness
   * shifts *which* animals come, not merely how many — and the sample count is
   * what gives it power. Halving the seeds to make it finish sooner would make
   * it flakier at the thing it exists to prove.
   */
  it('produces far more rare sightings for a still player than a noisy one', { timeout: 60_000 }, () => {
    let stillRare = 0;
    let noisyRare = 0;
    let stillCommon = 0;
    let noisyCommon = 0;
    for (let seed = 0; seed < 60; seed++) {
      const quiet = run(seed, 300, stillInput());
      const loud = run(seed, 300, noisyInput());
      stillRare += appearances(quiet, 'flying_squirrel');
      noisyRare += appearances(loud, 'flying_squirrel');
      stillCommon += appearances(quiet, 'squirrel');
      noisyCommon += appearances(loud, 'squirrel');
    }
    expect(stillRare).toBeGreaterThan(5);
    expect(stillRare).toBeGreaterThan(noisyRare * 5);
    // Not a punishment: the bold species still visits a noisy camp.
    expect(noisyCommon).toBeGreaterThan(0);
    // And stillness shifts the *mix*, not just the volume.
    const stillShare = stillRare / (stillRare + stillCommon);
    const noisyShare = noisyRare / (noisyRare + noisyCommon);
    expect(stillShare).toBeGreaterThan(noisyShare);
  });

  it('loses accumulated stillness to a single startle', () => {
    const state = createWildlife({ campsiteSeed: 3, roster: ROSTER });
    const rng = new Rng(7);
    for (let i = 0; i < Math.round(120 / SIM_DT); i++) stepWildlife(state, stillInput(), SIM_DT, rng);
    const before = state.stillnessSeconds;
    expect(before).toBeGreaterThan(100);
    stepWildlife(state, stillInput({ startle: 1 }), SIM_DT, rng);
    for (let i = 0; i < Math.round(2 / SIM_DT); i++) stepWildlife(state, stillInput(), SIM_DT, rng);
    expect(state.stillnessSeconds).toBeLessThan(before * 0.6);
  });
});

describe('animals respond to the player', () => {
  function settle(seed: number): { state: WildlifeState; rng: Rng } | null {
    const state = createWildlife({ campsiteSeed: 0xbeef, roster: ROSTER });
    const rng = new Rng(seed);
    for (let i = 0; i < Math.round(900 / SIM_DT); i++) {
      stepWildlife(state, stillInput(), SIM_DT, rng);
      const watching = state.animals.some((animal) => animal.phase === 'watching');
      if (watching) return { state, rng };
    }
    return null;
  }

  it('flees from a sudden noise and light, then comes back when it is quiet again', () => {
    const settled = settle(21);
    expect(settled).not.toBeNull();
    const { state, rng } = settled as { state: WildlifeState; rng: Rng };
    drainWildlifeEvents(state);
    expect(state.animals.length).toBeGreaterThan(0);

    const startled: WildlifeEvent[] = [];
    for (let i = 0; i < Math.round(20 / SIM_DT); i++) {
      stepWildlife(state, noisyInput({ startle: i === 0 ? 1 : 0, noise: 0.9, lightSweep: 0.9 }), SIM_DT, rng);
      startled.push(...drainWildlifeEvents(state));
    }
    expect(startled.some((event) => event.kind === 'startled')).toBe(true);
    expect(state.animals.every((animal) => animal.phase === 'fleeing' || animal.phase === 'gone')).toBe(true);

    // The place empties out...
    for (let i = 0; i < Math.round(30 / SIM_DT); i++) {
      stepWildlife(state, noisyInput({ noise: 0.9 }), SIM_DT, rng);
      drainWildlifeEvents(state);
    }
    expect(state.animals.length).toBe(0);

    // ...and fills again once the player is still.
    let returned = false;
    for (let i = 0; i < Math.round(1800 / SIM_DT) && !returned; i++) {
      stepWildlife(state, stillInput(), SIM_DT, rng);
      returned = drainWildlifeEvents(state).some((event) => event.kind === 'appeared');
    }
    expect(returned).toBe(true);
  });

  it('reports being watched from the dark', () => {
    const state = createWildlife({ campsiteSeed: 0xbeef, roster: [FLYING_SQUIRREL] });
    const rng = new Rng(4);
    let watched = false;
    for (let i = 0; i < Math.round(2400 / SIM_DT) && !watched; i++) {
      stepWildlife(state, stillInput(), SIM_DT, rng);
      watched = wildlifeSignals(state).watched;
    }
    expect(watched).toBe(true);
    const nearest = presentAnimals(state)[0];
    expect(nearest).toBeDefined();
    // A shy animal keeps its distance even when it stays.
    expect((nearest as { distanceM: number }).distanceM).toBeGreaterThan(6);
  });
});

describe('objects and traces', () => {
  it('investigates an unattended object, sometimes carries it off, and leaves a trace', () => {
    let investigated = 0;
    let taken = 0;
    let traces = 0;
    for (let seed = 0; seed < 24; seed++) {
      const state = createWildlife({ campsiteSeed: 99, roster: [SQUIRREL] });
      const rng = new Rng(seed);
      const input = stillInput({
        objects: [{ id: 'marshmallow_bag', position: vec3(2.2, 0, 0.4), portable: true, food: true }],
      });
      for (let i = 0; i < Math.round(600 / SIM_DT); i++) {
        stepWildlife(state, input, SIM_DT, rng);
        for (const event of drainWildlifeEvents(state)) {
          if (event.kind === 'investigated') investigated++;
          if (event.kind === 'took-object') {
            taken++;
            expect(event.objectId).toBe('marshmallow_bag');
          }
          if (event.kind === 'left-trace') {
            traces++;
            expect(SQUIRREL.traces).toContain(event.trace);
          }
        }
      }
    }
    expect(investigated).toBeGreaterThan(0);
    expect(taken).toBeGreaterThan(0);
    expect(traces).toBeGreaterThan(0);
  });

  it('never takes the same object twice', () => {
    const state = createWildlife({ campsiteSeed: 99, roster: [SQUIRREL] });
    const rng = new Rng(2);
    const input = stillInput({
      objects: [{ id: 'cup', position: vec3(1.8, 0, 0), portable: true, food: false }],
    });
    let taken = 0;
    for (let i = 0; i < Math.round(3000 / SIM_DT); i++) {
      stepWildlife(state, input, SIM_DT, rng);
      taken += drainWildlifeEvents(state).filter((event) => event.kind === 'took-object').length;
    }
    expect(taken).toBeLessThanOrEqual(1);
    // And the module never mutated the caller's object.
    expect(input.objects?.[0]?.id).toBe('cup');
  });
});

describe('persistent individuals', () => {
  it('derives the same residents from the same campsite seed', () => {
    const a = createWildlife({ campsiteSeed: 'pine_hollow', roster: ROSTER });
    const b = createWildlife({ campsiteSeed: 'pine_hollow', roster: ROSTER });
    const c = createWildlife({ campsiteSeed: 'cedar_switchback', roster: ROSTER });

    const ids = (state: WildlifeState): string[] => residents(state).map((individual) => individual.id).sort();
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).not.toEqual(ids(c));
    expect(residents(a).length).toBeGreaterThan(0);

    // Personality travels with the identity, not the session.
    const first = residents(a)[0];
    const same = residents(b).find((individual) => individual.id === first?.id);
    expect(same?.boldness).toBe(first?.boldness);
    expect(same?.markings).toBe(first?.markings);
    expect(same?.markings).not.toBe('');
  });

  it('brings the same individual back on a later visit', () => {
    const seenIn = (sessionSeed: number, priorVisits: Record<string, number> = {}): Set<string> => {
      const state = createWildlife({ campsiteSeed: 'pine_hollow', roster: [SQUIRREL], priorVisits });
      const rng = new Rng(sessionSeed);
      const seen = new Set<string>();
      for (let i = 0; i < Math.round(1500 / SIM_DT); i++) {
        stepWildlife(state, stillInput(), SIM_DT, rng);
        for (const event of drainWildlifeEvents(state)) {
          if (event.kind === 'appeared' && event.persistent) seen.add(event.individualId);
        }
      }
      return seen;
    };

    const visitOne = seenIn(1);
    const visitTwo = seenIn(2);
    expect(visitOne.size).toBeGreaterThan(0);
    expect(visitTwo.size).toBeGreaterThan(0);

    const residentIds = new Set(
      residents(createWildlife({ campsiteSeed: 'pine_hollow', roster: [SQUIRREL] })).map((r) => r.id),
    );
    for (const id of [...visitOne, ...visitTwo]) expect(residentIds.has(id)).toBe(true);
    // The same animal, across two independent sessions.
    const recurring = [...visitOne].filter((id) => visitTwo.has(id));
    expect(recurring.length).toBeGreaterThan(0);
  });

  it('carries earlier visits into recognition without any counter for the player', () => {
    const state = createWildlife({ campsiteSeed: 'pine_hollow', roster: [SQUIRREL] });
    const resident = residents(state)[0];
    expect(resident).toBeDefined();
    const primed = createWildlife({
      campsiteSeed: 'pine_hollow',
      roster: [SQUIRREL],
      priorVisits: { [(resident as { id: string }).id]: 4 },
    });
    const rng = new Rng(9);
    let event: WildlifeEvent | null = null;
    for (let i = 0; i < Math.round(1500 / SIM_DT) && !event; i++) {
      stepWildlife(primed, stillInput(), SIM_DT, rng);
      event =
        drainWildlifeEvents(primed).find(
          (candidate) => candidate.kind === 'appeared' && candidate.individualId === (resident as { id: string }).id,
        ) ?? null;
    }
    expect(event).not.toBeNull();
    expect((event as WildlifeEvent).visits).toBeGreaterThan(4);
    expect(describeSighting(event as WildlifeEvent)).toBe('Pine squirrel, again.');
  });
});

describe('wildlife is not a collectible', () => {
  it('exposes no taming, feeding or completion surface', () => {
    const state = createWildlife({ campsiteSeed: 1, roster: ROSTER });
    const signals = wildlifeSignals(state);
    const banned = ['tame', 'taming', 'tamed', 'fed', 'feeding', 'completion', 'collected', 'total', 'compendium'];
    for (const key of [...Object.keys(signals), ...Object.keys(state)]) {
      expect(banned).not.toContain(key.toLowerCase());
    }
    const resident = residents(state)[0];
    expect(resident).toBeDefined();
    for (const key of Object.keys(resident as object)) expect(banned).not.toContain(key.toLowerCase());
  });

  it('feeds the significance model without persisting anything', () => {
    const events = run(3, 900, stillInput());
    const rare = events.find((event) => event.kind === 'appeared' && event.speciesId === 'flying_squirrel');
    expect(rare).toBeDefined();
    const evidence = wildlifeEvidence(rare as WildlifeEvent, { photographed: true, dwellSeconds: 60 });
    expect(evidence.kind).toBe('wildlife-encounter');
    expect(evidence.rarity).toBeCloseTo(0.9, 6);
    // A rare, photographed, dwelt-on sighting is worth keeping.
    expect(decideTrace(evidence).disposition).not.toBe('fade');
  });
});

describe('weather', () => {
  it('keeps animals in when it is really coming down', () => {
    const state = createWildlife({ campsiteSeed: 1, roster: ROSTER });
    const rng = new Rng(1);
    const dry = stillInput();
    const wet = stillInput({ weather: { precipitation: 0.95, windSpeed: 8, fog: 0, temperatureC: 4 } });
    for (let i = 0; i < Math.round(200 / SIM_DT); i++) stepWildlife(state, dry, SIM_DT, rng);
    expect(speciesAppearanceRate(state, SQUIRREL, wet)).toBeLessThan(
      speciesAppearanceRate(state, SQUIRREL, dry) * 0.7,
    );
  });
});
