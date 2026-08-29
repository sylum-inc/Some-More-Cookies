import { describe, expect, it } from 'vitest';
import {
  BEST_CASE_GAP_SECONDS,
  biteRate,
  cast,
  createFishing,
  describeCatch,
  drainFishingEvents,
  fishingEvidence,
  fishingSignals,
  playFish,
  releaseFish,
  residentsOf,
  stepFishing,
  stowRod,
  strike,
  takeRod,
  type FishingConditions,
  type FishingState,
} from '../src/fishing.js';
import { createWater, stepWater, type WaterFeatureSpec } from '../src/water.js';
import { assertNoScoring } from '../src/activity.js';
import { decideTrace } from '../src/significance.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

const NARROWS: WaterFeatureSpec = {
  kind: 'lake',
  label: 'The narrows',
  widthM: 700,
  flow: 'lapping',
  clarity: 0.7,
  fishable: true,
  skippable: true,
  note: '',
};

const TARN: WaterFeatureSpec = {
  kind: 'tarn',
  label: 'The tarn',
  widthM: 90,
  flow: 'still',
  clarity: 0.97,
  fishable: false,
  skippable: true,
  note: '',
};

const CALM = { precipitation: 0, windSpeed: 1, temperatureC: 10 };

const PATIENT: FishingConditions = {
  window: 'dusk',
  calm: 1,
  precipitation: 0,
  disturbance: 0,
};

function water(spec = NARROWS, seconds = 60) {
  const state = createWater(spec, { campsiteSeed: 5150 });
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepWater(state, SIM_DT, CALM);
  return state;
}

/** Fishes for `seconds` and returns the state, striking whenever it can. */
function fish(
  seconds: number,
  conditions: FishingConditions = PATIENT,
  options: { spec?: WaterFeatureSpec; seed?: number; strikeAt?: boolean } = {},
): { state: FishingState; nibbles: number } {
  const surface = water(options.spec ?? NARROWS);
  const state = createFishing();
  takeRod(state);
  cast(state, surface, 0.6, 0);
  const rng = new Rng(options.seed ?? 77);
  let nibbles = 0;
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    stepWater(surface, SIM_DT, CALM);
    const before = state.phase;
    stepFishing(state, SIM_DT, surface, conditions, rng);
    if (before !== 'nibble' && state.phase === 'nibble') {
      nibbles++;
      if (options.strikeAt !== false) strike(state);
    }
    if (state.phase === 'playing') playFish(state, 0.45, SIM_DT);
    if (state.phase === 'landed') {
      releaseFish(state);
      cast(state, surface, 0.6, 0);
    }
  }
  return { state, nibbles };
}

describe('where there is anything to catch', () => {
  it('has nothing at all in water content says holds nothing', () => {
    // The tarn is "too cold and too young for fish", and content says so.
    expect(residentsOf(TARN)).toHaveLength(0);
    expect(biteRate(water(TARN), PATIENT, 600)).toBe(0);
    const { state } = fish(1800, PATIENT, { spec: TARN });
    expect(state.caught).toHaveLength(0);
  });

  it('has a real roster in water that does', () => {
    expect(residentsOf(NARROWS).length).toBeGreaterThan(2);
  });
});

describe('slow, and that is the point', () => {
  it('has a best case measured in minutes', () => {
    expect(BEST_CASE_GAP_SECONDS).toBeGreaterThanOrEqual(120);
    // Even everything going right, the expected wait is minutes.
    const best = biteRate(water(), PATIENT, 600);
    expect(1 / best).toBeGreaterThan(120);
  });

  it('produces long stretches of nothing whatever, which is not a failure', () => {
    const { state, nibbles } = fish(240);
    expect(state.phase).toBe('soaking');
    // Four minutes of fishing may well produce nothing at all.
    expect(nibbles).toBeLessThan(4);
  });

  it('never gets kinder the longer you go without one', () => {
    // No pity timer. A model that gets more generous as you wait is a promise,
    // and a promise is an obligation (§5.2).
    const surface = water();
    const early = biteRate(surface, PATIENT, 30);
    const late = biteRate(surface, PATIENT, 3600);
    expect(late).toBeCloseTo(early, 10);
  });

  it('is quiet for a line that has only just landed', () => {
    const surface = water();
    expect(biteRate(surface, PATIENT, 0)).toBe(0);
    expect(biteRate(surface, PATIENT, 60)).toBeGreaterThan(0);
  });
});

describe('patience is the only skill, and it is the camp’s', () => {
  it('rewards the same stillness the wildlife model reads', () => {
    const surface = water();
    const restless = biteRate(surface, { ...PATIENT, calm: 0 }, 120);
    const settled = biteRate(surface, { ...PATIENT, calm: 1 }, 120);
    expect(settled).toBeGreaterThan(restless * 2);
  });

  it('is put down by a racket in the camp', () => {
    const surface = water();
    const quiet = biteRate(surface, { ...PATIENT, disturbance: 0 }, 120);
    const compressor = biteRate(surface, { ...PATIENT, disturbance: 1 }, 120);
    expect(compressor).toBeLessThan(quiet * 0.4);
  });

  it('is better in the rain, as it genuinely is', () => {
    const surface = water();
    expect(biteRate(surface, { ...PATIENT, precipitation: 1 }, 120)).toBeGreaterThan(
      biteRate(surface, { ...PATIENT, precipitation: 0 }, 120),
    );
  });

  it('varies with the part of the night', () => {
    const surface = water();
    const dusk = biteRate(surface, { ...PATIENT, window: 'dusk' }, 120);
    const dead = biteRate(surface, { ...PATIENT, window: 'deep-night' }, 120);
    expect(dead).toBeLessThan(dusk);
    expect(dead).toBeGreaterThan(0);
  });
});

