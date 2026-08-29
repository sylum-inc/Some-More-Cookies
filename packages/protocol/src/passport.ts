import { z } from 'zod';
import {
  IdSchema,
  LocaleSchema,
  NonNegativeIntSchema,
  SemVerSchema,
  TimestampSchema,
  withIdempotency,
} from './common.js';
import { PhotoRefSchema } from './media.js';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const ColorVisionModeValues = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export const ColorVisionModeSchema = z.enum(ColorVisionModeValues);

/**
 * Accessibility is a first-class part of the passport, not an afterthought:
 * these travel with the player to every device the moment they sign in.
 */
export const AccessibilitySettingsSchema = z.object({
  reducedMotion: z.boolean().default(false),
  reducedFlicker: z.boolean().default(false),
  highContrastUi: z.boolean().default(false),
  textScale: z.number().min(0.75).max(2).default(1),
  captionsEnabled: z.boolean().default(true),
  captionSize: z.enum(['small', 'medium', 'large']).default('medium'),
  monoAudio: z.boolean().default(false),
  audioDescription: z.boolean().default(false),
  hapticsEnabled: z.boolean().default(true),
  hapticsIntensity: z.number().min(0).max(1).default(0.7),
  colorVisionMode: ColorVisionModeSchema.default('none'),
  /** Replaces "hold to roast" with a single press + auto-hold. */
  holdToPressAssist: z.boolean().default(false),
  /** Snaps the marshmallow to a good roasting distance for tremor/low-dexterity. */
  aimAssist: z.enum(['off', 'light', 'strong']).default('off'),
  /** Caps the amount of continuous stick-rotation the roast asks for. */
  simplifiedRoastControls: z.boolean().default(false),
  screenReaderVerbosity: z.enum(['terse', 'normal', 'verbose']).default('normal'),
});
export type AccessibilitySettings = z.infer<typeof AccessibilitySettingsSchema>;

export const PassportSettingsSchema = z.object({
  locale: LocaleSchema.default('en-US'),
  units: z.enum(['metric', 'imperial']).default('imperial'),
  /** Default privacy applied to newly created campsites. Private by default. */
  defaultCampsitePrivacy: z.enum(['private', 'invite_only', 'friends', 'public']).default('private'),
  defaultPhotoVisibility: z.enum(['private', 'campsite', 'link', 'public']).default('private'),
  allowFriendInvites: z.boolean().default(true),
  showOnLeaderboards: z.boolean().default(false),
  marketingEmailOptIn: z.boolean().default(false),
  pushNotifications: z
    .object({
      campsiteInvites: z.boolean().default(true),
      orderUpdates: z.boolean().default(true),
      seasonalEvents: z.boolean().default(false),
    })
    .prefault({}),
  accessibility: AccessibilitySettingsSchema.prefault({}),
});
export type PassportSettings = z.infer<typeof PassportSettingsSchema>;

/* -------------------------------------------------------------------------- */
/* Passport collections                                                        */
/* -------------------------------------------------------------------------- */

export const RarityValues = ['common', 'uncommon', 'rare', 'legendary'] as const;
export const RaritySchema = z.enum(RarityValues);
export type Rarity = z.infer<typeof RaritySchema>;

/** Ink stamp pressed into the passport for a milestone. */
export const StampSchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(80),
  description: z.string().max(240).default(''),
  rarity: RaritySchema.default('common'),
  earnedAt: TimestampSchema,
  campsiteId: IdSchema.nullable().default(null),
  /** Stamps can be earned more than once; the passport shows a little tally. */
  count: z.number().int().min(1).default(1),
});
export type Stamp = z.infer<typeof StampSchema>;

/** A scribbled note. Player-authored text, moderated like any other UGC. */
export const NoteSchema = z.object({
  id: IdSchema,
  body: z.string().min(1).max(2000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  pinned: z.boolean().default(false),
  campsiteId: IdSchema.nullable().default(null),
  sandwichId: IdSchema.nullable().default(null),
});
export type Note = z.infer<typeof NoteSchema>;

/** Iron-on patch — cosmetic, equippable onto the passport cover. */
export const PatchSchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(80),
  rarity: RaritySchema.default('common'),
  earnedAt: TimestampSchema,
  slot: z.enum(['cover', 'spine', 'inside_front', 'inside_back']).default('cover'),
  equipped: z.boolean().default(false),
});
export type Patch = z.infer<typeof PatchSchema>;

/** Torn ticket stub — proof of attending an event or redeeming a perk. */
export const TicketStubSchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64),
  eventName: z.string().min(1).max(120),
  venue: z.string().max(120).nullable().default(null),
  issuedAt: TimestampSchema,
  admittedAt: TimestampSchema.nullable().default(null),
  orderId: IdSchema.nullable().default(null),
  rewardGrantId: IdSchema.nullable().default(null),
});
export type TicketStub = z.infer<typeof TicketStubSchema>;

