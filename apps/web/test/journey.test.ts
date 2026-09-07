import { beforeEach, describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '@somemore/content';
import { campsiteSeedFor, currentCampsite, nextCampsite, rootSeed, settleAt } from '../src/state/journey.js';

/**
 * A localStorage that behaves like the real one, including being absent.
 *
 * The journey module is the one place in the client that must survive storage
 * being unavailable — a private window is a perfectly ordinary way to arrive
 * at a campfire — so the throwing case is tested rather than assumed.
 */
function useStorage(mode: 'works' | 'throws' = 'works'): Map<string, string> {
  const map = new Map<string, string>();
  const storage =
    mode === 'works'
      ? {
          getItem: (key: string) => map.get(key) ?? null,
          setItem: (key: string, value: string) => void map.set(key, value),
        }
      : {
          getItem: () => {
            throw new Error('denied');
          },
          setItem: () => {
            throw new Error('denied');
          },
        };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return map;
}

describe('the root seed', () => {
  beforeEach(() => useStorage());

  it('is minted once and then kept, because it is who you are', () => {
    let minted = 0;
    const first = rootSeed(() => `camp-${minted++}`);
    const second = rootSeed(() => `camp-${minted++}`);
    expect(second).toBe(first);
    expect(minted).toBe(1);
  });

  it('still hands back a seed when there is nowhere to keep it', () => {
    useStorage('throws');
    expect(rootSeed(() => 'camp-nowhere')).toBe('camp-nowhere');
  });
});

describe('where you are camped', () => {
  beforeEach(() => useStorage());

  it('is the same place every boot, because returning is the promise', () => {
    const root = 'camp-steady';
    const first = currentCampsite('', root);
    settleAt(first);
    for (let boot = 0; boot < 5; boot++) {
      expect(currentCampsite('', root)).toEqual(first);
    }
  });

  it('gives a campsite its own seed, so two places never share a memory', () => {
    const root = 'camp-distinct';
    const seeds = ENVIRONMENTS.map((environment) => campsiteSeedFor(root, environment.id));
    expect(new Set(seeds).size).toBe(ENVIRONMENTS.length);
  });

  it('lets a link pin an exact campsite without moving your own', () => {
    const root = 'camp-visitor';
    const home = currentCampsite('', root);
    settleAt(home);
    const guest = currentCampsite('?env=mirror_flats&camp=someone-elses', root);
    expect(guest.environmentId).toBe('mirror_flats');
    expect(guest.campsiteSeed).toBe('someone-elses');
    // And the visit did not rehome the device.
    expect(currentCampsite('', root)).toEqual(home);
  });
});

describe('walking out', () => {
  beforeEach(() => useStorage());

  it('never lands you back where you started', () => {
    const root = 'camp-onward';
    for (const environment of ENVIRONMENTS) {
      const next = nextCampsite(root, [environment.id], environment.id);
      expect(next.environmentId, `walked out of ${environment.id} into itself`).not.toBe(environment.id);
    }
  });

  it('reaches every environment in the catalogue, which is the whole point', () => {
    /*
     * §5.4: every player must eventually be able to discover every core
     * environment, and region never locks content. This walks the trail the
     * way a player would — out of each campsite into the next, carrying the
     * record of where they have been — and asserts it visits all twelve.
     */
    const root = 'camp-wanderer';
    let where = currentCampsite('', root);
    const found = new Set<string>([where.environmentId]);
    for (let night = 0; night < ENVIRONMENTS.length * 3 && found.size < ENVIRONMENTS.length; night++) {
      where = nextCampsite(root, [...found], where.environmentId);
      found.add(where.environmentId);
    }
    expect([...found].sort()).toEqual(ENVIRONMENTS.map((environment) => environment.id).sort());
  });

  it('reaches all twelve from any starting seed, not just a lucky one', () => {
    for (let device = 0; device < 24; device++) {
      const root = `camp-device-${device}`;
      let where = currentCampsite('', root);
      const found = new Set<string>([where.environmentId]);
      for (let night = 0; night < 60 && found.size < ENVIRONMENTS.length; night++) {
        where = nextCampsite(root, [...found], where.environmentId);
        found.add(where.environmentId);
      }
      expect(found.size, `device ${device} could not reach every campsite`).toBe(ENVIRONMENTS.length);
    }
  });

  it('keeps moving once everywhere has been seen', () => {
    // The pool falls back to the whole catalogue when nothing is undiscovered.
    // With a fixed seed that would be the same campsite forever, which is the
    // pin again by another route.
    const root = 'camp-veteran';
    const all = ENVIRONMENTS.map((environment) => environment.id);
    const visited = new Set<string>();
    let from = all[0] as string;
    for (let night = 0; night < 12; night++) {
      const next = nextCampsite(root, all, from);
      expect(next.environmentId).not.toBe(from);
      visited.add(next.environmentId);
      from = next.environmentId;
    }
    expect(visited.size).toBeGreaterThan(1);
  });
});
