import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveMachineIdentity, deriveSandwich, PROGRAMS, type SandwichRecord } from '@somemore/sim';
import { ApiClient, deviceId, idempotencyKey } from '../src/net/client.js';
import { SyncEngine } from '../src/net/sync.js';
import { toAssemblyQuality, toMachineRun, toRoastTelemetry } from '../src/net/mapping.js';

const CAMPSITE_ID = 'cmp_0123456789abcdef';

/** A sandwich the simulation would actually produce. */
function makeSandwich(): SandwichRecord {
  return deriveSandwich({
    roast: {
      brown: 0.6, char: 0.05, blister: 0.2, evenness: 0.8, sidedness: 0.1,
      peakTempC: 194, melt: 0.3, fallen: false, ignitionCount: 0, flameSeconds: 0,
      seconds: 74.2, rotationTravel: 40, descriptors: ['evenly-golden'], label: 'Evenly golden',
    },
    assembly: {
      misalignment: 0.004, maxMisalignment: 0.006, lean: 0.02, squish: 0.4,
      crumbs: 0.3, smear: 0.2, seconds: 20, tidiness: 0.8, label: 'Neatly stacked',
    },
    machine: {
      serial: deriveMachineIdentity('camp-net', 'pine_hollow').serial,
      program: 'standard', durationSeconds: 50, peakFrost: 0.7,
      minChamberTempC: -28, quirkIds: [], firmness: PROGRAMS.standard.firmness,
    },
    environmentId: 'pine_hollow',
    campsiteSeed: 'camp-net',
    createdAt: Date.UTC(2026, 0, 1),
    index: 1,
  });
}

/** A minimal localStorage so the modules behave as they do in a browser. */
function installStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const SESSION = {
  account: {
    id: 'acct_0123456789abcdef',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedIntoAccountId: null,
    anonymous: true,
    schemaVersion: '1.0.0',
  },
  identities: [],
  auth: {
    token: 'sm1.token.signature.value',
    accountId: 'acct_0123456789abcdef',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2126-01-01T00:00:00.000Z',
    schemaVersion: '1.0.0',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('idempotency keys', () => {
  it('look like version 4 UUIDs', () => {
    expect(idempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('are unique', () => {
    const keys = new Set(Array.from({ length: 500 }, () => idempotencyKey()));
    expect(keys.size).toBe(500);
  });
});

describe('device identity', () => {
  beforeEach(() => installStorage());

  it('is stable across calls', () => {
    expect(deviceId()).toBe(deviceId());
  });

  it('survives without storage', () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(deviceId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ApiClient', () => {
  beforeEach(() => installStorage());

  it('bootstraps an anonymous account', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SESSION));
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.bootstrap('device-1');
    expect(result.ok).toBe(true);
    expect(client.authenticated).toBe(true);
    expect(client.accountId).toBe('acct_0123456789abcdef');
  });

  it('sends the shared schema version and platform', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SESSION));
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.bootstrap('device-1');
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(String(calls[0]?.[1]?.body));
    expect(body.device.platform).toBe('web');
    expect(body.device.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('refuses authenticated calls before bootstrap rather than sending them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.fetchPassport();
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attaches the bearer token once authenticated', async () => {
    const headers: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push((init.headers ?? {}) as Record<string, string>);
      return jsonResponse(SESSION);
    });
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.bootstrap('device-1');
    await client.fetchPassport();
    expect(headers[0]!.authorization).toBeUndefined();
    expect(headers[1]!.authorization).toBe(`Bearer ${SESSION.auth.token}`);
  });

  it('drops a rejected token so the next call can start clean', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? jsonResponse(SESSION) : jsonResponse({ error: { code: 'unauthorized' } }, 401);
    });
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.bootstrap('device-1');
    expect(client.authenticated).toBe(true);
    const result = await client.fetchPassport();
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
    expect(client.authenticated).toBe(false);
  });

  it('reports an idempotency conflict distinctly', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? jsonResponse(SESSION)
        : jsonResponse({ error: { code: 'idempotency_key_conflict', message: 'differs' } }, 409);
    });
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.bootstrap('device-1');
    const result = await client.recordSandwich({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('conflict');
  });

  it('treats a network failure as offline and backs off', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.bootstrap('device-1');
    expect(result).toEqual({ ok: false, error: { kind: 'offline' } });
    expect(client.offline).toBe(true);
    // A second call must not hammer a dead server.
    await client.bootstrap('device-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out rather than hanging the ritual', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
    expect(await client.bootstrap('device-1')).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('rejects a response that does not match the shared contract', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ account: { id: 'nope' } }));
    const client = new ApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.bootstrap('device-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('malformed');
  });
});

