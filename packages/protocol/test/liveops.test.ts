import { describe, expect, it } from 'vitest';
import {
  ActivationWindowSchema,
  CONTENT_TRANSITIONS,
  ContentDocumentSchema,
  ContentManifestSchema,
  ContentReleaseSchema,
  CreateContentDocumentRequestSchema,
  canTransitionContent,
  isWindowOpen,
} from '../src/index.js';

const NOW = '2026-08-29T12:00:00.000Z';
const CHECKSUM = 'a'.repeat(64);

describe('the content lifecycle', () => {
  it('goes draft -> staged -> published -> retired and no further', () => {
    expect(canTransitionContent('draft', 'staged')).toBe(true);
    expect(canTransitionContent('staged', 'published')).toBe(true);
    expect(canTransitionContent('published', 'retired')).toBe(true);
    expect(CONTENT_TRANSITIONS.retired).toEqual([]);
  });

  it('refuses to publish straight from draft', () => {
    // Staging is where a document is looked at. Skipping it would make the
    // preview step optional, which is the same as not having one.
    expect(canTransitionContent('draft', 'published')).toBe(false);
  });

  it('has no un-publish, because taking something down is its own release', () => {
    expect(canTransitionContent('published', 'staged')).toBe(false);
    expect(canTransitionContent('published', 'draft')).toBe(false);
  });
});

describe('activation windows', () => {
  it('treats a null window as always open', () => {
    expect(isWindowOpen(null, NOW)).toBe(true);
  });

  it('is closed before the start and at or after the end', () => {
    const window = { startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-03T00:00:00.000Z' };
    expect(isWindowOpen(window, '2026-08-31T23:59:59.000Z')).toBe(false);
    expect(isWindowOpen(window, '2026-09-01T00:00:00.000Z')).toBe(true);
    expect(isWindowOpen(window, '2026-09-02T12:00:00.000Z')).toBe(true);
    // Half-open: the instant the window ends, it is over. Two events that abut
    // must never both be live for one millisecond.
    expect(isWindowOpen(window, '2026-09-03T00:00:00.000Z')).toBe(false);
  });

  it('accepts an open-ended window on either side', () => {
    expect(isWindowOpen({ startsAt: null, endsAt: '2026-09-03T00:00:00.000Z' }, NOW)).toBe(true);
    expect(isWindowOpen({ startsAt: '2026-09-01T00:00:00.000Z', endsAt: null }, NOW)).toBe(false);
  });

  it('refuses a window that ends before it starts', () => {
    expect(
      ActivationWindowSchema.safeParse({
        startsAt: '2026-09-03T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('content documents', () => {
  const base = {
    id: 'cdoc_1',
    kind: 'seasonal_event',
    slug: 'perseid_weekend',
    version: 1,
    title: 'Perseid weekend',
    body: { id: 'perseid_weekend' },
    checksum: CHECKSUM,
    schemaVersion: '1.0.0',
    createdAt: NOW,
    createdBy: 'acct_1',
    updatedAt: NOW,
  };

  it('starts as a draft with no activation window and no publish date', () => {
    const document = ContentDocumentSchema.parse(base);
    expect(document.status).toBe('draft');
    expect(document.activation).toBeNull();
    expect(document.publishedAt).toBeNull();
  });

  it('requires a slug that can address a document and a real checksum', () => {
    expect(ContentDocumentSchema.safeParse({ ...base, slug: 'Perseid Weekend' }).success).toBe(false);
    expect(ContentDocumentSchema.safeParse({ ...base, checksum: 'nope' }).success).toBe(false);
    expect(ContentDocumentSchema.safeParse({ ...base, version: 0 }).success).toBe(false);
  });

  it('requires an idempotency key to author one', () => {
    const request = { kind: 'seasonal_event', slug: 'x', title: 'X', body: {} };
    expect(CreateContentDocumentRequestSchema.safeParse(request).success).toBe(false);
    expect(
      CreateContentDocumentRequestSchema.safeParse({ ...request, idempotencyKey: 'idem-0001-abcd' }).success,
    ).toBe(true);
  });
});

describe('releases and the manifest', () => {
  it('records which release a rollback reproduces', () => {
    const release = ContentReleaseSchema.parse({
      id: 'crel_3',
      version: 3,
      reason: 'rollback',
      entries: [{ documentId: 'cdoc_1', kind: 'environment', slug: 'pine_hollow', version: 2, checksum: CHECKSUM }],
      rolledBackFromVersion: 1,
      createdAt: NOW,
      createdBy: 'acct_1',
    });
    expect(release.rolledBackFromVersion).toBe(1);
  });

  it('states in the payload that it is an overlay, and cannot say otherwise', () => {
    const manifest = {
      releaseVersion: 1,
      evaluatedAt: NOW,
      schemaVersion: '1.0.0',
      etag: '"abc"',
      documents: [],
      activeEventSlugs: [],
      overlay: true,
    };
    expect(ContentManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ContentManifestSchema.safeParse({ ...manifest, overlay: false }).success).toBe(false);
  });
});
