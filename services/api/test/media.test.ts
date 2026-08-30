/**
 * The photo path, end to end and adversarially.
 *
 * Everything here drives the real HTTP server, including the binary upload —
 * `harness.request` speaks JSON, so the byte routes use `fetch` directly
 * against `api.baseUrl`, which is the same thing a browser does.
 *
 * The suite runs against both storage backends the same way the rest of the
 * API suite runs against both persistence backends: the media tests give each
 * case its own directory under the OS temp dir, so nothing leaks between them.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sniffImageContentType } from '@somemore/protocol';
import { createS3MediaStorage, encodeS3Path, signV4 } from '../src/media/s3.js';
import { isSafeStorageKey, photoStorageKey } from '../src/media/types.js';
import { createLocalMediaStorage } from '../src/media/local.js';
import { silentLogger } from '../src/logging.js';
import { createManualClock } from '../src/clock.js';
import { bootstrap, createCampsite, key, startTestApi, type Player, type TestHarness } from './harness.js';

let api: TestHarness;
let mediaRoot: string;

beforeEach(async () => {
  mediaRoot = await mkdtemp(path.join(tmpdir(), 'somemore-media-test-'));
  api = await startTestApi({ MEDIA_LOCAL_ROOT: mediaRoot });
});

afterEach(async () => {
  await api.close();
  await rm(mediaRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixtures: bytes that really are what they say                               */
/* -------------------------------------------------------------------------- */

/** A one-pixel PNG. Real bytes, so the sniffing under test is real too. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A tiny JPEG: SOI, a minimal APP0 and EOI. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xd9]),
]);

interface Ticket {
  status: 'ready' | 'not_configured';
  photoId: string;
  uploadUrl: string;
  uploadToken: string;
  storageKey: string;
  maxBytes: number;
  provider: string;
  reason?: string;
}

async function requestTicket(
  player: Player,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Ticket }> {
  const response = await api.request('/v1/media/uploads', {
    method: 'POST',
    token: player.token,
    body: {
      idempotencyKey: key('upl'),
      contentType: 'image/png',
      byteSize: PNG.byteLength,
      width: 1,
      height: 1,
      capturedAt: new Date(api.clock.now()).toISOString(),
      ...overrides,
    },
  });
  return { status: response.status, body: response.body as Ticket };
}

async function put(
  ticket: Ticket,
  player: Player,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${api.baseUrl}${ticket.uploadUrl}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${player.token}`,
      'x-upload-ticket': ticket.uploadToken,
      'content-type': 'image/png',
      ...headers,
    },
    body: new Uint8Array(bytes),
  });
}

async function upload(player: Player, bytes = PNG, overrides: Record<string, unknown> = {}) {
  const ticket = await requestTicket(player, overrides);
  expect(ticket.body.status).toBe('ready');
  const response = await put(ticket.body, player, bytes);
  const body = (await response.json()) as { photo: { id: string; visibility: string }; url: string };
  return { ticket: ticket.body, status: response.status, body };
}

/* -------------------------------------------------------------------------- */
/* The path a photograph actually takes                                        */
/* -------------------------------------------------------------------------- */

