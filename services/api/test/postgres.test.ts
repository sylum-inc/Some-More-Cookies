import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createCampsite,
  key,
  sandwichPayload,
  startTestApi,
  PERSISTENCE,
  type TestHarness,
} from './harness.js';
import { listApplied, loadMigrations, migrate, truncateData } from '../src/db/index.js';

/*
 * The tests a single-threaded Map cannot fail.
 *
 * Everything here is about two things happening at once. The in-memory
 * repositories are correct only because nothing ever interleaves inside them;
 * the moment storage is real and shared, "check, then write" stops being a
 * rule and becomes a hope. These cases put two requests in flight at the same
 * instant and insist the database, not the ordering of the event loop, decides
 * who won.
 *
 * They are skipped without DATABASE_URL, because there is nothing honest to
 * assert about concurrency against a Map.
 */
const describePostgres = PERSISTENCE === 'postgres' ? describe : describe.skip;

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

/** Fail loudly if a "concurrent" pair silently ran one after the other. */
function outcomes(responses: Array<{ status: number }>): number[] {
  return responses.map((r) => r.status).sort((a, b) => a - b);
}

describePostgres('racing on one idempotency key', () => {
  it('runs the handler exactly once when two identical requests arrive together', async () => {
    const player = await bootstrap(api);
    const idempotencyKey = key('race');
    const body = { idempotencyKey, name: 'Twice Requested' };

    const [first, second] = await Promise.all([
      api.request('/v1/campsites', { method: 'POST', token: player.token, body }),
      api.request('/v1/campsites', { method: 'POST', token: player.token, body }),
    ]);

    // One of them created the campsite. The other either replayed the stored
    // response or was told the original is still in flight — never a second
    // campsite, and never a 500.
    const statuses = outcomes([first, second]);
    expect(statuses).toContain(201);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const loser = first.status === 201 ? second : first;
    expect([200, 409]).toContain(loser.status);
    if (loser.status === 200) {
      expect(loser.headers.get('idempotent-replay')).toBe('true');
      expect(loser.body.id).toBe((first.status === 201 ? first : second).body.id);
    } else {
      expect(loser.body.error.code).toBe('conflict');
    }

    const listed = await api.request('/v1/campsites', { token: player.token });
    expect(listed.body.items.filter((c: any) => c.name === 'Twice Requested')).toHaveLength(1);
  });

  it('still rejects the same key with a different payload when they race', async () => {
    const player = await bootstrap(api);
    const idempotencyKey = key('race');

    const [a, b] = await Promise.all([
      api.request('/v1/campsites', {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey, name: 'Alpha' },
      }),
      api.request('/v1/campsites', {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey, name: 'Beta' },
      }),
    ]);

    const statuses = outcomes([a, b]);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const loser = a.status === 201 ? b : a;
    expect(loser.status).toBe(409);
    expect(['idempotency_key_conflict', 'conflict']).toContain(loser.body.error.code);

    const listed = await api.request('/v1/campsites', { token: player.token });
    expect(listed.body.items).toHaveLength(1);
  });

  it('releases the key when the handler throws, so a genuine retry still works', async () => {
    const owner = await bootstrap(api, 'Owner');
    const joiner = await bootstrap(api, 'Joiner');
    const campsite = await createCampsite(api, owner);
    const idempotencyKey = key('race');

    // The key is claimed, then the handler throws: a wrong camp code is a
    // not-found from inside the handler, not a schema rejection at the edge.
    const failed = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: joiner.token,
      body: { idempotencyKey, join: { method: 'camp_code', code: 'ZZZZZZ' } },
    });
    expect(failed.status).toBe(404);

    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv'), grantsRole: 'guest' },
    });

    // Same key, now with a code that works. A failed call must not poison it.
    const retried = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: joiner.token,
      body: { idempotencyKey, join: { method: 'camp_code', code: invite.body.invite.campCode } },
    });
    expect(retried.status).toBe(200);
  });
});

