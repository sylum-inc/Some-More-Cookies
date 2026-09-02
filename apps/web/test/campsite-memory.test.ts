/**
 * A campsite that remembers.
 *
 * The significance model's whole outward behaviour is this: come back to Pine
 * Hollow a fourth time and the fox that has seen you three times behaves like
 * it has. That only works if what a night produced is folded back into the
 * Passport and handed to the next session — so this tests the round trip, not
 * the model.
 *
 * What it must *never* do is surface a score. §6.4 is explicit: the
 * significance value is internal, and a `Trace` carries only a disposition and
 * a lifetime.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { setPresence, stepRitual, SIM_DT, type WildlifeSpecies } from '@somemore/sim';
import { Store, type PassportState } from '../src/state/store.js';
import { visitLine } from '../src/ui/Passport.js';

/** The smallest localStorage that behaves like one. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

const FOX: WildlifeSpecies = {
  id: 'fox',
  label: 'a red fox',
  shyness: 0.4,
  curiosity: 0.85,
  window: ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'],
  attractedBy: ['stillness', 'quiet', 'food-smell', 'crumbs'],
  repelledBy: ['sudden-movement', 'voices'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['four narrow prints in the ash'],
  note: 'knows exactly how close it can get',
};

const WORLD = { wildlife: [FOX] };

function night(seed: string, seconds: number): Store {
  const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: seed, world: WORLD });
  setPresence(store.state.ritual, { speed: 0 });
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) stepRitual(store.state.ritual, SIM_DT);
  store.rememberCampsite();
  return store;
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe('campsite memory', () => {
  it('counts the visit on arrival, before anything has happened', () => {
    const first = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'seed-a', world: WORLD });
    expect(first.campsiteMemory().visits).toBe(1);
    expect(first.state.ritual.options.visitIndex).toBe(1);

    const second = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'seed-a', world: WORLD });
    expect(second.campsiteMemory().visits).toBe(2);
    expect(second.state.ritual.options.visitIndex).toBe(2);
  });

  it('keeps each campsite separate', () => {
    new Store({ environmentId: 'pine_hollow', campsiteSeed: 'seed-a', world: WORLD });
    new Store({ environmentId: 'pine_hollow', campsiteSeed: 'seed-a', world: WORLD });
    const other = new Store({ environmentId: 'lantern_mesa', campsiteSeed: 'seed-b', world: WORLD });
    expect(other.campsiteMemory().visits).toBe(1);
  });

  it('hands a night’s residents back to the next night', () => {
    // Walk campsites until one actually produced a resident sighting: which
    // animals turn up is chance, and a seed's night is fully determined, so
    // replaying one campsite would replay the same coin toss.
    let seed = '';
    for (const candidate of ['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5']) {
      const store = night(candidate, 900);
      if (Object.keys(store.campsiteMemory().residents).length > 0) {
        seed = candidate;
        break;
      }
    }
    expect(seed).not.toBe('');

    const remembered = new Store({ environmentId: 'pine_hollow', campsiteSeed: seed, world: WORLD });
    const priorVisits = remembered.state.passport.campsites[seed]?.residents ?? {};
    for (const individual of remembered.state.ritual.wildlife.individuals) {
      const prior = priorVisits[individual.id];
      if (prior !== undefined) expect(individual.visits).toBe(prior);
    }
    expect(Object.values(priorVisits).some((count) => count > 0)).toBe(true);
  });

  it('is idempotent: remembering twice does not duplicate anything', () => {
    const store = night('idem-1', 600);
    const once = structuredClone(store.campsiteMemory());
    store.rememberCampsite();
    store.rememberCampsite();
    const thrice = store.campsiteMemory();
    expect(thrice.secrets).toHaveLength(once.secrets.length);
    expect(thrice.traces).toHaveLength(once.traces.length);
    expect(thrice.sightings).toHaveLength(once.sightings.length);
    expect(thrice.visits).toBe(once.visits);
  });

  it('never stores a significance score', () => {
    const store = night('score-1', 900);
    const raw = localStorage.getItem('some-more/passport/v1') ?? '';
    expect(raw.length).toBeGreaterThan(0);
    for (const forbidden of ['"score"', '"value"', '"significance"', '"weight"', '"rating"']) {
      expect(raw).not.toContain(forbidden);
    }
    for (const trace of store.campsiteMemory().traces) {
      expect(['keep', 'passport', 'landmark']).toContain(trace.disposition);
    }
  });

  it('drops traces the model decided should fade', () => {
    const store = night('fade-1', 900);
    // `fade` is real in the world tonight and is not something the Passport
    // carries forward — the campsite forgets gently rather than hoarding.
    expect(store.campsiteMemory().traces.every((t) => t.disposition !== 'fade')).toBe(true);
  });

  it('survives a corrupt Passport rather than blocking the world', () => {
    localStorage.setItem('some-more/passport/v1', '{not json');
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'corrupt-1', world: WORLD });
    expect(store.campsiteMemory().visits).toBe(1);
  });

  it('survives a Passport written by a build that had no campsite memory', () => {
    const legacy: Partial<PassportState> = {
      playerId: 'anon-old',
      entries: [],
      photos: [],
      stamps: [],
      visitedEnvironments: ['pine_hollow'],
      sandwichCount: 3,
    };
    localStorage.setItem('some-more/passport/v1', JSON.stringify(legacy));
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'legacy-1', world: WORLD });
    expect(store.state.passport.sandwichCount).toBe(3);
    expect(store.campsiteMemory().visits).toBe(1);
  });
});

describe('the campsite page reads as a page, not a record card', () => {
  it('says how many times you have been, in words', () => {
    expect(visitLine(1)).toBe('The first night here.');
    expect(visitLine(2)).toContain('once before');
    expect(visitLine(3)).toContain('third');
    expect(visitLine(40)).toContain('eyes shut');
  });

  it('never puts a number in the line', () => {
    // A count is a statistic and a statistic turns a campsite into a record
    // card. An ordinal said in words is a fact about a night.
    for (const visits of [1, 2, 3, 5, 9, 25, 300]) {
      expect(visitLine(visits)).not.toMatch(/\d/);
    }
  });
});
