/**
 * Limits and the token buckets that enforce them.
 *
 * Every number here is a defence rather than a tuning knob: an open socket is
 * an invitation to spend the server's memory and CPU, and "2–4 players per
 * campsite" (spec §9) means the honest traffic is tiny. Anything much above
 * these numbers is a bug or an attack, and either way the answer is the same.
 */

import type { RealtimeLimits } from '@somemore/protocol';
import { MAX_INPUT_HISTORY, DEFAULT_MUTUAL_HOLD_TICKS } from '@somemore/protocol';

export interface RealtimeLimitsConfig extends RealtimeLimits {
  /** Largest single frame we will even begin to buffer. */
  readonly maxFrameBytes: number;
  /** Unflushed bytes tolerated before a slow peer is disconnected. */
  readonly maxBufferedBytes: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  /** How long a socket may sit connected without sending `join`. */
  readonly joinTimeoutMs: number;
  /** Rate-limit refusals tolerated before the socket is closed outright. */
  readonly rateLimitStrikes: number;
  readonly closeTimeoutMs: number;
  /** How long a `walk_off` silhouette stays on the trail before it is gone. */
  readonly departureLingerMs: number;
  /**
   * Blocks a peer may register per minute.
   *
   * Server-side only, deliberately: it is not on the wire like the chat and
   * authority budgets are, because blocking is not a thing a client paces
   * itself for. Nobody blocks twelve people a minute by hand, and a client that
   * is doing so does not need to be told its budget politely.
   */
  readonly blocksPerMinute: number;
}

export const DEFAULT_REALTIME_LIMITS: RealtimeLimitsConfig = Object.freeze({
  // 16 KiB is generous for a message whose largest member is a Vec3 and a
  // rotation; the snapshot goes the other way and is not bound by this.
  maxMessageBytes: 16 * 1024,
  maxFrameBytes: 64 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  messagesPerSecond: 90,
  messageBurst: 120,
  // 60 Hz of input from one hand, plus headroom for a burst after a stall.
  inputsPerSecond: 70,
  chatPerMinute: 20,
  authorityRequestsPerMinute: 60,
  // "A short cooldown on repeated interference" (spec §9).
  interferencePerMinute: 12,
  /*
   * Blocking somebody is a rare, deliberate social act — you do it once about
   * one person. Twelve a minute is far more than anybody means and far less
   * than a loop.
   *
   * It needs its own bucket because `handleBlock` writes a moderation row per
   * message, and the only thing metering it was the ninety-a-second global
   * message budget. That is not an attack — you need somebody's account id for
   * each row — but it is unbounded storage growth driven by a peer, which is
   * the kind of thing that is only ever noticed by the person paying for the
   * disk. Audit S12.
   */
  blocksPerMinute: 12,
  interferenceCooldownMs: 8_000,
  connectionsPerAccount: 3,
  maxInputHistory: MAX_INPUT_HISTORY,
  mutualHoldTicks: DEFAULT_MUTUAL_HOLD_TICKS,
  pingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  joinTimeoutMs: 10_000,
  rateLimitStrikes: 20,
  closeTimeoutMs: 5_000,
  departureLingerMs: 7_000,
});

/**
 * Classic token bucket. Refills continuously from an injected clock, so tests
 * with a manual clock get exact, non-flaky behaviour rather than sleeping.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  readonly capacity: number;
  readonly refillPerSecond: number;

  constructor(capacity: number, refillPerSecond: number, nowMs: number) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const gained = ((nowMs - this.lastRefillMs) / 1000) * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefillMs = nowMs;
  }

  tryTake(nowMs: number, cost = 1): boolean {
    this.refill(nowMs);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Milliseconds until one more token is available. */
  retryAfterMs(nowMs: number, cost = 1): number {
    this.refill(nowMs);
    if (this.tokens >= cost) return 0;
    if (this.refillPerSecond <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  get available(): number {
    return this.tokens;
  }
}

/** The set of buckets one connection is metered by. */
export class ConnectionMeters {
  readonly messages: TokenBucket;
  readonly inputs: TokenBucket;
  readonly chat: TokenBucket;
  readonly authority: TokenBucket;
  readonly interference: TokenBucket;
  readonly blocks: TokenBucket;
  strikes = 0;
  /** Epoch ms until which interference-prone intents are refused outright. */
  interferenceCooldownUntilMs = 0;

  constructor(limits: RealtimeLimitsConfig, nowMs: number) {
    this.messages = new TokenBucket(limits.messageBurst, limits.messagesPerSecond, nowMs);
    this.inputs = new TokenBucket(limits.inputsPerSecond, limits.inputsPerSecond, nowMs);
    this.chat = new TokenBucket(limits.chatPerMinute, limits.chatPerMinute / 60, nowMs);
    this.authority = new TokenBucket(limits.authorityRequestsPerMinute, limits.authorityRequestsPerMinute / 60, nowMs);
    this.interference = new TokenBucket(limits.interferencePerMinute, limits.interferencePerMinute / 60, nowMs);
    this.blocks = new TokenBucket(limits.blocksPerMinute, limits.blocksPerMinute / 60, nowMs);
  }
}

/** The subset of the config that goes on the wire in `welcome`. */
export function wireLimits(limits: RealtimeLimitsConfig): RealtimeLimits {
  return {
    maxMessageBytes: limits.maxMessageBytes,
    messagesPerSecond: limits.messagesPerSecond,
    messageBurst: limits.messageBurst,
    inputsPerSecond: limits.inputsPerSecond,
    chatPerMinute: limits.chatPerMinute,
    authorityRequestsPerMinute: limits.authorityRequestsPerMinute,
    interferencePerMinute: limits.interferencePerMinute,
    interferenceCooldownMs: limits.interferenceCooldownMs,
    connectionsPerAccount: limits.connectionsPerAccount,
    maxInputHistory: limits.maxInputHistory,
    mutualHoldTicks: limits.mutualHoldTicks,
  };
}
