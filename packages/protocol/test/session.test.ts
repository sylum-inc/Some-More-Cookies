import { describe, expect, it } from 'vitest';
import {
  AuthorityHandoffRequestSchema,
  AuthorityHandoffResultSchema,
  AuthorityRecordSchema,
  HeartbeatRequestSchema,
  JoinCampsiteRequestSchema,
  JoinMethodSchema,
  QR_JOIN_PREFIX,
  SESSION_TRANSITIONS,
  SessionSchema,
  authorityHandoffDenial,
  canTransitionSession,
  parseQrJoinPayload,
} from '../src/index.js';
import { NOW } from './fixtures.js';

describe('join methods', () => {
  it('accepts all three arrival routes', () => {
    expect(JoinMethodSchema.safeParse({ method: 'invite_link', token: 'tok_abcdefghijklmnop' }).success).toBe(true);
    expect(JoinMethodSchema.safeParse({ method: 'camp_code', code: 'K7QMR3' }).success).toBe(true);
    expect(
      JoinMethodSchema.safeParse({ method: 'qr', payload: `${QR_JOIN_PREFIX}tok_abcdefghijklmnop` }).success,
    ).toBe(true);
  });

  it('rejects a malformed camp code, a stubby token and an unknown method', () => {
    expect(JoinMethodSchema.safeParse({ method: 'camp_code', code: 'lower1' }).success).toBe(false);
    expect(JoinMethodSchema.safeParse({ method: 'invite_link', token: 'nope' }).success).toBe(false);
    expect(JoinMethodSchema.safeParse({ method: 'telepathy' }).success).toBe(false);
  });

  it('parses QR payloads and rejects foreign schemes', () => {
    expect(parseQrJoinPayload(`${QR_JOIN_PREFIX}tok_abcdefghijklmnop`)).toBe('tok_abcdefghijklmnop');
    expect(parseQrJoinPayload('https://evil.example/join?t=abc')).toBeNull();
    expect(parseQrJoinPayload(`${QR_JOIN_PREFIX}short`)).toBeNull();
  });

  it('requires an idempotency key to join', () => {
    expect(JoinCampsiteRequestSchema.safeParse({ join: { method: 'camp_code', code: 'K7QMR3' } }).success).toBe(false);
    expect(
      JoinCampsiteRequestSchema.safeParse({ idempotencyKey: 'join-0001', join: { method: 'camp_code', code: 'K7QMR3' } })
        .success,
    ).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('parses a session with defaults', () => {
    const session = SessionSchema.parse({
      id: 'ses_1',
      campsiteId: 'cmp_1',
      hostAccountId: 'acct_1',
      state: 'lobby',
      startedAt: NOW,
    });
    expect(session.maxMembers).toBe(8);
    expect(session.authorityEpoch).toBe(0);
    expect(session.presence).toEqual([]);
  });

  it('enforces the session state machine', () => {
    expect(canTransitionSession('lobby', 'active')).toBe(true);
    expect(canTransitionSession('active', 'ending')).toBe(true);
    expect(canTransitionSession('ending', 'ended')).toBe(true);
    expect(canTransitionSession('ended', 'active')).toBe(false);
    expect(canTransitionSession('lobby', 'ending')).toBe(false);
    expect(SESSION_TRANSITIONS.ended).toEqual([]);
  });

  it('bounds the member cap and validates heartbeats', () => {
    expect(
      SessionSchema.safeParse({ id: 's', campsiteId: 'c', hostAccountId: 'a', state: 'lobby', startedAt: NOW, maxMembers: 64 })
        .success,
    ).toBe(false);
    expect(HeartbeatRequestSchema.parse({}).connection).toBe('connected');
    expect(HeartbeatRequestSchema.safeParse({ activity: 'juggling' }).success).toBe(false);
  });
});

describe('authority hand-off', () => {
  const record = AuthorityRecordSchema.parse({
    sessionId: 'ses_1',
    objectId: 'obj_marsh_1',
    objectKind: 'marshmallow',
    holderAccountId: 'acct_a',
    grantedAt: NOW,
    sequence: 4,
  });

  const base = {
    record,
    requesterAccountId: 'acct_a',
    request: { expectedSequence: 4, reason: 'give' as const, toAccountId: 'acct_b' },
    requesterIsHost: false,
    requesterIsMember: true,
    targetIsPresent: true,
    sessionState: 'active' as const,
  };

  it('allows the holder to hand an object to a present member', () => {
    expect(authorityHandoffDenial(base)).toBeNull();
  });

  it('denies a stale fencing sequence', () => {
    expect(authorityHandoffDenial({ ...base, request: { ...base.request, expectedSequence: 3 } })).toBe(
      'sequence_stale',
    );
  });

  it('denies a non-holder, a non-member and an absent target', () => {
    expect(authorityHandoffDenial({ ...base, requesterAccountId: 'acct_c' })).toBe('not_holder');
    expect(authorityHandoffDenial({ ...base, requesterIsMember: false })).toBe('not_a_member');
    expect(authorityHandoffDenial({ ...base, targetIsPresent: false })).toBe('target_not_present');
  });

  it('denies grabbing a locked object unless the host overrides', () => {
    const locked = AuthorityRecordSchema.parse({ ...record, locked: true, holderAccountId: null });
    expect(authorityHandoffDenial({ ...base, record: locked, requesterAccountId: 'acct_b' })).toBe('object_locked');
    expect(
      authorityHandoffDenial({
        ...base,
        record: locked,
        requesterAccountId: 'acct_b',
        requesterIsHost: true,
        request: { ...base.request, reason: 'host_override' },
      }),
    ).toBeNull();
  });

  it('denies a host_override from a non-host and any hand-off in an ended session', () => {
    expect(authorityHandoffDenial({ ...base, request: { ...base.request, reason: 'host_override' } })).toBe(
      'not_holder',
    );
    expect(authorityHandoffDenial({ ...base, sessionState: 'ended' })).toBe('session_not_active');
  });

  it('models granted and denied results as a discriminated union', () => {
    expect(AuthorityHandoffResultSchema.safeParse({ status: 'granted', record }).success).toBe(true);
    expect(
      AuthorityHandoffResultSchema.safeParse({ status: 'denied', reason: 'sequence_stale', current: record }).success,
    ).toBe(true);
    expect(AuthorityHandoffResultSchema.safeParse({ status: 'denied', reason: 'vibes', current: record }).success).toBe(
      false,
    );
    expect(AuthorityHandoffRequestSchema.safeParse({ objectId: 'o', objectKind: 'marshmallow' }).success).toBe(false);
  });
});
