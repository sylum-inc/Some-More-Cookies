import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PROXIMITY, proximityGain } from '@somemore/protocol';
import { createManualClock } from '../src/clock.js';
import {
  createFakeVoiceRoom,
  createLiveKitVoiceRoom,
  liveKitConfigFromEnv,
  mintLiveKitToken,
} from '../src/realtime/voice.js';
import { fireside, joinMessage, startRealtimeHarness, type RealtimeHarness } from './realtime-harness.js';

const clock = () => createManualClock('2026-08-29T12:00:00.000Z');

describe('the LiveKit adapter without credentials', () => {
  it('reports "not configured" instead of throwing, and names what is missing', async () => {
    const room = createLiveKitVoiceRoom({ url: null, apiKey: null, apiSecret: null }, clock());
    expect(room.isConfigured()).toBe(false);
    expect(room.unavailableReason()).toContain('LIVEKIT_URL');

    const info = await room.mintToken({
      sessionId: 'ses_1',
      campsiteId: 'cmp_1',
      accountId: 'acct_1',
      displayName: 'Rowan',
      mode: 'push_to_talk',
    });
    expect(info.status).toBe('not_configured');
    if (info.status !== 'ready') {
      // Degrade, never block: the fire carries on with text and gesture.
      expect(info.fallback).toBe('text_and_gesture');
      expect(info.reason).toContain('LIVEKIT_URL');
    }
  });

  it('is still not configured when only some of the credentials are present', async () => {
    const room = createLiveKitVoiceRoom({ url: 'wss://voice.example', apiKey: 'key', apiSecret: null }, clock());
    expect(room.isConfigured()).toBe(false);
    expect(room.unavailableReason()).toContain('LIVEKIT_API_SECRET');
    expect(room.unavailableReason()).not.toContain('LIVEKIT_URL');
  });

  it('reads its configuration from the environment, all-or-nothing', () => {
    expect(liveKitConfigFromEnv({})).toEqual({ url: null, apiKey: null, apiSecret: null });
    expect(liveKitConfigFromEnv({ LIVEKIT_URL: '  ', LIVEKIT_API_KEY: 'k' })).toMatchObject({ url: null, apiKey: 'k' });
  });
});

describe('the LiveKit adapter with credentials', () => {
  it('mints a real, verifiable LiveKit access token', async () => {
    const room = createLiveKitVoiceRoom(
      { url: 'wss://voice.example', apiKey: 'API_key', apiSecret: 'secret-value' },
      clock(),
    );
    expect(room.isConfigured()).toBe(true);
    expect(room.unavailableReason()).toBeNull();

    const info = await room.mintToken({
      sessionId: 'ses_42',
      campsiteId: 'cmp_1',
      accountId: 'acct_rowan',
      displayName: 'Rowan',
      mode: 'open_mic',
      ttlSeconds: 3_600,
    });
    expect(info.status).toBe('ready');
    if (info.status !== 'ready') throw new Error('expected a token');
    expect(info.url).toBe('wss://voice.example');
    expect(info.roomName).toBe('somemore-ses_42');

    // A LiveKit access token is an HS256 JWT; verify it the way LiveKit would.
    const [header, payload, signature] = info.token.split('.');
    const expected = createHmac('sha256', 'secret-value').update(`${header}.${payload}`).digest('base64url');
    expect(signature).toBe(expected);

    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
    expect(claims.iss).toBe('API_key');
    expect(claims.sub).toBe('acct_rowan');
    expect(claims.video.room).toBe('somemore-ses_42');
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.exp - claims.iat).toBe(3_600);

    // Private voice is not recorded. There is no way to ask for it to be.
    expect(claims.video.roomRecord).toBe(false);
    expect(claims.video.recorder).toBe(false);
    expect(info.recording).toBe(false);
  });
});