describePostgres('two clients claiming the same once-only reward', () => {
  async function playerWhoDeservesAKit() {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const made = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });
    expect(made.status).toBe(201);
    api.clock.advance(3 * 3_600_000);
    return player;
  }

  const claim = () => ({
    idempotencyKey: key('claim'),
    rewardCode: 'free_kit',
    deviceId: `device-${key('d')}`,
    clientNonce: `nonce-${key('n')}`,
  });

  it('grants it once, no matter how simultaneous the two taps are', async () => {
    const player = await playerWhoDeservesAKit();

    // Two devices, two different idempotency keys: nothing upstream of the
    // repository can collapse these into one operation.
    const responses = await Promise.all([
      api.request('/v1/rewards/claims', { method: 'POST', token: player.token, body: claim() }),
      api.request('/v1/rewards/claims', { method: 'POST', token: player.token, body: claim() }),
    ]);

    const granted = responses.filter((r) => r.status === 201);
    expect(granted).toHaveLength(1);
    const refused = responses.filter((r) => r.status !== 201);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.body.error.code).toBe('reward_already_claimed');

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    expect(grants.body.items.filter((g: any) => g.rewardCode === 'free_kit')).toHaveLength(1);
  });

  it('holds the line across five simultaneous attempts', async () => {
    const player = await playerWhoDeservesAKit();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.request('/v1/rewards/claims', { method: 'POST', token: player.token, body: claim() }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    for (const response of responses.filter((r) => r.status !== 201)) {
      // Refused for a reason a player can act on: already claimed, or slow down.
      expect(['reward_already_claimed', 'rate_limited']).toContain(response.body.error.code);
    }

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    expect(grants.body.items.filter((g: any) => g.rewardCode === 'free_kit')).toHaveLength(1);
  });
});

describePostgres('authority hand-off under contention', () => {
  async function fireside() {
    const owner = await bootstrap(api, 'Owner');
    const guest = await bootstrap(api, 'Guest');
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv'), grantsRole: 'guest' },
    });
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: guest.token,
      body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: invite.body.invite.campCode } },
    });
    const session = await api.request(`/v1/campsites/${campsite.id}/sessions`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('ses') },
    });
    await api.request(`/v1/sessions/${session.body.id}/join`, { method: 'POST', token: owner.token });
    await api.request(`/v1/sessions/${session.body.id}/join`, { method: 'POST', token: guest.token });
    return { owner, guest, sessionId: session.body.id as string };
  }

  const grab = (accountId: string, expectedSequence: number) => ({
    objectId: 'obj_skewer_1',
    objectKind: 'skewer' as const,
    toAccountId: accountId,
    reason: 'grab' as const,
    expectedSequence,
  });

  it('lets exactly one of two simultaneous grabs win, and bumps the fence once', async () => {
    const { owner, guest, sessionId } = await fireside();

    const responses = await Promise.all([
      api.request(`/v1/sessions/${sessionId}/authority`, {
        method: 'POST',
        token: owner.token,
        body: grab(owner.accountId, 0),
      }),
      api.request(`/v1/sessions/${sessionId}/authority`, {
        method: 'POST',
        token: guest.token,
        body: grab(guest.accountId, 0),
      }),
    ]);

    const winners = responses.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(responses.filter((r) => r.status !== 200)).toHaveLength(1);

    // Whoever lost, the object moved forward exactly one step and has exactly
    // one holder — not two clients each convinced they are simulating it.
    const listed = await api.request(`/v1/sessions/${sessionId}/authority`, { token: owner.token });
    const record = listed.body.items.find((r: any) => r.objectId === 'obj_skewer_1');
    expect(record.sequence).toBe(1);
    expect([owner.accountId, guest.accountId]).toContain(record.holderAccountId);
    expect(record.holderAccountId).toBe(winners[0]?.body.record.holderAccountId);
  });

  it('refuses a stale fencing sequence even when it arrives in the same instant', async () => {
    const { owner, guest, sessionId } = await fireside();

    const first = await api.request(`/v1/sessions/${sessionId}/authority`, {
      method: 'POST',
      token: owner.token,
      body: grab(owner.accountId, 0),
    });
    expect(first.status).toBe(200);

    // Both of these believe the fence is still at 1.
    const responses = await Promise.all([
      api.request(`/v1/sessions/${sessionId}/authority`, {
        method: 'POST',
        token: owner.token,
        body: { ...grab(guest.accountId, 1), reason: 'give' },
      }),
      api.request(`/v1/sessions/${sessionId}/authority`, {
        method: 'POST',
        token: owner.token,
        body: { ...grab(guest.accountId, 1), reason: 'give' },
      }),
    ]);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const listed = await api.request(`/v1/sessions/${sessionId}/authority`, { token: owner.token });
    const record = listed.body.items.find((r: any) => r.objectId === 'obj_skewer_1');
    expect(record.sequence).toBe(2);
    expect(record.holderAccountId).toBe(guest.accountId);
  });
});

