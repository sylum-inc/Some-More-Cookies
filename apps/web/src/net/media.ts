/**
 * Getting a photograph off the device.
 *
 * Photo mode has always produced real images and had nowhere to put them: a
 * data URL in `localStorage`, hard-capped at twenty-four because a runaway
 * Passport would break the quota. This is the path that changes that, and it
 * is shaped by one rule above all the others:
 *
 * **The local copy is the source of truth until the upload lands.** The player
 * takes a photograph and sees it in the Passport immediately; whether it also
 * reached a bucket is a background fact they are never asked to care about.
 * Nothing here blocks the ritual, nothing here shows an error, and a
 * deployment with no object storage at all behaves exactly like today.
 *
 * The payoff is the cap. Once a photo is safely uploaded its bytes do not have
 * to sit in `localStorage` any more, so the twenty-four stops being a ceiling
 * on how many photographs a Passport may contain and becomes a ceiling on how
 * many *un-uploaded* ones it carries. That is the actual player-visible
 * change: the album stops throwing away last week.
 */

import type { PhotoUploadTicket, RequestPhotoUploadRequest, StoredPhoto } from '@somemore/protocol';
import type { ApiClient, ApiFailure, ApiResult } from './client.js';
import type { PassportPhoto } from '../state/store.js';

/** What happened to one photo. All four outcomes are ordinary. */
export type PhotoUploadOutcome =
  | { kind: 'uploaded'; stored: StoredPhoto }
  /** No bucket on this deployment. Not a failure; the photo stays local. */
  | { kind: 'not_configured'; reason: string }
  /** Worth retrying: offline, a timeout, a 5xx. */
  | { kind: 'retry'; failure: ApiFailure }
  /** Not worth retrying: the service refused these bytes and always will. */
  | { kind: 'rejected'; reason: string };

/**
 * Turn a `data:` URL back into bytes.
 *
 * `capturePhoto` produces one because a canvas does, and because a data URL is
 * what makes the photo visible before anything has been uploaded. Returns null
 * for anything that is not a base64 image data URL, which is a photo that
 * simply never gets sent rather than a thrown error in the middle of a ritual.
 */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (match === null) return null;
  const contentType = (match[1] ?? '').toLowerCase();
  const base64 = match[2] ?? '';
  try {
    const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.byteLength === 0 ? null : { bytes, contentType };
  } catch {
    return null;
  }
}

/** Only the four the protocol accepts; anything else is not sent at all. */
const UPLOADABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/**
 * Upload one photo: ask where it goes, then send it there.
 *
 * Two requests rather than one because that is the shape a pre-signed
 * object-storage URL has. When this deployment gains a bucket, the ticket
 * starts naming the provider's URL and nothing in this function changes.
 */
export async function uploadPhoto(
  client: ApiClient,
  photo: PassportPhoto,
  options: { campsiteId?: string | null; sandwichId?: string | null } = {},
): Promise<PhotoUploadOutcome> {
  const decoded = decodeDataUrl(photo.dataUrl);
  if (decoded === null || !UPLOADABLE.has(decoded.contentType)) {
    return { kind: 'rejected', reason: 'That photo is not in a format the service stores.' };
  }

  const request: RequestPhotoUploadRequest = {
    contentType: decoded.contentType as RequestPhotoUploadRequest['contentType'],
    byteSize: decoded.bytes.byteLength,
    // Dimensions are not read back off the bytes here: decoding a JPEG header
    // to learn its size, on the main thread, during a ritual, to fill in a
    // metadata field, is not a trade worth making. The capture width is the
    // one `capturePhoto` used.
    width: 480,
    height: 360,
    capturedAt: new Date(photo.takenAt).toISOString(),
    campsiteId: options.campsiteId ?? null,
    sandwichId: options.sandwichId ?? null,
    caption: photo.caption.slice(0, 280),
    // Never widened here. A photo is not public because it exists (§9), and
    // the only thing that may change this is a person choosing to.
    visibility: 'private',
    cameraPreset: photo.stage,
  };

  const ticket: ApiResult<PhotoUploadTicket> = await client.requestPhotoUpload(request);
  if (!ticket.ok) return classify(ticket.error);
  if (ticket.value.status === 'not_configured') {
    return { kind: 'not_configured', reason: ticket.value.reason };
  }
  if (decoded.bytes.byteLength > ticket.value.maxBytes) {
    return { kind: 'rejected', reason: 'That photo is larger than this deployment accepts.' };
  }

  const sent = await client.uploadPhotoBytes(ticket.value, decoded.bytes);
  if (!sent.ok) return classify(sent.error);
  return { kind: 'uploaded', stored: sent.value };
}

/**
 * Retry, or give up?
 *
 * The distinction matters because the queue is persistent: a 413 or a 415 will
 * be a 413 or a 415 forever, and retrying it six times with backoff is six
 * pointless requests from somebody's phone.
 */
function classify(failure: ApiFailure): PhotoUploadOutcome {
  if (failure.kind === 'server') {
    if (failure.code === 'service_not_configured') {
      return { kind: 'not_configured', reason: failure.message };
    }
    if (failure.status >= 400 && failure.status < 500 && failure.status !== 429) {
      return { kind: 'rejected', reason: failure.message };
    }
  }
  if (failure.kind === 'conflict') return { kind: 'rejected', reason: failure.message };
  return { kind: 'retry', failure };
}
