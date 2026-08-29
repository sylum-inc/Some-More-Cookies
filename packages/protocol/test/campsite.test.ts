import { describe, expect, it } from 'vitest';
import {
  CampCodeSchema,
  CampsiteInviteSchema,
  CampsiteSchema,
  CreateCampsiteRequestSchema,
  DEFAULT_LANDMARK_PROMOTION_RULE,
  LandmarkSchema,
  MachineSerialSchema,
  MaintenanceEventSchema,
  MachineQuirkSchema,
  SM01Schema,
  TRACE_SWEEP_THRESHOLD,
  UpdateCampsiteRequestSchema,
  WorldTraceSchema,
  decayedIntensity,
  roleAtLeast,
} from '../src/index.js';
import { NOW, machine } from './fixtures.js';

const baseCampsite = {
  id: 'cmp_1',
  environmentId: 'pine_hollow',
  seed: 123456,
  ownerAccountId: 'acct_1',
  name: 'Rowan Hollow',
  campCode: 'K7QMR3',
  members: [{ accountId: 'acct_1', role: 'owner', joinedAt: NOW }],
  machine,
  createdAt: NOW,
  updatedAt: NOW,
  lastActiveAt: NOW,
  revision: 0,
  schemaVersion: '1.0.0',
};

describe('campsite', () => {
  it('is private by default and seeds an SM-01', () => {
    const campsite = CampsiteSchema.parse(baseCampsite);
    expect(campsite.privacy).toBe('private');
    expect(campsite.machine.model).toBe('SM-01');
    expect(campsite.traces).toEqual([]);
    expect(campsite.promotionRule).toEqual(DEFAULT_LANDMARK_PROMOTION_RULE);
  });

  it('rejects a bad seed, environment id or camp code', () => {
    expect(CampsiteSchema.safeParse({ ...baseCampsite, seed: -1 }).success).toBe(false);
    expect(CampsiteSchema.safeParse({ ...baseCampsite, seed: 2 ** 33 }).success).toBe(false);
    expect(CampsiteSchema.safeParse({ ...baseCampsite, environmentId: 'Pine Hollow' }).success).toBe(false);
    expect(CampsiteSchema.safeParse({ ...baseCampsite, campCode: 'ABC12' }).success).toBe(false);
    expect(CampsiteSchema.safeParse({ ...baseCampsite, campCode: 'ABCDIO' }).success).toBe(false);
  });

  it('defaults new campsites to private in the create request', () => {
    const req = CreateCampsiteRequestSchema.parse({ idempotencyKey: 'camp-0001', name: 'Fire #1' });
    expect(req.privacy).toBe('private');
    expect(req.environmentId).toBe('pine_hollow');
    expect(CreateCampsiteRequestSchema.safeParse({ name: 'Fire #1' }).success).toBe(false);
  });

  it('rejects an unknown privacy value on update', () => {
    expect(UpdateCampsiteRequestSchema.safeParse({ privacy: 'semi_public' }).success).toBe(false);
    expect(UpdateCampsiteRequestSchema.safeParse({ privacy: 'public' }).success).toBe(true);
  });

  it('ranks member roles', () => {
    expect(roleAtLeast('owner', 'cohost')).toBe(true);
    expect(roleAtLeast('guest', 'cohost')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('SM-01', () => {
  it('validates the serial number format', () => {
    expect(MachineSerialSchema.safeParse('SM01-4KQ2-9ZX7').success).toBe(true);
    expect(MachineSerialSchema.safeParse('SM01-4kq2-9ZX7').success).toBe(false);
    expect(MachineSerialSchema.safeParse('SM02-4KQ2-9ZX7').success).toBe(false);
    expect(CampCodeSchema.safeParse('K7QMR3').success).toBe(true);
  });

  it('bounds wear to the unit interval', () => {
    expect(SM01Schema.safeParse({ ...machine, wear: { ...machine.wear, drum: 1.2 } }).success).toBe(false);
    expect(SM01Schema.safeParse({ ...machine, wear: { ...machine.wear, drum: 1 } }).success).toBe(true);
  });

  it('records maintenance history and quirks', () => {
    const event = MaintenanceEventSchema.parse({
      id: 'mnt_1',
      kind: 'descale',
      at: NOW,
      performedBy: 'acct_1',
      component: 'chiller',
      wearBefore: 0.4,
      wearAfter: 0.1,
    });
    expect(event.notes).toBe('');
    const quirk = MachineQuirkSchema.parse({
      code: 'sings_at_dusk',
      name: 'Sings At Dusk',
      severity: 'charming',
      acquiredAt: NOW,
    });
    expect(quirk.effects.chillBiasSeconds).toBe(0);
    expect(MaintenanceEventSchema.safeParse({ ...event, kind: 'percussive_maintenance' }).success).toBe(false);
    expect(MachineQuirkSchema.safeParse({ ...quirk, severity: 'catastrophic' }).success).toBe(false);
  });
});

describe('world traces and landmarks', () => {
  const trace = {
    id: 'trc_1',
    campsiteId: 'cmp_1',
    kind: 'scorch',
    position: { x: 1, y: 0, z: -2 },
    createdBy: 'acct_1',
    createdAt: NOW,
    intensity: 1,
    decayRatePerHour: 0.1,
    lastDecayedAt: NOW,
  };

  it('accepts a trace and defaults its witness list', () => {
    const parsed = WorldTraceSchema.parse(trace);
    expect(parsed.witnessAccountIds).toEqual([]);
    expect(parsed.promotedLandmarkId).toBeNull();
  });

  it('rejects an unknown kind, a non-finite position and an out-of-range intensity', () => {
    expect(WorldTraceSchema.safeParse({ ...trace, kind: 'lava' }).success).toBe(false);
    expect(WorldTraceSchema.safeParse({ ...trace, position: { x: Infinity, y: 0, z: 0 } }).success).toBe(false);
    expect(WorldTraceSchema.safeParse({ ...trace, intensity: 1.5 }).success).toBe(false);
    expect(WorldTraceSchema.safeParse({ ...trace, decayRatePerHour: -1 }).success).toBe(false);
  });

  it('decays exponentially and is monotonic', () => {
    const oneHour = 3_600_000;
    expect(decayedIntensity(1, 0, oneHour)).toBe(1);
    expect(decayedIntensity(1, 0.1, 0)).toBe(1);
    const after1 = decayedIntensity(1, 0.1, oneHour);
    const after2 = decayedIntensity(1, 0.1, oneHour * 2);
    expect(after1).toBeCloseTo(Math.exp(-0.1), 6);
    expect(after2).toBeLessThan(after1);
    expect(decayedIntensity(1, 5, oneHour * 100)).toBe(0);
    expect(decayedIntensity(1, 0.1, oneHour * 200)).toBeLessThan(TRACE_SWEEP_THRESHOLD);
  });

  it('validates a landmark and its permanence', () => {
    const landmark = LandmarkSchema.parse({
      id: 'lmk_1',
      campsiteId: 'cmp_1',
      originTraceId: 'trc_1',
      name: 'The Ash Ring',
      kind: 'scorch',
      position: { x: 1, y: 0, z: -2 },
      promotedAt: NOW,
      promotedBy: 'acct_1',
    });
    expect(landmark.permanence).toBe('persistent');
    expect(landmark.citations).toBe(0);
    expect(LandmarkSchema.safeParse({ ...landmark, permanence: 'eternal' }).success).toBe(false);
  });
});

describe('invites', () => {
  it('never grants owner on redemption', () => {
    const invite = CampsiteInviteSchema.parse({
      id: 'inv_1',
      campsiteId: 'cmp_1',
      token: 'tok_abcdefghijklmnop',
      campCode: 'K7QMR3',
      createdBy: 'acct_1',
      createdAt: NOW,
      expiresAt: NOW,
    });
    expect(invite.grantsRole).toBe('guest');
    expect(CampsiteInviteSchema.safeParse({ ...invite, grantsRole: 'owner' }).success).toBe(false);
    expect(CampsiteInviteSchema.safeParse({ ...invite, token: 'short' }).success).toBe(false);
  });
});