describePostgres('concurrent read-modify-write on one aggregate', () => {
  it('does not lose a write when two updates land together', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const traceIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api
          .request(`/v1/campsites/${campsite.id}/traces`, {
            method: 'POST',
            token: player.token,
            body: {
              idempotencyKey: key('trace'),
              kind: 'carving',
              position: { x: i, y: 0, z: 0 },
              intensity: 0.9,
              decayRatePerHour: 0.01,
            },
          })
          .then((r) => r.body.id as string),
      ),
    );
    expect(new Set(traceIds).size).toBe(8);

    // Eight witnesses arriving at once, each a read-modify-write of the same
    // trace document. Without `SELECT … FOR UPDATE` most of them vanish.
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('inv'), grantsRole: 'guest', maxUses: 20 },
    });
    const witnesses = await Promise.all(Array.from({ length: 8 }, () => bootstrap(api, 'Witness')));
    const target = traceIds[0] as string;
    for (const witness of witnesses) {
      const joined = await api.request('/v1/campsites/join', {
        method: 'POST',
        token: witness.token,
        body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: invite.body.invite.campCode } },
      });
      expect(joined.status).toBe(200);
    }

    await Promise.all(
      witnesses.map((witness) =>
        api.request(`/v1/campsites/${campsite.id}/traces/${target}/witness`, {
          method: 'POST',
          token: witness.token,
        }),
      ),
    );

    const world = await api.request(`/v1/campsites/${campsite.id}/world`, { token: player.token });
    const trace = world.body.traces.find((t: any) => t.id === target);
    // The author plus every witness that joined — nobody's write was clobbered.
    const expected = new Set([player.accountId, ...witnesses.map((w) => w.accountId)]);
    expect(new Set(trace.witnessAccountIds)).toEqual(expected);
  });
});