describe('SyncEngine', () => {
  beforeEach(() => installStorage());

  const sandwich = makeSandwich();

  it('queues work without waiting for the network', () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline');
    });
    const sync = new SyncEngine({ fetchImpl: fetchImpl as unknown as typeof fetch });
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    // Enqueue is synchronous: the ritual never waits on this.
    expect(sync.status.pending).toBe(1);
    sync.dispose();
  });

  it('sends queued work once an account exists', async () => {
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/auth/anonymous')) return jsonResponse(SESSION);
      sent.push(JSON.parse(init.body as string));
      return jsonResponse(wireSandwich());
    });
    const sync = new SyncEngine({ fetchImpl: fetchImpl as unknown as typeof fetch });
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    await sync.drain();
    // Exactly one send: a re-entrant drain used to upload the same sandwich
    // several times over.
    expect(sent).toHaveLength(1);
    expect(sync.status.pending).toBe(0);
    sync.dispose();
  });

  it('does not queue the same sandwich twice', () => {
    const sync = new SyncEngine({ fetchImpl: (async () => jsonResponse(SESSION)) as unknown as typeof fetch });
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    expect(sync.status.pending).toBe(1);
    sync.dispose();
  });

  it('treats a conflict as already delivered', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/auth/anonymous')
        ? jsonResponse(SESSION)
        : jsonResponse({ error: { code: 'idempotency_key_conflict' } }, 409),
    );
    const sync = new SyncEngine({ fetchImpl: fetchImpl as unknown as typeof fetch });
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    await sync.drain();
    expect(sync.status.pending).toBe(0);
    sync.dispose();
  });

  it('survives a reload with work still queued', () => {
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const first = new SyncEngine({ fetchImpl: offline });
    first.enqueueSandwich(sandwich, CAMPSITE_ID);
    first.dispose();

    const second = new SyncEngine({ fetchImpl: offline });
    expect(second.status.pending).toBe(1);
    second.dispose();
  });

  it('starts clean when the stored queue is corrupt', () => {
    localStorage.setItem('some-more/sync-queue/v1', '{not json');
    const sync = new SyncEngine({ fetchImpl: (async () => jsonResponse(SESSION)) as unknown as typeof fetch });
    expect(sync.status.pending).toBe(0);
    sync.dispose();
  });

  it('reports status to subscribers', () => {
    const sync = new SyncEngine({ fetchImpl: (async () => jsonResponse(SESSION)) as unknown as typeof fetch });
    const seen: number[] = [];
    const unsubscribe = sync.subscribe((status) => seen.push(status.pending));
    sync.enqueueSandwich(sandwich, CAMPSITE_ID);
    expect(seen).toContain(1);
    unsubscribe();
    sync.dispose();
  });
});

/** A response shaped like the server's, so validation is exercised. */
function wireSandwich(): Record<string, unknown> {
  return {
    id: 'snd_0123456789abcdef',
    accountId: 'acct_0123456789abcdef',
    campsiteId: CAMPSITE_ID,
    sessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: '1.0.0',
    name: null,
    roast: toRoastTelemetry(makeSandwich(), 18),
    assembly: toAssemblyQuality(makeSandwich()),
    machineRun: toMachineRun(makeSandwich(), 'run_0123456789abcdef', new Date('2026-01-01T00:00:00.000Z')),
    overallScore: 0.7,
    rarity: 'common',
    flavorTags: [],
    photoIds: [],
    heroPhotoId: null,
    shareState: 'private',
    savedToPassport: true,
    consumedAt: null,
    orderId: null,
  };
}
