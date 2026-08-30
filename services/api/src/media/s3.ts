import { createHash, createHmac } from 'node:crypto';
import { sniffImageContentType, type ImageContentType } from '@somemore/protocol';
import type { Clock } from '../clock.js';
import type { Logger } from '../logging.js';
import {
  isSafeStorageKey,
  type DeleteObjectResult,
  type GetObjectResult,
  type MediaStorage,
  type PutObjectInput,
  type PutObjectResult,
} from './types.js';

/*
 * S3-compatible object storage.
 *
 * Structured against the real thing — SigV4 over `node:crypto`, the canonical
 * request AWS actually specifies, `x-amz-content-sha256` on every call,
 * virtual-hosted-style URLs with a path-style escape hatch for R2/MinIO — and
 * it has never been run against a live bucket, because no bucket exists for
 * this project (README, Blocker 3). Exactly the position the Stripe adapter is
 * in, and it behaves the same way about it: with no credentials it reports
 * `not_configured` and the service falls back honestly instead of pretending
 * an upload succeeded.
 *
 * SigV4 is implemented rather than sketched because a signature is the part
 * that is either right or silently wrong, and `test/media.test.ts` pins it
 * against AWS's own published test vector. What has *not* been proved is
 * everything a real endpoint would tell us: bucket policy, CORS on the
 * browser's direct PUT, lifecycle rules, and whether the retention policy the
 * Passport's delete promise needs is actually configured.
 */