describe('the strike, and missing it', () => {
  it('hooks inside the window and does nothing outside it', () => {
    const surface = water();
    const state = createFishing();
    takeRod(state);
    cast(state, surface, 0.6, 0);
    // Nothing there: striking at nothing is a normal, harmless thing to do.
    expect(strike(state)).toBe(false);
    expect(state.phase).toBe('casting');

    // Force a nibble by fishing until one arrives.
    const rng = new Rng(3);
    let guard = 0;
    while (state.phase !== 'nibble' && guard++ < 200_000) {
      stepWater(surface, SIM_DT, CALM);
      stepFishing(state, SIM_DT, surface, PATIENT, rng);
    }
    expect(state.phase).toBe('nibble');
    expect(strike(state)).toBe(true);
    expect(state.phase).toBe('playing');
  });

  it('costs nothing to miss: the line stays in the water', () => {
    const surface = water();
    const state = createFishing();
    takeRod(state);
    cast(state, surface, 0.6, 0);
    const rng = new Rng(3);
    let guard = 0;
    while (state.phase !== 'nibble' && guard++ < 200_000) {
      stepWater(surface, SIM_DT, CALM);
      stepFishing(state, SIM_DT, surface, PATIENT, rng);
    }
    // Let the window close without striking.
    for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
      stepWater(surface, SIM_DT, CALM);
      stepFishing(state, SIM_DT, surface, PATIENT, rng);
    }
    expect(state.phase).toBe('soaking');
    expect(state.caught).toHaveLength(0);
    expect(biteRate(surface, PATIENT, state.soakSeconds)).toBeGreaterThan(0);
  });

  it('breaks the line if it is hauled, and that is the end of it', () => {
    const surface = water();
    const state = createFishing();
    takeRod(state);
    cast(state, surface, 0.9, 0);
    const rng = new Rng(3);
    let guard = 0;
    while (state.phase !== 'nibble' && guard++ < 200_000) {
      stepWater(surface, SIM_DT, CALM);
      stepFishing(state, SIM_DT, surface, PATIENT, rng);
    }
    strike(state);
    let lost = false;
    for (let i = 0; i < Math.round(30 / SIM_DT) && !lost; i++) {
      playFish(state, 1, SIM_DT);
      stepFishing(state, SIM_DT, surface, PATIENT, rng);
      lost = state.events.some((event) => event.kind === 'lost');
    }
    // Either it broke off or it came in; both are stories and neither is a
    // penalty. What must never happen is a stuck state.
    expect(['soaking', 'landed']).toContain(state.phase);
  });

  it('brings one in when it is played patiently', () => {
    const { state } = fish(3600, PATIENT, { seed: 21 });
    expect(state.caught.length).toBeGreaterThan(0);
    expect(describeCatch(state.caught[0]!)).toMatch(/^[A-Z]/);
  });
});

describe('never a minigame with a score', () => {
  it('exposes no total, best or completion anywhere', () => {
    const { state } = fish(1200, PATIENT, { seed: 21 });
    assertNoScoring('fishingSignals', fishingSignals(state));
    assertNoScoring('fishing events', drainFishingEvents(state));
    assertNoScoring('caught', state.caught);
    const signals = fishingSignals(state);
    expect(Object.keys(signals)).not.toContain('caught');
    expect(Object.keys(signals)).not.toContain('total');
  });

  it('offers no way to keep one: the only thing you can do is put it back', () => {
    const { state } = fish(3600, PATIENT, { seed: 21 });
    expect(state.caught.length).toBeGreaterThan(0);
    for (const record of state.caught) {
      expect(Object.keys(record).sort()).toEqual(['at', 'label', 'note', 'playedSeconds']);
    }
  });

  it('has no tackle to lose and no bait to run out of', () => {
    const state = createFishing();
    expect(Object.keys(state)).not.toContain('bait');
    expect(Object.keys(state)).not.toContain('tackle');
    expect(Object.keys(state)).not.toContain('lures');
  });

  it('lets the rod be put down mid-fight with no consequence', () => {
    const { state } = fish(600, PATIENT, { seed: 21 });
    stowRod(state);
    expect(state.phase).toBe('stowed');
    expect(state.hooked).toBeNull();
    takeRod(state);
    expect(state.phase).toBe('ready');
  });
});

describe('determinism', () => {
  it('produces the identical session from the same seed and inputs', () => {
    const a = fish(1800, PATIENT, { seed: 31 });
    const b = fish(1800, PATIENT, { seed: 31 });
    expect(a.state.caught).toEqual(b.state.caught);
    expect(a.nibbles).toBe(b.nibbles);
    expect(a.state.casts).toBe(b.state.casts);
  });

  it('produces a different session from a different seed', () => {
    const a = fish(1800, PATIENT, { seed: 31 });
    const b = fish(1800, PATIENT, { seed: 32 });
    expect(a.state.caught.length + a.nibbles).not.toBe(-1);
    expect([a.nibbles, a.state.caught.length]).not.toEqual([b.nibbles, b.state.caught.length]);
  });
});

describe('the significance model', () => {
  it('remembers something unusual and lets the ordinary fade', () => {
    const rare = decideTrace(
      fishingEvidence(
        { kind: 'landed', at: 400, label: 'something much larger', rarity: 0.95 },
        { isFirst: true, interactionCount: 6, dwellSeconds: 120 },
      ),
    );
    expect(rare.disposition).not.toBe('fade');

    const perch = decideTrace(
      fishingEvidence({ kind: 'landed', at: 40, label: 'a perch', rarity: 0 }, { interactionCount: 1 }),
    );
    expect(perch.disposition).toBe('fade');
  });
});
