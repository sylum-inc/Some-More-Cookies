/**
 * Scanning a wrapper.
 *
 * A code is printed on a mass-produced package, so it is public and will be
 * photographed; ADR-0008 designed the format around that, and this is the
 * client half of it. Two properties do the work here:
 *
 *  1. **Verification is offline.** The signing key's public half is shippable
 *     by definition, so a forged, mistyped or expired code is refused *on the
 *     phone*, with no request, and the person is told plainly. That matters at
 *     a campsite on one bar of signal, and it means a scraper's garbage never
 *     reaches storage at all.
 *  2. **Redemption is not.** A code carries no value and no capability; what it
 *     is worth lives on the batch, server-side. So a code that passes locally
 *     is presented to the service with an authenticated account, and the
 *     database decides — including claim-once, which is a unique index and not
 *     an `if` anywhere on this side of the wire.
 *
 * The local check is deliberately a *necessary* condition and never a
 * sufficient one. It can say no on its own; it can never say yes.
 *
 * ## Where the key comes from
 *
 * Two sources, in order, neither of which is a secret:
 *
 *  - `VITE_CODE_VERIFY_PUBLIC_KEYS` baked into the build (`k1:base64,k2:base64`)
 *    — a public key inside a client is the whole idea;
 *  - `GET /v1/codes/keys`, cached to the device, which is how a key rotation
 *    reaches an installed client without a store release.
 *
 * With neither, offline verification is *unavailable* rather than *passing*:
 * `verify` answers `unverifiable`, the UI says we cannot check it here, and the
 * service is asked. It never degrades to accepting everything, which is the one
 * failure mode that would turn a missing environment variable into free ice
 * cream — the same rule `src/codes/signing.ts` holds on the other side.
 */

import {
  CodeVerificationKeysSchema,
  parseSomeMoreCode,
  type CodeVerificationKey,
  type ParsedCode,
  type RedeemCodeResult,
} from '@somemore/protocol';
import type { ApiClient, ApiFailure } from './client.js';

const KEY_CACHE = 'some-more/code-keys/v1';

/* -------------------------------------------------------------------------- */
/* The keyring                                                                 */
/* -------------------------------------------------------------------------- */

/** base64 (not base64url) of the raw 32 public-key bytes, as the service emits. */
function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** `k1:AAA...,k2:BBB...` — the same shape the service reads from its own env. */
export function parseKeyList(value: string | undefined | null): CodeVerificationKey[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const keys: CodeVerificationKey[] = [];
  for (const entry of value.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const keyId = entry.slice(0, separator).trim();
    const publicKey = entry.slice(separator + 1).trim();
    if (keyId.length === 0 || publicKey.length === 0) continue;
    keys.push({ keyId, publicKey });
  }
  return keys;
}

export class CodeKeyring {
  private readonly material = new Map<string, string>();
  private readonly imported = new Map<string, CryptoKey | null>();

  constructor(keys: readonly CodeVerificationKey[] = []) {
    this.add(keys);
  }

  add(keys: readonly CodeVerificationKey[]): void {
    for (const key of keys) {
      if (this.material.get(key.keyId) === key.publicKey) continue;
      this.material.set(key.keyId, key.publicKey);
      this.imported.delete(key.keyId);
    }
  }

  get empty(): boolean {
    return this.material.size === 0;
  }

  get keyIds(): string[] {
    return [...this.material.keys()].sort();
  }

  /**
   * Ed25519 through WebCrypto, imported once per key and remembered.
   *
   * `subtle` is only present in a secure context, and Ed25519 only landed in
   * WebCrypto recently, so an import failure is a real possibility on an older
   * browser — and it resolves to `null`, which the caller reads as
   * "unverifiable here", not as "valid".
   */
  private async key(keyId: string): Promise<CryptoKey | null> {
    if (this.imported.has(keyId)) return this.imported.get(keyId) ?? null;
    const material = this.material.get(keyId);
    if (material === undefined) return null;
    const bytes = base64ToBytes(material);
    const subtle = globalThis.crypto?.subtle;
    if (bytes === null || bytes.length !== 32 || subtle === undefined) {
      this.imported.set(keyId, null);
      return null;
    }
    try {
      const key = await subtle.importKey('raw', bytes as BufferSource, { name: 'Ed25519' }, false, ['verify']);
      this.imported.set(keyId, key);
      return key;
    } catch {
      this.imported.set(keyId, null);
      return null;
    }
  }

