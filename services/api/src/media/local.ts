import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImageContentType } from '@somemore/protocol';
import type { Logger } from '../logging.js';
import {
  isSafeStorageKey,
  TYPE_BY_EXTENSION,
  type DeleteObjectResult,
  type GetObjectResult,
  type MediaStorage,
  type PutObjectInput,
  type PutObjectResult,
} from './types.js';

/**
 * Photo bytes on local disk.
 *
 * This is a real implementation, not a mock. It is what makes the whole upload
 * path — request, store, serve, delete, authorize — exist, work and be tested
 * today, on a machine with no cloud account, and it is what a single-instance
 * deployment with a volume can genuinely run on. Swapping in S3 or GCS is one
 * constructor call at the seam above it (README, Blocker 3).
 *
 * What it is not: shared. Two instances behind a load balancer do not see each
 * other's directory, and neither does a container that has been rescheduled.
 * That is the honest limit and it is why the S3 adapter exists.
 *
 * Two things it is careful about, because a filesystem is unforgiving:
 *
 *  - **Every key is re-validated here.** The route already only ever passes
 *    keys the service minted, and the protocol schema already refuses `..`.
 *    This checks again and then verifies that the *resolved* path is still
 *    inside the root, because path traversal is the failure that turns a photo
 *    endpoint into an arbitrary-file-read endpoint.
 *  - **Writes are atomic.** Bytes go to a temporary file in the same directory
 *    and are renamed into place, so a crash halfway through an upload leaves
 *    no half a photograph for the next reader to serve.
 */
export interface LocalMediaStorageOptions {
  /** Directory the keys are relative to. Created on first write. */
  readonly root: string;
  /** Reported as the bucket at `/v1/meta`, purely for symmetry with S3. */
  readonly bucket: string;
  readonly logger: Logger;
}

export function createLocalMediaStorage(options: LocalMediaStorageOptions): MediaStorage {
  const root = path.resolve(options.root);
  const logger = options.logger;

  /**
   * The absolute path for a key, or `null` if the key is not one of ours.
   *
   * The resolve-then-compare is the check that matters: a key can be
   * character-legal and still escape, and only the resolved path knows.
   */
  function pathFor(key: string): string | null {
    if (!isSafeStorageKey(key)) return null;
    const resolved = path.resolve(root, key);
    const boundary = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolved !== root && !resolved.startsWith(boundary)) return null;
    return resolved;
  }

  return {
    name: 'local',
    bucket: options.bucket,

    isConfigured() {
      return true;
    },

    unavailableReason() {
      return null;
    },

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const target = pathFor(input.key);
      if (target === null) {
        logger.warn('media.local.rejected_key', { keyLength: input.key.length });
        return { status: 'rejected', reason: 'That storage key is not one this service mints.' };
      }
      const etag = createHash('sha256').update(input.bytes).digest('hex');
      const temporary = `${target}.${etag.slice(0, 16)}.part`;
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(temporary, input.bytes, { mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        logger.error('media.local.write_failed', { message: String(error) });
        return { status: 'failed', reason: 'Could not write the object.' };
      }
      return { status: 'stored', key: input.key, byteSize: input.bytes.byteLength, etag };
    },

    async get(key): Promise<GetObjectResult> {
      const target = pathFor(key);
      if (target === null) return { status: 'missing' };
      let bytes: Buffer;
      try {
        bytes = await readFile(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return { status: 'missing' };
        logger.error('media.local.read_failed', { message: String(error) });
        return { status: 'failed', reason: 'Could not read the object.' };
      }
      /*
       * Sniffed again on the way out, never taken from the extension. What is
       * served is decided by the bytes on every single read, so a file that
       * somehow became something else on disk is a 404 rather than a
       * `text/html` response from our origin.
       */
      const contentType = sniffImageContentType(bytes);
      if (contentType === null) {
        logger.warn('media.local.unrecognised_object', { key });
        return { status: 'missing' };
      }
      const declared = TYPE_BY_EXTENSION[path.extname(key).slice(1).toLowerCase()];
      if (declared !== undefined && declared !== contentType) {
        logger.warn('media.local.type_mismatch', { key, contentType });
        return { status: 'missing' };
      }
      return { status: 'found', bytes, contentType };
    },

    async delete(key): Promise<DeleteObjectResult> {
      const target = pathFor(key);
      if (target === null) return { status: 'missing' };
      try {
        await stat(target);
      } catch {
        return { status: 'missing' };
      }
      try {
        await rm(target, { force: true });
      } catch (error) {
        logger.error('media.local.delete_failed', { message: String(error) });
        return { status: 'failed', reason: 'Could not delete the object.' };
      }
      return { status: 'deleted' };
    },

    /**
     * Local disk has no origin. The API serves the bytes, and says so by
     * returning `null` rather than inventing a URL nobody can fetch.
     */
    publicUrl() {
      return null;
    },
  };
}