describe('uploading a photo', () => {
  it('stores the bytes and hands them back byte-for-byte', async () => {
    const player = await bootstrap(api);
    const { status, body, ticket } = await upload(player);
    expect(status).toBe(201);
    expect(body.photo.id).toBe(ticket.photoId);

    const fetched = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    const returned = Buffer.from(await fetched.arrayBuffer());
    expect(returned.equals(PNG)).toBe(true);
  });

  it('puts the photo in the Passport, through the same path a registration would', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player);
    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.photos.map((p: { id: string }) => p.id)).toContain(body.photo.id);
    expect(passport.body.stats.photosTaken).toBe(1);
  });

  it('is private by default — a photo is not public because it exists', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player);
    expect(body.photo.visibility).toBe('private');

    const stranger = await bootstrap(api);
    const denied = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    // A 404 rather than a 403: whether a private photo exists is not a
    // stranger's business either.
    expect(denied.status).toBe(404);

    const anonymous = await fetch(`${api.baseUrl}${body.url}`);
    expect(anonymous.status).toBe(404);
  });

  it('serves a public photo to anybody, signed out', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player, PNG, { visibility: 'public' });
    const anonymous = await fetch(`${api.baseUrl}${body.url}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('cache-control')).toContain('public');
  });

  it('shares a campsite photo with that campsite’s members and nobody else', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const { body } = await upload(owner, PNG, { visibility: 'campsite', campsiteId: campsite.id });

    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    const friend = await bootstrap(api);
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: friend.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
    });

    const asFriend = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${friend.token}` },
    });
    expect(asFriend.status).toBe(200);

    const stranger = await bootstrap(api);
    const asStranger = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(asStranger.status).toBe(404);
  });

  it('deletes the bytes as well as the row', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player);

    const before = await readdir(path.join(mediaRoot, 'campsites', player.accountId));
    expect(before).toHaveLength(1);

    const deleted = await api.request(`/v1/media/${body.photo.id}`, {
      method: 'DELETE',
      token: player.token,
    });
    expect(deleted.status).toBe(204);

    const after = await readdir(path.join(mediaRoot, 'campsites', player.accountId));
    expect(after).toHaveLength(0);

    const gone = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(gone.status).toBe(404);

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.photos).toHaveLength(0);
  });

  it('refuses to let one account delete another’s photo, and says nothing about it', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player);
    const stranger = await bootstrap(api);

    const attempt = await api.request(`/v1/media/${body.photo.id}`, {
      method: 'DELETE',
      token: stranger.token,
    });
    expect(attempt.status).toBe(404);

    const still = await fetch(`${api.baseUrl}${body.url}`, {
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(still.status).toBe(200);
  });

  it('reports what this deployment can do at /v1/meta and /v1/media/status', async () => {
    const meta = await api.request('/v1/meta');
    expect(meta.body.mediaStorage).toBe('local');
    expect(meta.body.mediaConfigured).toBe(true);
    const status = await api.request('/v1/media/status');
    expect(status.body.status).toBe('ready');
    expect(status.body.maxBytes).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Adversarial                                                                 */
/* -------------------------------------------------------------------------- */

describe('the upload path under attack', () => {
  it('rejects a file that claims to be a PNG and is not', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    // An HTML document with a `.png` key and an `image/png` header. This is the
    // whole reason the bytes decide and the header does not.
    const html = Buffer.from('<!doctype html><script>alert(document.domain)</script>', 'utf8');
    const response = await put(ticket.body, player, html);
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');

    // And nothing was written: a refused upload leaves no object behind.
    await expect(readdir(path.join(mediaRoot, 'campsites', player.accountId))).rejects.toThrow();
  });

  it('rejects a real image of the wrong type', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player, { contentType: 'image/png' });
    const response = await put(ticket.body, player, JPEG);
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('image/jpeg');
  });

  it('refuses an oversized upload without buffering it', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    const response = await put(ticket.body, player, huge);
    expect(response.status).toBe(413);
  });

  it('refuses to even offer a ticket for something too large', async () => {
    const player = await bootstrap(api);
    const asked = await requestTicket(player, { byteSize: 40 * 1024 * 1024 });
    expect(asked.status).toBe(413);
  });

  it('refuses an empty upload', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    const response = await put(ticket.body, player, Buffer.alloc(0));
    expect(response.status).toBe(400);
  });

  it('will not let one account spend another’s upload ticket', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    const thief = await bootstrap(api);
    const response = await put(ticket.body, thief, PNG);
    expect(response.status).toBe(403);
  });

  it('refuses an upload with no ticket at all', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    const response = await fetch(`${api.baseUrl}${ticket.body.uploadUrl}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${player.token}`, 'content-type': 'image/png' },
      body: new Uint8Array(PNG),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a tampered ticket', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    const parts = ticket.body.uploadToken.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat((parts[2] ?? '').length)}`;
    const response = await put(ticket.body, player, PNG, { 'x-upload-ticket': forged });
    expect(response.status).toBe(401);
  });

  it('refuses an expired ticket', async () => {
    const player = await bootstrap(api);
    const ticket = await requestTicket(player);
    api.clock.advance(16 * 60 * 1000);
    const response = await put(ticket.body, player, PNG);
    expect(response.status).toBe(401);
  });

  it('never serves a stored object as anything a browser would run', async () => {
    const player = await bootstrap(api);
    const { body } = await upload(player, PNG, { visibility: 'public' });
    const response = await fetch(`${api.baseUrl}${body.url}`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('cannot be talked into reading a file outside the store', async () => {
    const player = await bootstrap(api);
    for (const attempt of [
      '../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'pho_../../../../etc/passwd',
      '/etc/passwd',
    ]) {
      const response = await fetch(`${api.baseUrl}/v1/media/${attempt}`, {
        headers: { authorization: `Bearer ${player.token}` },
      });
      // 404 (no route, or no such photo) or 422 (not an id) — never 200, and
      // never anything with a byte of /etc in it.
      expect([404, 422]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain('root:');
    }
  });

  it('will not serve a key that names a file it did not write', async () => {
    // The storage adapter is the second line: even handed a traversing key
    // directly, it refuses rather than resolving it.
    const outside = path.join(path.dirname(mediaRoot), 'outside.png');
    await writeFile(outside, PNG);
    const storage = createLocalMediaStorage({ root: mediaRoot, bucket: 'test', logger: silentLogger });
    try {
      for (const bad of ['../outside.png', '../../etc/passwd', '/etc/passwd', 'a/../../outside.png', 'a//b']) {
        expect(isSafeStorageKey(bad)).toBe(false);
        expect((await storage.get(bad)).status).toBe('missing');
        expect((await storage.put({ key: bad, bytes: PNG, contentType: 'image/png', ownerAccountId: 'x' })).status)
          .toBe('rejected');
      }
    } finally {
      await rm(outside, { force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The adapters themselves                                                     */
/* -------------------------------------------------------------------------- */

describe('the local disk adapter', () => {
  it('round-trips bytes and reports a missing object as missing', async () => {
    const storage = createLocalMediaStorage({ root: mediaRoot, bucket: 'test', logger: silentLogger });
    const key1 = photoStorageKey({
      prefix: 'campsites',
      accountId: 'acct_1',
      photoId: 'pho_1',
      contentType: 'image/png',
    });
    expect(storage.isConfigured()).toBe(true);
    expect(storage.unavailableReason()).toBeNull();
    expect(storage.publicUrl(key1)).toBeNull();

    const stored = await storage.put({
      key: key1,
      bytes: PNG,
      contentType: 'image/png',
      ownerAccountId: 'acct_1',
    });
    expect(stored.status).toBe('stored');

    const got = await storage.get(key1);
    expect(got.status).toBe('found');
    if (got.status === 'found') expect(got.bytes.equals(PNG)).toBe(true);

    expect((await storage.get('campsites/acct_1/pho_missing.png')).status).toBe('missing');
    expect((await storage.delete(key1)).status).toBe('deleted');
    expect((await storage.delete(key1)).status).toBe('missing');
  });

  it('leaves no half-written file behind, and no `.part` files at rest', async () => {
    const storage = createLocalMediaStorage({ root: mediaRoot, bucket: 'test', logger: silentLogger });
    const key1 = 'campsites/acct_2/pho_2.png';
    await storage.put({ key: key1, bytes: PNG, contentType: 'image/png', ownerAccountId: 'acct_2' });
    const files = await readdir(path.join(mediaRoot, 'campsites', 'acct_2'));
    expect(files).toEqual(['pho_2.png']);
  });

  it('refuses to serve an object whose bytes stopped being an image', async () => {
    const storage = createLocalMediaStorage({ root: mediaRoot, bucket: 'test', logger: silentLogger });
    const key1 = 'campsites/acct_3/pho_3.png';
    await storage.put({ key: key1, bytes: PNG, contentType: 'image/png', ownerAccountId: 'acct_3' });
    // Somebody, or something, replaced the file on disk.
    await writeFile(path.join(mediaRoot, key1), '<html>not a png</html>');
    expect((await storage.get(key1)).status).toBe('missing');
  });
});

describe('the S3 adapter', () => {
  const clock = createManualClock('2026-08-30T12:00:00.000Z');

  function storage(overrides: Record<string, unknown> = {}) {
    return createS3MediaStorage({
      bucket: 'somemore-media',
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
      endpoint: null,
      publicBaseUrl: null,
      clock,
      logger: silentLogger,
      ...overrides,
    });
  }

  it('reports not_configured without credentials, and never throws', async () => {
    const s3 = storage();
    expect(s3.isConfigured()).toBe(false);
    expect(s3.unavailableReason()).toContain('MEDIA_S3_REGION');
    expect(s3.unavailableReason()).toContain('MEDIA_S3_ACCESS_KEY_ID');

    const put = await s3.put({ key: 'a/b.png', bytes: PNG, contentType: 'image/png', ownerAccountId: 'x' });
    expect(put.status).toBe('not_configured');
    expect((await s3.get('a/b.png')).status).toBe('not_configured');
    expect((await s3.delete('a/b.png')).status).toBe('not_configured');
  });

  it('signs a request the way AWS says to', () => {
    /*
     * AWS's own `get-vanilla` SigV4 test vector. A signature nobody has held
     * against a known answer is a signature that will be wrong on the first
     * real request, on a day when the only clue is a 403.
     */
    const signed = signV4({
      method: 'GET',
      host: 'example.amazonaws.com',
      canonicalUri: '/',
      canonicalQuery: '',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00.000Z'),
      service: 'service',
    });
    expect(signed.amzDate).toBe('20150830T123600Z');
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('percent-encodes a key the way a canonical URI needs, not the way JS does', () => {
    expect(encodeS3Path('campsites/acct_1/pho 1.png')).toBe('campsites/acct_1/pho%201.png');
    expect(encodeS3Path('a/b+c.png')).toBe('a/b%2Bc.png');
    // Slashes stay slashes; unreserved characters stay themselves.
    expect(encodeS3Path('a/b-c_d.~png')).toBe('a/b-c_d.~png');
  });

  it('offers a CDN URL only when there is a CDN', () => {
    expect(storage().publicUrl('a/b.png')).toBeNull();
    expect(storage({ publicBaseUrl: 'https://cdn.example/' }).publicUrl('a/b.png')).toBe(
      'https://cdn.example/a/b.png',
    );
  });

  it('sends the bytes to a real S3 URL with a signature and a private ACL', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const s3 = storage({
      region: 'us-west-2',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 200, headers: { etag: '"abc"' } });
      },
    });
    const result = await s3.put({
      key: 'campsites/acct_1/pho_1.png',
      bytes: PNG,
      contentType: 'image/png',
      ownerAccountId: 'acct_1',
    });
    expect(result.status).toBe('stored');
    const call = seen[0];
    expect(call?.url).toBe('https://somemore-media.s3.us-west-2.amazonaws.com/campsites/acct_1/pho_1.png');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-amz-acl']).toBe('private');
    expect(headers['authorization']).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/');
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sniffing', () => {
  it('knows the four types it accepts, and nothing else', () => {
    expect(sniffImageContentType(PNG)).toBe('image/png');
    expect(sniffImageContentType(JPEG)).toBe('image/jpeg');
    expect(
      sniffImageContentType(
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
      ),
    ).toBe('image/webp');
    expect(
      sniffImageContentType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')])),
    ).toBe('image/avif');

    for (const impostor of [
      Buffer.from('<!doctype html>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('GIF89a'),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // a zip
      Buffer.alloc(0),
    ]) {
      expect(sniffImageContentType(impostor)).toBeNull();
    }
  });
});

describe('with no object storage at all', () => {
  it('says so honestly and keeps the photo on the device', async () => {
    const unconfigured = await startTestApi({
      MEDIA_STORAGE: 's3',
      MEDIA_BUCKET: 'somemore-media',
    });
    try {
      const player = await bootstrap(unconfigured);
      const response = await unconfigured.request('/v1/media/uploads', {
        method: 'POST',
        token: player.token,
        body: {
          idempotencyKey: key('upl'),
          contentType: 'image/png',
          byteSize: PNG.byteLength,
          width: 1,
          height: 1,
          capturedAt: new Date(unconfigured.clock.now()).toISOString(),
        },
      });
      // 200, not 503: "there is nowhere to put this, and here is why" is a
      // complete answer to "where do I put this".
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('not_configured');
      expect(response.body.fallback).toBe('device_local');
      expect(response.body.reason).toContain('MEDIA_S3_');

      const meta = await unconfigured.request('/v1/meta');
      expect(meta.body.mediaConfigured).toBe(false);
      expect(meta.body.mediaStorage).toBe('s3');
    } finally {
      await unconfigured.close();
    }
  });
});
