import type { ImageContentType, MediaStorageProvider } from '@somemore/protocol';

/**
 * The single seam between this service and wherever photo bytes actually live.
 *
 * Modelled on `PaymentProvider` (`src/payments/types.ts`) and on `VoiceRoom`
 * (`src/realtime/voice.ts`), for the same reason both exist: an external
 * service we may or may not have credentials for must be a *seam* with an
 * honest report, not a stub with a promise attached.
 *
 *  - `isConfigured()` says whether bytes can move at all.
 *  - Every method returns a structured result. Nothing here throws for a
 *    missing credential, because "degrade, never block" (ARCHITECTURE §1.5)
 *    is not compatible with an exception on the photo path.
 *  - The adapters decide *where*, never *whether*: authorization, size limits,
 *    content-type sniffing and key minting are the service's rules and live
 *    above this interface, so swapping local disk for S3 cannot loosen them.
 */
export interface PutObjectInput {
  readonly key: string;
  readonly bytes: Buffer;
  /** Already sniffed from the bytes. Adapters must not re-derive it. */
  readonly contentType: ImageContentType;
  /** Who it belongs to, for adapters that can carry object metadata. */
  readonly ownerAccountId: string;
}

export type PutObjectResult =
  | { readonly status: 'stored'; readonly key: string; readonly byteSize: number; readonly etag: string }
  | { readonly status: 'not_configured'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export type GetObjectResult =
  | { readonly status: 'found'; readonly bytes: Buffer; readonly contentType: ImageContentType }
  | { readonly status: 'missing' }
  | { readonly status: 'not_configured'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export type DeleteObjectResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'missing' }
  | { readonly status: 'not_configured'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface MediaStorage {
  readonly name: MediaStorageProvider;
  /** The bucket (or directory) these keys are relative to. */
  readonly bucket: string;
  /** False when credentials or a destination are missing. */
  isConfigured(): boolean;
  /** Why bytes cannot move, or `null` when they can. */
  unavailableReason(): string | null;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  get(key: string): Promise<GetObjectResult>;
  delete(key: string): Promise<DeleteObjectResult>;
  /**
   * A URL a client may fetch directly, or `null` when the API must serve the
   * bytes itself.
   *
   * Local disk has no origin of its own, so it returns `null` and the media
   * route streams the object. A CDN-backed bucket returns a URL and the route
   * redirects — which is the one behavioural difference between the adapters,
   * and it is deliberate: nobody should serve a photo through Node once there
   * is somewhere better to serve it from.
   */
  publicUrl(key: string): string | null;
}

/**
 * The key layout. Server-minted, always — a client never proposes a key.
 *
 * `<prefix>/<accountId>/<photoId>.<ext>`: every object is under the account
 * that owns it, so "delete my account" is a prefix delete and a mis-scoped
 * read is visible in the key itself rather than only in a policy.
 */
export function photoStorageKey(input: {
  prefix: string;
  accountId: string;
  photoId: string;
  contentType: ImageContentType;
}): string {
  const extension = EXTENSION_BY_TYPE[input.contentType];
  const prefix = input.prefix.replace(/^\/+|\/+$/g, '');
  return `${prefix}/${input.accountId}/${input.photoId}.${extension}`;
}

export const EXTENSION_BY_TYPE: Readonly<Record<ImageContentType, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
});

export const TYPE_BY_EXTENSION: Readonly<Record<string, ImageContentType>> = Object.freeze({
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
});

/**
 * Is this a key we minted, or something somebody typed?
 *
 * The protocol's `StorageKeySchema` already refuses `..` and a leading slash.
 * This is the second line, applied inside every adapter, because a traversal
 * that reaches the filesystem layer is the one bug in this file that is worth
 * more than an apology. Backslashes, control characters, absolute paths,
 * percent-encoding and empty segments are all out.
 */
export function isSafeStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key)) return false;
  if (key.includes('//')) return false;
  const segments = key.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
