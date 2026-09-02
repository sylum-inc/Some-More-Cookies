/**
 * A campsite remarking on itself.
 *
 * The catalogue writes a paragraph of sensory prose per environment and, until
 * this existed, none of it reached anybody. What is being tested is not that
 * the words come out — it is that they come out *when they are true*, once
 * each, and never all at once.
 */
import { describe, expect, it } from 'vitest';
import {
  createPlace,
  stepPlace,
  surveyPlace,
  nightColdness,
  type PlaceConditions,
  type PlaceNotes,
} from '../src/place.js';
import { Rng } from '../src/rng.js';
import { arrive, createRitual, setPresence, stepRitual } from '../src/ritual.js';
import { SIM_DT } from '../src/types.js';

const NOTES: PlaceNotes = {
  ground: 'Deep rust-brown needle litter over compacted dirt.',
  elevation: 'A shallow bowl, rising gently on three sides.',
  temperature: 'Cold enough by four in the morning to want the fire between you and the air.',
  wind: 'It comes down the bowl in long breaths rather than gusts.',
  exposure: 'The rim takes most of it. The pit barely notices.',
  insects: 'A modest crick-and-pause chorus that stops dead if you stand up too fast.',
  reverb: 'Short, dry, absorbed.',
  nightRangeC: { min: 2, max: 11 },
  distant: [
    { id: 'far_car', label: 'A car on the loop road', weight: 3, minGapSeconds: 240, note: 'Tyres on gravel, then nothing.' },
    { id: 'snag_creak', label: 'The snag creaks', weight: 5, minGapSeconds: 90, note: 'A long wooden complaint overhead.' },
  ],
};

function conditions(overrides: Partial<PlaceConditions> = {}): PlaceConditions {
  return {
    elapsed: 30,
    deepNight: false,
    temperatureC: 9,
    windSpeed: 0.6,
    precipitation: 0,
    distanceFromFire: 1.2,
    fireHarried: false,
    ...overrides,
  };
}

/** Steps for a while, collecting everything the place said. */
function listen(
  notes: PlaceNotes,
  seconds: number,
  now: PlaceConditions,
  seed = 3,
): { remarks: string[]; heard: string[] } {
  const place = createPlace();
  const rng = new Rng(seed);
  const remarks: string[] = [];
  const heard: string[] = [];
  // One conditions object, advanced in place. This loop runs 216,000 times
  // per simulated hour and the eeriness suite listens to a hundred and
  // twenty of them; a fresh object per step was most of what that cost.
  const conditionsNow: PlaceConditions = { ...now };
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    conditionsNow.elapsed = now.elapsed + i * SIM_DT;
    stepPlace(place, notes, conditionsNow, SIM_DT, rng);
    if (place.remark) remarks.push(place.remark.id);
    if (place.heard) heard.push(place.heard.id);
  }
  return { remarks, heard };
}

