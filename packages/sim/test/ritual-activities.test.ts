/**
 * The secondary activities, wired into the ritual.
 *
 * `skipping.test.ts`, `torch.test.ts`, `sitting.test.ts`, `fishing.test.ts` and
 * `stargazing.test.ts` prove the models. This file proves the *wiring*: that
 * `stepRitual` actually advances them, that they read the same weather and the
 * same water the rest of the session does, that the torch really is what the
 * wildlife feel, and that a moment worth remembering reaches the significance
 * model the same way a wildlife sighting does.
 */

import { describe, expect, it } from 'vitest';
import {
  castLine,
  createRitual,
  lieBack,
  lookAtSky,
  pointTorch,
  raiseBinoculars,
  ritualSignals,
  setPresence,
  setTorchFocus,
  sitOnSeat,
  skipStone,
  standFromSeat,
  stepRitual,
  stonesCanSkip,
  strikeLine,
  takeFishingRod,
  takeStone,
  takeTorchFromLog,
  toggleTorch,
  skyTargets,
  waterHoldsFish,
  worldCues,
  bestStone,
  createThrow,
  type RitualState,
  type RitualWorldContent,
  type SkyTarget,
  type WaterFeatureSpec,
  type WildlifeSpecies,
} from '../src/index.js';
import { assertNoScoring } from '../src/activity.js';
import { SIM_DT, vec3 } from '../src/types.js';

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

/** Ashfall Barrens: water that is neither fishable nor skippable. */
const SEEP: WaterFeatureSpec = {
  kind: 'hot-spring',
  label: 'The seep and the box',
  widthM: 2.2,
  flow: 'seeping',
  clarity: 0.8,
  fishable: false,
  skippable: false,
  note: '',
};