describe('voice room rules', () => {
  it('honours mute, block, per-player volume and proximity together', async () => {
    const room = createFakeVoiceRoom(clock());
    for (const accountId of ['acct_a', 'acct_b']) {
      await room.mintToken({ sessionId: 'ses_1', campsiteId: 'cmp_1', accountId, displayName: accountId, mode: 'open_mic' });
    }

    // Open mic, standing next to each other.
    expect(await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_a', speakerAccountId: 'acct_b', distanceM: 1 })).toBe(1);

    // Across the clearing: quieter, but still there.
    const far = await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_a', speakerAccountId: 'acct_b', distanceM: 10 });
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(1);
    expect(far).toBeCloseTo(proximityGain(10, DEFAULT_VOICE_PROXIMITY), 10);

    // Turned down by the listener.
    await room.setVolume('ses_1', 'acct_a', 'acct_b', 0.25);
    expect(await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_a', speakerAccountId: 'acct_b', distanceM: 1 })).toBe(0.25);

    // Muted at the source.
    await room.setMuted('ses_1', 'acct_b', true);
    expect(await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_a', speakerAccountId: 'acct_b', distanceM: 1 })).toBe(0);
    await room.setMuted('ses_1', 'acct_b', false);

    // Blocked: silent at any distance, whatever the volume says.
    await room.setBlocked('ses_1', 'acct_a', 'acct_b', true);
    expect(await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_a', speakerAccountId: 'acct_b', distanceM: 0 })).toBe(0);
    // ...and only for the person who blocked them.
    expect(await room.gainFor({ sessionId: 'ses_1', listenerAccountId: 'acct_b', speakerAccountId: 'acct_a', distanceM: 1 })).toBe(1);
  });

  it('lists participants and forgets them when they leave', async () => {
    const room = createFakeVoiceRoom(clock());
    await room.mintToken({ sessionId: 'ses_1', campsiteId: 'cmp_1', accountId: 'acct_a', displayName: 'A', mode: 'open_mic' });
    await room.mintToken({ sessionId: 'ses_1', campsiteId: 'cmp_1', accountId: 'acct_b', displayName: 'B', mode: 'push_to_talk' });

    const participants = await room.participants('ses_1');
    expect(participants.map((p) => p.accountId).sort()).toEqual(['acct_a', 'acct_b']);
    // Push-to-talk starts muted; open mic does not.
    expect(participants.find((p) => p.accountId === 'acct_b')?.muted).toBe(true);
    expect(participants.find((p) => p.accountId === 'acct_a')?.muted).toBe(false);

    await room.leave('ses_1', 'acct_a');
    expect((await room.participants('ses_1')).map((p) => p.accountId)).toEqual(['acct_b']);
    await room.closeRoom('ses_1');
    expect(await room.participants('ses_1')).toEqual([]);
  });
});

describe('voice over the wire', () => {
  let rig: RealtimeHarness;

  beforeEach(async () => {
    rig = await startRealtimeHarness();
  });

  afterEach(async () => {
    await rig.close();
  });

  it('hands a joining player a room token', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('snapshot');

    client.send({ t: 'voice', op: 'join', mode: 'push_to_talk' });
    const message = await client.waitFor('voice');
    expect(message.room.status).toBe('ready');
    if (message.room.status !== 'ready') throw new Error('expected a room');
    expect(message.room.recording).toBe(false);
    expect(message.room.proximity).toEqual(DEFAULT_VOICE_PROXIMITY);
    expect(message.room.participants.map((p) => p.accountId)).toContain(host.accountId);
    expect(rig.voice.minted).toHaveLength(1);
  });

  it('applies mute and per-player volume asked for over the socket', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    await hostClient.waitFor('snapshot');
    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');

    for (const client of [hostClient, guestClient]) {
      client.send({ t: 'voice', op: 'join', mode: 'open_mic' });
      await client.waitFor('voice');
    }

    const volumeSeq = hostClient.send({ t: 'voice', op: 'set_volume', accountId: guest.accountId, volume: 0.4 });
    await hostClient.waitFor('ack', (m) => m.seq === volumeSeq);

    expect(
      await rig.voice.gainFor({
        sessionId: session.id,
        listenerAccountId: host.accountId,
        speakerAccountId: guest.accountId,
        distanceM: 0,
      }),
    ).toBeCloseTo(0.4, 10);

    const muteSeq = guestClient.send({ t: 'voice', op: 'set_muted', muted: true });
    await guestClient.waitFor('ack', (m) => m.seq === muteSeq);
    // Muting is not a per-listener setting: nobody hears a muted mic.
    expect(
      await rig.voice.gainFor({
        sessionId: session.id,
        listenerAccountId: host.accountId,
        speakerAccountId: guest.accountId,
        distanceM: 0,
      }),
    ).toBe(0);
  });

  it('blocking somebody also silences them', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    await hostClient.waitFor('snapshot');
    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');
    for (const client of [hostClient, guestClient]) {
      client.send({ t: 'voice', op: 'join', mode: 'open_mic' });
      await client.waitFor('voice');
    }

    const seq = guestClient.send({ t: 'block', accountId: host.accountId });
    await guestClient.waitFor('ack', (m) => m.seq === seq);

    expect(
      await rig.voice.gainFor({
        sessionId: session.id,
        listenerAccountId: guest.accountId,
        speakerAccountId: host.accountId,
        distanceM: 0,
      }),
    ).toBe(0);
  });

  it('leaves a deployment with no provider working, minus the voices', async () => {
    // What a fresh deployment actually does: the adapter is present, wired and
    // asked for a token, and answers honestly rather than failing the join.
    const liveKit = createLiveKitVoiceRoom({ url: null, apiKey: null, apiSecret: null }, rig.api.clock);
    const info = await liveKit.mintToken({
      sessionId: 'ses_x',
      campsiteId: 'cmp_x',
      accountId: 'acct_x',
      displayName: 'x',
      mode: 'push_to_talk',
    });
    expect(info.status).toBe('not_configured');

    // The rest of the fire is unaffected: people still arrive, and still talk
    // to each other in text and gesture.
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('snapshot');
    const chat = client.send({ t: 'chat', text: 'anyone got a stick?' });
    await client.waitFor('ack', (m) => m.seq === chat);
  });
});
