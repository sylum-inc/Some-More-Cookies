import { describe, expect, it } from 'vitest';
import {
  aimSky,
  createStargazing,
  describeSkyMoment,
  drainStargazingEvents,
  separation,
  setBinoculars,
  setPosture,
  skySignals,
  skyTargets,
  stargazingEvidence,
  steadinessFor,
  stepStargazing,
  viewingQuality,
  type StargazingState,
} from '../src/stargazing.js';
import { CONSTELLATIONS, activeMeteorShower, horizonPositionOf } from '../src/astronomy.js';
import { assertNoScoring } from '../src/activity.js';
import { decideTrace } from '../src/significance.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

/** Mid-August, mid-Perseids, well after midnight in Vermont. */
const PERSEID_NIGHT = Date.UTC(2024, 7, 12, 6, 0, 0);
/** A February night with no shower on at all. */
const ORDINARY_NIGHT = Date.UTC(2024, 1, 20, 5, 0, 0);

function make(epochMs = PERSEID_NIGHT, skyOpenness = 0.9): StargazingState {
  return createStargazing({ epochMs, latitudeDeg: 44, longitudeDeg: -73, skyOpenness });
}

function run(
  state: StargazingState,
  seconds: number,
  cloudCover: number,
  seed = 11,
): StargazingState {
  const rng = new Rng(seed);
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    stepStargazing(state, SIM_DT, { cloudCover }, rng);
  }
  return state;
}

describe('the actual sky for the actual date', () => {
  it('puts the constellations where they really are', () => {
    const state = make();
    const targets = skyTargets(state, 0.1);
    expect(targets).toHaveLength(CONSTELLATIONS.length);

    for (const constellation of CONSTELLATIONS) {
      const target = targets.find((candidate) => candidate.id === constellation.id)!;
      const truth = horizonPositionOf(
        constellation.raHours,
        constellation.decDeg,
        new Date(state.epochMs),
        44,
        -73,
      );
      expect(target.altitude).toBeCloseTo(truth.altitude, 9);
      expect(target.azimuth).toBeCloseTo(truth.azimuth, 9);
    }
  });

  it('has some of them below the horizon, as a real sky does', () => {
    const targets = skyTargets(make(), 0.1);
    expect(targets.some((target) => !target.up)).toBe(true);
    expect(targets.some((target) => target.up)).toBe(true);
  });

  it('turns over the course of a night', () => {
    const state = make();
    const before = skyTargets(state, 0.1).find((t) => t.id === 'cygnus')!;
    run(state, 3600, 0.1);
    const after = skyTargets(state, 0.1).find((t) => t.id === 'cygnus')!;
    expect(after.altitude).not.toBeCloseTo(before.altitude, 3);
  });

  it('is occluded by the weather model’s own cloud, never by a separate one', () => {
    const clear = skyTargets(make(), 0);
    const overcast = skyTargets(make(), 1);
    const clearBest = Math.max(...clear.map((t) => t.clarity));
    const overcastBest = Math.max(...overcast.map((t) => t.clarity));
    expect(clearBest).toBeGreaterThan(0.4);
    expect(overcastBest).toBeLessThan(clearBest * 0.1);
  });

  it('sees less sky from a closed-in site than from an open one', () => {
    const canyon = Math.max(...skyTargets(make(PERSEID_NIGHT, 0.2), 0).map((t) => t.clarity));
    const flats = Math.max(...skyTargets(make(PERSEID_NIGHT, 1), 0).map((t) => t.clarity));
    expect(canyon).toBeLessThan(flats * 0.5);
  });

  it('knows which shower is on, because the astronomy model already did', () => {
    expect(activeMeteorShower(new Date(PERSEID_NIGHT))?.shower.id).toBe('perseids');
    expect(activeMeteorShower(new Date(ORDINARY_NIGHT))).toBeNull();
    expect(skySignals(make(PERSEID_NIGHT), 0).showerLabel).toBe('Perseids');
    expect(skySignals(make(ORDINARY_NIGHT), 0).showerLabel).toBeNull();
  });
});