describePostgres('migrations', () => {
  it('is a no-op the second time, and every time after', async () => {
    const database = api.app.database;
    expect(database).not.toBeNull();
    if (database === null) return;

    const onDisk = await loadMigrations();
    const first = await migrate(database.pool);
    expect(first.applied).toHaveLength(0);
    expect(first.skipped).toHaveLength(onDisk.length);
    expect(first.currentVersion).toBe(Math.max(...onDisk.map((m) => m.version)));

    const second = await migrate(database.pool);
    expect(second.applied).toHaveLength(0);

    const ledger = await database.pool.withClient((client) => listApplied(client));
    expect(ledger).toHaveLength(onDisk.length);
    for (const row of ledger) {
      const match = onDisk.find((m) => m.version === row.version);
      expect(match?.checksum).toBe(row.checksum);
      expect(row.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('survives being applied concurrently by several booting instances', async () => {
    const database = api.app.database;
    if (database === null) return;
    const results = await Promise.all(Array.from({ length: 4 }, () => migrate(database.pool)));
    for (const result of results) expect(result.applied).toHaveLength(0);

    const ledger = await database.pool.withClient((client) => listApplied(client));
    expect(new Set(ledger.map((row) => row.version)).size).toBe(ledger.length);
  });

  it('leaves data alone when it re-runs', async () => {
    const database = api.app.database;
    if (database === null) return;

    const player = await bootstrap(api, 'Persistent');
    const campsite = await createCampsite(api, player, { name: 'Survives Migration' });

    await migrate(database.pool);

    const after = await api.request(`/v1/campsites/${campsite.id}`, { token: player.token });
    expect(after.status).toBe(200);
    expect(after.body.name).toBe('Survives Migration');
  });

  it('refuses to run when an applied migration has been edited underneath it', async () => {
    const database = api.app.database;
    if (database === null) return;

    await database.pool.query(
      `UPDATE somemore.schema_migrations SET checksum = 'tampered' WHERE version = 1`,
    );
    await expect(migrate(database.pool)).rejects.toThrow(/has changed since it was applied/);

    // Put it back so the rest of the file still has a usable database.
    const onDisk = await loadMigrations();
    const first = onDisk.find((m) => m.version === 1);
    await database.pool.query(`UPDATE somemore.schema_migrations SET checksum = $1 WHERE version = 1`, [
      first?.checksum ?? '',
    ]);
    await expect(migrate(database.pool)).resolves.toMatchObject({ applied: [] });
  });

  it('refuses a database that is ahead of this checkout', async () => {
    const database = api.app.database;
    if (database === null) return;

    await database.pool.query(
      `INSERT INTO somemore.schema_migrations (version, name, checksum) VALUES (9999, 'from_the_future', 'x')`,
    );
    await expect(migrate(database.pool)).rejects.toThrow(/older than the database/);
    await database.pool.query(`DELETE FROM somemore.schema_migrations WHERE version = 9999`);
  });
});

describePostgres('the pool', () => {
  it('serves far more concurrent work than it has connections', async () => {
    const database = api.app.database;
    if (database === null) return;

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => database.pool.maybeOne<{ n: number }>('SELECT $1::int AS n', [i])),
    );
    expect(results.map((r) => r?.n)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(database.pool.stats.total).toBeLessThanOrEqual(database.pool.config.maxConnections);
    expect(database.pool.stats.leased).toBe(0);
  });

  it('rolls a transaction back without poisoning the connection', async () => {
    const database = api.app.database;
    if (database === null) return;

    await expect(
      database.pool.transaction(async (client) => {
        await client.query('CREATE TEMP TABLE rollback_probe (id int)');
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const after = await database.pool.maybeOne<{ ok: number }>('SELECT 1 AS ok');
    expect(after?.ok).toBe(1);
  });

  it('reports reachability at /health without leaking where the database is', async () => {
    const response = await api.request('/health');
    expect(response.status).toBe(200);
    expect(response.body.persistence).toBe('postgres');
    expect(response.body.database.reachable).toBe(true);
    expect(response.body.database.error).toBeNull();
    expect(response.body.database.pool.total).toBeGreaterThan(0);

    const serialized = JSON.stringify(response.body);
    for (const secret of ['postgres://', '5433', 'password', 'somemore_test', '127.0.0.1']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describePostgres('durability', () => {
  it('keeps everything across a full restart of the API process', async () => {
    const player = await bootstrap(api, 'Remembered');
    const campsite = await createCampsite(api, player, { name: 'Still Here' });
    await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });

    // A new server on the same database: the process restarted, the world did
    // not. This is the whole point of the exercise.
    const restarted = await startTestApi({}, { resetDatabase: false });
    try {
      const me = await restarted.request('/v1/auth/me', { token: player.token });
      expect(me.status).toBe(200);
      expect(me.body.account.id).toBe(player.accountId);

      const sandwiches = await restarted.request('/v1/sandwiches', { token: player.token });
      expect(sandwiches.body.items).toHaveLength(1);

      const campsites = await restarted.request('/v1/campsites', { token: player.token });
      expect(campsites.body.items.map((c: any) => c.name)).toEqual(['Still Here']);
    } finally {
      await restarted.close();
    }
  });

  it('truncation is what resets a test, not a restart', async () => {
    const database = api.app.database;
    if (database === null) return;
    await bootstrap(api);
    expect(await api.app.repos.accounts.count()).toBeGreaterThan(0);
    await truncateData(database.pool);
    expect(await api.app.repos.accounts.count()).toBe(0);
  });
});
