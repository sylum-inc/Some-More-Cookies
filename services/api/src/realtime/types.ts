/**
 * The ports the realtime transport needs from the rest of the service.
 *
 * `attachRealtime` takes every one of these as a parameter rather than
 * importing the composition root: the transport is wired in `main.ts`, it owns
 * no state that the HTTP API does not already own, and — because these are
 * structural interfaces satisfied by the existing services — nothing in
 * `domain/` or `repos/` had to change to accommodate it.
 */

import type {
  AuthorityHandoffRequest,
  AuthorityHandoffResult,
  AuthorityRecord,
  Campsite,
  HeartbeatRequest,
  JoinCampsiteRequest,
  MemberRole,
  Presence,
  Session,
} from '@somemore/protocol';
import type { Clock } from '../clock.js';
import type { Logger } from '../logging.js';
import type { RealtimeLimitsConfig } from './limits.js';
import type { VoiceRoom } from './voice.js';

/** Satisfied by `SessionService`. */
export interface RealtimeSessionPort {
  get(accountId: string, sessionId: string): Promise<Session>;
  join(accountId: string, sessionId: string): Promise<Session>;
  leave(accountId: string, sessionId: string): Promise<Session>;
  heartbeat(accountId: string, sessionId: string, request: HeartbeatRequest): Promise<Presence>;
  listAuthority(accountId: string, sessionId: string): Promise<AuthorityRecord[]>;
  handoff(accountId: string, sessionId: string, request: AuthorityHandoffRequest): Promise<AuthorityHandoffResult>;
}

/** Satisfied by `CampsiteService`. */
export interface RealtimeCampsitePort {
  get(accountId: string, campsiteId: string): Promise<Campsite>;
  join(accountId: string, request: JoinCampsiteRequest): Promise<{ campsite: Campsite; role: MemberRole }>;
}

/** Satisfied by `ModerationRepository`. Blocks gate what gets relayed. */
export interface BlockDirectory {
  isBlocked(blockerAccountId: string, blockedAccountId: string): Promise<boolean>;
  listBlocks(blockerAccountId: string): Promise<readonly { readonly blockedAccountId: string }[]>;
  createBlock(block: { blockerAccountId: string; blockedAccountId: string; createdAt: string }): Promise<unknown>;
  deleteBlock(blockerAccountId: string, blockedAccountId: string): Promise<boolean>;
}

/** The same bearer-token check the HTTP API performs. One auth model, not two. */
export type RealtimeAuthenticate = (token: string, now: Date) => Promise<{ accountId: string }>;

export interface RealtimeDeps {
  readonly sessions: RealtimeSessionPort;
  readonly campsites: RealtimeCampsitePort;
  readonly authenticate: RealtimeAuthenticate;
  readonly blocks: BlockDirectory;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Defaults to a LiveKit adapter reading the environment. */
  readonly voice?: VoiceRoom;
  readonly limits?: Partial<RealtimeLimitsConfig>;
  /** Defaults to `REALTIME_PATH`. */
  readonly path?: string;
  /**
   * Drives heartbeats and lease expiry. Left on by default; tests turn it off
   * and call `sweep()` themselves so nothing depends on wall-clock timing.
   */
  readonly sweepIntervalMs?: number | null;
  /** Injectable id source, so connection ids can be made deterministic. */
  readonly newConnectionId?: () => string;
}

export interface RealtimeStats {
  readonly connections: number;
  readonly rooms: number;
  readonly participants: number;
  readonly inputsRelayed: number;
  readonly inputsRetained: number;
}

export interface RealtimeHandle {
  readonly path: string;
  readonly voice: VoiceRoom;
  readonly limits: RealtimeLimitsConfig;
  /** Heartbeat, dead-connection reaping and authority-lease expiry, one pass. */
  sweep(nowMs?: number): Promise<void>;
  stats(): RealtimeStats;
  /** Detach from the HTTP server and close every connection. */
  close(code?: number, reason?: string): Promise<void>;
}
