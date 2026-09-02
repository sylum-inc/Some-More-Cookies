import { describe, expect, it } from 'vitest';
import {
  AccessibilitySettingsSchema,
  CampfirePassportSchema,
  CreateNoteRequestSchema,
  HandleSchema,
  PassportSettingsSchema,
  PhotoRefSchema,
  RegisterPhotoRequestSchema,
  StampSchema,
  UpdatePassportRequestSchema,
} from '../src/index.js';
import { NOW } from './fixtures.js';

const basePassport = {
  accountId: 'acct_1',
  displayName: 'Rowan',
  issuedAt: NOW,
  updatedAt: NOW,
  revision: 0,
  schemaVersion: '1.0.0',
  settings: PassportSettingsSchema.parse({}),
  stats: {
    marshmallowsRoasted: 0,
    marshmallowsIgnited: 0,
    sandwichesMade: 0,
    sandwichesEaten: 0,
    perfectRoasts: 0,
    machineRuns: 0,
    photosTaken: 0,
    campfireMinutes: 0,
    points: 0,
  },
};

describe('passport settings', () => {
  it('fills in accessibility defaults', () => {
    const settings = PassportSettingsSchema.parse({});
    expect(settings.accessibility.textScale).toBe(1);
    expect(settings.accessibility.colorVisionMode).toBe('none');
    expect(settings.accessibility.captionsEnabled).toBe(true);
  });

  it('defaults campsites and photos to private', () => {
    const settings = PassportSettingsSchema.parse({});
    expect(settings.defaultCampsitePrivacy).toBe('private');
    expect(settings.defaultPhotoVisibility).toBe('private');
    expect(settings.showOnLeaderboards).toBe(false);
    expect(settings.marketingEmailOptIn).toBe(false);
  });

  it('rejects out-of-range accessibility values', () => {
    expect(AccessibilitySettingsSchema.safeParse({ textScale: 4 }).success).toBe(false);
    expect(AccessibilitySettingsSchema.safeParse({ hapticsIntensity: 1.5 }).success).toBe(false);
    expect(AccessibilitySettingsSchema.safeParse({ colorVisionMode: 'sepia' }).success).toBe(false);
    expect(AccessibilitySettingsSchema.safeParse({ aimAssist: 'aimbot' }).success).toBe(false);
  });
});

describe('handles', () => {
  it('accepts lowercase handles and rejects the rest', () => {
    expect(HandleSchema.safeParse('rowan_ash').success).toBe(true);
    expect(HandleSchema.safeParse('Rowan').success).toBe(false);
    expect(HandleSchema.safeParse('ab').success).toBe(false);
    expect(HandleSchema.safeParse('_leading').success).toBe(false);
    expect(HandleSchema.safeParse('trailing_').success).toBe(false);
  });
});

