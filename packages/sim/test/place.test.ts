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
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    stepPlace(place, notes, { ...now, elapsed: now.elapsed + i * SIM_DT }, SIM_DT, rng);
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