describe('a place saying what it is like', () => {
  it('says the ground under your feet, once, shortly after you arrive', () => {
    const { remarks } = listen(NOTES, 60, conditions({ elapsed: 0 }));
    expect(remarks.filter((id) => id === 'ground')).toHaveLength(1);
  });

  it('says nothing at all about wind until the wind does something', () => {
    const calm = listen(NOTES, 200, conditions({ windSpeed: 0.5 }));
    expect(calm.remarks).not.toContain('wind');
    const blowing = listen(NOTES, 200, conditions({ windSpeed: 4.2 }));
    expect(blowing.remarks).toContain('wind');
  });

  it('says the cold when the night has actually turned cold', () => {
    const mild = listen(NOTES, 200, conditions({ temperatureC: 9, deepNight: false }));
    expect(mild.remarks).not.toContain('temperature');
    const late = listen(NOTES, 200, conditions({ temperatureC: 3, deepNight: true }));
    expect(late.remarks).toContain('temperature');
  });

  it('says what this place does to a fire only while it is doing it', () => {
    const sheltered = listen(NOTES, 200, conditions({ fireHarried: false }));
    expect(sheltered.remarks).not.toContain('exposure');
    const harried = listen(NOTES, 200, conditions({ fireHarried: true }));
    expect(harried.remarks).toContain('exposure');
  });

  it('mentions the insects only on the kind of night that has any', () => {
    const cold = listen(NOTES, 400, conditions({ temperatureC: 3, elapsed: 200 }));
    expect(cold.remarks).not.toContain('insects');
    const warm = listen(NOTES, 400, conditions({ temperatureC: 15, windSpeed: 0.4, elapsed: 200 }));
    expect(warm.remarks).toContain('insects');
  });

  it('never says the same thing twice, and never two things at once', () => {
    const place = createPlace();
    const rng = new Rng(11);
    const said: string[] = [];
    for (let i = 0; i < 60 * 900; i++) {
      stepPlace(place, NOTES, conditions({ elapsed: i * SIM_DT, windSpeed: 4, temperatureC: 2, deepNight: true, distanceFromFire: 8, fireHarried: true }), SIM_DT, rng);
      if (place.remark) said.push(place.remark.id);
      // A remark and a distant sound in the same breath is a paragraph.
      if (place.remark) expect(place.heard).toBeNull();
    }
    expect(new Set(said).size).toBe(said.length);
  });
});

describe('hearing something a long way off', () => {
  it('happens, but not for a while and not often', () => {
    const { heard } = listen(NOTES, 900, conditions());
    expect(heard.length).toBeGreaterThan(0);
    // Fifteen minutes of campsite. A handful, not a soundtrack.
    expect(heard.length).toBeLessThan(9);
  });

  it('respects how rare each one is meant to be', () => {
    const place = createPlace();
    const rng = new Rng(5);
    const at = new Map<string, number[]>();
    for (let i = 0; i < 60 * 3600; i++) {
      stepPlace(place, NOTES, conditions(), SIM_DT, rng);
      if (place.heard) {
        const times = at.get(place.heard.id) ?? [];
        times.push(i * SIM_DT);
        at.set(place.heard.id, times);
      }
    }
    for (const [id, times] of at) {
      const spec = NOTES.distant!.find((d) => d.id === id)!;
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!, `${id} came round too soon`).toBeGreaterThanOrEqual(spec.minGapSeconds);
      }
    }
  });

  it('is the same night at the same campsite twice over', () => {
    const a = listen(NOTES, 1200, conditions(), 8);
    const b = listen(NOTES, 1200, conditions(), 8);
    expect(a.heard).toEqual(b.heard);
  });

  it('says nothing at a campsite with nothing to hear', () => {
    const { heard } = listen({ ground: 'Bare rock.' }, 1200, conditions());
    expect(heard).toHaveLength(0);
  });
});

describe('being asked what it is like', () => {
  it('answers with what is true now, not with the whole paragraph', () => {
    const calm = surveyPlace(NOTES, conditions({ windSpeed: 0.4, temperatureC: 14 }));
    expect(calm.join(' ')).not.toContain('long breaths');
    const blowing = surveyPlace(NOTES, conditions({ windSpeed: 3.5, temperatureC: 2, deepNight: true }));
    expect(blowing.join(' ')).toContain('long breaths');
    expect(blowing.join(' ')).toContain('four in the morning');
    // The ground and the shape of the land are always true.
    expect(calm[0]).toBe(NOTES.ground);
  });

  it('measures the cold against what this campsite calls cold', () => {
    expect(nightColdness(NOTES, 11)).toBeCloseTo(0, 2);
    expect(nightColdness(NOTES, 2)).toBeCloseTo(1, 2);
    // A campsite with no stated range still has an opinion.
    expect(nightColdness({}, -5)).toBeGreaterThan(0.7);
  });
});

/**
 * How liminal the place is, and the one thing it is allowed to change.
 *
 * `character.eeriness` grades all twelve campsites 1..5 and had never been
 * read. The schema's own calibration rule is the constraint that shapes what
 * it can do: the axis "never reaches *threatening*", and "nothing stalks,
 * chases or endangers the player at any value". So a strange place is one that
 * keeps hearing things a long way off, and is less sure what they are — never
 * one where something is out there.
 */
