import { createHmac, timingSafeEqual } from 'node:crypto';
import { SCHEMA_MAJOR } from '@somemore/protocol';
import { ApiError } from '../errors.js';

/**
 * Stateless session tokens: `sm1.<base64url(payload)>.<base64url(hmac)>`.
 *
 * HMAC-SHA256 with a server secret (`AUTH_TOKEN_SECRET`). Stateless is the
 * right call here because the only thing a token asserts is "you are this
 * account"; revocation is handled by rotating the secret or by the account
 * status check that every authenticated request performs anyway.
 */
export const TOKEN_PREFIX = 'sm1';

export interface TokenPayload {
  /** Account id. */
  sub: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Protocol major this token was minted against. */
  v: number;
}

export interface TokenSigner {
  sign(accountId: string, now: Date): { token: string; issuedAt: Date; expiresAt: Date };
  verify(token: string, now: Date): TokenPayload;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function createTokenSigner(secret: string, ttlSeconds: number): TokenSigner {
  function signature(payloadPart: string): Buffer {
    return createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payloadPart}`).digest();
  }

  return {
    sign(accountId, now) {
      const issuedAtSeconds = Math.floor(now.getTime() / 1000);
      const payload: TokenPayload = {
        sub: accountId,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + ttlSeconds,
        v: SCHEMA_MAJOR,
      };
      const payloadPart = b64url(JSON.stringify(payload));
      const token = `${TOKEN_PREFIX}.${payloadPart}.${signature(payloadPart).toString('base64url')}`;
      return {
        token,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
      };
    },

    verify(token, now) {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
        throw new ApiError('unauthorized', 'Malformed session token.');
      }
      const payloadPart = parts[1] ?? '';
      const signaturePart = parts[2] ?? '';
      const expected = signature(payloadPart);
      let provided: Buffer;
      try {
        provided = Buffer.from(signaturePart, 'base64url');
      } catch {
        throw new ApiError('unauthorized', 'Malformed session token.');
      }
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new ApiError('unauthorized', 'Session token signature does not verify.');
      }
      let payload: TokenPayload;
      try {
        payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as TokenPayload;
      } catch {
        throw new ApiError('unauthorized', 'Malformed session token payload.');
      }
      if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
        throw new ApiError('unauthorized', 'Malformed session token payload.');
      }
      if (payload.exp * 1000 <= now.getTime()) {
        throw new ApiError('unauthorized', 'Session token has expired.');
      }
      if (payload.v !== SCHEMA_MAJOR) {
        throw new ApiError('schema_version_unsupported', 'Session token was issued for a different protocol major.');
      }
      return payload;
    },
  };
}

/** Pull a bearer token out of an Authorization header. */
export function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? null;
}
