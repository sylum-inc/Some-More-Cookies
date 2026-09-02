import type { Clock } from '../clock.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../logging.js';
import type { IdFactory } from '../ids.js';
import type { Mailer } from '../mailer.js';
import type { RateLimiter } from '../ratelimit.js';
import type { PaymentProvider } from '../payments/types.js';
import type { Repositories } from '../repos/interfaces.js';
import type { TokenSigner } from '../auth/tokens.js';

/**
 * Everything a domain module is allowed to reach for. Domain modules never
 * import each other's internals: when one needs another it takes the other's
 * public interface through this bag (see `ServiceRegistry` in app.ts).
 */
export interface DomainDeps {
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly config: ApiConfig;
  readonly payments: PaymentProvider;
  readonly mailer: Mailer;
  readonly rateLimiter: RateLimiter;
  readonly tokens: TokenSigner;
}
