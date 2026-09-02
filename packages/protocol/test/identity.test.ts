import { describe, expect, it } from 'vitest';
import {
  AccountSchema,
  IdentitySchema,
  LinkCredentialSchema,
  LinkIdentityOutcomeSchema,
  LinkIdentityRequestSchema,
  MagicLinkRequestSchema,
  MergePolicySchema,
  MergeReportSchema,
  AnonymousBootstrapRequestSchema,
} from '../src/index.js';
import { NOW } from './fixtures.js';

describe('anonymous bootstrap', () => {
  it('accepts a device bootstrap', () => {
    const parsed = AnonymousBootstrapRequestSchema.parse({
      device: { deviceId: 'device-abc-123456', platform: 'ios', appVersion: '0.3.0', locale: 'en-US' },
    });
    expect(parsed.device.platform).toBe('ios');
  });

  it('rejects a short device id, an unknown platform and a bad app version', () => {
    expect(
      AnonymousBootstrapRequestSchema.safeParse({ device: { deviceId: 'abc', platform: 'ios', appVersion: '0.3.0' } })
        .success,
    ).toBe(false);
    expect(
      AnonymousBootstrapRequestSchema.safeParse({
        device: { deviceId: 'device-abc-123456', platform: 'nintendo', appVersion: '0.3.0' },
      }).success,
    ).toBe(false);
    expect(
      AnonymousBootstrapRequestSchema.safeParse({
        device: { deviceId: 'device-abc-123456', platform: 'ios', appVersion: 'v3' },
      }).success,
    ).toBe(false);
  });
});