describe('lying back', () => {
  it('is what makes the view steady', () => {
    expect(steadinessFor('reclined', false, 1.2)).toBeGreaterThan(
      steadinessFor('standing', false, 1.2),
    );
  });

  it('makes craning at the zenith worse the higher you look, standing', () => {
    expect(steadinessFor('standing', false, 1.4)).toBeLessThan(steadinessFor('standing', false, 0.2));
    // Lying back, height costs nothing: your head is on a log.
    expect(steadinessFor('reclined', false, 1.4)).toBe(steadinessFor('reclined', false, 0.2));
  });

  it('makes hand-held binoculars usable, which standing does not', () => {
    const standingGlass = steadinessFor('standing', true, 1.1);
    const reclinedGlass = steadinessFor('reclined', true, 1.1);
    expect(reclinedGlass).toBeGreaterThan(standingGlass * 1.8);
  });

  it('is recorded as a moment in itself', () => {
    const state = make();
    setPosture(state, 'reclined');
    const events = drainStargazingEvents(state);
    expect(events.map((event) => event.kind)).toContain('looked-up');
  });
});

describe('binoculars', () => {
  it('narrow the field and reach deeper', () => {
    const naked = make();
    const glassed = make();
    setBinoculars(glassed, true);
    expect(glassed.fieldRadius).toBeLessThan(naked.fieldRadius * 0.4);

    const target = skyTargets(naked, 0.6).find((t) => t.up)!;
    naked.steadiness = 1;
    glassed.steadiness = 1;
    expect(viewingQuality(glassed, target)).toBeGreaterThan(viewingQuality(naked, target));
  });

  it('lose whatever was being held when they are raised or lowered', () => {
    const state = make();
    state.holdingId = 'orion';
    state.holdSeconds = 3;
    setBinoculars(state, true);
    expect(state.holdingId).toBeNull();
    expect(state.holdSeconds).toBe(0);
  });
});

