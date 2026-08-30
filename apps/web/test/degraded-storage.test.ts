/**
 * What the campsite does when the device's own storage lies to it.
 *
 * `localStorage` is a file. It carries whatever an older build wrote, whatever
 * a half-finished write left behind, and whatever somebody typed into a
 * console. The existing corruption test covers the easy case — a document that
 * is not JSON at all — and everything below is the harder one: a document that
 * parses perfectly and is the wrong shape.
 *
 * The rule being tested is ARCHITECTURE §1.5, and it has no exceptions: the
 * ritual is local-first, so nothing about a device's own saved state may be a
 * reason the world does not open.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCESSIBILITY, Store, sanitizeSettings } from '../src/state/store.js';

/** The smallest localStorage that behaves like one. */
class MemoryStorage {
  private map = new Map<string, string>();
  /** Set to make every write fail, the way a full quota does. */
  full = false;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.full) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
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

const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;

const PASSPORT_KEY = 'some-more/passport/v1';
const SETTINGS_KEY = 'some-more/settings/v1';

beforeEach(() => {
  storage.clear();
  storage.full = false;
});

describe('a Passport document of the wrong shape', () => {
  const documents: [string, unknown][] = [
    ['the whole document is an array', []],
    ['the whole document is a number', 3],
    ['campsites is an array', { campsites: [] }],
    ['campsites is a string', { campsites: 'nope' }],
    ['a single campsite memory is a string', { campsites: { 'seed-a': 'nope' } }],
    ['traces is not an array', { campsites: { 'seed-a': { traces: 3 } } }],
    ['photos is a number', { photos: 7 }],
    ['entries is null', { entries: null }],
  ];

  for (const [name, document] of documents) {
    it(`still opens the campsite when ${name}`, () => {
      storage.setItem(PASSPORT_KEY, JSON.stringify(document));
      const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'shape' });
      expect(store.campsiteMemory().visits).toBe(1);
    });
  }
});

describe('settings that are not what they claim to be', () => {
  /*
   * This one is not merely a crash risk. `autoRotate` is handed straight to
   * `createRitual`, so a string there put a NaN into the marshmallow's
   * rotation and the roast stopped turning — a broken *assist*, silently, for
   * the person who needed it.
   */
  it('never lets a corrupt assist reach the simulation', () => {
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ accessibility: { autoRotate: 'fast', assemblyAssist: null } }),
    );
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'assists' });
    expect(Number.isFinite(store.state.accessibility.autoRotate)).toBe(true);
    expect(Number.isFinite(store.state.accessibility.assemblyAssist)).toBe(true);
    expect(Number.isFinite(store.state.ritual.roastInput.rotation)).toBe(true);
  });

  it('keeps text scale a number, because every font size multiplies by it', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ accessibility: { textScale: 'huge' }, render: 4 }));
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'scale' });
    expect(store.state.accessibility.textScale).toBe(DEFAULT_ACCESSIBILITY.textScale);
    expect(Number.isFinite(store.state.render.dither)).toBe(true);
  });

  it('clamps a value to the range the settings screen offers', () => {
    const settings = sanitizeSettings({
      accessibility: { textScale: 900, autoRotate: -4 },
      audio: { master: 12 },
      render: { colorDepth: 2.7 },
    });
    expect(settings.accessibility.textScale).toBe(1.8);
    expect(settings.accessibility.autoRotate).toBe(0);
    expect(settings.audio.master).toBe(1);
    expect(settings.render.colorDepth).toBe(3);
  });

  it('keeps a settings document that is simply from an older build', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ accessibility: { highContrast: true } }));
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'legacy' });
    expect(store.state.accessibility.highContrast).toBe(true);
    expect(store.state.accessibility.subtitles).toBe(DEFAULT_ACCESSIBILITY.subtitles);
  });
});

describe('a device with no room left', () => {
  it('opens the campsite anyway when every write is refused', () => {
    storage.full = true;
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'full' });
    expect(store.campsiteMemory().visits).toBe(1);
    // And the session keeps working: a settings change a full disk cannot hold
    // is still a settings change for tonight.
    store.updateAccessibility({ highContrast: true });
    expect(store.state.accessibility.highContrast).toBe(true);
  });
});
