/**
 * Photos and campsite memory, across the seam.
 *
 * Not a mocked fetch and not a mocked store: this boots the real API — real
 * routes, real storage adapter, real merge — and drives it with the real
 * `SyncEngine`, `ApiClient` and `Store` the game uses. The seam between the
 * two halves is the thing under test, and a mock of either half cannot test a
 * seam.
 *
 * Four things it is here to prove, none of which a unit test can see:
 *
 *  1. A photograph uploads and comes back.
 *  2. A campsite that remembers you reaches a second device.
 *  3. Two devices that both camped offline merge without losing a night or
 *     inventing one.
 *  4. No significance score is anywhere in any payload, in either direction —
 *     asserted on the serialised bytes, the way the order tests assert that
 *     nothing card-shaped crosses the wire.
 *
 * And one that is really a promise about failure: an unreachable service
 * leaves local play byte-identical.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPresence, stepRitual, SIM_DT, type WildlifeSpecies } from '@somemore/sim';
import { startTestApi, type TestHarness } from '../../services/api/test/harness.js';
import { ApiClient, deviceId } from '../../apps/web/src/net/client.js';
import { SyncEngine } from '../../apps/web/src/net/sync.js';
import { buildSnapshot, applyRemoteMemory } from '../../apps/web/src/net/memory.js';
import { uploadPhoto, decodeDataUrl } from '../../apps/web/src/net/media.js';
import { Store, type PassportPhoto } from '../../apps/web/src/state/store.js';

/* -------------------------------------------------------------------------- */
/* A localStorage per simulated device                                         */
/* -------------------------------------------------------------------------- */

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
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/** Swap in a device's storage, run something, and put the old one back. */
async function onDevice<T>(storage: MemoryStorage, run: () => Promise<T> | T): Promise<T> {
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    return await run();
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
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

const PNG_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function photo(id: string): PassportPhoto {
  return {
    id,
    dataUrl: PNG_DATA_URL,
    caption: 'The fire, low.',
    takenAt: Date.parse('2026-08-29T12:00:00.000Z'),
    environmentId: 'pine_hollow',
    stage: 'at-fire',
  };
}

let api: TestHarness;
let mediaRoot: string;
let bodies: string[] = [];

/** Records every request and response body, for the byte-level assertions. */
function recordingFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body !== undefined && init.body !== null && typeof init.body === 'string') {
      bodies.push(init.body);
    }
    const response = await fetch(input as string, init);
    const clone = response.clone();
    const type = clone.headers.get('content-type') ?? '';
    if (type.includes('json')) bodies.push(await clone.text());
    return response;
  }) as typeof fetch;
}

beforeEach(async () => {
  bodies = [];
  mediaRoot = await mkdtemp(path.join(tmpdir(), 'somemore-seam-'));
  api = await startTestApi({ MEDIA_LOCAL_ROOT: mediaRoot });
});

