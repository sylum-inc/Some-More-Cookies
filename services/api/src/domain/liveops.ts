import { createHash } from 'node:crypto';
import {
  ContentDocumentSchema,
  RewardDefinitionSchema,
  SCHEMA_VERSION,
  canTransitionContent,
  isWindowOpen,
  type ContentDocument,
  type ContentIssue,
  type ContentKind,
  type ContentManifest,
  type ContentRelease,
  type ContentValidationResult,
  type CreateContentDocumentRequest,
  type JsonValue,
  type LiveOpsStatus,
  type ManifestDocument,
  type ReleaseEntry,
  type RollbackReleaseRequest,
  type TransitionContentDocumentRequest,
} from '@somemore/protocol';
import {
  ENVIRONMENTS,
  validateEnvironment,
  validateSeasonalEvent,
  validateStationProgramming,
} from '@somemore/content';
import { ApiError, conflict, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { DomainDeps } from './types.js';

/**
 * Live ops: content that changes after ship (spec §14).
 *
 * The rule this module exists to keep is in ARCHITECTURE §1.5 — *degrade, never
 * block*. Everything here is an **overlay** on the catalogue compiled into the
 * client. A campsite never waits on this service, never fails because of it,
 * and works identically with the endpoint switched off. What live ops buys is
 * the ability to run a meteor-shower weekend without shipping a build.
 *
 * Three things are deliberately strict:
 *
 *  1. **Validation happens at publish time, on our machine.** A document that
 *     violates the content rules is an operator's 422, never a player's broken
 *     campsite. The rules come from `@somemore/content`'s validator — the same
 *     one the compiled catalogue passes — because two validators would be two
 *     answers to one question and one of them would be wrong.
 *  2. **Releases are append-only.** Every publish, retirement and rollback
 *     mints a numbered snapshot of exactly what was live. Rolling back is
 *     publishing an old body as a *new* version, forward-only, for the same
 *     reason the migration runner has no `down`.
 *  3. **Time is the server's.** Activation windows are evaluated against the
 *     injected clock, never `Date.now()` in a handler and never a timestamp the
 *     client sent. A phone with its clock wound forward is the oldest trick
 *     there is, and a limited-edition flavour is exactly what it would be
 *     pointed at.
 */
export interface LiveOpsService {
  status(): Promise<LiveOpsStatus>;
  /** Dry-run the publish gate without writing anything. */
  validate(kind: ContentKind, body: JsonValue): Promise<ContentValidationResult>;
  createDocument(actor: string, request: CreateContentDocumentRequest): Promise<ContentDocument>;
  getDocument(documentId: string): Promise<ContentDocument>;
  listDocuments(filter: { kind?: ContentKind; slug?: string; status?: ContentDocument['status'] }): Promise<ContentDocument[]>;
  transition(actor: string, documentId: string, request: TransitionContentDocumentRequest): Promise<ContentDocument>;
  listReleases(limit?: number): Promise<ContentRelease[]>;
  rollback(actor: string, request: RollbackReleaseRequest): Promise<ContentRelease>;
  /** The read model the client fetches, with the ETag it should send back. */
  manifest(): Promise<ContentManifest>;
  publishedDocument(kind: ContentKind, slug: string): Promise<ContentDocument>;
}

/**
 * Stable JSON: object keys sorted at every depth.
 *
 * The checksum is what the ETag is derived from, so two byte-identical bodies
 * that happened to be typed in a different key order must produce the same
 * hash. Otherwise re-saving a document with no changes would invalidate every
 * client's cache.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`;
}

export function checksumOfBody(body: JsonValue): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** Every environment id a document may legitimately point at. */
const COMPILED_ENVIRONMENT_IDS: ReadonlySet<string> = new Set(ENVIRONMENTS.map((environment) => environment.id));

function issuesFrom(list: readonly { path: string; message: string }[]): ContentIssue[] {
  return list.map((issue) => ({ path: issue.path, message: issue.message }));
}

export function createLiveOpsService(deps: DomainDeps): LiveOpsService {
  const { repos, clock, ids, logger, config } = deps;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * The publish gate.
   *
   * Structural rules come from `@somemore/content` (environments, seasonal
   * events, station programming) or from the protocol schema (reward
   * definitions). Referential rules — "this event names an environment that
   * exists" — need storage, so they live here.
   */
  async function validateBody(kind: ContentKind, slug: string, body: JsonValue): Promise<ContentIssue[]> {
    const issues: ContentIssue[] = [];

    switch (kind) {
      case 'environment':
        issues.push(...issuesFrom(validateEnvironment(body, slug)));
        break;
      case 'seasonal_event':
        issues.push(...issuesFrom(validateSeasonalEvent(body, slug)));
        break;
      case 'station_programming':
        issues.push(...issuesFrom(validateStationProgramming(body, slug)));
        break;
      case 'reward_definition': {
        // Rewards are a protocol contract, not content, so the protocol schema
        // is the authority. Zod paths are flattened to the same dotted form the
        // content validator reports, so an operator sees one kind of error.
        const parsed = RewardDefinitionSchema.safeParse(body);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            issues.push({
              path: [slug, ...issue.path.map((p) => String(p))].join('.'),
              message: issue.message,
            });
          }
        } else if (parsed.data.code !== slug) {
          issues.push({ path: `${slug}.code`, message: `must equal the document slug ("${slug}")` });
        }
        break;
      }
    }

    // The slug is the addressable name of the thing; a body that calls itself
    // something else would publish cleanly and then be unfindable.
    if (kind !== 'reward_definition' && isRecord(body) && body['id'] !== slug) {
      issues.push({ path: `${slug}.id`, message: `must equal the document slug ("${slug}")` });
    }

    // Referential checks. An event pointed at an environment that does not
    // exist is the single most likely live-ops mistake, and it is silent.
    if ((kind === 'seasonal_event' || kind === 'station_programming') && isRecord(body)) {
      const targets = Array.isArray(body['environments']) ? body['environments'] : [];
      const publishedEnvironments = await repos.contentDocuments.list({ kind: 'environment', status: 'published' });
      const known = new Set([...COMPILED_ENVIRONMENT_IDS, ...publishedEnvironments.map((d) => d.slug)]);
      targets.forEach((target, index) => {
        if (typeof target !== 'string' || target === '*') return;
        if (!known.has(target)) {
          issues.push({
            path: `${slug}.environments[${index}]`,
            message: `no environment "${target}" is compiled in or published`,
          });
        }
      });
    }

    if (kind === 'seasonal_event' && isRecord(body)) {
      const codes = Array.isArray(body['rewardCodes']) ? body['rewardCodes'] : [];
      for (const [index, code] of codes.entries()) {
        if (typeof code !== 'string') continue;
        const defined = await repos.rewardDefinitions.getByCode(code);
        if (defined !== null) continue;
        const published = await repos.contentDocuments.findPublished('reward_definition', code);
        if (published !== null) continue;
        issues.push({
          path: `${slug}.rewardCodes[${index}]`,
          message: `no reward is defined for code "${code}"`,
        });
      }
    }

    return issues;
  }

  /** The set of documents live right now, as release entries. */
  async function currentEntries(): Promise<ReleaseEntry[]> {
    const published = await repos.contentDocuments.listPublished();
    return published
      .map((document) => ({
        documentId: document.id,
        kind: document.kind,
        slug: document.slug,
        version: document.version,
        checksum: document.checksum,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.slug.localeCompare(b.slug) : a.kind.localeCompare(b.kind)));
  }

  async function appendRelease(
    actor: string,
    reason: ContentRelease['reason'],
    note: string,
    rolledBackFromVersion: number | null,
  ): Promise<ContentRelease> {
    const latest = await repos.contentReleases.latest();
    const release: ContentRelease = {
      id: ids.next(ID_PREFIX.contentRelease),
      version: (latest?.version ?? 0) + 1,
      reason,
      entries: await currentEntries(),
      rolledBackFromVersion,
      createdAt: clock.isoNow(),
      createdBy: actor,
      note,
    };
    const created = await repos.contentReleases.create(release);
    logger.info('liveops.release', {
      version: created.version,
      reason,
      documents: created.entries.length,
      rolledBackFromVersion,
    });
    return created;
  }

  function requireConfigured(): void {
    if (config.liveOpsToken === null) {
      throw new ApiError(
        'service_not_configured',
        'Live-ops authoring is not configured on this deployment (LIVE_OPS_TOKEN). Reads still work.',
      );
    }
  }

  /** One attempt at claiming the next version number for a slug. */
  async function draftOnce(actor: string, request: CreateContentDocumentRequest): Promise<ContentDocument> {
    const now = clock.isoNow();
    const previous = await repos.contentDocuments.latestVersion(request.kind, request.slug);
    const document = ContentDocumentSchema.parse({
      id: ids.next(ID_PREFIX.contentDocument),
      kind: request.kind,
      slug: request.slug,
      version: previous + 1,
      status: 'draft',
      title: request.title,
      body: request.body,
      checksum: checksumOfBody(request.body),
      activation: request.activation,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      publishedAt: null,
      retiredAt: null,
      notes: request.notes,
    } satisfies Record<string, unknown>);
    const created = await repos.contentDocuments.create(document);
    logger.info('liveops.document_created', {
      documentId: created.id,
      kind: created.kind,
      slug: created.slug,
      version: created.version,
    });
    return created;
  }

  return {
    async status() {
      if (config.liveOpsToken === null) {
        return {
          status: 'not_configured',
          reason:
            'Live-ops authoring is not configured: LIVE_OPS_TOKEN is not set. The manifest still serves whatever '
            + 'was published before, and the client still boots from its compiled catalogue.',
          fallback: 'read_only',
        };
      }
      const latest = await repos.contentReleases.latest();
      return { status: 'ready', releaseVersion: latest?.version ?? 0 };
    },

    async validate(kind, body) {
      const slug = isRecord(body) && typeof body['id'] === 'string' ? body['id'] : 'document';
      const issues = await validateBody(kind, slug, body);
      return { valid: issues.length === 0, issues };
    },

    /**
     * Draft the next version of a document.
     *
     * Version numbers come from `max(version) + 1`, which two operators
     * drafting the same slug at the same instant will both compute identically.
     * `content_documents_kind_slug_version` refuses the loser, so rather than
     * hand a person a 409 for something they did nothing wrong to cause, we
     * take the next number and try again. Bounded, because a conflict that
     * survives five attempts is not contention any more.
     */
    async createDocument(actor, request) {
      requireConfigured();
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await draftOnce(actor, request);
        } catch (error) {
          if (attempt >= 4 || !(error instanceof ApiError) || error.code !== 'conflict') throw error;
        }
      }
    },

    async getDocument(documentId) {
      const document = await repos.contentDocuments.get(documentId);
      if (document === null) throw notFound('No such content document.');
      return document;
    },

    async listDocuments(filter) {
      return repos.contentDocuments.list(filter);
    },

    async transition(actor, documentId, request) {
      requireConfigured();
      const document = await repos.contentDocuments.get(documentId);
      if (document === null) throw notFound('No such content document.');
      if (!canTransitionContent(document.status, request.to)) {
        throw new ApiError(
          'illegal_state_transition',
          `A content document cannot go from ${document.status} to ${request.to}.`,
          { details: { from: document.status, to: request.to } },
        );
      }

      const now = clock.isoNow();

      if (request.to === 'published') {
        // The gate. Everything a player could trip over is caught here, once,
        // rather than on a phone in a tent with no signal.
        const issues = await validateBody(document.kind, document.slug, document.body);
        if (issues.length > 0) {
          logger.warn('liveops.publish_rejected', {
            documentId,
            slug: document.slug,
            issues: issues.length,
          });
          throw new ApiError('content_invalid', `That document has ${issues.length} problem(s) and was not published.`, {
            details: { issues } as never,
          });
        }
        // At most one live version per slug; retire the incumbent first so the
        // partial unique index never has two candidates.
        const incumbent = await repos.contentDocuments.findPublished(document.kind, document.slug);
        if (incumbent !== null && incumbent.id !== document.id) {
          await repos.contentDocuments.update(incumbent.id, (d) => ({
            ...d,
            status: 'retired',
            retiredAt: now,
            updatedAt: now,
          }));
        }
      }

      const updated = await repos.contentDocuments.update(documentId, (d) => ({
        ...d,
        status: request.to,
        updatedAt: now,
        publishedAt: request.to === 'published' ? now : d.publishedAt,
        retiredAt: request.to === 'retired' ? now : d.retiredAt,
        notes: request.notes.length > 0 ? request.notes : d.notes,
      }));

      if (request.to === 'published' || request.to === 'retired') {
        await appendRelease(actor, request.to === 'published' ? 'publish' : 'retire', request.notes, null);
      }
      return updated;
    },

    async listReleases(limit) {
      return repos.contentReleases.list(limit);
    },

    /**
     * Undo a bad publish without a deploy.
     *
     * A rollback does not resurrect a retired row — it republishes the old body
     * as a *new* version. Document versions stay immutable, the release history
     * keeps every step, and "what was live at 03:14" is still answerable after
     * three rollbacks in a row.
     */
    async rollback(actor, request) {
      requireConfigured();
      const target = await repos.contentReleases.getByVersion(request.toVersion);
      if (target === null) throw notFound(`No release ${request.toVersion}.`);
      const latest = await repos.contentReleases.latest();
      if (latest !== null && latest.version === request.toVersion) {
        throw conflict('That release is already live.', { version: request.toVersion });
      }

      const now = clock.isoNow();
      const keyOf = (kind: ContentKind, slug: string): string => `${kind}/${slug}`;
      const wanted = new Map<string, ReleaseEntry>(
        target.entries.map((entry) => [keyOf(entry.kind, entry.slug), entry]),
      );

      // Anything live that the target release did not contain comes down.
      for (const live of await repos.contentDocuments.listPublished()) {
        const key = keyOf(live.kind, live.slug);
        const entry = wanted.get(key);
        if (entry !== undefined && entry.checksum === live.checksum) {
          wanted.delete(key);
          continue;
        }
        await repos.contentDocuments.update(live.id, (d) => ({
          ...d,
          status: 'retired',
          retiredAt: now,
          updatedAt: now,
        }));
      }

      // Whatever is left is republished as a fresh version of the old body.
      for (const entry of wanted.values()) {
        const source = await repos.contentDocuments.get(entry.documentId);
        if (source === null) {
          throw conflict('That release refers to a document that no longer exists.', {
            documentId: entry.documentId,
          });
        }
        // A validator that has tightened since the original publish would
        // otherwise let a rollback reintroduce content we now know is broken.
        const issues = await validateBody(source.kind, source.slug, source.body);
        if (issues.length > 0) {
          throw new ApiError(
            'content_invalid',
            `Release ${request.toVersion} contains ${source.kind}/${source.slug}, which no longer passes validation.`,
            { details: { issues } as never },
          );
        }
        const version = (await repos.contentDocuments.latestVersion(source.kind, source.slug)) + 1;
        await repos.contentDocuments.create(
          ContentDocumentSchema.parse({
            ...source,
            id: ids.next(ID_PREFIX.contentDocument),
            version,
            status: 'published',
            createdAt: now,
            createdBy: actor,
            updatedAt: now,
            publishedAt: now,
            retiredAt: null,
            notes: `Rolled back from release ${request.toVersion} (was v${source.version}).`,
          } satisfies Record<string, unknown>),
        );
      }

      return appendRelease(actor, 'rollback', request.note, request.toVersion);
    },

    /**
     * The manifest.
     *
     * Activation is evaluated here, once, against the service clock — so the
     * ETag changes the moment a window opens even though nobody published
     * anything, and a client polling with `If-None-Match` learns about the
     * meteor shower on the same request that would otherwise have been a 304.
     */
    async manifest() {
      const nowIso = clock.isoNow();
      const release = await repos.contentReleases.latest();
      const published = await repos.contentDocuments.listPublished();

      const documents: ManifestDocument[] = published
        .map((document) => ({
          kind: document.kind,
          slug: document.slug,
          version: document.version,
          checksum: document.checksum,
          title: document.title,
          body: document.body,
          activation: document.activation,
          active: isWindowOpen(document.activation, nowIso),
        }))
        .sort((a, b) => (a.kind === b.kind ? a.slug.localeCompare(b.slug) : a.kind.localeCompare(b.kind)));

      const fingerprint = createHash('sha256')
        .update(String(release?.version ?? 0))
        .update('\n')
        .update(
          documents
            .map((d) => `${d.kind}/${d.slug}@${d.version}:${d.checksum}:${d.active ? '1' : '0'}`)
            .join('\n'),
        )
        .digest('hex')
        .slice(0, 32);

      return {
        releaseVersion: release?.version ?? 0,
        evaluatedAt: nowIso,
        schemaVersion: SCHEMA_VERSION,
        etag: `"${fingerprint}"`,
        documents,
        activeEventSlugs: documents
          .filter((d) => d.kind === 'seasonal_event' && d.active)
          .map((d) => d.slug),
        overlay: true,
      };
    },

    async publishedDocument(kind, slug) {
      const document = await repos.contentDocuments.findPublished(kind, slug);
      if (document === null) throw notFound('No published document with that name.');
      return document;
    },
  };
}
