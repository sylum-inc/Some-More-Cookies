import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, sandwichPayload, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function playerWithASandwich(harness: TestHarness = api) {
  const player = await bootstrap(harness);
  const campsite = await createCampsite(harness, player);
  const made = await harness.request('/v1/sandwiches', {
    method: 'POST',
    token: player.token,
    body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
  });
  expect(made.status).toBe(201);
  return { player, campsite, sandwich: made.body };
}

function claimBody(rewardCode: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key('claim'),
    rewardCode,
    deviceId: `device-claim-${key('d')}`,
    clientNonce: `nonce-${key('n')}`,
    ...overrides,
  };
}

describe('the reward catalog and automatic grants', () => {
  it('lists the catalog', async () => {
    const player = await bootstrap(api);
    const response = await api.request('/v1/rewards', { token: player.token });
    expect(response.status).toBe(200);
    const codes = response.body.items.map((r: any) => r.code);
    expect(codes).toContain('first_roast');
    expect(codes).toContain('free_kit');
    expect(response.body.items.find((r: any) => r.code === 'free_kit').valueTier).toBe('high');
  });

  it('grants gameplay rewards when a sandwich is recorded, and only once', async () => {
    const { player } = await playerWithASandwich();

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    const codes = grants.body.items.map((g: any) => g.rewardCode).sort();
    expect(codes).toEqual(['first_roast', 'golden_brown']);
    expect(grants.body.items.every((g: any) => g.valueTier === 'standard')).toBe(true);

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.stamps.map((s: any) => s.code)).toEqual(['first_roast']);
    expect(passport.body.patches.map((p: any) => p.code)).toEqual(['golden_brown']);
    expect(passport.body.stats.points).toBe(35);

    // A second sandwich must not duplicate a one-per-account reward.
    const campsite = (await api.request('/v1/campsites', { token: player.token })).body.items[0];
    const full = await api.request(`/v1/campsites/${campsite.id}`, { token: player.token });
    await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, full.body.machine.serialNumber),
    });
    const after = await api.request('/v1/rewards/grants', { token: player.token });
    expect(after.body.items).toHaveLength(2);
    const stamps = (await api.request('/v1/passport', { token: player.token })).body.stamps;
    expect(stamps).toHaveLength(1);
    expect(stamps[0].count).toBe(1);
  });
});

describe('high-value claims', () => {
  it('sends a brand-new account to manual review, then grants once it settles', async () => {
    const { player } = await playerWithASandwich();

    const early = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_kit'),
    });
    expect(early.status).toBe(202);
    expect(early.body.status).toBe('pending_review');
    expect(early.body.claim.state).toBe('validating');
    expect(early.body.claim.antiAbuse.signals).toContain('account_too_young');
    expect(early.body.claim.antiAbuse.ipHash).toHaveLength(64);
    expect(early.body.claim.antiAbuse).not.toHaveProperty('ip');

    // A second attempt while a claim is open is refused: claim-once.
    const duplicate = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_kit'),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('reward_already_claimed');
  });

  it('grants a settled account its perk exactly once', async () => {
    const { player } = await playerWithASandwich();
    api.clock.advance(3 * 3_600_000);

    const claim = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_kit'),
    });
    expect(claim.status).toBe(201);
    expect(claim.body.status).toBe('granted');
    expect(claim.body.claim.state).toBe('fulfilled');
    expect(claim.body.claim.fulfillmentRef).toBe('SM-KIT-001-4');
    expect(claim.body.grant.valueTier).toBe('high');

    // Claim-once holds even with a brand new idempotency key and nonce.
    const second = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_kit'),
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('reward_already_claimed');
    expect(second.body.error.details.perAccountLimit).toBe(1);

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    expect(grants.body.items.filter((g: any) => g.rewardCode === 'free_kit')).toHaveLength(1);
  });

  it('rejects a claim whose prerequisites the server cannot verify', async () => {
    const player = await bootstrap(api);
    api.clock.advance(3 * 3_600_000);

    const response = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_kit'),
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
    expect(response.body.claim.state).toBe('rejected');
    expect(response.body.signals).toContain('prerequisites_unmet');
    expect(response.body.claim.rejectionReason).toMatch(/sandwiches_made/);

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    expect(grants.body.items.filter((g: any) => g.rewardCode === 'free_kit')).toHaveLength(0);
  });

  it('rejects a replayed client nonce from a different account', async () => {
    const first = await playerWithASandwich();
    const second = await playerWithASandwich();
    api.clock.advance(3 * 3_600_000);

    const nonce = `nonce-shared-${key('n')}`;
    const good = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: first.player.token,
      body: claimBody('free_kit', { clientNonce: nonce }),
    });
    expect(good.body.status).toBe('granted');

    const replayed = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: second.player.token,
      body: claimBody('free_kit', { clientNonce: nonce }),
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body.status).toBe('rejected');
    expect(replayed.body.signals).toContain('duplicate_client_nonce');
    expect(replayed.body.claim.antiAbuse.duplicateOfClaimId).toBe(good.body.claim.id);
  });

  it('rejects a perk whose prerequisite is a linked account until it is linked', async () => {
    const { player } = await playerWithASandwich();
    api.clock.advance(3 * 3_600_000);

    const unlinked = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('founders_ticket'),
    });
    expect(unlinked.body.status).toBe('rejected');
    expect(unlinked.body.signals).toContain('prerequisites_unmet');

    const magic = await api.request('/v1/auth/magic-link', {
      method: 'POST',
      body: { idempotencyKey: key('ml'), email: 'ticket@example.com' },
    });
    await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: magic.body.devToken } },
    });

    const linked = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('founders_ticket'),
    });
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('granted');

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.ticketStubs).toHaveLength(1);
    expect(passport.body.ticketStubs[0].code).toBe('ticket_opening_night');
  });

  it('404s an unknown reward code', async () => {
    const player = await bootstrap(api);
    const response = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: claimBody('free_yacht'),
    });
    expect(response.status).toBe(404);
  });
});

describe('claim rate limiting', () => {
  it('stops a burst of high-value claims', async () => {
    const limited = await startTestApi({ REWARD_CLAIMS_PER_WINDOW: '1' });
    try {
      const player = await bootstrap(limited);
      const campsite = await createCampsite(limited, player);
      await limited.request('/v1/sandwiches', {
        method: 'POST',
        token: player.token,
        body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
      });
      const magic = await limited.request('/v1/auth/magic-link', {
        method: 'POST',
        body: { idempotencyKey: key('ml'), email: 'burst@example.com' },
      });
      await limited.request('/v1/auth/link', {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: magic.body.devToken } },
      });
      limited.clock.advance(3 * 3_600_000);

      const first = await limited.request('/v1/rewards/claims', {
        method: 'POST',
        token: player.token,
        body: claimBody('free_kit'),
      });
      expect(first.body.status).toBe('granted');

      const second = await limited.request('/v1/rewards/claims', {
        method: 'POST',
        token: player.token,
        body: claimBody('founders_ticket'),
      });
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('rate_limited');
      expect(second.headers.get('retry-after')).not.toBeNull();
    } finally {
      await limited.close();
    }
  });
});