export interface S3MediaStorageOptions {
  readonly bucket: string;
  readonly region: string | null;
  readonly accessKeyId: string | null;
  readonly secretAccessKey: string | null;
  /** Override for R2/MinIO/Ceph. Absent ⇒ `https://s3.<region>.amazonaws.com`. */
  readonly endpoint: string | null;
  /** MinIO and friends need `https://host/bucket/key` rather than a subdomain. */
  readonly forcePathStyle?: boolean;
  /** CDN origin objects are read through, if there is one. */
  readonly publicBaseUrl: string | null;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_HEADERS = new Set(['authorization', 'content-length', 'user-agent']);

function sha256Hex(payload: string | Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20260830T121314Z` and `20260830`, the two forms every signature needs. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Percent-encoding as S3 defines it for a canonical URI: everything except
 * the unreserved set, and `/` left alone in a key path. `encodeURIComponent`
 * is close and wrong in three characters, which is enough to break a
 * signature.
 */
export function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      segment.replace(/[^A-Za-z0-9\-_.~]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
      ),
    )
    .join('/');
}

export interface SigV4Input {
  readonly method: string;
  readonly host: string;
  readonly canonicalUri: string;
  readonly canonicalQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
  /**
   * Signing scope. `s3` everywhere in this service; a parameter only so the
   * test below can pin AWS's own published `get-vanilla` vector, which is
   * scoped to `service`. A signature checked against a known answer is the
   * difference between "written" and "will work".
   */
  readonly service?: string;
}

/**
 * One AWS Signature Version 4 `Authorization` header.
 *
 * Exported so a test can hold it against AWS's published vector: a signature
 * nobody has checked against a known answer is a signature that will be wrong
 * on the first real request, on a day when the error message is `403` and the
 * reason is a header-ordering difference.
 */
export function signV4(input: SigV4Input): { authorization: string; amzDate: string } {
  const { amzDate, dateStamp } = amzDates(input.now);
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .filter(([name]) => !UNSIGNED_HEADERS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service ?? SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), input.service ?? SERVICE),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    amzDate,
    authorization:
      `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createS3MediaStorage(options: S3MediaStorageOptions): MediaStorage {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger;

  function missing(): string[] {
    const gaps: string[] = [];
    if (options.region === null) gaps.push('MEDIA_S3_REGION');
    if (options.accessKeyId === null) gaps.push('MEDIA_S3_ACCESS_KEY_ID');
    if (options.secretAccessKey === null) gaps.push('MEDIA_S3_SECRET_ACCESS_KEY');
    return gaps;
  }

  function reason(): string {
    const gaps = missing();
    return `Object storage is not configured: ${gaps.join(', ')} not set. See README "Blockers".`;
  }

  function urlFor(key: string): { url: string; host: string; canonicalUri: string } {
    const region = options.region ?? 'us-east-1';
    const encoded = encodeS3Path(key);
    if (options.endpoint !== null) {
      const base = new URL(options.endpoint);
      const pathStyle = options.forcePathStyle !== false;
      const host = pathStyle ? base.host : `${options.bucket}.${base.host}`;
      const canonicalUri = pathStyle ? `/${options.bucket}/${encoded}` : `/${encoded}`;
      return { url: `${base.protocol}//${host}${canonicalUri}`, host, canonicalUri };
    }
    const host = `${options.bucket}.s3.${region}.amazonaws.com`;
    return { url: `https://${host}/${encoded}`, host, canonicalUri: `/${encoded}` };
  }

  async function call(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body: Buffer | null,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response | { error: string }> {
    const { url, host, canonicalUri } = urlFor(key);
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      ...extraHeaders,
    };
    const { authorization, amzDate } = signV4({
      method,
      host,
      canonicalUri,
      canonicalQuery: '',
      headers: { ...headers, 'x-amz-date': amzDates(options.clock.now()).amzDate },
      payloadHash,
      region: options.region ?? 'us-east-1',
      accessKeyId: options.accessKeyId ?? '',
      secretAccessKey: options.secretAccessKey ?? '',
      now: options.clock.now(),
    });
    try {
      return await doFetch(url, {
        method,
        headers: { ...headers, 'x-amz-date': amzDate, authorization },
        ...(body === null ? {} : { body: new Uint8Array(body) }),
      });
    } catch (error) {
      logger.error('media.s3.request_failed', { method, message: String(error) });
      return { error: 'Could not reach object storage.' };
    }
  }

  return {
    name: 's3',
    bucket: options.bucket,

    isConfigured() {
      return missing().length === 0;
    },

    unavailableReason() {
      return missing().length === 0 ? null : reason();
    },

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      if (missing().length > 0) return { status: 'not_configured', reason: reason() };
      if (!isSafeStorageKey(input.key)) {
        return { status: 'rejected', reason: 'That storage key is not one this service mints.' };
      }
      const response = await call('PUT', input.key, input.bytes, {
        'content-type': input.contentType,
        // Private unless somebody chose otherwise, at the bucket too — a
        // default-public object is a privacy failure one policy edit away.
        'x-amz-acl': 'private',
        'x-amz-meta-owner': input.ownerAccountId,
      });
      if ('error' in response) return { status: 'failed', reason: response.error };
      if (!response.ok) {
        logger.warn('media.s3.put_rejected', { status: response.status });
        return { status: 'failed', reason: `Object storage refused the write (${response.status}).` };
      }
      return {
        status: 'stored',
        key: input.key,
        byteSize: input.bytes.byteLength,
        etag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
      };
    },

    async get(key): Promise<GetObjectResult> {
      if (missing().length > 0) return { status: 'not_configured', reason: reason() };
      if (!isSafeStorageKey(key)) return { status: 'missing' };
      const response = await call('GET', key, null);
      if ('error' in response) return { status: 'failed', reason: response.error };
      if (response.status === 404) return { status: 'missing' };
      if (!response.ok) return { status: 'failed', reason: `Object storage refused the read (${response.status}).` };
      const bytes = Buffer.from(await response.arrayBuffer());
      // The bucket's `Content-Type` is metadata somebody could have set. The
      // bytes are not.
      const contentType: ImageContentType | null = sniffImageContentType(bytes);
      if (contentType === null) return { status: 'missing' };
      return { status: 'found', bytes, contentType };
    },

    async delete(key): Promise<DeleteObjectResult> {
      if (missing().length > 0) return { status: 'not_configured', reason: reason() };
      if (!isSafeStorageKey(key)) return { status: 'missing' };
      const response = await call('DELETE', key, null);
      if ('error' in response) return { status: 'failed', reason: response.error };
      if (response.status === 404) return { status: 'missing' };
      if (!response.ok) {
        return { status: 'failed', reason: `Object storage refused the delete (${response.status}).` };
      }
      return { status: 'deleted' };
    },

    publicUrl(key) {
      if (options.publicBaseUrl === null) return null;
      return `${options.publicBaseUrl.replace(/\/$/, '')}/${encodeS3Path(key)}`;
    },
  };
}