export const DiscoveryKindValues = ['landmark', 'recipe', 'critter', 'lore', 'quirk', 'constellation'] as const;
export const DiscoveryKindSchema = z.enum(DiscoveryKindValues);

/** Something the player found in the world and the world now remembers. */
export const DiscoverySchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  kind: DiscoveryKindSchema,
  name: z.string().min(1).max(80),
  discoveredAt: TimestampSchema,
  campsiteId: IdSchema.nullable().default(null),
  /** True when this player was the first on the server to find it. */
  firstFinder: z.boolean().default(false),
});
export type Discovery = z.infer<typeof DiscoverySchema>;

export const VisitedCampsiteSchema = z.object({
  campsiteId: IdSchema,
  environmentId: z.string().min(1).max(64),
  firstVisitedAt: TimestampSchema,
  lastVisitedAt: TimestampSchema,
  visitCount: z.number().int().min(1),
  nickname: z.string().max(60).nullable().default(null),
});
export type VisitedCampsite = z.infer<typeof VisitedCampsiteSchema>;

export const PassportStatsSchema = z.object({
  marshmallowsRoasted: NonNegativeIntSchema.default(0),
  marshmallowsIgnited: NonNegativeIntSchema.default(0),
  sandwichesMade: NonNegativeIntSchema.default(0),
  sandwichesEaten: NonNegativeIntSchema.default(0),
  perfectRoasts: NonNegativeIntSchema.default(0),
  machineRuns: NonNegativeIntSchema.default(0),
  photosTaken: NonNegativeIntSchema.default(0),
  campfireMinutes: NonNegativeIntSchema.default(0),
  points: NonNegativeIntSchema.default(0),
});
export type PassportStats = z.infer<typeof PassportStatsSchema>;

/* -------------------------------------------------------------------------- */
/* The passport                                                                */
/* -------------------------------------------------------------------------- */

/** Handles are lowercase, stable, and unique across the service. */
export const HandleSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9](?:[a-z0-9_]{1,22})[a-z0-9]$/, 'handles are lowercase alphanumeric with underscores');

export const CampfirePassportSchema = z.object({
  accountId: IdSchema,
  displayName: z.string().min(1).max(40),
  handle: HandleSchema.nullable().default(null),
  bio: z.string().max(280).default(''),
  avatarPhotoId: IdSchema.nullable().default(null),
  issuedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Optimistic-concurrency counter; PATCH may assert an expected version. */
  revision: NonNegativeIntSchema,
  schemaVersion: SemVerSchema,
  stamps: z.array(StampSchema).default([]),
  photos: z.array(PhotoRefSchema).default([]),
  /** Sandwich records live in their own collection; the passport indexes them. */
  sandwichIds: z.array(IdSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  patches: z.array(PatchSchema).default([]),
  ticketStubs: z.array(TicketStubSchema).default([]),
  discoveries: z.array(DiscoverySchema).default([]),
  visitedCampsites: z.array(VisitedCampsiteSchema).default([]),
  settings: PassportSettingsSchema,
  stats: PassportStatsSchema,
});
export type CampfirePassport = z.infer<typeof CampfirePassportSchema>;

/** Redacted view handed out when someone else looks at your passport. */
export const PublicPassportSchema = z.object({
  accountId: IdSchema,
  displayName: z.string().max(40),
  handle: HandleSchema.nullable(),
  bio: z.string().max(280),
  avatarPhotoId: IdSchema.nullable(),
  issuedAt: TimestampSchema,
  stamps: z.array(StampSchema),
  patches: z.array(PatchSchema),
  stats: PassportStatsSchema.pick({ sandwichesMade: true, perfectRoasts: true, campfireMinutes: true }),
});
export type PublicPassport = z.infer<typeof PublicPassportSchema>;

export const UpdatePassportRequestSchema = z.object({
  displayName: z.string().min(1).max(40).optional(),
  handle: HandleSchema.optional(),
  bio: z.string().max(280).optional(),
  avatarPhotoId: IdSchema.nullable().optional(),
  settings: PassportSettingsSchema.partial().optional(),
  /** When present the write fails with `precondition_failed` on a mismatch. */
  expectedRevision: NonNegativeIntSchema.optional(),
});
export type UpdatePassportRequest = z.infer<typeof UpdatePassportRequestSchema>;

export const CreateNoteRequestSchema = withIdempotency(
  z.object({
    body: z.string().min(1).max(2000),
    campsiteId: IdSchema.optional(),
    sandwichId: IdSchema.optional(),
    pinned: z.boolean().default(false),
  }),
);
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;
