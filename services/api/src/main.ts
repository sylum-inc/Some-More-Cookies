import { createApp } from './app.js';
import { describeRoutes } from './routes/index.js';

/**
 * Local entry point: `npm run api` (node --experimental-strip-types src/main.ts).
 * Everything is in memory; see README for what a production boot would need.
 */
const app = createApp();

app.server.listen(app.config.port, app.config.host, () => {
  app.logger.info('api.listening', {
    host: app.config.host,
    port: app.config.port,
    paymentProvider: app.payments.name,
    paymentsConfigured: app.payments.isConfigured(),
    mailer: app.mailer.name,
    routes: app.router.routes.length,
  });
  if (app.config.logLevel === 'debug') {
    for (const line of describeRoutes(app.router.routes)) app.logger.debug('api.route', { route: line });
  }
});

function shutdown(signal: string): void {
  app.logger.info('api.shutdown', { signal });
  app.server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