describe('campfire passport', () => {
  it('parses a fresh passport with empty collections', () => {
    const passport = CampfirePassportSchema.parse(basePassport);
    expect(passport.stamps).toEqual([]);
    expect(passport.photos).toEqual([]);
    expect(passport.sandwichIds).toEqual([]);
    expect(passport.handle).toBeNull();
  });

  it('rejects a passport with a bad revision or missing display name', () => {
    expect(CampfirePassportSchema.safeParse({ ...basePassport, revision: -1 }).success).toBe(false);
    expect(CampfirePassportSchema.safeParse({ ...basePassport, displayName: '' }).success).toBe(false);
    expect(CampfirePassportSchema.safeParse({ ...basePassport, schemaVersion: 'one' }).success).toBe(false);
  });

  it('carries stamps, notes, patches, stubs and discoveries', () => {
    const passport = CampfirePassportSchema.parse({
      ...basePassport,
      stamps: [{ id: 'stp_1', code: 'first_roast', name: 'First Roast', earnedAt: NOW }],
      notes: [{ id: 'not_1', body: 'the fire hissed', createdAt: NOW, updatedAt: NOW }],
      patches: [{ id: 'pat_1', code: 'golden_brown', name: 'Golden Brown', earnedAt: NOW }],
      ticketStubs: [{ id: 'tkt_1', code: 'ABC123', eventName: 'Opening Night', issuedAt: NOW }],
      discoveries: [{ id: 'dsc_1', code: 'ash_ring', kind: 'landmark', name: 'Ash Ring', discoveredAt: NOW }],
      visitedCampsites: [
        { campsiteId: 'cmp_1', environmentId: 'pine_hollow', firstVisitedAt: NOW, lastVisitedAt: NOW, visitCount: 1 },
      ],
    });
    expect(passport.stamps[0]?.count).toBe(1);
    expect(passport.patches[0]?.equipped).toBe(false);
    expect(passport.discoveries[0]?.firstFinder).toBe(false);
  });

  it('rejects a stamp code that is not a slug and an over-long note', () => {
    expect(StampSchema.safeParse({ id: 's', code: 'First Roast', name: 'x', earnedAt: NOW }).success).toBe(false);
    expect(
      CampfirePassportSchema.safeParse({
        ...basePassport,
        notes: [{ id: 'not_1', body: 'x'.repeat(2001), createdAt: NOW, updatedAt: NOW }],
      }).success,
    ).toBe(false);
  });
});

describe('photos', () => {
  it('stores object-storage keys, never blobs', () => {
    const photo = PhotoRefSchema.parse({
      id: 'pho_1',
      ownerAccountId: 'acct_1',
      storageKey: 'campsites/cmp_1/photos/abc.jpg',
      contentType: 'image/jpeg',
      width: 1920,
      height: 1080,
      byteSize: 480_000,
      capturedAt: NOW,
      createdAt: NOW,
    });
    expect(photo.visibility).toBe('private');
    expect(photo.thumbnailKey).toBeNull();
    expect(Object.keys(photo)).not.toContain('data');
  });

  it('rejects traversal, absolute keys and impossible dimensions', () => {
    const base = {
      id: 'pho_1',
      ownerAccountId: 'acct_1',
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
      byteSize: 10,
      capturedAt: NOW,
      createdAt: NOW,
    };
    expect(PhotoRefSchema.safeParse({ ...base, storageKey: '../secrets/key' }).success).toBe(false);
    expect(PhotoRefSchema.safeParse({ ...base, storageKey: '/absolute/key.jpg' }).success).toBe(false);
    expect(PhotoRefSchema.safeParse({ ...base, storageKey: 'ok/key.jpg', width: 0 }).success).toBe(false);
    expect(PhotoRefSchema.safeParse({ ...base, storageKey: 'ok/key.gif', contentType: 'image/gif' }).success).toBe(
      false,
    );
  });

  it('omits server-owned fields from the register request', () => {
    const shape = Object.keys(RegisterPhotoRequestSchema.shape);
    expect(shape).not.toContain('id');
    expect(shape).not.toContain('ownerAccountId');
    expect(shape).toContain('storageKey');
  });
});

describe('passport writes', () => {
  it('allows a partial settings patch with an expected revision', () => {
    const parsed = UpdatePassportRequestSchema.parse({
      displayName: 'Rowan A.',
      settings: { accessibility: { reducedMotion: true, textScale: 1.25 } },
      expectedRevision: 3,
    });
    expect(parsed.settings?.accessibility?.reducedMotion).toBe(true);
  });

  it('rejects an invalid handle or negative expected revision', () => {
    expect(UpdatePassportRequestSchema.safeParse({ handle: 'NO' }).success).toBe(false);
    expect(UpdatePassportRequestSchema.safeParse({ expectedRevision: -2 }).success).toBe(false);
  });

  it('requires an idempotency key for note creation', () => {
    expect(CreateNoteRequestSchema.safeParse({ body: 'hello' }).success).toBe(false);
    expect(CreateNoteRequestSchema.safeParse({ idempotencyKey: 'note-0001', body: 'hello' }).success).toBe(true);
  });
});
