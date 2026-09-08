import { describe, expect, it } from 'vitest';
import { REACH_SPRITES, fireSprite, lifeSprite, timeSprite, weatherSprite } from '../src/ui/iconography.js';
import { SPRITES } from '../src/ui/sprites/atlas.js';
import { ACTIVITY_WINDOWS, WEATHER_KINDS } from '@somemore/sim';

/**
 * Holes in the vocabulary.
 *
 * The HUD stopped being words and became pictures, which trades one failure
 * mode for another: a missing sentence is obvious in review, and a missing
 * icon is a player walking up to something and being shown nothing at all.
 * Every id the world can actually produce therefore has to resolve, and that
 * is a question about data rather than about pixels — so it is answered here
 * rather than by opening twelve screenshots.
 */

const inAtlas = (name: string) => name in SPRITES;

describe('every picture the HUD can ask for exists', () => {
  it('has a sprite for everything you can walk up to', () => {
    const missing = Object.entries(REACH_SPRITES).filter(([, sprite]) => !inAtlas(sprite));
    expect(missing.map(([id, sprite]) => `${id} -> ${sprite}`)).toEqual([]);
  });

  it('has a sprite for every part of the day', () => {
    // Driven off the simulation's own list, so a window added later fails here
    // rather than rendering a blank corner.
    const missing = ACTIVITY_WINDOWS.filter((window) => !inAtlas(timeSprite(window)));
    expect(missing).toEqual([]);
  });

  it('has a sprite for every kind of weather', () => {
    const missing = WEATHER_KINDS.filter((kind) => !inAtlas(weatherSprite(kind)));
    expect(missing).toEqual([]);
  });

  it('has a sprite for every state the fire can be in', () => {
    const fires = [
      { flame: 0, emberMass: 0 },
      { flame: 0, emberMass: 0.2 },
      { flame: 0.2, emberMass: 0.3 },
      { flame: 0.9, emberMass: 0.6 },
    ];
    for (const fire of fires) expect(inAtlas(fireSprite(fire)), fireSprite(fire)).toBe(true);
    // And the four are genuinely four, not one picture with four names.
    expect(new Set(fires.map(fireSprite)).size).toBe(4);
  });

  it('falls back rather than showing nothing for an animal it has not met', () => {
    /*
     * The roster is content and grows; the icon set is code and does not. An
     * unknown species at the moment it appears is still an animal, and an
     * approximate picture beats an empty box.
     */
    expect(inAtlas(lifeSprite('some_bird_nobody_drew'))).toBe(true);
    expect(lifeSprite('red_fox')).toBe('life-fox');
    expect(lifeSprite('saw_whet_owl')).toBe('life-owl');
    expect(lifeSprite('deer_mouse'), 'a deer mouse is a mouse, not a deer').toBe('life-mouse');
    expect(lifeSprite('douglas_squirrel')).toBe('life-squirrel');
  });
});

describe('the fire is a picture, not a gauge', () => {
  it('never reports a number, only which of four it is', () => {
    /*
     * §5.3. A bar that empties is a score however it is drawn, and the fire is
     * the one piece of state a HUD would most naturally turn into one. So the
     * only thing this function can return is the name of a picture — there is
     * nowhere in the type for a magnitude to hide.
     */
    const result = fireSprite({ flame: 0.5, emberMass: 0.5 });
    expect(typeof result).toBe('string');
    expect(result).not.toMatch(/\d/);
  });

  it('reads the fire the way the pit looks, in order', () => {
    expect(fireSprite({ flame: 0.9, emberMass: 0.6 })).toBe('state-fire-good');
    expect(fireSprite({ flame: 0.2, emberMass: 0.4 })).toBe('state-fire-low');
    expect(fireSprite({ flame: 0.01, emberMass: 0.3 })).toBe('state-fire-embers');
    expect(fireSprite({ flame: 0, emberMass: 0 })).toBe('state-fire-out');
  });
});
