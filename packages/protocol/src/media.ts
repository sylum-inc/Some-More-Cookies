import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  TimestampSchema,
  withIdempotency,
} from './common.js';

/**
 * Photos are the memento currency of Some More. The protocol NEVER carries
 * image bytes: a photo is metadata plus an object-storage key. Clients upload
 * to a pre-signed URL and then register the resulting key here.
 */
export const ImageContentTypeValues = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const ImageContentTypeSchema = z.enum(ImageContentTypeValues);
export type ImageContentType = z.infer<typeof ImageContentTypeSchema>;

/** `campsites/<campsiteId>/photos/<uuid>.jpg` — bucket is server-side config. */
export const StorageKeySchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, 'storage keys are slash-delimited, no leading slash')
  .refine((k) => !k.includes('..'), 'storage keys may not traverse');

export const PhotoVisibilityValues = ['private', 'campsite', 'link', 'public'] as const;
export const PhotoVisibilitySchema = z.enum(PhotoVisibilityValues);
export type PhotoVisibility = z.infer<typeof PhotoVisibilitySchema>;

export const PhotoRefSchema = z.object({
  id: IdSchema,
  ownerAccountId: IdSchema,
  storageKey: StorageKeySchema,
  thumbnailKey: StorageKeySchema.nullable().default(null),
  contentType: ImageContentTypeSchema,
  width: PositiveIntSchema.max(16384),
  height: PositiveIntSchema.max(16384),
  byteSize: NonNegativeIntSchema.max(50 * 1024 * 1024),
  capturedAt: TimestampSchema,
  createdAt: TimestampSchema,
  campsiteId: IdSchema.nullable().default(null),
  sandwichId: IdSchema.nullable().default(null),
  caption: z.string().max(280).nullable().default(null),
  visibility: PhotoVisibilitySchema.default('private'),
  /** Free-form camera state so a shot can be re-framed in-world later. */
  cameraPreset: z.string().max(64).nullable().default(null),
});
export type PhotoRef = z.infer<typeof PhotoRefSchema>;

export const RegisterPhotoRequestSchema = PhotoRefSchema.omit({
  id: true,
  ownerAccountId: true,
  createdAt: true,
});
export type RegisterPhotoRequest = z.infer<typeof RegisterPhotoRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Uploading the bytes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which object store this deployment is actually pointed at.
 *
 * `local` is a real, working adapter that writes to a directory — it is what
 * makes the whole upload path exist and be testable without a bucket. `s3` is
 * the S3-compatible adapter, which reports `not_configured` without
 * credentials rather than pretending (see README "Blockers").
 */
export const MediaStorageProviderValues = ['local', 's3'] as const;
export const MediaStorageProviderSchema = z.enum(MediaStorageProviderValues);
export type MediaStorageProvider = z.infer<typeof MediaStorageProviderSchema>;

/**
 * Ask for somewhere to put a photo.
 *
 * The client declares what it is about to send; the service decides the key,
 * the ceiling and how long the offer stands. Nothing here is trusted at
 * upload time — the declared `contentType` is checked against the bytes'
 * own magic number, and `byteSize` against what actually arrives.
 */
export const RequestPhotoUploadRequestSchema = z.object({
  contentType: ImageContentTypeSchema,
  byteSize: PositiveIntSchema.max(50 * 1024 * 1024),
  width: PositiveIntSchema.max(16384),
  height: PositiveIntSchema.max(16384),
  capturedAt: TimestampSchema,
  campsiteId: IdSchema.nullable().default(null),
  sandwichId: IdSchema.nullable().default(null),
  caption: z.string().max(280).nullable().default(null),
  /**
   * Private unless somebody chose otherwise. A photo is not public because it
   * exists (spec §9); the default is the safest value the enum has, and the
   * server never widens it on the player's behalf.
   */
  visibility: PhotoVisibilitySchema.default('private'),
  cameraPreset: z.string().max(64).nullable().default(null),
});
export type RequestPhotoUploadRequest = z.infer<typeof RequestPhotoUploadRequestSchema>;

export const RequestPhotoUploadBodySchema = withIdempotency(RequestPhotoUploadRequestSchema);
export type RequestPhotoUploadBody = z.infer<typeof RequestPhotoUploadBodySchema>;

/**
 * An offer to accept some bytes.
 *
 * `uploadUrl` is where they go and `uploadToken` is what authorises them; with
 * an S3-shaped adapter both come from the provider's pre-signed URL, and with
 * the local adapter the service is its own upload endpoint. Either way the
 * client does the same thing, which is the point of the seam.
 */
export const PhotoUploadTicketReadySchema = z.object({
  status: z.literal('ready'),
  provider: MediaStorageProviderSchema,
  photoId: IdSchema,
  storageKey: StorageKeySchema,
  uploadUrl: z.string().min(1).max(2048),
  method: z.enum(['PUT', 'POST']),
  uploadToken: z.string().min(16).max(1024),
  contentType: ImageContentTypeSchema,
  /** Hard ceiling enforced on the request, not a suggestion. */
  maxBytes: PositiveIntSchema,
  expiresAt: TimestampSchema,
});

/**
 * No bucket, no credentials, no pretending.
 *
 * The same shape voice uses when there is no SFU: a structured report and a
 * named fallback, never a throw and never a fake success. The client keeps the
 * photo locally and says nothing to the player, because a photo they can see
 * is not a failure.
 */
export const PhotoUploadTicketUnavailableSchema = z.object({
  status: z.literal('not_configured'),
  provider: MediaStorageProviderSchema,
  reason: z.string().min(1).max(500),
  fallback: z.literal('device_local'),
});

export const PhotoUploadTicketSchema = z.discriminatedUnion('status', [
  PhotoUploadTicketReadySchema,
  PhotoUploadTicketUnavailableSchema,
]);
export type PhotoUploadTicket = z.infer<typeof PhotoUploadTicketSchema>;

/** What comes back once the bytes are safely stored. */
export const StoredPhotoSchema = z.object({
  photo: PhotoRefSchema,
  /** Where to fetch it. Relative to the API today; a CDN origin later. */
  url: z.string().min(1).max(2048),
  /** The type the *bytes* turned out to be, which is what will be served. */
  contentType: ImageContentTypeSchema,
  byteSize: PositiveIntSchema,
});
export type StoredPhoto = z.infer<typeof StoredPhotoSchema>;

/** The magic numbers we accept, and the type each one really is. */
export const IMAGE_MAGIC: ReadonlyArray<{
  readonly contentType: ImageContentType;
  readonly test: (bytes: Uint8Array) => boolean;
}> = Object.freeze([
  {
    contentType: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    contentType: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    // ISO-BMFF: `....ftypavif` / `....ftypavis`.
    contentType: 'image/avif',
    test: (b) =>
      b.length >= 12 &&
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70 &&
      b[8] === 0x61 &&
      b[9] === 0x76 &&
      b[10] === 0x69 &&
      (b[11] === 0x66 || b[11] === 0x73),
  },
]);

/**
 * What these bytes actually are, or `null`.
 *
 * The client's `Content-Type` is a claim, and a file claiming to be a PNG is
 * exactly what somebody uploads when they would rather we served their HTML.
 * This is the only thing allowed to decide what a stored object is.
 */
export function sniffImageContentType(bytes: Uint8Array): ImageContentType | null {
  for (const candidate of IMAGE_MAGIC) {
    if (candidate.test(bytes)) return candidate.contentType;
  }
  return null;
}