describe('eeriness', () => {
  const homely: PlaceNotes = { ...NOTES, eeriness: 1 };
  const strange: PlaceNotes = { ...NOTES, eeriness: 5 };

  /** Everything heard over an hour, averaged over a spread of seeds. */
  function heardPerHour(notes: PlaceNotes): number {
    let total = 0;
    for (let seed = 1; seed <= 12; seed++) {
      total += listen(notes, 3600, conditions(), seed).heard.length;
    }
    return total / 12;
  }

  it('is the middle of the axis when a campsite says nothing', () => {
    const said = heardPerHour(NOTES);
    const middle = heardPerHour({ ...NOTES, eeriness: 3 });
    expect(said).toBe(middle);
  });

  it('makes a strange place speak up from a distance more often than a homely one', () => {
    expect(heardPerHour(strange)).toBeGreaterThan(heardPerHour(homely) * 1.3);
  });

  /*
   * The bound that keeps this a mood rather than a sound effect.
   *
   * `stepPlace`'s own note: "a campsite that produces a distant sound every
   * minute is a campsite with a sound effect, not a campsite in a landscape".
   * So the ceiling is one every two minutes even at the strangest place in the
   * catalogue — it currently sits around one every two and a half — and the
   * floor is that the homely end has not gone silent.
   */
  it('keeps a distant sound rare even at the strange end', () => {
    expect(heardPerHour(strange)).toBeLessThan(30);
    expect(heardPerHour(homely)).toBeGreaterThan(2);
  });

  it('adds nothing to a campsite that its author did not write', () => {
    const { heard } = listen(strange, 7200, conditions(), 5);
    for (const id of heard) expect(['far_car', 'snag_creak']).toContain(id);
  });

  /*
   * A homely place is *predictable*: the same creek, the same road, the same
   * owl. A strange one is not — the thing its manifest gave a weight of one to
   * is genuinely on the cards. Same list either way.
   */
  it('is less sure what you are hearing at the strange end', () => {
    /*
     * Equal minimum gaps, deliberately.
     *
     * The catalogue's own sounds carry different `minGapSeconds`, and with
     * those in play the *frequency* of distant events decides the mix rather
     * than the weights: at a campsite that speaks up often, the sound with the
     * long gap is usually still inside it and cannot be picked. That is
     * correct behaviour and it is not what this test is about, so the fixture
     * takes it off the table and leaves only the weighting.
     */
    const even = (eeriness: number): PlaceNotes => ({
      ...NOTES,
      eeriness,
      distant: [
        { id: 'far_car', label: 'A car', weight: 3, minGapSeconds: 30, note: '' },
        { id: 'snag_creak', label: 'The snag', weight: 5, minGapSeconds: 30, note: '' },
      ],
    });
    const share = (notes: PlaceNotes): number => {
      let common = 0;
      let all = 0;
      for (let seed = 1; seed <= 60; seed++) {
        for (const id of listen(notes, 3600, conditions(), seed).heard) {
          all++;
          if (id === 'snag_creak') common++;
        }
      }
      return common / all;
    };
    // `snag_creak` is weight 5 against `far_car`'s 3 — five eighths at even
    // odds, more than that when the weights are sharpened, less when flattened.
    expect(share(even(1))).toBeGreaterThan(share(even(5)) + 0.05);
    /*
     * A hundred and twenty simulated hours at sixty hertz. It is a statistic,
     * and sixty seeds a side is what makes the five-point margin above a
     * property rather than luck. Measured at 2.7 s alone on one machine and
     * over the default five on a CI runner with another job on it, so its
     * budget is its own.
     */
  }, 20_000);

  it('still never says two things in one breath', () => {
    const place = createPlace();
    const rng = new Rng(4);
    // Counted rather than asserted per step: two hours at sixty hertz is
    // 432,000 steps, and an assertion inside that loop makes the test's own
    // cost the thing being measured.
    let doubled = 0;
    let spoke = 0;
    for (let i = 0; i < Math.round(7200 / SIM_DT); i++) {
      stepPlace(place, strange, conditions(), SIM_DT, rng);
      if (place.remark !== null && place.heard !== null) doubled++;
      if (place.remark !== null || place.heard !== null) spoke++;
    }
    expect(doubled).toBe(0);
    // And it did speak, so the zero above is a property rather than silence.
    expect(spoke).toBeGreaterThan(4);
  });
});

