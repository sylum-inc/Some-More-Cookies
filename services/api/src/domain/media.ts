import {
  sniffImageContentType,
  type ImageContentType,
  type PhotoRef,
  type PhotoUploadTicket,
  type RequestPhotoUploadRequest,
  type StoredPhoto,
} from '@somemore/protocol';
import { ApiError, forbidden, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { MediaStorage } from '../media/types.js';
import { photoStorageKey } from '../media/types.js';
import type { UploadTicketSigner } from '../media/ticket.js';
import type { PassportService } from './passport.js';
import type { DomainDeps } from './types.js';

/**
 * Photos: the bytes, and who may see them.
 *
 * The passport domain has always modelled photo *metadata* — a storage key and
 * a size, with nothing behind either. This is the other half: the path that
 * accepts an image, decides what it really is, keeps it somewhere, hands it
 * back to the people entitled to see it, and forgets it on request.
 *
 * Everything a photo endpoint has to get right that a JSON endpoint does not
 * is decided here or at the route above it, and none of it is delegated to the
 * storage adapter:
 *
 *  - **The client's `Content-Type` is a claim.** What the object *is* comes
 *    from its magic number, on the way in and again on the way out. A file
 *    that says PNG and is not is a `415`, not a stored object.
 *  - **The size ceiling is enforced before the bytes are buffered**, at the
 *    HTTP edge, from the ticket. A ticket that says 8 MB is what makes a 40 MB
 *    upload a rejected stream rather than 40 MB of resident memory.
 *  - **Keys are minted here, never proposed.** A client cannot name the place
 *    its bytes land, which is the only reliable answer to traversal.
 *  - **A stored object can never be served as a document.** Only four image
 *    types are storable, the served type is the sniffed one, and the route
 *    adds `nosniff` and a sandboxed CSP on top.
 *  - **Private by default, and reading somebody else's photo is a 404.** Not a
 *    403: whether a private photo exists is itself none of a stranger's
 *    business.
 */
export interface MediaService {
  /** Ask for somewhere to put a photo. Never throws for a missing bucket. */
  requestUpload(accountId: string, request: RequestPhotoUploadRequest): Promise<PhotoUploadTicket>;
  /** Store the bytes and register the photo. */
  completeUpload(input: {
    accountId: string;
    uploadToken: string;
    bytes: Buffer;
    declaredContentType: string | undefined;
  }): Promise<StoredPhoto>;
  /** The bytes, if this viewer is allowed them. `null` viewer = signed out. */
  read(viewerAccountId: string | null, photoId: string): Promise<{
    photo: PhotoRef;
    bytes: Buffer;
    contentType: ImageContentType;
    /** Set when the object lives somewhere with an origin of its own. */
    redirectTo: string | null;
  }>;
  /** Metadata only, same authorization as `read`. */
  describe(viewerAccountId: string | null, photoId: string): Promise<PhotoRef>;
  remove(accountId: string, photoId: string): Promise<void>;
}

export interface MediaServiceDeps {
  readonly storage: MediaStorage;
  readonly tickets: UploadTicketSigner;
  /** How long an upload offer stands. */
  readonly ticketTtlSeconds: number;
  readonly maxBytes: number;
}

export function createMediaService(
  deps: DomainDeps,
  media: MediaServiceDeps,
  passports: PassportService,
): MediaService {
  const { repos, clock, ids, config, logger } = deps;
  const { storage, tickets } = media;

  /**
   * May this viewer see this photo?
   *
   * Private by default is not a comment: it is the `private` branch, which is
   * the schema default, refusing everybody but the owner. The rest widen only
   * because somebody chose to.
   */
  async function authorizeRead(viewerAccountId: string | null, photo: PhotoRef): Promise<void> {
    if (viewerAccountId !== null && viewerAccountId === photo.ownerAccountId) return;

    // Blocks always win, exactly as they do for a passport read.
    if (viewerAccountId !== null && (await repos.moderation.isBlocked(photo.ownerAccountId, viewerAccountId))) {
      throw notFound('No such photo.');
    }

    switch (photo.visibility) {
      case 'public':
        return;
      case 'link':
        // The id is the capability. It is a v4 UUID behind a prefix, which is
        // what "unlisted" has always meant; it is not, and does not claim to
        // be, an access control.
        return;
      case 'campsite': {
        if (viewerAccountId === null || photo.campsiteId === null) break;
        const campsite = await repos.campsites.get(photo.campsiteId);
        const member = campsite?.members.find((m) => m.accountId === viewerAccountId && !m.banned);
        if (member !== undefined) return;
        break;
      }
      case 'private':
        break;
    }
    // Never "you may not see that photo", which answers the question anyway.
    throw notFound('No such photo.');
  }

  return {
    async requestUpload(accountId, request) {
      if (!storage.isConfigured()) {
        /*
         * The house style for an external service we do not have (see
         * `realtime/voice.ts`): a structured report and a named fallback, at
         * 200. The client keeps the photo on the device and shows the player
         * nothing, because a photograph they can see is not an error.
         */
        return {
          status: 'not_configured',
          provider: storage.name,
          reason: storage.unavailableReason() ?? 'Object storage is not configured.',
          fallback: 'device_local',
        };
      }

      if (request.campsiteId !== null) {
        const campsite = await repos.campsites.get(request.campsiteId);
        if (campsite === null || !campsite.members.some((m) => m.accountId === accountId && !m.banned)) {
          throw forbidden('You are not a member of that campsite.');
        }
      }
      if (request.byteSize > media.maxBytes) {
        throw new ApiError(
          'payload_too_large',
          `A photo may be at most ${media.maxBytes} bytes; that one is ${request.byteSize}.`,
          { details: { maxBytes: media.maxBytes, byteSize: request.byteSize } },
        );
      }

      const photoId = ids.next(ID_PREFIX.photo);
      const key = photoStorageKey({
        prefix: config.mediaKeyPrefix,
        accountId,
        photoId,
        contentType: request.contentType,
      });
      const expiresAtMs = clock.now().getTime() + media.ticketTtlSeconds * 1000;
      const uploadToken = tickets.sign({
        pid: photoId,
        sub: accountId,
        key,
        ct: request.contentType,
        max: media.maxBytes,
        exp: Math.floor(expiresAtMs / 1000),
        w: request.width,
        h: request.height,
        cap: request.capturedAt,
        cmp: request.campsiteId,
        swh: request.sandwichId,
        cptn: request.caption,
        vis: request.visibility,
        preset: request.cameraPreset,
      });

      return {
        status: 'ready',
        provider: storage.name,
        photoId,
        storageKey: key,
        // One endpoint whichever adapter is behind it. With a real bucket this
        // becomes the provider's pre-signed URL and the client's code does not
        // change, which is the entire reason the ticket exists.
        uploadUrl: `/v1/media/uploads/${encodeURIComponent(photoId)}`,
        method: 'PUT',
        uploadToken,
        contentType: request.contentType,
        maxBytes: media.maxBytes,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async completeUpload({ accountId, uploadToken, bytes, declaredContentType }) {
      const ticket = tickets.verify(uploadToken, accountId, clock.now().getTime());

      if (bytes.byteLength === 0) {
        throw new ApiError('bad_request', 'That upload had no bytes in it.');
      }
      if (bytes.byteLength > ticket.max) {
        throw new ApiError('payload_too_large', `A photo may be at most ${ticket.max} bytes.`);
      }

      /*
       * What arrived, according to the bytes. The header is compared to this
       * rather than believed: a PNG header over a ZIP, an SVG, or an HTML
       * document is the oldest upload trick there is, and it is the reason
       * anything served from our origin has to be something we recognised.
       */
      const actual = sniffImageContentType(bytes);
      if (actual === null) {
        throw new ApiError(
          'unsupported_media_type',
          'That does not look like a JPEG, PNG, WebP or AVIF.',
          { details: { declared: ticket.ct } },
        );
      }
      if (actual !== ticket.ct) {
        throw new ApiError(
          'unsupported_media_type',
          `That upload was declared ${ticket.ct} and is actually ${actual}.`,
          { details: { declared: ticket.ct, actual } },
        );
      }
      if (declaredContentType !== undefined && !declaredContentType.startsWith(actual)) {
        throw new ApiError(
          'unsupported_media_type',
          `The Content-Type header says ${declaredContentType} and the bytes say ${actual}.`,
        );
      }

      const stored = await storage.put({
        key: ticket.key,
        bytes,
        contentType: actual,
        ownerAccountId: accountId,
      });
      if (stored.status === 'not_configured') {
        throw new ApiError('service_not_configured', stored.reason);
      }
      if (stored.status === 'rejected') {
        throw new ApiError('bad_request', stored.reason);
      }
      if (stored.status === 'failed') {
        logger.error('media.store_failed', { reason: stored.reason });
        throw new ApiError('internal_error', 'Could not store that photo.');
      }

      /*
       * Registered through the passport service, so a photo that reached
       * storage lands in the Passport by exactly the same path a photo
       * registered by `POST /v1/passport/photos` does. Two ways into one
       * collection would be two sets of rules about it.
       */
      const photo = await passports.registerPhoto(
        accountId,
        {
          storageKey: ticket.key,
          thumbnailKey: null,
          contentType: actual,
          width: ticket.w,
          height: ticket.h,
          byteSize: stored.byteSize,
          capturedAt: ticket.cap,
          campsiteId: ticket.cmp,
          sandwichId: ticket.swh,
          caption: ticket.cptn,
          visibility: ticket.vis,
          cameraPreset: ticket.preset,
        },
        // The ticket named this photo before the bytes existed; the row has to
        // carry that id or the URL the client already holds points at nothing.
        ticket.pid,
      );

      logger.info('media.stored', {
        photoId: photo.id,
        provider: storage.name,
        byteSize: stored.byteSize,
        contentType: actual,
      });

      return {
        photo,
        url: storage.publicUrl(ticket.key) ?? `/v1/media/${encodeURIComponent(photo.id)}`,
        contentType: actual,
        byteSize: stored.byteSize,
      };
    },

    async describe(viewerAccountId, photoId) {
      const photo = await repos.photos.get(photoId);
      if (photo === null) throw notFound('No such photo.');
      await authorizeRead(viewerAccountId, photo);
      return photo;
    },

    async read(viewerAccountId, photoId) {
      const photo = await repos.photos.get(photoId);
      if (photo === null) throw notFound('No such photo.');
      await authorizeRead(viewerAccountId, photo);

      const direct = storage.publicUrl(photo.storageKey);
      if (direct !== null) {
        return { photo, bytes: Buffer.alloc(0), contentType: photo.contentType, redirectTo: direct };
      }

      const object = await storage.get(photo.storageKey);
      if (object.status === 'missing') {
        // Metadata without bytes: the row is real and the object is not. A 404
        // is the truth; the alternative is a broken image with a 200 on it.
        logger.warn('media.object_missing', { photoId });
        throw notFound('That photo is no longer stored.');
      }
      if (object.status === 'not_configured') throw new ApiError('service_not_configured', object.reason);
      if (object.status === 'failed') {
        logger.error('media.read_failed', { photoId, reason: object.reason });
        throw new ApiError('internal_error', 'Could not read that photo.');
      }
      return { photo, bytes: object.bytes, contentType: object.contentType, redirectTo: null };
    },

    async remove(accountId, photoId) {
      const photo = await repos.photos.get(photoId);
      if (photo === null) throw notFound('No such photo.');
      // Deleting is owner-only and admits nothing about photos that are not
      // yours: a stranger's DELETE reads exactly like a missing photo.
      if (photo.ownerAccountId !== accountId) throw notFound('No such photo.');

      const result = await storage.delete(photo.storageKey);
      if (result.status === 'failed') {
        logger.error('media.delete_failed', { photoId, reason: result.reason });
        throw new ApiError('internal_error', 'Could not delete that photo.');
      }
      await repos.photos.delete(photoId);
      await repos.passports.update(accountId, (p) => ({
        ...p,
        photos: p.photos.filter((candidate) => candidate.id !== photoId),
        avatarPhotoId: p.avatarPhotoId === photoId ? null : p.avatarPhotoId,
        updatedAt: clock.isoNow(),
        revision: p.revision + 1,
      }));
      logger.info('media.deleted', { photoId, provider: storage.name });
    },
  };
}
