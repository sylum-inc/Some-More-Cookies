/**
 * Local-first synchronisation.
 *
 * The rule that shapes this file: **the ritual never waits on the network.**
 * Everything a player does is committed locally first and mirrored to the
 * service afterwards, on a queue that survives reloads and retries with
 * backoff. A campsite with no signal behaves exactly like one with signal,
 * only quieter.
 *
 * This is also what makes the anonymous → linked transition a merge rather
 * than a reset (spec §6.1): the device's history is already the source of
 * truth, so linking an account uploads it instead of replacing it.
 */

import type { SandwichRecord } from '@somemore/sim';
import { ApiClient, deviceId, idempotencyKey, type ApiFailure } from './client.js';
import { toCreateSandwichRequest } from './mapping.js';

/** Work waiting to reach the service. */
export type PendingOperation = {
  kind: 'sandwich';
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export interface SyncStatus {
  /** Whether a session exists. */
  linked: boolean;
  /** Operations still waiting to be sent. */
  pending: number;
  /** The last failure, if the queue is stuck. */
  lastError: ApiFailure | null;
  /** Whether the service is currently reachable. */
  online: boolean;
}

const QUEUE_KEY = 'some-more/sync-queue/v1';
const SESSION_KEY = 'some-more/session/v1';
/** Give up re-sending after this many tries; the local copy still stands. */
const MAX_ATTEMPTS = 6;

export class SyncEngine {
  private readonly client: ApiClient;
  private queue: PendingOperation[] = [];
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: ApiFailure | null = null;
  private listeners = new Set<(status: SyncStatus) => void>();

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.client = new ApiClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      onSession: (session) => {
        try {
          if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
          else localStorage.removeItem(SESSION_KEY);
        } catch {
          // A device that will not persist a session simply signs in again.
        }
      },
    });
    this.restore();
  }

  private restore(): void {
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (rawSession) this.client.restore(JSON.parse(rawSession));
      const rawQueue = localStorage.getItem(QUEUE_KEY);
      if (rawQueue) {
        const parsed: unknown = JSON.parse(rawQueue);
        if (Array.isArray(parsed)) this.queue = parsed as PendingOperation[];
      }
    } catch {
      // A corrupt queue must never block the world; start clean.
      this.queue = [];
    }
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get status(): SyncStatus {
    return {
      linked: this.client.authenticated,
      pending: this.queue.length,
      lastError: this.lastError,
      online: !this.client.offline,
    };
  }

  private notify(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Establishes an anonymous account if there is not one already.
   *
   * Deliberately fire-and-forget: nothing in the product waits for it, and a
   * failure means the player carries on offline with a local Passport.
   */
  async ensureAccount(): Promise<boolean> {
    if (this.client.authenticated) return true;
    const result = await this.client.bootstrap(deviceId());
    if (!result.ok) {
      this.lastError = result.error;
      this.notify();
      return false;
    }
    this.lastError = null;
    this.notify();
    return true;
  }

  /**
   * Queues a sandwich for upload. Returns immediately.
   *
   * The body is built here, synchronously, rather than at send time: if the
   * simulation and the wire contract ever drift apart, this throws at the
   * moment of the sandwich rather than silently failing in a background
   * queue an hour later.
   */
  enqueueSandwich(sandwich: SandwichRecord, campsiteId: string, minimumDistanceCm = 18): void {
    const payload = toCreateSandwichRequest({
      sandwich,
      campsiteId,
      runId: sandwich.id,
      startedAt: new Date(sandwich.createdAt),
      minimumDistanceCm,
      idempotencyKey: idempotencyKey(),
    });
    this.enqueue({ kind: 'sandwich', id: sandwich.id, attempts: 0, payload });
  }

  /**
   * The server-side campsite this device's sandwiches belong to.
   *
   * Created once and remembered, so a returning player keeps the same
   * campsite rather than accumulating one per visit.
   */
  async ensureCampsite(name: string, environmentId: string, seed: number): Promise<string | null> {
    const KEY = `some-more/campsite-id/v1:${environmentId}`;
    try {
      const existing = localStorage.getItem(KEY);
      if (existing) return existing;
    } catch {
      /* fall through and create one */
    }
    if (!(await this.ensureAccount())) return null;
    const result = await this.client.createCampsite({ name, environmentId, seed });
    if (!result.ok) {
      this.lastError = result.error;
      this.notify();
      return null;
    }
    try {
      localStorage.setItem(KEY, result.value.id);
    } catch {
      /* not fatal */
    }
    return result.value.id;
  }

  private enqueue(operation: PendingOperation): void {
    // De-duplicate: the same sandwich queued twice is one upload.
    if (this.queue.some((existing) => existing.kind === operation.kind && existing.id === operation.id)) return;
    this.queue.push(operation);
    this.persist();
    this.notify();
    void this.drain();
  }

  private persist(): void {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(0, 200)));
    } catch {
      // Out of quota: the queue is a convenience, not the record of truth.
    }
  }

  /**
   * Sends whatever is waiting, one at a time, with backoff on failure.
   *
   * The re-entrancy guard is set *before* the first await, not after. An
   * earlier version authenticated first and only then claimed the lock, so
   * several callers could slip past it while the bootstrap was in flight and
   * send the same work repeatedly.
   */
  drain(): Promise<void> {
    // Awaiting a drain that is already running should wait for *that* one to
    // finish, not return immediately. Returning early made callers believe
    // the queue had been flushed when it had barely started.
    if (this.draining) return this.draining;
    if (this.queue.length === 0) return Promise.resolve();
    const run = this.runDrain();
    this.draining = run;
    void run.finally(() => {
      this.draining = null;
    });
    return run;
  }

  private async runDrain(): Promise<void> {
    {
      if (!this.client.authenticated) {
        const ok = await this.ensureAccount();
        if (!ok) {
          this.scheduleRetry();
          return;
        }
      }
      while (this.queue.length > 0) {
        const operation = this.queue[0] as PendingOperation;
        const result = await this.client.recordSandwich(operation.payload);

        if (result.ok) {
          this.queue.shift();
          this.lastError = null;
          this.persist();
          this.notify();
          continue;
        }

        // A conflict means the server already has it — that is success.
        if (result.error.kind === 'conflict') {
          this.queue.shift();
          this.persist();
          this.notify();
          continue;
        }

        operation.attempts++;
        this.lastError = result.error;
        if (operation.attempts >= MAX_ATTEMPTS) {
          // Stop retrying forever. The local record is untouched and the
          // player never learns anything went wrong.
          this.queue.shift();
          this.persist();
          this.notify();
          continue;
        }
        this.persist();
        this.notify();
        this.scheduleRetry(operation.attempts);
        return;
      }
    }
  }

  private scheduleRetry(attempts = 1): void {
    if (this.timer !== null) return;
    // Exponential backoff, capped, so a dead server costs almost nothing.
    const delay = Math.min(60_000, 1500 * 2 ** Math.min(attempts, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  /** Links an account, keeping everything already recorded. */
  async link(provider: 'apple' | 'google' | 'email', credential: string): Promise<boolean> {
    const result = await this.client.link(provider, credential);
    if (!result.ok) {
      this.lastError = result.error;
      this.notify();
      return false;
    }
    this.lastError = null;
    this.notify();
    // Anything queued now belongs to the linked account.
    void this.drain();
    return true;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