const FLYING_SQUIRREL: WildlifeSpecies = {
  id: 'flying-squirrel',
  label: 'a flying squirrel',
  shyness: 0.86,
  curiosity: 0.7,
  window: ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'],
  attractedBy: ['stillness', 'quiet'],
  repelledBy: ['flashlight', 'voices', 'sudden-movement'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['a scatter of bark'],
  note: '',
};

function makeRitual(world: RitualWorldContent = {}, overrides = {}): RitualState {
  return createRitual({
    campsiteSeed: 'camp-activities',
    environmentId: 'loonwater_narrows',
    now: Date.UTC(2024, 7, 12, 6, 0, 0),
    world,
    ...overrides,
  });
}

function seconds(ritual: RitualState, s: number, before?: () => void): void {
  const steps = Math.round(s / SIM_DT);
  for (let i = 0; i < steps; i++) {
    before?.();
    stepRitual(ritual, SIM_DT);
  }
}

/* -------------------------------------------------------------------------- */

describe('water only where the manifest has it', () => {
  it('has no water at all at a dry site, and nothing breaks', () => {
    const dry = makeRitual({});
    expect(dry.water).toBeNull();
    expect(stonesCanSkip(dry)).toBe(false);
    expect(waterHoldsFish(dry)).toBe(false);
    expect(takeStone(dry)).toBeNull();
    expect(skipStone(dry, createThrow({}), vec3(0, 1.2, 0))).toBe(false);
    expect(castLine(dry, 0.5, 0)).toBe(false);
    // A whole session at a dry site runs exactly as it always did.
    seconds(dry, 30);
    expect(dry.elapsed).toBeGreaterThan(29);
    expect(ritualSignals(dry).waterLabel).toBeNull();
    expect(ritualSignals(dry).fishing).toBeNull();
  });

  it('respects what the manifest says even where there *is* water', () => {
    // The hot spring is water you cannot skip on or fish in, and the model
    // takes content's word for it rather than inferring from the kind.
    const barrens = makeRitual({ water: SEEP });
    expect(barrens.water).not.toBeNull();
    expect(stonesCanSkip(barrens)).toBe(false);
    expect(waterHoldsFish(barrens)).toBe(false);
  });

  it('steps the surface with the session’s own weather', () => {
    const ritual = makeRitual({ water: NARROWS });
    const before = ritual.water!.elapsed;
    seconds(ritual, 10);
    expect(ritual.water!.elapsed).toBeGreaterThan(before + 9);
    expect(ritualSignals(ritual).waterLabel).toContain('The narrows');
  });
});

describe('a stone, thrown through the ritual', () => {
  it('flies, skips and ends, stepped by stepRitual alone', () => {
    const ritual = makeRitual({ water: NARROWS });
    // Let the surface settle to whatever tonight's weather makes of it.
    seconds(ritual, 60);
    const stone = bestStone(ritual.skipping.stones)!;
    expect(takeStone(ritual, stone.id)).toEqual(stone);
    expect(skipStone(ritual, createThrow({ power: 0.9, elevation: 0.08, tilt: 0.32, spin: 0.85 }), vec3(0, 1.2, 0))).toBe(
      true,
    );
    expect(ritual.skipping.phase).toBe('flying');

    seconds(ritual, 10);
    expect(['sunk', 'shore']).toContain(ritual.skipping.phase);
    expect(ritual.skipping.skips).toBeGreaterThan(0);
    expect(ritual.skipEvents.some((event) => event.kind === 'skip')).toBe(true);
  });

  it('rings the surface where it touched, which the wildlife can hear', () => {
    const ritual = makeRitual({ water: NARROWS });
    seconds(ritual, 60);
    expect(worldCues(ritual).splashing).toBe(0);
    takeStone(ritual);
    skipStone(ritual, createThrow({ power: 0.9, tilt: 0.32, spin: 0.85 }), vec3(0, 1.2, 0));
    seconds(ritual, 1.5);
    expect(worldCues(ritual).splashing).toBeGreaterThan(0);
    expect(worldCues(ritual)['water-edge']).toBe(1);
  });

  it('leaves a trace the significance model decided on, and never a score', () => {
    const ritual = makeRitual({ water: NARROWS });
    seconds(ritual, 90, () => setPresence(ritual, { places: ['water-edge'] }));
    takeStone(ritual, bestStone(ritual.skipping.stones)!.id);
    skipStone(ritual, createThrow({ power: 0.9, elevation: 0.08, tilt: 0.32, spin: 0.85 }), vec3(0, 1.2, 0));
    seconds(ritual, 10);

    const trace = ritual.traces.find((candidate) => candidate.id.startsWith('skip:'));
    expect(trace).toBeDefined();
    expect(['fade', 'keep', 'passport', 'landmark']).toContain(trace!.disposition);
    // The value behind the decision never leaves the model (§6.4).
    expect(Object.keys(trace!)).not.toContain('score');
    assertNoScoring('skip trace payload', trace!.payload);
  });
});

describe('the torch is what the wildlife feel', () => {
  it('produces no flashlight cue until it is picked up and switched on', () => {
    const ritual = makeRitual({ wildlife: [FLYING_SQUIRREL] });
    seconds(ritual, 2);
    expect(worldCues(ritual).flashlight).toBe(0);

    takeTorchFromLog(ritual);
    seconds(ritual, 1);
    expect(worldCues(ritual).flashlight).toBeGreaterThan(0);

    toggleTorch(ritual, false);
    seconds(ritual, 2);
    expect(worldCues(ritual).flashlight).toBe(0);
  });

  it('is far worse when it is raked about than when it is held still', () => {
    const build = (rake: boolean): number => {
      const ritual = makeRitual({ wildlife: [FLYING_SQUIRREL] });
      takeTorchFromLog(ritual);
      let yaw = 0;
      seconds(ritual, 3, () => {
        if (rake) yaw += 2.6 * SIM_DT;
        pointTorch(ritual, yaw, -0.1);
      });
      return worldCues(ritual).flashlight ?? 0;
    };
    const still = build(false);
    const raked = build(true);
    expect(raked).toBeGreaterThan(still * 2);
  });

  it('no longer invents a light sweep out of walking speed', () => {
    // The defect this replaces: walking about with no torch at all emptied
    // the treeline, because the client derived `lightSweep` from speed.
    const ritual = makeRitual({ wildlife: [FLYING_SQUIRREL] });
    seconds(ritual, 3, () => setPresence(ritual, { speed: 1.5 }));
    expect(worldCues(ritual).flashlight).toBe(0);
    // Footsteps are still heard — walking is not silent, it is just not light.
    expect(worldCues(ritual).footsteps).toBeGreaterThan(0);
  });

  it('trades reach against width when the head is twisted', () => {
    const ritual = makeRitual();
    takeTorchFromLog(ritual);
    setTorchFocus(ritual, 1);
    expect(ritual.torch.rangeM).toBeGreaterThan(15);
    setTorchFocus(ritual, 0);
    expect(ritual.torch.rangeM).toBeLessThan(9);
  });
});

describe('sitting, through the ritual', () => {
  it('reaches the wildlife model and banks stillness faster than standing', () => {
    const standing = makeRitual({ wildlife: [FLYING_SQUIRREL] });
    seconds(standing, 90);

    const seated = makeRitual({ wildlife: [FLYING_SQUIRREL] });
    sitOnSeat(seated, 'log-seat');
    seconds(seated, 90);

    expect(seated.seat.settled).toBeGreaterThan(0.9);
    expect(seated.wildlife.stillnessSeconds).toBeGreaterThan(standing.wildlife.stillnessSeconds * 1.5);
    expect(seated.wildlife.calm).toBeGreaterThan(standing.wildlife.calm);
    expect(ritualSignals(seated).settled).toBeGreaterThan(0.9);
  });

  it('follows the client’s own seated flag, so there is one source of truth', () => {
    const ritual = makeRitual();
    setPresence(ritual, { seated: true, seatId: 'log-seat' });
    seconds(ritual, 40);
    expect(ritual.seat.seated).toBe(true);
    expect(ritual.seat.settled).toBeGreaterThan(0.5);

    setPresence(ritual, { seated: false });
    seconds(ritual, 1);
    expect(ritual.seat.seated).toBe(false);
    expect(ritual.seat.settled).toBeLessThan(0.1);
  });

  it('loses the settling on standing up, immediately', () => {
    const ritual = makeRitual();
    sitOnSeat(ritual);
    seconds(ritual, 120);
    expect(ritual.seat.settled).toBeGreaterThan(0.9);
    standFromSeat(ritual);
    expect(ritual.seat.settled).toBe(0);
  });
});

describe('the sky, through the ritual', () => {
  it('is the real sky for the injected date, occluded by the real cloud', () => {
    // Cloud is pinned on every step: the weather model would otherwise pull it
    // straight back to whatever this campsite's profile wants, which is
    // correct behaviour and would make the comparison meaningless.
    const build = (cloudCover: number): number => {
      const ritual = makeRitual({ skyOpenness: 1 });
      seconds(ritual, 25, () => {
        ritual.weather.cloudCover = cloudCover;
      });
      return ritualSignals(ritual).sky.quality;
    };
    const clear = build(0);
    const socked = build(1);

    expect(clear).toBeGreaterThan(0.3);
    expect(socked).toBeLessThan(clear * 0.2);

    const ritual = makeRitual({ skyOpenness: 1 });
    seconds(ritual, 25);
    expect(ritualSignals(ritual).sky.moonLabel).toMatch(/moon|quarter|crescent|gibbous/i);
  });

  it('lets a constellation be found by lying back and holding it in view', () => {
    const ritual = makeRitual({ skyOpenness: 1 });
    lieBack(ritual, true);
    seconds(ritual, 1, () => {
      ritual.weather.cloudCover = 0;
    });
    // Aim at whatever is highest tonight — no marker told us where it was.
    const target = ritual.stargazing.sky.starVisibility > 0 ? highestTarget(ritual) : null;
    expect(target).not.toBeNull();
    lookAtSky(ritual, target!.azimuth, target!.altitude);
    expect(ritualSignals(ritual).sky.holding).toBeNull();
    seconds(ritual, 8, () => {
      ritual.weather.cloudCover = 0;
    });
    expect(ritual.stargazing.recognised).toContain(target!.id);
    expect(ritualSignals(ritual).sky.holding).toBe(target!.label);
  });

  it('reports the binoculars as raised and narrows the field', () => {
    const ritual = makeRitual();
    const wide = ritual.stargazing.fieldRadius;
    raiseBinoculars(ritual, true);
    seconds(ritual, 0.5);
    expect(ritual.stargazing.fieldRadius).toBeLessThan(wide);
    expect(ritualSignals(ritual).sky.binoculars).toBe(true);
  });
});

/** Whatever is highest in tonight's sky — the same readout the renderer uses. */
function highestTarget(ritual: RitualState): SkyTarget | null {
  return (
    skyTargets(ritual.stargazing, ritual.weather.cloudCover)
      .filter((target) => target.up)
      .sort((a, b) => b.altitude - a.altitude)[0] ?? null
  );
}

describe('fishing, through the ritual', () => {
  it('reads the session’s calm, so sitting by the water genuinely helps', () => {
    const ritual = makeRitual({ water: NARROWS });
    takeFishingRod(ritual);
    castLine(ritual, 0.6, 0);
    seconds(ritual, 60);
    expect(ritual.fishing.phase).toBe('soaking');
    expect(ritual.fishing.soakSeconds).toBeGreaterThan(50);
    const signals = ritualSignals(ritual).fishing!;
    expect(signals.phase).toBe('soaking');
    assertNoScoring('ritualSignals.fishing', signals);
  });

  it('rings the surface when the float goes in', () => {
    const ritual = makeRitual({ water: NARROWS });
    takeFishingRod(ritual);
    seconds(ritual, 5);
    const before = ritual.water!.ripples.length;
    castLine(ritual, 0.6, 0);
    expect(ritual.water!.ripples.length).toBeGreaterThan(before);
  });

  it('does nothing at all where content says there are no fish', () => {
    const ritual = makeRitual({ water: SEEP });
    takeFishingRod(ritual);
    expect(ritual.fishing.phase).toBe('stowed');
    expect(castLine(ritual, 0.6, 0)).toBe(false);
    expect(strikeLine(ritual)).toBe(false);
  });
});

describe('determinism of the whole session', () => {
  it('reproduces every activity exactly from the same seed and input timeline', () => {
    const build = () => {
      const ritual = makeRitual({ water: NARROWS, wildlife: [FLYING_SQUIRREL], skyOpenness: 0.9 });
      takeTorchFromLog(ritual);
      sitOnSeat(ritual);
      lieBack(ritual, true);
      takeFishingRod(ritual);
      castLine(ritual, 0.7, 1.1);
      let yaw = 0;
      seconds(ritual, 120, () => {
        yaw += 0.9 * SIM_DT;
        pointTorch(ritual, yaw, -0.2);
        lookAtSky(ritual, yaw * 0.4, 1.0);
      });
      takeStone(ritual, bestStone(ritual.skipping.stones)!.id);
      skipStone(ritual, createThrow({ power: 0.9, elevation: 0.08, tilt: 0.32, spin: 0.85 }), vec3(0, 1.2, 0));
      seconds(ritual, 12);
      return {
        skips: ritual.skipping.skips,
        distance: ritual.skipping.distanceM,
        settled: ritual.seat.settled,
        stillness: ritual.wildlife.stillnessSeconds,
        recognised: [...ritual.stargazing.recognised],
        casts: ritual.fishing.casts,
        caught: ritual.fishing.caught.length,
        traces: ritual.traces.map((trace) => `${trace.id}:${trace.disposition}`),
        chop: ritual.water!.chop,
      };
    };
    expect(build()).toEqual(build());
  });

  it('does not depend on which activities happened first', () => {
    // ADR-0006: the per-step streams are independent, so a session spent
    // fishing consumes the same fire randomness as one spent throwing stones.
    const quiet = makeRitual({ water: NARROWS, wildlife: [FLYING_SQUIRREL] });
    seconds(quiet, 60);

    const busy = makeRitual({ water: NARROWS, wildlife: [FLYING_SQUIRREL] });
    takeTorchFromLog(busy);
    takeStone(busy);
    seconds(busy, 60);

    expect(busy.fire.flame).toBeCloseTo(quiet.fire.flame, 10);
    expect(busy.weather.windSpeed).toBeCloseTo(quiet.weather.windSpeed, 10);
  });
});
