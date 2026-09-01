/**
 * The named things at a campsite, and where they turn out to be.
 *
 * The catalogue says what they are; this decides where. What is being tested
 * is that a written landmark ends up somewhere a person can walk to, that two
 * of them never end up in the same place, and that nothing is ever put inside
 * the fire or inside the freezer.
 */
import { describe, expect, it } from 'vitest';
import { placeLandmarks, landmarkAt, type LandmarkSpec } from '../src/landmarks.js';
import { createRitual, visitLandmark } from '../src/ritual.js';
import { Rng } from '../src/rng.js';

const SPECS: LandmarkSpec[] = [
  { id: 'site_post_11', label: 'Site post 11', kind: 'signage', note: 'A weathered post with a reflector.' },
  { id: 'bear_box', label: 'Steel bear box', kind: 'built', note: 'Olive drab, dented on the top left.' },
  { id: 'leaning_snag', label: 'The leaning snag', kind: 'natural', note: 'A dead pine caught in a living one.' },
  { id: 'creek_stones', label: 'Creek stepping stones', kind: 'water', note: 'The middle one wobbles.' },
  { id: 'the_flight_path', label: 'The flight path', kind: 'sky', note: 'Something crosses, very high up.' },
];

const OCCUPIED = [
  { x: -2.75, z: 1.75, radius: 0.8 },
  { x: 1.42, z: 1.32, radius: 0.5 },
  { x: 1.7, z: -0.9, radius: 0.5 },
];

function place(radius = 13) {
  return placeLandmarks({
    landmarks: SPECS,
    radius,
    trailBearing: 0.69,
    shore: { bearing: 2.4, distanceM: 8.2 },
    occupied: OCCUPIED,
    rng: new Rng(4),
  });
}

describe('placing the landmarks', () => {
  it('puts every one that is a thing you can walk to somewhere you can walk', () => {
    const placed = place();
    // Everything but the sky one, which is a thing you look at.
    expect(placed).toHaveLength(4);
    expect(placed.map((l) => l.id)).not.toContain('the_flight_path');
    for (const landmark of placed) {
      const distance = Math.hypot(landmark.x, landmark.z);
      expect(distance).toBeGreaterThan(2.2);
      expect(distance).toBeLessThan(13);
    }
  });

  it('never stands one in the fire, in the freezer, or in another one', () => {
    const placed = place();
    for (const landmark of placed) {
      expect(Math.hypot(landmark.x, landmark.z), `${landmark.id} is in the fire`).toBeGreaterThan(2.2);
      for (const thing of OCCUPIED) {
        expect(
          Math.hypot(thing.x - landmark.x, thing.z - landmark.z),
          `${landmark.id} is inside something`,
        ).toBeGreaterThan(thing.radius);
      }
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} and ${b.id} are on top of each other`).toBeGreaterThan(1.2);
      }
    }
  });

  it('puts the sign on the way in and the snag out at the treeline', () => {
    const placed = place();
    const sign = landmarkAt(placed, 'site_post_11')!;
    const snag = landmarkAt(placed, 'leaning_snag')!;
    expect(Math.hypot(sign.x, sign.z)).toBeLessThan(Math.hypot(snag.x, snag.z));
    // The sign faces whoever is arriving rather than facing the fire.
    expect(Math.abs(sign.rotation - (0.69 + Math.PI))).toBeLessThan(0.01);
  });

  it('puts the stepping stones at the water', () => {
    const stones = landmarkAt(place(), 'creek_stones')!;
    const bearing = Math.atan2(stones.z, stones.x);
    expect(Math.abs(bearing - 2.4)).toBeLessThan(1);
    expect(Math.hypot(stones.x, stones.z)).toBeGreaterThan(5);
  });

  it('is the same campsite every time you come back to it', () => {
    const a = place();
    const b = place();
    expect(a.map((l) => [l.id, l.x.toFixed(6), l.z.toFixed(6)])).toEqual(
      b.map((l) => [l.id, l.x.toFixed(6), l.z.toFixed(6)]),
    );
  });

  it('copes with a campsite too small to hold everything comfortably', () => {
    const cramped = placeLandmarks({
      landmarks: SPECS,
      radius: 8,
      trailBearing: 0.69,
      occupied: OCCUPIED,
      rng: new Rng(9),
    });
    // Whatever it can fit, it fits legally. It never overlaps to fit more.
    for (const landmark of cramped) expect(Math.hypot(landmark.x, landmark.z)).toBeGreaterThan(2.2);
  });
});

describe('walking up to one', () => {
  it('tells you what it is, once', () => {
    const ritual = createRitual({
      campsiteSeed: 'landmarks',
      environmentId: 'pinewood',
      world: { landmarks: SPECS, trailBearing: 0.69 },
    });
    expect(ritual.landmarks.length).toBeGreaterThan(2);
    const first = ritual.landmarks[0]!;
    const met = visitLandmark(ritual, first.id)!;
    expect(met.label).toBe(first.label);
    expect(met.telling).toBe(first.note);
    // Second time: it has a name and you already know what it is.
    expect(visitLandmark(ritual, first.id)!.telling).toBeNull();
    expect(visitLandmark(ritual, 'nothing_here')).toBeNull();
  });
});