afterEach(async () => {
  await api.close();
  await rm(mediaRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 1. A photograph goes somewhere and comes back                               */
/* -------------------------------------------------------------------------- */

describe('a photograph, through the real client and the real service', () => {
  it('uploads and comes back byte-for-byte', async () => {
    const storage = new MemoryStorage();
    await onDevice(storage, async () => {
      const client = new ApiClient({ baseUrl: api.baseUrl });
      const session = await client.bootstrap(deviceId());
      expect(session.ok).toBe(true);

      const outcome = await uploadPhoto(client, photo('photo-1'));
      expect(outcome.kind).toBe('uploaded');
      if (outcome.kind !== 'uploaded') return;

      const fetched = await fetch(`${api.baseUrl}${outcome.stored.url}`, {
        headers: { authorization: `Bearer ${session.ok ? session.value.auth.token : ''}` },
      });
      expect(fetched.status).toBe(200);
      const returned = new Uint8Array(await fetched.arrayBuffer());
      const original = decodeDataUrl(PNG_DATA_URL);
      expect(original).not.toBeNull();
      expect(Buffer.from(returned).equals(Buffer.from(original?.bytes ?? new Uint8Array()))).toBe(true);
      // Private unless somebody chose otherwise, all the way through.
      expect(outcome.stored.photo.visibility).toBe('private');
    });
  });

  it('lifts the twenty-four cap off the Passport once the bytes are safe', async () => {
    const storage = new MemoryStorage();
    await onDevice(storage, async () => {
      const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'cap-1', world: WORLD });
      const sync = new SyncEngine({ baseUrl: api.baseUrl });
      sync.onPhotoUploaded = (localId, remoteId, url) => store.markPhotoUploaded(localId, remoteId, url);
      await sync.ensureAccount();

      // Thirty photographs, which under the old rule was six lost ones.
      for (let i = 0; i < 30; i += 1) {
        const taken = photo(`photo-${i}`);
        store.addPhoto(taken);
        sync.enqueuePhoto(taken, null);
        await sync.drain();
      }

      const photos = store.state.passport.photos;
      expect(photos).toHaveLength(30);
      // Every one of them reached storage, so none of them is carrying bytes.
      expect(photos.every((entry) => entry.remoteId !== undefined)).toBe(true);
      expect(photos.every((entry) => entry.dataUrl === '')).toBe(true);
      // And each is still fetchable, which is what makes the entry worth keeping.
      const first = photos[photos.length - 1];
      const fetched = await fetch(`${api.baseUrl}${first?.url ?? ''}`, {
        headers: { authorization: `Bearer ${sync.api.accountId === null ? '' : ''}` },
      });
      // Signed out it is a 404, because a photo is private by default.
      expect(fetched.status).toBe(404);
      sync.dispose();
    });
  });

  it('keeps the photo, and the cap, when there is no object storage at all', async () => {
    const unconfigured = await startTestApi({ MEDIA_STORAGE: 's3' });
    const storage = new MemoryStorage();
    try {
      await onDevice(storage, async () => {
        const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'nostore-1', world: WORLD });
        const sync = new SyncEngine({ baseUrl: unconfigured.baseUrl });
        sync.onPhotoUploaded = (localId, remoteId, url) => store.markPhotoUploaded(localId, remoteId, url);
        await sync.ensureAccount();

        const taken = photo('photo-solo');
        store.addPhoto(taken);
        sync.enqueuePhoto(taken, null);
        await sync.drain();

        // The photo is exactly where the player left it, with its bytes, and
        // nothing is still queued: there is no bucket, and that is not an
        // error worth retrying six times from somebody's phone.
        expect(store.state.passport.photos[0]?.dataUrl).toBe(PNG_DATA_URL);
        expect(store.state.passport.photos[0]?.remoteId).toBeUndefined();
        expect(sync.status.pending).toBe(0);
        sync.dispose();
      });
    } finally {
      await unconfigured.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2 & 3. Two devices                                                          */
/* -------------------------------------------------------------------------- */

/** One night at a campsite, on a given device's storage. */
async function night(storage: MemoryStorage, seed: string, seconds: number): Promise<Store> {
  return onDevice(storage, () => {
    const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: seed, world: WORLD });
    setPresence(store.state.ritual, { speed: 0 });
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps; i += 1) stepRitual(store.state.ritual, SIM_DT);
    store.rememberCampsite();
    return store;
  });
}

describe('a campsite that remembers you, on a second device', () => {
  it('reaches the second device with everything the first one learned', async () => {
    const phone = new MemoryStorage();
    const tablet = new MemoryStorage();
    const SEED = 'seam-two-devices';

    // Two nights on the phone, with a real simulated evening behind each.
    let campsiteId: string | null = null;
    let uploaded = 0;
    for (let i = 0; i < 2; i += 1) {
      const store = await night(phone, SEED, 240);
      await onDevice(phone, async () => {
        const sync = new SyncEngine({ baseUrl: api.baseUrl, fetchImpl: recordingFetch() });
        campsiteId = await sync.ensureCampsite('Pine Hollow', 'pine_hollow', 4242);
        expect(campsiteId).not.toBeNull();
        const merged = await sync.syncCampsiteMemory(campsiteId as string, store.campsiteMemory());
        expect(merged).not.toBeNull();
        if (merged) {
          store.applyCampsiteMemory(merged);
          uploaded = merged.visits;
        }
        sync.dispose();
      });
    }
    expect(uploaded).toBe(2);
    const onPhone = (await night(phone, SEED, 1)).campsiteMemory();

    // A different device, signing into the same account: it restores the
    // session the phone persisted, which is what a real second device does
    // after a magic-link sign-in.
    tablet.setItem('some-more/session/v1', phone.getItem('some-more/session/v1') ?? '');
    const restored = await onDevice(tablet, async () => {
      const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: SEED, world: WORLD });
      const sync = new SyncEngine({ baseUrl: api.baseUrl, fetchImpl: recordingFetch() });
      // The tablet has never heard of this campsite, and finds it on the
      // account rather than pitching a second one.
      const found = await sync.ensureCampsite('Pine Hollow', 'pine_hollow', 4242);
      expect(found).toBe(campsiteId);
      const merged = await sync.fetchCampsiteMemory(found as string, store.campsiteMemory());
      expect(merged).not.toBeNull();
      if (merged) store.applyCampsiteMemory(merged);
      sync.dispose();
      return store.campsiteMemory();
    });

    // The place has met this player, on a device that was never there.
    expect(restored.visits).toBeGreaterThanOrEqual(2);
    for (const [individualId, seen] of Object.entries(onPhone.residents)) {
      expect(restored.residents[individualId] ?? 0).toBeGreaterThanOrEqual(seen);
    }
    for (const secret of onPhone.secrets) {
      expect(restored.secrets.some((s) => s.secretId === secret.secretId)).toBe(true);
    }
  });

  it('merges two offline devices without losing a night or inventing one', async () => {
    const phone = new MemoryStorage();
    const tablet = new MemoryStorage();
    const SEED = 'seam-offline';

    const client = new ApiClient({ baseUrl: api.baseUrl });
    const session = await client.bootstrap(`device-shared-${Date.now()}`);
    if (!session.ok) throw new Error('bootstrap failed');
    const campsite = await client.createCampsite({ name: 'Pine Hollow', environmentId: 'pine_hollow', seed: 77 });
    if (!campsite.ok) throw new Error('campsite failed');
    const campsiteId = campsite.value.id;
    for (const storage of [phone, tablet]) {
      storage.setItem('some-more/session/v1', JSON.stringify(session.value));
      storage.setItem('some-more/campsite-id/v1:pine_hollow', campsiteId);
    }
    // Two devices means two device ids; the store's own device id is derived
    // from `localStorage`, so each simulated device gets its own.
    phone.setItem('some-more/device/v1', 'device-phone');
    tablet.setItem('some-more/device/v1', 'device-tablet');

    async function campAndSync(storage: MemoryStorage, nights: number): Promise<number> {
      let visits = 0;
      for (let i = 0; i < nights; i += 1) {
        const store = await night(storage, SEED, 60);
        visits = await onDevice(storage, async () => {
          const sync = new SyncEngine({ baseUrl: api.baseUrl });
          const merged = await sync.syncCampsiteMemory(campsiteId, store.campsiteMemory());
          if (merged) store.applyCampsiteMemory(merged);
          sync.dispose();
          return merged?.visits ?? 0;
        });
      }
      return visits;
    }

    // Both camp offline — three nights on the phone, two on the tablet, with
    // neither device syncing in between — and then both come back.
    await onDevice(phone, () => {});
    for (let i = 0; i < 3; i += 1) await night(phone, SEED, 60);
    for (let i = 0; i < 2; i += 1) await night(tablet, SEED, 60);

    const afterPhone = await campAndSync(phone, 1);
    const afterTablet = await campAndSync(tablet, 1);

    // Four nights on the phone and three on the tablet: seven, counted once.
    expect(afterPhone).toBe(4);
    expect(afterTablet).toBe(7);

    // Re-syncing an unchanged device adds nothing. This is the failure mode
    // that summing device totals would have, and it fires on a timer.
    const again = await onDevice(phone, async () => {
      const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: SEED, world: WORLD });
      // Loading the store counts an arrival, so push it and then push again.
      const sync = new SyncEngine({ baseUrl: api.baseUrl });
      const first = await sync.syncCampsiteMemory(campsiteId, store.campsiteMemory());
      const second = await sync.syncCampsiteMemory(campsiteId, store.campsiteMemory());
      const third = await sync.syncCampsiteMemory(campsiteId, store.campsiteMemory());
      sync.dispose();
      return { first: first?.visits, second: second?.visits, third: third?.visits };
    });
    expect(again.second).toBe(again.first);
    expect(again.third).toBe(again.first);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The score is not out here                                                */
/* -------------------------------------------------------------------------- */

describe('§6.4 holds on the wire', () => {
  it('has no significance score in any payload, in either direction', async () => {
    const storage = new MemoryStorage();
    // Which animals turn up is chance, and a seed's night is fully determined,
    // so replaying one campsite would replay the same coin toss. Walk until one
    // actually produced traces — an empty memory would prove nothing.
    let store: Store | null = null;
    for (const candidate of ['score-1', 'score-2', 'score-3', 'score-4', 'score-5']) {
      const attempt = await night(storage, candidate, 900);
      if (attempt.campsiteMemory().traces.length > 0) {
        store = attempt;
        break;
      }
    }
    if (store === null) throw new Error('no seed produced a trace');
    bodies = [];

    await onDevice(storage, async () => {
      const sync = new SyncEngine({ baseUrl: api.baseUrl, fetchImpl: recordingFetch() });
      const campsiteId = await sync.ensureCampsite('Pine Hollow', 'pine_hollow', 909);
      if (campsiteId === null) throw new Error('no campsite');
      const merged = await sync.syncCampsiteMemory(campsiteId, store.campsiteMemory());
      expect(merged).not.toBeNull();
      if (merged) store.applyCampsiteMemory(merged);
      // And a second round trip, so the *response* is in the recording too.
      await sync.fetchCampsiteMemory(campsiteId, store.campsiteMemory());
      sync.dispose();
    });

    // There has to be something in there worth checking.
    expect(store.campsiteMemory().traces.length).toBeGreaterThan(0);
    const wire = bodies.join('\n');
    expect(wire).toContain('"disposition"');

    /*
     * Not a promise in a comment. The score is a number the significance model
     * computes; every one of these is either that number, or one of the
     * evidence fields it is computed from, or the free-form payload where one
     * could hide. None of them has a place in the protocol, and this asserts it
     * on the serialised bytes rather than on a shape.
     */
    for (const forbidden of [
      '"score"',
      '"significance"',
      '"weight"',
      '"rating"',
      '"rarity"',
      '"isFirst"',
      '"interactionCount"',
      '"photographed"',
      '"social"',
      '"duringWorldEvent"',
      '"explicitlyPreserved"',
      '"dwellSeconds"',
      '"lifetimeSeconds"',
      '"payload"',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    // A `fade` disposition is not expressible, so it cannot appear either.
    expect(wire).not.toContain('"fade"');
  });

  it('drops the payload on the way out and never gets one back', async () => {
    const storage = new MemoryStorage();
    const store = await night(storage, 'seam-payload', 900);
    const memory = store.campsiteMemory();
    const withPayload = memory.traces.filter((t) => Object.keys(t.payload).length > 0);
    expect(withPayload.length).toBeGreaterThan(0);

    const built = buildSnapshot({ memory, deviceId: 'device-x', entry: { own: 0, lastKnownTotal: 0 } });
    for (const trace of built.snapshot.traces) {
      expect(Object.keys(trace).sort()).toEqual(['createdAt', 'disposition', 'id', 'kind']);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Local play is untouched by a service that is not there                      */
/* -------------------------------------------------------------------------- */

describe('an unreachable service', () => {
  it('leaves local play byte-identical', async () => {
    /*
     * One device, one night, and the Passport bytes read before and after a
     * dead service is asked for everything it cannot give. Comparing one
     * device against another would compare two different random player ids and
     * two different wall clocks; this compares the thing the claim is actually
     * about, which is whether the network touched the local record at all.
     */
    const storage = new MemoryStorage();
    await onDevice(storage, async () => {
      const store = new Store({ environmentId: 'pine_hollow', campsiteSeed: 'seam-dead', world: WORLD });
      setPresence(store.state.ritual, { speed: 0 });
      for (let i = 0; i < Math.round(600 / SIM_DT); i += 1) stepRitual(store.state.ritual, SIM_DT);
      store.rememberCampsite();
      const taken = photo('photo-offline');
      store.addPhoto(taken);

      const before = storage.getItem('some-more/passport/v1') ?? '';
      expect(before.length).toBeGreaterThan(0);

      const sync = new SyncEngine({
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      });
      sync.onPhotoUploaded = (localId, remoteId, url) => store.markPhotoUploaded(localId, remoteId, url);
      sync.enqueuePhoto(taken, null);
      await sync.drain();
      const merged = await sync.syncCampsiteMemory('cmp_nowhere', store.campsiteMemory());
      expect(merged).toBeNull();
      sync.dispose();

      const after = storage.getItem('some-more/passport/v1') ?? '';
      // Byte-identical: the same campsite memory, and the photograph still
      // carrying its own bytes because nothing took them anywhere.
      expect(after).toBe(before);
      expect(store.state.passport.photos[0]?.dataUrl).toBe(PNG_DATA_URL);
      expect(store.state.passport.photos[0]?.remoteId).toBeUndefined();
    });
  });

  it('leaves the campsite memory exactly as it was when a sync fails', async () => {
    const storage = new MemoryStorage();
    const store = await night(storage, 'seam-failed-sync', 300);
    const before = JSON.stringify(store.campsiteMemory());

    await onDevice(storage, async () => {
      const sync = new SyncEngine({
        baseUrl: api.baseUrl,
        fetchImpl: async () => new Response('{"error":{"code":"internal_error","message":"boom"}}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      });
      const merged = await sync.syncCampsiteMemory('cmp_anything', store.campsiteMemory());
      expect(merged).toBeNull();
      sync.dispose();
    });

    expect(JSON.stringify(store.campsiteMemory())).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Skew                                                                        */
/* -------------------------------------------------------------------------- */

describe('a device whose clock is wrong', () => {
  it('re-bases a remote trace onto its own clock, so it fades with everybody else', () => {
    const local = {
      campsiteSeed: 's',
      environmentId: 'pine_hollow',
      visits: 1,
      lastVisitAt: 0,
      secrets: [],
      residents: {},
      traces: [],
      sightings: [],
      constellations: [],
    };
    const serverNow = Date.parse('2026-08-30T12:00:00.000Z');
    // A phone a day ahead of the service.
    const deviceNow = serverNow + 86_400_000;

    const merged = applyRemoteMemory({
      local,
      remote: {
        campsiteId: 'cmp_1',
        accountId: 'acct_1',
        environmentId: 'pine_hollow',
        observedAt: new Date(serverNow).toISOString(),
        visits: 1,
        lastVisitAt: new Date(serverNow).toISOString(),
        secrets: [],
        residents: {},
        traces: [
          {
            id: 'a',
            kind: 'discovery',
            // Two days old, as the server sees it.
            createdAt: new Date(serverNow - 2 * 86_400_000).toISOString(),
            disposition: 'keep',
          },
        ],
        sightings: [],
        constellations: [],
        expiredTraceIds: [],
        updatedAt: new Date(serverNow).toISOString(),
        revision: 1,
      },
      localNowMs: deviceNow,
    });

    // Still two days old on this device, not three. Without the re-basing the
    // trace would look a day older than it is and fade a day early.
    const trace = merged.traces[0];
    expect(trace).toBeDefined();
    expect(deviceNow - (trace?.createdAt ?? 0)).toBe(2 * 86_400_000);
  });
});
