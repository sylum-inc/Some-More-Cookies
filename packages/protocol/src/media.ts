import { z } from 'zod';
import { IdSchema, NonNegativeIntSchema, PositiveIntSchema, TimestampSchema } from './common.js';

/**
 * Photos are the memento currency of Some More. The protocol NEVER carries
 * image bytes: a photo is metadata plus an object-storage key. Clients upload
 * to a pre-signed URL and then register the resulting key here.
 */
export const ImageContentTypeValues = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const ImageContentTypeSchema = z.enum(ImageContentTypeValues);

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
