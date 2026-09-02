/**
 * The realtime transport.
 *
 * ```ts
 * import { attachRealtime } from './realtime/index.js';
 *
 * const realtime = attachRealtime(app.server, {
 *   sessions: app.services.sessions,
 *   campsites: app.services.campsites,
 *   blocks: app.repos.moderation,
 *   authenticate: async (token, now) => ({ accountId: tokens.verify(token, now).sub }),
 *   clock: app.clock,
 *   logger: app.logger,
 * });
 * ```
 *
 * Nothing else in the service needs to change: `attachRealtime` takes every
 * collaborator as a parameter and registers itself on the HTTP server's
 * `upgrade` event, so the socket shares the API's port, TLS and auth model.
 */

export { attachRealtime } from './server.js';
export type {
  BlockDirectory,
  RealtimeAuthenticate,
  RealtimeCampsitePort,
  RealtimeDeps,
  RealtimeHandle,
  RealtimeSessionPort,
  RealtimeStats,
} from './types.js';
export { DEFAULT_REALTIME_LIMITS, TokenBucket, wireLimits, type RealtimeLimitsConfig } from './limits.js';
export { SessionRoom, type RoomPeer } from './room.js';
export {
  createFakeVoiceRoom,
  createLiveKitVoiceRoom,
  liveKitConfigFromEnv,
  mintLiveKitToken,
  type FakeVoiceRoom,
  type LiveKitConfig,
  type VoiceRoom,
  type VoiceTokenRequest,
} from './voice.js';
export { WsConnection, type ConnectionClose, type ReadyState, type WsConnectionOptions } from './connection.js';
export {
  FrameReader,
  OPCODE,
  WsProtocolError,
  applyMask,
  decodeClosePayload,
  decodeUtf8,
  encodeClosePayload,
  encodeFrame,
  isControlOpcode,
  isValidCloseCode,
  type Frame,
} from './frame.js';
export {
  WS_GUID,
  acceptKey,
  buildAcceptResponse,
  buildRejectionResponse,
  extractToken,
  generateClientKey,
  isValidClientKey,
  negotiateSubprotocol,
  parseUpgradeRequest,
  verifyAcceptResponse,
} from './handshake.js';
export { HandshakeFailure, RealtimeClient, openWebSocket, type RealtimeClientOptions } from './client.js';
