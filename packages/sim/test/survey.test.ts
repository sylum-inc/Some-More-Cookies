import { describe, expect, it } from 'vitest';

import { createPlayer, createWorld } from '../src/locomotion.js';
import { vec3 } from '../src/types.js';
import { createRitual, stepRitual } from '../src/ritual.js';
import { relativeBearing, surveySurroundings } from '../src/survey.js';

/**
 * The survey exists because the product narrates *change* and nobody had a way
 * to ask what is *here* (audit A5). These read it rather than hear it, which is
 * the only way to check it in this environment — but the thing being checked is
 * the sentences themselves, and those are the product.
 */

function world() {
  return createWorld({
    radius: 14,
    seed: 7,
    interactables: [
      { id: 'fire', x: 0, z: 0, reach: 1.45 },
      { id: 'woodpile', x: 1.7, z: -0.9, reach: 1.15 },
      { id: 'log-seat', x: -1.5, z: 0.9, reach: 1.0 },
      { id: 'machine', x: -3.2, z: -2.4, reach: 1.5 },
      // Far enough out that the survey should not mention it at all.
      { id: 'water-edge', x: 11, z: 4, reach: 1.9 },
    ],
  });
}

function ritualAt() {
  return createRitual({ campsiteSeed: 'survey', environmentId: 'pine_hollow' });
}

describe('surveying the campsite', () => {
  it('leads with what is in reach, because that is what you can act on', () => {
    const player = createPlayer(vec3(0.9, 0, 0));
    const lines = surveySurroundings(ritualAt(), player, world());
    expect(lines[0]).toMatch(/the fire/i);
  });

  it('says where things are relative to the body, not to the compass', () => {
    const player = createPlayer(vec3(0, 0, 0));
    player.facing = 0; // looking toward +x
    expect(relativeBearing(player, 5, 0)).toBe('straight ahead');
    expect(relativeBearing(player, -5, 0)).toBe('behind you');
    expect(relativeBearing(player, 0, 5)).toBe('to your right');
    expect(relativeBearing(player, 0, -5)).toBe('to your left');
  });

  it('does not read out the whole campsite', () => {
    // Standing away from the water: at eleven metres it is part of the
    // campsite and not part of what is around you.
    const player = createPlayer(vec3(-4, 0, -4));
    const lines = surveySurroundings(ritualAt(), player, world());
    // Nothing beyond the walking radius, and never a wall of text.
    expect(lines.join(' ')).not.toMatch(/water/i);
    expect(lines.length).toBeLessThanOrEqual(9);
  });

  it('describes the fire it actually finds, not the fire in general', () => {
    // A campsite arrives with a fire already going, so the interesting
    // comparison is not lit against unlit — it is flames against the coals
    // they become, which is the distinction the whole roast depends on.
    const ritual = ritualAt();
    const player = createPlayer(vec3(4, 0, 0));

    const flames = surveySurroundings(ritual, player, world()).join(' ');
    expect(flames).toMatch(/burning/i);

    for (let i = 0; i < 60 * 900 && ritual.fire.flame >= 0.2; i += 1) {
      stepRitual(ritual, 1 / 60);
    }
    const coals = surveySurroundings(ritual, player, world()).join(' ');

    expect(coals, 'the survey said the same thing about two different fires').not.toBe(flames);
    expect(coals).toMatch(/coals|out\. The pit is cold/i);
  });

  it('gives distances in paces, because a campsite is not a map', () => {
    const player = createPlayer(vec3(0, 0, 0));
    const lines = surveySurroundings(ritualAt(), player, world()).join(' ');
    expect(lines).toMatch(/paces? away|right here/);
    expect(lines, 'a survey should not read out metres').not.toMatch(/\d+(\.\d+)? ?m\b/);
  });

  it('speaks the named places rather than reading out their ids', () => {
    // The first version said "You are in water-edge." A survey is prose or it
    // is nothing, and an id with no phrasing is left out rather than mangled.
    const player = createPlayer(vec3(0, 0, 0));
    const spoken = surveySurroundings(ritualAt(), player, world(), {
      places: ['fireside', 'water-edge', 'some-place-nobody-named'],
    }).join(' ');
    expect(spoken).toContain("by the fire and at the water's edge");
    expect(spoken).not.toMatch(/water-edge|some-place-nobody-named/);
  });

  it('always says something, even standing in an empty part of the campsite', () => {
    const player = createPlayer(vec3(12, 0, 12));
    const lines = surveySurroundings(ritualAt(), player, createWorld({ radius: 14, seed: 7 }));
    // The fire and the night, at minimum. Silence would be the one useless
    // answer to "what is around me".
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
  });
});

/**
 * The one thing this campsite is for.
 *
 * `ActivityEntry.prominence` marks exactly one activity per environment as
 * `signature` — the tide pools, the slot that answers you back, the box you
 * can sit in — and until the survey read it, the field decided nothing at all.
 * A player who can see the screen finds those by walking into them. The survey
 * is for the player who cannot, and a list of furniture is not an answer to
 * "what is here".
 */
describe('what this campsite is for', () => {
  const withActivities = () =>
    createRitual({
      campsiteSeed: 'survey',
      environmentId: 'loonwater_narrows',
      world: {
        activities: [
          { id: 'fire-tending', label: 'Tend the fire', prominence: 'notable', note: 'Birch bark.' },
          {
            id: 'loon-answering',
            label: 'Answer the loon',
            prominence: 'signature',
            note: 'Cup your hands and try the wail.',
          },
          { id: 'fishing', label: 'Fish the seam', prominence: 'available', note: '' },
        ],
      },
    });

  it('names the signature activity and nothing else from the list', () => {
    const lines = surveySurroundings(withActivities(), createPlayer(vec3(0.9, 0, 0)), world());
    const text = lines.join(' ');
    expect(text).toContain('Answer the loon. That is the thing this campsite is for.');
    expect(text).toContain('Cup your hands and try the wail.');
    expect(text).not.toContain('Tend the fire');
    expect(text).not.toContain('Fish the seam');
  });

  it('says nothing at all where the caller passes no activities', () => {
    const lines = surveySurroundings(ritualAt(), createPlayer(vec3(0.9, 0, 0)), world());
    expect(lines.join(' ')).not.toContain('is for');
  });

  it('names the activity even when its note is empty', () => {
    const ritual = createRitual({
      campsiteSeed: 'survey',
      environmentId: 'mirror_flats',
      world: {
        activities: [{ id: 'stargazing', label: 'Stargaze', prominence: 'signature', note: '' }],
      },
    });
    const text = surveySurroundings(ritual, createPlayer(vec3(0.9, 0, 0)), world()).join(' ');
    expect(text).toContain('Stargaze. That is the thing this campsite is for.');
  });

  it('comes after what is in reach, because that is what you can act on now', () => {
    const lines = surveySurroundings(withActivities(), createPlayer(vec3(0.9, 0, 0)), world());
    const reach = lines.findIndex((line) => /the fire/i.test(line));
    const forWhat = lines.findIndex((line) => /is for/.test(line));
    expect(reach).toBeGreaterThanOrEqual(0);
    expect(forWhat).toBeGreaterThan(reach);
  });
});