  /** True only when a real Ed25519 signature check passed. */
  async verifySignature(code: ParsedCode): Promise<boolean | 'unavailable'> {
    const key = await this.key(code.body.keyId);
    if (key === null) return this.material.has(code.body.keyId) ? 'unavailable' : false;
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) return 'unavailable';
    try {
      return await subtle.verify(
        { name: 'Ed25519' },
        key,
        code.signature as BufferSource,
        new TextEncoder().encode(code.signedInput) as BufferSource,
      );
    } catch {
      return 'unavailable';
    }
  }
}

/** The build's own keys, if whoever built it configured any. */
export function keysFromBuild(env: Record<string, unknown> = {}): CodeVerificationKey[] {
  const raw = env['VITE_CODE_VERIFY_PUBLIC_KEYS'];
  return parseKeyList(typeof raw === 'string' ? raw : null);
}

/** Keys this device has seen before. Public data; caching it is not a risk. */
export function readCachedKeys(): CodeVerificationKey[] {
  try {
    const raw = localStorage.getItem(KEY_CACHE);
    if (raw === null) return [];
    const parsed = CodeVerificationKeysSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.keys : [];
  } catch {
    return [];
  }
}

export function writeCachedKeys(keys: readonly CodeVerificationKey[], mintingKeyId: string | null): void {
  try {
    localStorage.setItem(KEY_CACHE, JSON.stringify({ keys, mintingKeyId }));
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* Offline verification                                                        */
/* -------------------------------------------------------------------------- */

export type LocalVerdict =
  /** Shaped like a code and signed by a key we hold. Still not *redeemable*. */
  | { ok: true; code: ParsedCode }
  /** Not shaped like one at all: a typo, a URL, somebody's shopping list. */
  | { ok: false; reason: 'malformed' }
  /** Signed by something that is not us. */
  | { ok: false; reason: 'bad_signature' }
  /** Signed by a key this build has never heard of — possibly a real rotation. */
  | { ok: false; reason: 'unknown_key' }
  /** The expiry baked into the code has passed, by this device's clock. */
  | { ok: false; reason: 'expired' }
  /** No key material, or no Ed25519 in this browser. We cannot say. */
  | { ok: false; reason: 'unverifiable'; code: ParsedCode };

/**
 * Everything that can be decided without asking anybody.
 *
 * Note the order: parse, then signature, then expiry. Checking the expiry of an
 * unsigned body would be reading a number a forger chose.
 *
 * The expiry check is the one place a device clock is consulted, and it is safe
 * to: it can only make the client refuse something, never accept it. A phone
 * wound backwards still has to get past the server, which uses its own clock
 * and its own batch window.
 */
export async function verifyCodeLocally(
  keyring: CodeKeyring,
  input: string,
  nowMs: number,
): Promise<LocalVerdict> {
  const parsed = parseSomeMoreCode(input);
  if (!parsed.ok) return { ok: false, reason: 'malformed' };
  const code = parsed.code;

  if (keyring.empty) return { ok: false, reason: 'unverifiable', code };

  const verdict = await keyring.verifySignature(code);
  if (verdict === 'unavailable') return { ok: false, reason: 'unverifiable', code };
  if (verdict === false) {
    // A key id we hold that did not verify is a forgery; one we have never
    // heard of might be a rotation we have not fetched yet, and the two
    // deserve different words to the person holding the box.
    return keyring.keyIds.includes(code.body.keyId)
      ? { ok: false, reason: 'bad_signature' }
      : { ok: false, reason: 'unknown_key' };
  }

  if (code.body.expiresAtUnix !== 0 && code.body.expiresAtUnix * 1000 <= nowMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, code };
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

export type ScanStage =
  | 'idle'
  /** Local signature check in flight. Milliseconds, but it is a promise. */
  | 'checking'
  /** Presented to the service with an account attached. */
  | 'redeeming'
  | 'redeemed'
  /** A `camp` code. The seam where the multiplayer client takes over. */
  | 'camp_invite'
  | 'rejected'
  /** The service could not be reached, or has no keys configured. */
  | 'unavailable';

export interface ScanState {
  stage: ScanStage;
  /** What the player is told. One sentence, no jargon, never a stack trace. */
  message: string | null;
  /** What they got, in the service's words, on success. */
  awarded: string | null;
  result: RedeemCodeResult | null;
  /** Set on a `camp` code: the invite token to hand to the join path. */
  inviteToken: string | null;
  /** True when the refusal was decided on this device, with no request sent. */
  decidedOffline: boolean;
  failure: ApiFailure | null;
}

function initialScanState(): ScanState {
  return {
    stage: 'idle',
    message: null,
    awarded: null,
    result: null,
    inviteToken: null,
    decidedOffline: false,
    failure: null,
  };
}

/**
 * What a person is told for each local refusal.
 *
 * Deliberately plain and deliberately *not* uniform the way the service's are:
 * the service has to avoid being an oracle for someone working through a
 * scraped list, but this runs on the phone of somebody holding a box, where the
 * useful thing is to distinguish "you mistyped it" from "that one has run out
 * of time". Nothing here tells an attacker anything they could not learn by
 * running the same check themselves, because they can: the key is public.
 */
const LOCAL_MESSAGES: Readonly<Record<Exclude<LocalVerdict, { ok: true }>['reason'], string>> = {
  malformed: "That does not look like a Some More code. Check it against the wrapper — it starts with SM1.",
  bad_signature: 'That code did not check out. If you typed it, a character is probably off.',
  unknown_key: 'That code was signed with a key this app does not know yet. Try again with a connection.',
  expired: 'That code has expired. The date on it has passed.',
  unverifiable: 'This app cannot check that code by itself — asking the depot.',
};

export interface ScanFlowOptions {
  keyring: CodeKeyring;
  /** Injected in tests; defaults to the real clock. */
  now?: () => number;
  /** Optional: told about a successful grant so the Passport can show it. */
  onRedeemed?: (result: RedeemCodeResult) => void;
}

export class ScanFlow {
  private readonly client: ApiClient;
  private readonly keyring: CodeKeyring;
  private readonly now: () => number;
  private readonly onRedeemed: ((result: RedeemCodeResult) => void) | undefined;
  private readonly listeners = new Set<(state: ScanState) => void>();
  state: ScanState = initialScanState();

  constructor(client: ApiClient, options: ScanFlowOptions) {
    this.client = client;
    this.keyring = options.keyring;
    this.now = options.now ?? (() => Date.now());
    this.onRedeemed = options.onRedeemed;
  }

  subscribe(listener: (state: ScanState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(partial: Partial<ScanState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  reset(): void {
    this.set(initialScanState());
  }

  /**
   * One scanned or typed code, all the way through.
   *
   * The offline half runs first and can end the whole thing without a request.
   * That is the point of Ed25519 here: a forged code costs the service nothing
   * and costs the person holding it one honest sentence.
   */
  async submit(input: string): Promise<void> {
    this.set({ ...initialScanState(), stage: 'checking' });

    const verdict = await verifyCodeLocally(this.keyring, input, this.now());

    if (!verdict.ok && verdict.reason !== 'unverifiable') {
      return this.set({
        stage: 'rejected',
        message: LOCAL_MESSAGES[verdict.reason],
        decidedOffline: true,
      });
    }

    const code = verdict.ok ? verdict.code : verdict.code;

    /*
     * A campfire invite is a join, not a redemption — the service says so too,
     * refusing `camp` at `/v1/codes/redeem` with `wrong_kind`. The signature
     * check above is the useful part and it has already happened: a forged camp
     * QR dies here, before the invite table is ever read.
     *
     * This is the seam. What happens next — opening a session, presenting the
     * invite token on the realtime handshake, showing somebody else's fire — is
     * the multiplayer client's, and it is being built separately. The token is
     * handed over and this flow stops.
     */
    if (code.body.kind === 'camp') {
      return this.set({
        stage: 'camp_invite',
        inviteToken: code.body.ref,
        decidedOffline: true,
        message: 'That is an invitation to somebody else’s fire.',
      });
    }

    if (!this.client.authenticated) {
      // Redeeming needs an account, which is what makes a scraped code worth
      // nothing. Anonymous is an account, so this is normally already true.
      return this.set({
        stage: 'unavailable',
        message: 'This passport is not linked to the depot yet. Try again in a moment.',
      });
    }

    this.set({ stage: 'redeeming', message: verdict.ok ? null : LOCAL_MESSAGES.unverifiable });

    const result = await this.client.redeemCode(code.token);
    if (result.ok) {
      this.onRedeemed?.(result.value);
      return this.set({
        stage: 'redeemed',
        result: result.value,
        awarded: result.value.awarded,
        message: result.value.awarded,
      });
    }

    return this.set(this.explainFailure(result.error));
  }

  /**
   * The service's refusal, in the service's own words where it has some.
   *
   * `code_invalid`, `code_revoked` and `code_already_redeemed` all carry a
   * human message written on the server precisely so a scanner does not have to
   * invent one — and so every "no" a stranger can provoke is the same word.
   */
  private explainFailure(failure: ApiFailure): Partial<ScanState> {
    switch (failure.kind) {
      case 'offline':
        return {
          stage: 'unavailable',
          failure,
          message: 'No connection. The code is fine — try it again when you have signal.',
        };
      case 'timeout':
        return { stage: 'unavailable', failure, message: 'The depot did not answer in time.' };
      case 'unauthorized':
        return { stage: 'unavailable', failure, message: 'This passport is not recognised by the depot.' };
      case 'conflict':
      case 'server':
        if (failure.code === 'service_not_configured') {
          return {
            stage: 'unavailable',
            failure,
            message: 'Code scanning is switched off on this deployment.',
          };
        }
        if (failure.code === 'rate_limited') {
          return { stage: 'rejected', failure, message: 'Too many scans. Give it a minute.' };
        }
        return { stage: 'rejected', failure, message: failure.message };
      case 'malformed':
        return {
          stage: 'unavailable',
          failure,
          message: 'The depot answered in a format this app does not know.',
        };
      default:
        return { stage: 'unavailable', failure, message: 'That did not work.' };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether this browser can read a QR without us shipping a decoder.
 *
 * `BarcodeDetector` is Chromium-only today. That is *fine*, because manual
 * entry is the primary path and always works — the camera is an enhancement,
 * not the feature. Adding a QR library to close the gap would be a runtime
 * dependency for a convenience, which this repo does not do.
 */
export function cameraScanSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const detector = (window as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof detector === 'function' && typeof navigator?.mediaDevices?.getUserMedia === 'function';
}

export type CameraFailure = 'unsupported' | 'denied' | 'no_camera' | 'failed';

export interface CameraScanner {
  stop(): void;
}

/**
 * Open the camera and watch for a code.
 *
 * Called **only** when somebody presses the button: a permission prompt that
 * appears because you sat down at a campfire is intrusive, and a game that asks
 * for a camera unprompted is a game people close. Denial is handled as an
 * ordinary answer — `onFailure('denied')` and the typed field is still right
 * there.
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  handlers: {
    onCode: (value: string) => void;
    onFailure: (reason: CameraFailure) => void;
  },
): Promise<CameraScanner | null> {
  if (!cameraScanSupported()) {
    handlers.onFailure('unsupported');
    return null;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    handlers.onFailure(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : name === 'NotFoundError'
          ? 'no_camera'
          : 'failed',
    );
    return null;
  }

  const Detector = (window as unknown as { BarcodeDetector: new (init: { formats: string[] }) => {
    detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
  } }).BarcodeDetector;

  let detector: { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
  try {
    detector = new Detector({ formats: ['qr_code'] });
  } catch {
    for (const track of stream.getTracks()) track.stop();
    handlers.onFailure('unsupported');
    return null;
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  try {
    await video.play();
  } catch {
    /* Autoplay policy; the frames still arrive once the element is visible. */
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const found = await detector.detect(video);
      const first = found[0];
      if (first !== undefined && first.rawValue.length > 0) {
        handlers.onCode(first.rawValue);
        return;
      }
    } catch {
      // A frame that could not be decoded is the normal case, not an error.
    }
    // Four looks a second: enough to feel instant, far short of per-frame work
    // on a device that is also rendering a campfire.
    timer = setTimeout(() => void tick(), 250);
  };
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