describe('constellations are findable, not labelled', () => {
  /** Points the view straight at whichever constellation is highest tonight. */
  function aimAtSomethingUp(state: StargazingState) {
    const target = skyTargets(state, 0)
      .filter((candidate) => candidate.up)
      .sort((a, b) => b.altitude - a.altitude)[0]!;
    aimSky(state, target.azimuth, target.altitude);
    return target;
  }

  it('names nothing until it has actually been held in view', () => {
    const state = make();
    setPosture(state, 'reclined');
    const target = aimAtSomethingUp(state);
    expect(state.recognised).not.toContain(target.id);
    expect(skySignals(state, 0).holding).toBeNull();

    run(state, 8, 0);
    expect(state.recognised).toContain(target.id);
    expect(skyTargets(state, 0).find((t) => t.id === target.id)!.known).toBe(true);
  });

  it('needs the view actually held: a glance is not enough', () => {
    const state = make();
    setPosture(state, 'reclined');
    const target = aimAtSomethingUp(state);
    run(state, 1.5, 0);
    expect(state.recognised).not.toContain(target.id);
  });

  it('will not resolve through solid overcast, however long you stare', () => {
    const state = make();
    setPosture(state, 'reclined');
    aimAtSomethingUp(state);
    run(state, 60, 1);
    expect(state.recognised).toHaveLength(0);
  });

  it('is measured by real angular separation', () => {
    expect(separation(0, 0.5, 0, 0.5)).toBeCloseTo(0, 9);
    expect(separation(0, 0, Math.PI / 2, 0)).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('meteors', () => {
  it('are far more frequent during a shower than on an ordinary night', () => {
    const perseids = make(PERSEID_NIGHT);
    setPosture(perseids, 'reclined');
    run(perseids, 900, 0, 4);
    const showerCount = perseids.events.filter((event) => event.kind === 'meteor').length;

    const ordinary = make(ORDINARY_NIGHT);
    setPosture(ordinary, 'reclined');
    run(ordinary, 900, 0, 4);
    const sporadicCount = ordinary.events.filter((event) => event.kind === 'meteor').length;

    expect(showerCount).toBeGreaterThan(sporadicCount * 2);
    expect(sporadicCount).toBeGreaterThan(0);
  });

  it('are only *seen* by somebody who was looking', () => {
    // A meteor still happens whether or not anyone saw it, which is the
    // difference between a world event and a reward.
    const looking = make(PERSEID_NIGHT);
    setPosture(looking, 'reclined');
    aimSky(looking, 0, 1.2);
    run(looking, 900, 0, 8);
    const seen = looking.events.filter((event) => event.kind === 'meteor-seen').length;
    const happened = looking.events.filter((event) => event.kind === 'meteor').length;
    expect(happened).toBeGreaterThan(0);
    expect(seen).toBeLessThanOrEqual(happened);
    expect(seen).toBeGreaterThan(0);
  });

  it('cannot pile up without limit', () => {
    const state = make(PERSEID_NIGHT);
    run(state, 1800, 0, 2);
    expect(state.meteors.length).toBeLessThanOrEqual(8);
  });

  it('are gifts and never gates: an ordinary night still works completely', () => {
    const ordinary = make(ORDINARY_NIGHT);
    setPosture(ordinary, 'reclined');
    const targets = skyTargets(ordinary, 0).filter((t) => t.up);
    expect(targets.length).toBeGreaterThan(0);
    aimSky(ordinary, targets[0]!.azimuth, targets[0]!.altitude);
    run(ordinary, 12, 0);
    // Everything you can do on a shower night you can do on a Tuesday.
    expect(ordinary.recognised.length).toBeGreaterThan(0);
  });
});

describe('determinism and the significance model', () => {
  it('replays identically from the same seed and the same aim', () => {
    const build = () => {
      const state = make(PERSEID_NIGHT);
      setPosture(state, 'reclined');
      const rng = new Rng(23);
      for (let i = 0; i < 3000; i++) {
        aimSky(state, Math.sin(i * 0.004) * 3, 0.9 + Math.cos(i * 0.003) * 0.3);
        stepStargazing(state, SIM_DT, { cloudCover: 0.15 }, rng);
      }
      return { recognised: state.recognised, events: state.events.length, meteors: state.meteors.length };
    };
    expect(build()).toEqual(build());
  });

  it('remembers a meteor during a named shower and forgets an ordinary sky', () => {
    const shower = decideTrace(
      stargazingEvidence(
        { kind: 'meteor-seen', at: 100, subjectId: 'perseids', label: 'Perseids', rarity: 0.8 },
        { dwellSeconds: 240 },
      ),
    );
    expect(shower.disposition).not.toBe('fade');

    const sporadic = decideTrace(
      stargazingEvidence({ kind: 'meteor', at: 100, subjectId: null, label: 'a meteor', rarity: 0.2 }),
    );
    expect(sporadic.disposition).toBe('fade');
  });

  it('reports no total and no denominator', () => {
    const state = make();
    setPosture(state, 'reclined');
    const signals = skySignals(state, 0.2);
    assertNoScoring('skySignals', signals);
    expect(Object.keys(signals)).not.toContain('found');
    expect(Object.keys(signals)).not.toContain('total');
    expect(JSON.stringify(signals)).not.toMatch(/ of \d/);
  });

  it('describes a sky moment warmly and without a verdict', () => {
    const line = describeSkyMoment({
      kind: 'recognised',
      at: 1,
      subjectId: 'orion',
      label: 'Orion',
      rarity: 0.3,
    });
    expect(line).toContain('Orion');
    expect(line.toLowerCase()).not.toMatch(/complete|unlock|reward|points/);
  });
});
