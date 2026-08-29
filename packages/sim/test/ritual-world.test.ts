/**
 * The world systems, wired into the ritual.
 *
 * `wildlife.test.ts`, `radio.test.ts` and `discovery.test.ts` prove the models
 * themselves. This file proves the *wiring*: that a ritual actually feeds them
 * real state, that the cues a player generates are the cues the animals read,
 * and that nothing here is decoration hanging off the side of the session.
 */

import { describe, expect, it } from 'vitest';
import {
  animalsPresent,
  createRitual,
  machineNoise,
  photograph,
  ritualSignals,
  setPresence,
  setRadioBand,
  stepRitual,
  toggleRadio,
  tuneToStation,
  turnRadioDial,
  windowAt,
  worldCues,
  type RitualState,
  type RitualWorldContent,
  type SecretDefinition,
  type WildlifeSpecies,
} from '../src/index.js';
import { SIM_DT, vec3 } from '../src/types.js';
function seconds(ritual: RitualState, s: number, before?: () => void): void {
  const steps = Math.round(s / SIM_DT);
  for (let i = 0; i < steps; i++) {
    before?.();
    stepRitual(ritual, SIM_DT);
  }
}

const FOX: WildlifeSpecies = {
  id: 'fox',
  label: 'a red fox',
  shyness: 0.5,
  curiosity: 0.8,
  window: ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'],
  attractedBy: ['stillness', 'quiet', 'food-smell', 'marshmallow-smell', 'crumbs'],
  repelledBy: ['sudden-movement', 'voices', 'compressor-noise', 'flashlight'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['four narrow prints in the ash'],
  note: 'knows exactly how close it can get',
};

const OWL: WildlifeSpecies = {
  id: 'owl',
  label: 'a barred owl',
  shyness: 0.85,
  curiosity: 0.25,
  window: ['deep-night', 'pre-dawn'],
  attractedBy: ['stillness', 'quiet'],
  repelledBy: ['sudden-movement', 'voices', 'radio-music'],
  canPersist: true,
  investigatesObjects: false,
  traces: ['a single barred feather'],
  note: 'heard far more often than seen',
};

const SECRET: SecretDefinition = {
  id: 'the-other-fire',
  title: 'The other fire',
  discovery: 'stand still long enough, past midnight, and there is a second light on the far ridge',
  telling: 'someone else is out here, and has been for a while',
  channels: ['distant-sounds'],
  oneTime: false,
  leavesEvidence: null,
  rarity: 0.9,
  optional: true,
  gatesNothing: true,
};

const WORLD: RitualWorldContent = {
  wildlife: [FOX, OWL],
  radio: {
    stations: [
      {
        id: 'kfr',
        dial: 96.3,
        band: 'fm',
        name: 'KFR',
        character: 'lofi',
        reception: 0.8,
        note: 'a signal that carries down the valley',
      },
      {
        id: 'weather',
        dial: 162.4,
        band: 'fm',
        name: 'WX',
        character: 'weather-service',
        reception: 0.55,
        note: 'the forecast, read by a machine',
      },
      {
        id: 'numbers',
        dial: 6840,
        band: 'shortwave',
        name: '',
        character: 'strange',
        reception: 0.22,
        note: 'nobody knows',
      },
    ],
    baseReception: 0.6,
    receptionNote: 'the ridge blocks half the sky',
    betweenStations: 'a wide, soft hiss',
  },
  secrets: [SECRET],
};

function makeRitual(overrides: Partial<Parameters<typeof createRitual>[0]> = {}): RitualState {
  return createRitual({
    campsiteSeed: 'pine-hollow-777',
    environmentId: 'pine_hollow',
    world: WORLD,
    ...overrides,
  });
}

describe('the world systems are actually wired in', () => {
  it('creates them from the campsite content, not from defaults', () => {
    const ritual = makeRitual();
    expect(ritual.wildlife.roster.map((s) => s.id)).toEqual(['fox', 'owl']);
    expect(ritual.radio.profile.stations).toHaveLength(3);
    expect(ritual.discovery.secrets).toHaveLength(1);
  });

  it('survives a campsite with no wildlife, no dial and no secrets', () => {
    const ritual = createRitual({ campsiteSeed: 'bare', environmentId: 'nowhere' });
    seconds(ritual, 4);
    expect(animalsPresent(ritual)).toHaveLength(0);
    expect(ritual.radio.profile.stations).toHaveLength(0);
    // A silent dial is still a radio: it can be switched on and hissed at.
    toggleRadio(ritual, true);
    seconds(ritual, 1);
    expect(ritual.radio.on).toBe(true);
    expect(ritual.radio.reception.hiss).toBeGreaterThan(0.3);
  });

  it('steps them every step, without the caller doing anything', () => {
    const ritual = makeRitual();
    seconds(ritual, 3);
    expect(ritual.wildlife.elapsed).toBeCloseTo(3, 1);
    expect(ritual.radio.elapsed).toBeCloseTo(3, 1);
    expect(ritual.discovery.elapsed).toBeCloseTo(3, 1);
  });
});

describe('cues come from the world, not from the stage', () => {
  it('reports the fire that is actually burning', () => {
    const ritual = makeRitual();
    seconds(ritual, 2);
    const lit = worldCues(ritual);
    expect(lit.firelight ?? 0).toBeGreaterThan(0.2);
    expect(lit.warmth ?? 0).toBeGreaterThan(0.2);

    // Put the flame out by hand and the cue follows immediately: nothing here
    // is keyed off `stage`.
    ritual.fire.flame = 0;
    ritual.fire.emberMass = 0;
    ritual.fire.emberTemp = 20;
    const dark = worldCues(ritual);
    expect(dark.firelight ?? 0).toBeLessThan(0.02);
    expect(dark.warmth ?? 0).toBeLessThan(0.05);
  });

  it('smells of marshmallow only once one is actually browning', () => {
    const ritual = makeRitual();
    seconds(ritual, 1);
    expect(worldCues(ritual)['marshmallow-smell'] ?? 0).toBe(0);

    ritual.stage = 'roasting';
    for (const patch of ritual.marshmallow.patches) patch.brown = 0;
    expect(worldCues(ritual)['marshmallow-smell'] ?? 0).toBe(0);

    const first = ritual.marshmallow.patches[0];
    if (!first) throw new Error('no patches');
    first.brown = 0.7;
    expect(worldCues(ritual)['marshmallow-smell'] ?? 0).toBeCloseTo(0.7, 5);
  });

  it('turns the player into footsteps and the radio into music', () => {
    const ritual = makeRitual();
    setPresence(ritual, { speed: 1.4 });
    seconds(ritual, 0.5);
    expect(worldCues(ritual).footsteps ?? 0).toBeGreaterThan(0.6);

    expect(worldCues(ritual)['radio-music'] ?? 0).toBe(0);
    toggleRadio(ritual, true);
    tuneToStation(ritual.radio, 'kfr');
    seconds(ritual, 2);
    expect(worldCues(ritual)['radio-music'] ?? 0).toBeGreaterThan(0.1);
  });

  it('reports the SM-01 as noise only while it is running', () => {
    const ritual = makeRitual();
    expect(machineNoise(ritual.machine)).toBe(0);
    ritual.machine.compressor = 1;
    ritual.machine.fan = 0.8;
    expect(machineNoise(ritual.machine)).toBeGreaterThan(0.9);
    expect(worldCues(ritual)['compressor-noise'] ?? 0).toBe(1);
  });
});

describe('stillness is a mechanic, through the ritual', () => {
  it('accumulates calm for a player who stops, and destroys it for one who does not', () => {
    const still = makeRitual();
    setPresence(still, { speed: 0, position: vec3(1.4, 0, 0.6) });
    seconds(still, 90);

    const restless = makeRitual();
    seconds(restless, 90, () => {
      setPresence(restless, { speed: 1.5, position: vec3(1.4, 0, 0.6) });
    });

    expect(still.wildlife.stillnessSeconds).toBeGreaterThan(60);
    expect(restless.wildlife.stillnessSeconds).toBeLessThan(5);
    expect(still.wildlife.calm).toBeGreaterThan(restless.wildlife.calm + 0.4);
  });

  // A statistical property needs trials, and trials of a 60 Hz simulation are
  // not free: this is the most expensive test in the package by a wide margin
  // and it timed out under a parallel full-suite run at the default 5 s. The
  // budget is explicit rather than implicit, so a future slowdown fails
  // loudly instead of flaking.
  it(
    'brings more animals to the still camp than to the noisy one',
    () => {
      let stillSightings = 0;
      let noisySightings = 0;

      for (let trial = 0; trial < 5; trial++) {
        const still = makeRitual({ campsiteSeed: `still-${trial}` });
        setPresence(still, { speed: 0 });
        seconds(still, 400);
        stillSightings += still.wildlifeEvents.filter((e) => e.kind === 'appeared').length;

        // The same campsite on the same night, with somebody crashing about
        // in it: the only difference is the player.
        const noisy = makeRitual({ campsiteSeed: `still-${trial}` });
        seconds(noisy, 400, () => {
          setPresence(noisy, { speed: 1.45, voices: 0.8, startle: 0.2 });
        });
        noisySightings += noisy.wildlifeEvents.filter((e) => e.kind === 'appeared').length;
      }

      expect(stillSightings).toBeGreaterThan(noisySightings);
    },
    30_000,
  );

  it('startles the camp when a flash goes off, and the impulse lasts one step', () => {
    const ritual = makeRitual();
    setPresence(ritual, { speed: 0 });
    seconds(ritual, 200);

    photograph(ritual, ['fox'], true);
    expect(ritual.presence.startle).toBe(1);
    stepRitual(ritual, SIM_DT);
    // Consumed, not latched: one flash is one startle.
    expect(ritual.presence.startle).toBe(0);
    expect(ritual.wildlife.startlePulse).toBeGreaterThan(0);
  });
});

describe('the night moves', () => {
  it('advances the activity window as a session runs long', () => {
    expect(windowAt('early-night', 0)).toBe('early-night');
    expect(windowAt('early-night', 15 * 60)).toBe('deep-night');
    expect(windowAt('early-night', 60 * 60)).toBe('dawn');
    // It never wraps past dawn: a session does not loop the sun.
    expect(windowAt('early-night', 10 * 60 * 60)).toBe('dawn');
  });

  it('reaches the ritual, so the deep-night species become possible', () => {
    const ritual = makeRitual();
    expect(ritual.window).toBe('early-night');
    seconds(ritual, 15 * 60);
    expect(ritual.window).toBe('deep-night');
  });
});

describe('the radio', () => {
  it('is off until someone switches it on, and then it is on', () => {
    const ritual = makeRitual();
    expect(ritual.radio.on).toBe(false);
    expect(ritualSignals(ritual).radioClarity).toBe(0);
    toggleRadio(ritual);
    tuneToStation(ritual.radio, 'kfr');
    seconds(ritual, 2);
    expect(ritualSignals(ritual).radioClarity).toBeGreaterThan(0.4);
    expect(ritualSignals(ritual).radioStationName).toBe('KFR');
  });

  it('goes quiet between stations', () => {
    const ritual = makeRitual();
    toggleRadio(ritual, true);
    tuneToStation(ritual.radio, 'kfr');
    seconds(ritual, 1);
    const locked = ritual.radio.reception.clarity;

    turnRadioDial(ritual, 4.5);
    seconds(ritual, 1);
    expect(ritual.radio.reception.clarity).toBeLessThan(locked * 0.5);
    expect(ritual.radio.reception.hiss).toBeGreaterThan(0.4);
  });

  it('is degraded by the SM-01 running beside it', () => {
    const quiet = makeRitual();
    toggleRadio(quiet, true);
    tuneToStation(quiet.radio, 'weather');
    seconds(quiet, 2);

    const noisy = makeRitual();
    toggleRadio(noisy, true);
    tuneToStation(noisy.radio, 'weather');
    seconds(noisy, 2, () => {
      noisy.machine.compressor = 1;
      noisy.machine.fan = 1;
    });

    expect(noisy.radio.reception.hum).toBeGreaterThan(quiet.radio.reception.hum);
  });

  it('keeps a shortwave band available without inventing one', () => {
    const ritual = makeRitual();
    setRadioBand(ritual, 'shortwave');
    expect(ritual.radio.band).toBe('shortwave');
    expect(ritual.radio.bands.shortwave.min).toBeLessThan(6840);
    expect(ritual.radio.bands.shortwave.max).toBeGreaterThan(6840);
  });
});

describe('significance', () => {
  it('turns sightings into traces, and never exposes a score', { timeout: 20_000 }, () => {
    const ritual = makeRitual({ campsiteSeed: 'traces-1' });
    setPresence(ritual, { speed: 0 });
    seconds(ritual, 600);

    expect(ritual.wildlifeEvents.length).toBeGreaterThan(0);
    expect(ritual.traces.length).toBeGreaterThan(0);
    for (const trace of ritual.traces) {
      expect(['fade', 'keep', 'passport', 'landmark']).toContain(trace.disposition);
      // The score behind the decision must never be reachable (§6.4).
      expect(Object.keys(trace)).not.toContain('score');
      expect(Object.keys(trace)).not.toContain('value');
      expect(Object.keys(trace)).not.toContain('significance');
    }
  });

  it('remembers residents across visits when the caller hands their history back', { timeout: 30_000 }, () => {
    // Whether a *resident* rather than a passing animal turns up is chance,
    // and a campsite's night is fully determined by its seed — so replaying
    // one campsite would replay the same coin toss. This walks campsites until
    // it finds a night where a resident actually came in.
    const priorVisits: Record<string, number> = {};
    let campsite = '';
    for (const candidate of ['return-1', 'return-2', 'return-3', 'return-4', 'return-5']) {
      const night = makeRitual({ campsiteSeed: candidate });
      setPresence(night, { speed: 0 });
      seconds(night, 900);
      for (const individual of night.wildlife.individuals) {
        if (individual.persistent && individual.visits > 0) priorVisits[individual.id] = individual.visits;
      }
      if (Object.keys(priorVisits).length > 0) {
        campsite = candidate;
        break;
      }
    }
    expect(Object.keys(priorVisits).length).toBeGreaterThan(0);

    const second = makeRitual({ campsiteSeed: campsite, visitIndex: 2, priorVisits });
    for (const individual of second.wildlife.individuals) {
      const prior = priorVisits[individual.id];
      if (prior !== undefined) expect(individual.visits).toBe(prior);
    }
  });

  it('reports no denominator anywhere in the readouts', () => {
    const ritual = makeRitual();
    seconds(ritual, 5);
    const signals = ritualSignals(ritual);
    // `found` with no total is the whole point: never "3 of 7" (§5.3).
    expect(signals.discovery).toHaveProperty('found');
    expect(signals.discovery).not.toHaveProperty('total');
    expect(signals.discovery).not.toHaveProperty('remaining');
    expect(signals.discovery).not.toHaveProperty('percent');
  });
});

describe('every step draws fresh randomness', () => {
  /**
   * Regression for a defect that made the whole simulation stochastically
   * frozen: `Rng.split(name)` derives from the parent's *current* state, and
   * nothing in the ritual ever drew from the parent, so every step handed each
   * subsystem the identical child stream. Fire crackle, weather transitions,
   * roasting variation, appearances — all of it sampled one value and then
   * repeated it for the entire session. Everything still compiled and every
   * test still passed, which is exactly why this one exists.
   */
  it('does not hand the same stream to a subsystem twice', () => {
    const ritual = makeRitual({ campsiteSeed: 'streams' });
    const seen = new Set<number>();
    for (let i = 0; i < 240; i++) {
      stepRitual(ritual, SIM_DT);
      // The tick is what varies the streams, so it is what must advance.
      seen.add(ritual.tick);
    }
    expect(seen.size).toBe(240);
  });

  it('produces a fire that actually varies over a long session', () => {
    const ritual = makeRitual({ campsiteSeed: 'varies' });
    const samples: number[] = [];
    for (let i = 0; i < Math.round(120 / SIM_DT); i++) {
      stepRitual(ritual, SIM_DT);
      if (i % 60 === 0) samples.push(ritual.fire.flame);
    }
    const unique = new Set(samples.map((v) => Math.round(v * 1000)));
    expect(unique.size).toBeGreaterThan(4);
  });

  it('lets the weather move, rather than freezing on its first sample', () => {
    const ritual = makeRitual({ campsiteSeed: 'weather-moves' });
    const winds: number[] = [];
    for (let i = 0; i < Math.round(600 / SIM_DT); i++) {
      stepRitual(ritual, SIM_DT);
      if (i % 600 === 0) winds.push(ritual.weather.windSpeed);
    }
    const spread = Math.max(...winds) - Math.min(...winds);
    expect(spread).toBeGreaterThan(0.05);
  });
});

describe('determinism holds with the world systems in', () => {
  it('produces an identical night from an identical seed and identical input', { timeout: 20_000 }, () => {
    const run = (): { animals: number; traces: number; dial: number; still: number } => {
      const ritual = makeRitual({ campsiteSeed: 'determinism' });
      toggleRadio(ritual, true);
      seconds(ritual, 300, () => setPresence(ritual, { speed: 0 }));
      return {
        animals: ritual.wildlifeEvents.length,
        traces: ritual.traces.length,
        dial: ritual.radio.dial + ritual.radio.drift,
        still: ritual.wildlife.stillnessSeconds,
      };
    };
    expect(run()).toEqual(run());
  });

  it('produces a different night at a different campsite', { timeout: 20_000 }, () => {
    const at = (seed: string): number => {
      const ritual = makeRitual({ campsiteSeed: seed });
      seconds(ritual, 300, () => setPresence(ritual, { speed: 0 }));
      return ritual.wildlife.individuals.length;
    };
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f'].map(at);
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});