/**
 * A campsite does not introduce itself over its own title card.
 *
 * The elevation remark's condition is "more than five and a half metres from
 * the fire", which is true of every frame of the walk in — so the campsite's
 * own description arrived during `arriving`, in a box, underneath the arrival
 * beat and on top of the title. Two pieces of prose about the same place at
 * once, before the player had done anything, which is the "loading screen with
 * trees" this module's own docstring exists to rule out.
 *
 * Found by opening the screenshot. Every assertion in the suite passed: they
 * knew the remark had been made and not where on the screen it was.
 */
describe('arriving', () => {
  const worldOf = () => ({
    place: {
      ground: NOTES.ground,
      elevation: NOTES.elevation,
      distant: NOTES.distant,
    } as PlaceNotes,
  });

  /** Walks in from out on the trail, which is where the elevation note fires. */
  function walkIn(seconds: number, stage: 'arriving' | 'settled'): string[] {
    const ritual = createRitual({ campsiteSeed: 'arrival', environmentId: 'pine_hollow', world: worldOf() });
    if (stage !== 'arriving') arrive(ritual);
    const said: string[] = [];
    for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
      setPresence(ritual, { position: { x: 9, y: 0, z: 6 }, speed: 1.2 });
      stepRitual(ritual, SIM_DT);
      if (ritual.place.remark) said.push(ritual.place.remark.id);
      if (ritual.place.heard) said.push(`heard:${ritual.place.heard.id}`);
    }
    return said;
  }

  it('says nothing at all while the player is still walking in', () => {
    expect(walkIn(240, 'arriving')).toEqual([]);
  });

  it('and says it the moment they are actually here', () => {
    const said = walkIn(240, 'settled');
    expect(said).toContain('ground');
    expect(said).toContain('elevation');
  });

  /*
   * The same mistake at the other end of the night.
   *
   * Walking to the SM-01 is walking away from the fire, so the elevation
   * remark comes due — and lands while the player is looking into the open
   * chamber at the thing the whole hour has been building to.
   */
  it('says nothing over the reveal either', () => {
    const ritual = createRitual({ campsiteSeed: 'reveal', environmentId: 'pine_hollow', world: worldOf() });
    arrive(ritual);
    // Set directly rather than driven through the machine: this is a test of
    // the gate, and the whole SM-01 sequence in between would be testing the
    // machine instead.
    ritual.stage = 'reveal';
    const said: string[] = [];
    for (let i = 0; i < Math.round(240 / SIM_DT); i++) {
      setPresence(ritual, { position: { x: 9, y: 0, z: 6 }, speed: 0 });
      stepRitual(ritual, SIM_DT);
      if (ritual.place.remark) said.push(ritual.place.remark.id);
      if (ritual.place.heard) said.push(`heard:${ritual.place.heard.id}`);
    }
    expect(said).toEqual([]);
  });

  it('but goes on talking while you are tending the fire', () => {
    const ritual = createRitual({ campsiteSeed: 'tending', environmentId: 'pine_hollow', world: worldOf() });
    arrive(ritual);
    ritual.stage = 'roasting';
    const said: string[] = [];
    for (let i = 0; i < Math.round(240 / SIM_DT); i++) {
      setPresence(ritual, { position: { x: 9, y: 0, z: 6 }, speed: 0 });
      stepRitual(ritual, SIM_DT);
      if (ritual.place.remark) said.push(ritual.place.remark.id);
    }
    expect(said.length).toBeGreaterThan(0);
  });
});
