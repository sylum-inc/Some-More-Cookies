/**
 * The client half of campsite sync, as arithmetic.
 *
 * The server's merge is tested where it lives; this is the other end — the
 * device ledger that decides how many nights *this* device claims, and the
 * translation back into a local `CampsiteMemory`. Both are pure, which is why
 * they are here rather than only in a seam test: the ledger is where a
 * double-count would be introduced, and a double-count is invisible until a
 * campsite quietly says you have been eleven times.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CampsiteMemoryState } from '@somemore/protocol';
import { applyRemoteMemory, buildSnapshot, loadLedger, saveLedger } from '../src/net/memory.js';
import { decodeDataUrl } from '../src/net/media.js';
import type { CampsiteMemory } from '../src/state/store.js';

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

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function memory(overrides: Partial<CampsiteMemory> = {}): CampsiteMemory {
  return {
    campsiteSeed: 'camp-1',
    environmentId: 'pine_hollow',
    visits: 1,
    lastVisitAt: NOW,
    secrets: [],
    residents: {},
    traces: [],
    sightings: [],
    constellations: [],
    ...overrides,
  };
}

function state(overrides: Partial<CampsiteMemoryState> = {}): CampsiteMemoryState {
  return {
    campsiteId: 'cmp_1',
    accountId: 'acct_1',
    environmentId: 'pine_hollow',
    observedAt: new Date(NOW).toISOString(),
    visits: 1,
    lastVisitAt: new Date(NOW).toISOString(),
    secrets: [],
    residents: {},
    traces: [],
    sightings: [],
    constellations: [],
    expiredTraceIds: [],
    updatedAt: new Date(NOW).toISOString(),
    revision: 1,
    ...overrides,
  };
}

describe('the device ledger', () => {
  it('claims only the nights this device has actually contributed', () => {
    // A fresh device on its first night claims one.
    const first = buildSnapshot({
      memory: memory({ visits: 1 }),
      deviceId: 'phone',
      entry: { own: 0, lastKnownTotal: 0 },
    });
    expect(first.snapshot.deviceVisits).toBe(1);

    // It is then told the campsite has been visited six times, five of them by
    // somebody else's device. Its own count must not move.
    const afterMerge = { own: first.entry.own, lastKnownTotal: 6 };
    const idle = buildSnapshot({ memory: memory({ visits: 6 }), deviceId: 'phone', entry: afterMerge });
    expect(idle.snapshot.deviceVisits).toBe(1);

    // Two more nights on this device: seven locally, so two new, so three own.
    const later = buildSnapshot({ memory: memory({ visits: 8 }), deviceId: 'phone', entry: afterMerge });
    expect(later.snapshot.deviceVisits).toBe(3);
  });

  it('never sends a smaller counter than it sent before', () => {
    // A device whose local `visits` somehow went backwards — a restored
    // backup, a cleared Passport — must not un-count a night the service has
    // already credited to it.
    const built = buildSnapshot({
      memory: memory({ visits: 1 }),
      deviceId: 'phone',
      entry: { own: 9, lastKnownTotal: 20 },
    });
    expect(built.snapshot.deviceVisits).toBe(9);
  });

  it('drops a trace the wire has no member for, rather than failing the sync', () => {
    const built = buildSnapshot({
      memory: memory({
        traces: [
          { id: 'ok', kind: 'photo', createdAt: NOW, lifetimeSeconds: 1, disposition: 'keep', payload: {} },
          // `fade` is not expressible; a path-shaped id is refused by the
          // protocol. Neither is worth failing a whole night's sync over.
          { id: 'gone', kind: 'photo', createdAt: NOW, lifetimeSeconds: 1, disposition: 'fade', payload: {} },
          { id: '../etc', kind: 'photo', createdAt: NOW, lifetimeSeconds: 1, disposition: 'keep', payload: {} },
        ],
      }),
      deviceId: 'phone',
      entry: { own: 0, lastKnownTotal: 0 },
    });
    expect(built.snapshot.traces.map((t) => t.id)).toEqual(['ok']);
  });

  it('sends no payload, and no lifetime', () => {
    const built = buildSnapshot({
      memory: memory({
        traces: [
          {
            id: 'a',
            kind: 'discovery',
            createdAt: NOW,
            lifetimeSeconds: 1_209_600,
            disposition: 'keep',
            payload: { rarity: 0.9, dwellSeconds: 400 },
          },
        ],
      }),
      deviceId: 'phone',
      entry: { own: 0, lastKnownTotal: 0 },
    });
    expect(Object.keys(built.snapshot.traces[0] ?? {}).sort()).toEqual([
      'createdAt',
      'disposition',
      'id',
      'kind',
    ]);
    expect(JSON.stringify(built.snapshot)).not.toContain('rarity');
    expect(JSON.stringify(built.snapshot)).not.toContain('lifetimeSeconds');
  });

  it('survives a corrupt ledger rather than blocking the world', () => {
    localStorage.setItem('some-more/memory-ledger/v1', '{not json');
    expect(loadLedger()).toEqual({});
    saveLedger({ 'cmp_1:camp-1': { own: 2, lastKnownTotal: 5 } });
    expect(loadLedger()['cmp_1:camp-1']?.own).toBe(2);
  });
});

describe('taking the merge back', () => {
  it('never lets the visit count go down', () => {
    // The service may lag a night this device has had and not yet pushed.
    const merged = applyRemoteMemory({
      local: memory({ visits: 9 }),
      remote: state({ visits: 4 }),
      localNowMs: NOW,
    });
    expect(merged.visits).toBe(9);
  });

  it('re-bases a remote trace onto this device’s clock', () => {
    const deviceNow = NOW + 3 * 86_400_000; // a phone three days fast
    const merged = applyRemoteMemory({
      local: memory(),
      remote: state({
        traces: [
          {
            id: 'a',
            kind: 'discovery',
            createdAt: new Date(NOW - 86_400_000).toISOString(),
            disposition: 'keep',
          },
        ],
      }),
      localNowMs: deviceNow,
    });
    // One day old on this device too, not four. Without this the trace would
    // fade three days early on a phone whose clock is wrong.
    expect(deviceNow - (merged.traces[0]?.createdAt ?? 0)).toBe(86_400_000);
    expect(merged.traces[0]?.lifetimeSeconds).toBe(14 * 86_400);
    expect(merged.traces[0]?.payload).toEqual({});
  });

  it('gives a landmark an infinite lifetime rather than a null one', () => {
    const merged = applyRemoteMemory({
      local: memory(),
      remote: state({
        traces: [{ id: 'l', kind: 'sandwich', createdAt: new Date(NOW).toISOString(), disposition: 'landmark' }],
      }),
      localNowMs: NOW,
    });
    expect(merged.traces[0]?.lifetimeSeconds).toBe(Infinity);
  });

  it('drops what the service swept and keeps what it has not heard of', () => {
    const local = memory({
      traces: [
        { id: 'swept', kind: 'photo', createdAt: NOW, lifetimeSeconds: 10, disposition: 'keep', payload: {} },
        { id: 'unsent', kind: 'photo', createdAt: NOW, lifetimeSeconds: 10, disposition: 'keep', payload: {} },
      ],
    });
    const merged = applyRemoteMemory({
      local,
      remote: state({ expiredTraceIds: ['swept'] }),
      localNowMs: NOW,
    });
    // `unsent` has not reached the service yet; the service is the merge point,
    // not an authority that may delete a night nobody has uploaded.
    expect(merged.traces.map((t) => t.id)).toEqual(['unsent']);
  });

  it('takes the max of an animal’s visits, never the remote value alone', () => {
    const merged = applyRemoteMemory({
      local: memory({ residents: { 'fox-1': 5 } }),
      remote: state({ residents: { 'fox-1': 2, 'owl-1': 3 } }),
      localNowMs: NOW,
    });
    expect(merged.residents['fox-1']).toBe(5);
    expect(merged.residents['owl-1']).toBe(3);
  });
});

describe('decoding a captured photo', () => {
  it('reads the bytes back out of a data URL', () => {
    const decoded = decodeDataUrl(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    );
    expect(decoded?.contentType).toBe('image/png');
    expect(decoded?.bytes[0]).toBe(0x89);
    expect(decoded?.bytes.byteLength).toBe(70);
  });

  it('returns null rather than throwing for anything that is not one', () => {
    for (const bad of ['', 'not a url', 'data:text/html;base64,PGh0bWw+', 'data:image/png,notbase64', 'data:image/png;base64,']) {
      expect(decodeDataUrl(bad)).toBeNull();
    }
  });
});
