import { createApp } from './app.js';
import { attachRealtime } from './realtime/index.js';
import { describeRoutes } from './routes/index.js';

/**
 * Local entry point: `npm run api` (node --experimental-strip-types src/main.ts).
 * Everything is in memory; see README for what a production boot would need.
 */
const app = createApp();

/*
 * The realtime transport.
 *
 * It shares this process, this port, this TLS terminator and this auth model
 * with the REST API — that was the whole point of attaching to the `upgrade`
 * event rather than deploying a second service. Without this line the entire
 * WebSocket stack is unreachable in a real boot, which it was: the module
 * comment promised "a one-liner in main.ts" and the one-liner had never been
 * written, so every socket a client opened would have been answered by
 * `node:http` with nothing at all.
 *
 * Voice defaults to the LiveKit adapter reading `LIVEKIT_*` from the
 * environment, which reports `not_configured` and never throws when there are
 * no credentials — the campfire carries on with text and gesture.
 */
const realtime = attachRealtime(app.server, {
  sessions: app.services.sessions,
  campsites: app.services.campsites,
  blocks: app.repos.moderation,
  authenticate: app.authenticate,
  clock: app.clock,
  logger: app.logger,
});

app.server.listen(app.config.port, app.config.host, () => {
  app.logger.info('api.listening', {
    host: app.config.host,
    port: app.config.port,
    paymentProvider: app.payments.name,
    paymentsConfigured: app.payments.isConfigured(),
    mailer: app.mailer.name,
    routes: app.router.routes.length,
    realtimePath: realtime.path,
    voiceProvider: realtime.voice.provider,
    voiceConfigured: realtime.voice.isConfigured(),
  });
  if (app.config.logLevel === 'debug') {
    for (const line of describeRoutes(app.router.routes)) app.logger.debug('api.route', { route: line });
  }
});

function shutdown(signal: string): void {
  app.logger.info('api.shutdown', { signal });
  // Upgraded sockets are not HTTP requests, so `server.close()` waits on them
  // forever unless the transport hangs up first.
  void realtime.close().finally(() => {
    app.server.closeAllConnections();
    app.server.close(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
