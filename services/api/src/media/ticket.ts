import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ImageContentType, PhotoVisibility } from '@somemore/protocol';
import { ApiError } from '../errors.js';

/**
 * The upload ticket: `smu1.<base64url(payload)>.<base64url(hmac-sha256)>`.
 *
 * Requesting somewhere to put a photo and then putting it there are two
 * requests, because that is the shape a pre-signed object-storage URL has and
 * the client should not have to learn a different one the day a bucket
 * appears. What connects them is this: a signed statement that *this* account
 * was told it could write *that* key, at *that* size, until *then*.
 *
 * Stateless on purpose, exactly as session tokens are (`auth/tokens.ts`). A
 * pending-upload table would need a migration, a sweeper for the tickets
 * nobody ever redeems, and a shared view across instances; an HMAC needs none
 * of those and cannot drift out of sync with itself.
 *
 * What a ticket is not: a capability anybody else can use. It names the
 * account, and the upload route still requires that account's bearer token —
 * a leaked ticket on its own is worth nothing.
 */
export const TICKET_PREFIX = 'smu1';

export interface UploadTicketPayload {
  /** Photo id, minted when the ticket was issued so the client can name it. */
  readonly pid: string;
  /** Account allowed to redeem it. */
  readonly sub: string;
  /** Storage key the bytes go to. */
  readonly key: string;
  /** Content type the client declared. Checked against the bytes on arrival. */
  readonly ct: ImageContentType;
  /** Hard byte ceiling for this upload. */
  readonly max: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
  readonly w: number;
  readonly h: number;
  /** Capture time, ISO. */
  readonly cap: string;
  readonly cmp: string | null;
  readonly swh: string | null;
  readonly cptn: string | null;
  readonly vis: PhotoVisibility;
  readonly preset: string | null;
}

export interface UploadTicketSigner {
  sign(payload: UploadTicketPayload): string;
  /** Throws `unauthorized` / `forbidden` rather than returning null. */
  verify(ticket: string, accountId: string, nowMs: number): UploadTicketPayload;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function createUploadTicketSigner(secret: string): UploadTicketSigner {
  function signature(payloadPart: string): Buffer {
    return createHmac('sha256', secret).update(`${TICKET_PREFIX}.${payloadPart}`).digest();
  }

  return {
    sign(payload) {
      const payloadPart = b64url(JSON.stringify(payload));
      return `${TICKET_PREFIX}.${payloadPart}.${signature(payloadPart).toString('base64url')}`;
    },

    verify(ticket, accountId, nowMs) {
      const parts = ticket.split('.');
      if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) {
        throw new ApiError('unauthorized', 'Malformed upload ticket.');
      }
      const payloadPart = parts[1] ?? '';
      const expected = signature(payloadPart);
      let provided: Buffer;
      try {
        provided = Buffer.from(parts[2] ?? '', 'base64url');
      } catch {
        throw new ApiError('unauthorized', 'Malformed upload ticket.');
      }
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new ApiError('unauthorized', 'Upload ticket signature does not verify.');
      }
      let payload: UploadTicketPayload;
      try {
        payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as UploadTicketPayload;
      } catch {
        throw new ApiError('unauthorized', 'Malformed upload ticket payload.');
      }
      if (typeof payload.key !== 'string' || typeof payload.exp !== 'number') {
        throw new ApiError('unauthorized', 'Malformed upload ticket payload.');
      }
      if (payload.exp * 1000 <= nowMs) {
        throw new ApiError('unauthorized', 'That upload ticket has expired. Ask for another.');
      }
      // A valid signature for somebody else's ticket is still somebody else's
      // ticket: whose photo this is, is decided here and not by the key.
      if (payload.sub !== accountId) {
        throw new ApiError('forbidden', 'That upload ticket belongs to another account.');
      }
      return payload;
    },
  };
}