describe('identities and accounts', () => {
  it('accepts an anonymous identity with null email', () => {
    const identity = IdentitySchema.parse({
      id: 'idn_1',
      accountId: 'acct_1',
      provider: 'anonymous',
      subject: 'device-abc-123456',
      createdAt: NOW,
      lastAuthenticatedAt: NOW,
    });
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('rejects an unknown provider and a malformed email', () => {
    expect(
      IdentitySchema.safeParse({
        id: 'idn_1',
        accountId: 'acct_1',
        provider: 'facebook',
        subject: 'x',
        createdAt: NOW,
        lastAuthenticatedAt: NOW,
      }).success,
    ).toBe(false);
    expect(
      IdentitySchema.safeParse({
        id: 'idn_1',
        accountId: 'acct_1',
        provider: 'email',
        subject: 'x',
        email: 'not-an-email',
        createdAt: NOW,
        lastAuthenticatedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('rejects an account with an unknown status', () => {
    expect(
      AccountSchema.safeParse({
        id: 'acct_1',
        status: 'vibing',
        createdAt: NOW,
        updatedAt: NOW,
        anonymous: true,
        schemaVersion: '1.0.0',
      }).success,
    ).toBe(false);
  });
});

describe('link credentials', () => {
  it('discriminates on provider', () => {
    expect(
      LinkCredentialSchema.safeParse({ provider: 'apple', identityToken: 'tok_abcdefgh', nonce: 'nonce-1234' })
        .success,
    ).toBe(true);
    expect(
      LinkCredentialSchema.safeParse({ provider: 'google', idToken: 'tok_abcdefgh', nonce: 'nonce-1234' }).success,
    ).toBe(true);
    expect(LinkCredentialSchema.safeParse({ provider: 'email', magicLinkToken: 'mlt_abcdefgh' }).success).toBe(true);
  });

  it('rejects a credential that mixes providers or omits its token', () => {
    expect(
      LinkCredentialSchema.safeParse({ provider: 'apple', idToken: 'tok_abcdefgh', nonce: 'nonce-1234' }).success,
    ).toBe(false);
    expect(LinkCredentialSchema.safeParse({ provider: 'email' }).success).toBe(false);
    expect(LinkCredentialSchema.safeParse({ provider: 'anonymous', subject: 'x' }).success).toBe(false);
  });

  it('never accepts a password', () => {
    const parsed = LinkCredentialSchema.parse({
      provider: 'email',
      magicLinkToken: 'mlt_abcdefgh',
      password: 'hunter2',
    });
    expect('password' in parsed).toBe(false);
  });
});

describe('link request and merge policy', () => {
  it('defaults the merge policy to abort and requires an idempotency key', () => {
    const parsed = LinkIdentityRequestSchema.parse({
      idempotencyKey: 'link-0001-abcd',
      credential: { provider: 'email', magicLinkToken: 'mlt_abcdefgh' },
    });
    expect(parsed.mergePolicy).toBe('abort');
    expect(
      LinkIdentityRequestSchema.safeParse({
        credential: { provider: 'email', magicLinkToken: 'mlt_abcdefgh' },
      }).success,
    ).toBe(false);
  });

  it('enumerates exactly the three non-destructive merge policies', () => {
    expect(MergePolicySchema.options).toEqual(['abort', 'keep_current', 'keep_existing']);
    expect(MergePolicySchema.safeParse('discard_other').success).toBe(false);
  });
});

describe('link outcomes', () => {
  const preview = {
    current: { sandwiches: 3, stamps: 2, campsites: 1 },
    existing: { sandwiches: 40, stamps: 19, campsites: 4 },
  };

  it('models the conflict branch with both sides and the retry policies', () => {
    const outcome = LinkIdentityOutcomeSchema.parse({
      status: 'conflict',
      conflict: 'identity_owned_by_other_account',
      currentAccountId: 'acct_new',
      existingAccountId: 'acct_old',
      resolutions: ['keep_existing', 'keep_current'],
      preview,
    });
    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.preview.existing.sandwiches).toBe(40);
  });

  it('rejects an unknown conflict kind and an unknown status', () => {
    expect(
      LinkIdentityOutcomeSchema.safeParse({
        status: 'conflict',
        conflict: 'vibes_mismatch',
        currentAccountId: 'a',
        existingAccountId: 'b',
        resolutions: [],
        preview,
      }).success,
    ).toBe(false);
    expect(LinkIdentityOutcomeSchema.safeParse({ status: 'exploded' }).success).toBe(false);
  });

  it('requires a full merge report on the merged branch', () => {
    const report = {
      survivingAccountId: 'acct_old',
      mergedAccountId: 'acct_new',
      moved: {
        identities: 1,
        stamps: 2,
        photos: 5,
        sandwiches: 3,
        notes: 1,
        patches: 0,
        ticketStubs: 0,
        discoveries: 2,
        visitedCampsites: 1,
        campsites: 1,
        rewardGrants: 2,
        orders: 0,
      },
      resolutions: [{ field: 'displayName', kept: 'existing' as const }],
      mergedAt: NOW,
    };
    expect(MergeReportSchema.safeParse(report).success).toBe(true);
    const missing = { ...report, moved: { ...report.moved, orders: undefined } };
    expect(MergeReportSchema.safeParse(missing).success).toBe(false);
    expect(MergeReportSchema.safeParse({ ...report, moved: { ...report.moved, stamps: -1 } }).success).toBe(false);
  });
});

describe('magic link', () => {
  it('requires a real email and an app-relative redirect', () => {
    expect(
      MagicLinkRequestSchema.safeParse({ idempotencyKey: 'ml-0001-abcd', email: 'rowan@example.com' }).success,
    ).toBe(true);
    expect(
      MagicLinkRequestSchema.safeParse({ idempotencyKey: 'ml-0001-abcd', email: 'rowan[at]example' }).success,
    ).toBe(false);
    expect(
      MagicLinkRequestSchema.safeParse({
        idempotencyKey: 'ml-0001-abcd',
        email: 'rowan@example.com',
        redirectPath: 'https://evil.example.com',
      }).success,
    ).toBe(false);
  });
});
