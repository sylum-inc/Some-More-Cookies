import type { IdempotencyRecord } from '@somemore/protocol';
import type { Clock } from './clock.js';
import type { ApiConfig } from './config.js';
import { ApiError } from './errors.js';
import type { Logger } from './logging.js';
import type { IdempotencyRepository } from './repos/interfaces.js';

export interface IdempotentExecution {
  readonly status: number;
  readonly body: unknown;
  readonly replayed: boolean;
}

export interface IdempotencyLayer {
  run(
    args: {
      scope: string;
      endpoint: string;
      key: string;
      requestHash: string;
    },
    handler: () => Promise<{ status: number; body: unknown }>,
  ): Promise<IdempotentExecution>;
}

/**
 * Replay safety for mutating endpoints.
 *
 * Contract, exactly as advertised to clients:
 *  - same key + same payload, already completed  -> the ORIGINAL response, with
 *    `Idempotent-Replay: true`. The handler does not run again.
 *  - same key + different payload                -> 409 `idempotency_key_conflict`.
 *  - same key + same payload, still in flight    -> 409 `conflict` (retry later).
 *  - handler throws                              -> the record is released so a
 *    genuine retry can succeed. A failed call must not poison the key.
 */
export function createIdempotencyLayer(deps: {
  repo: IdempotencyRepository;
  clock: Clock;
  config: ApiConfig;
  logger: Logger;
}): IdempotencyLayer {
  const { repo, clock, config, logger } = deps;

  return {
    async run({ scope, endpoint, key, requestHash }, handler) {
      const now = clock.now();
      const record: IdempotencyRecord = {
        key,
        accountId: scope,
        endpoint,
        requestHash,
        state: 'in_progress',
        statusCode: null,
        responseBody: null,
        createdAt: now.toISOString(),
        completedAt: null,
        expiresAt: new Date(now.getTime() + config.idempotencyTtlSeconds * 1000).toISOString(),
      };

      const started = await repo.begin(record);
      if (started === 'exists') {
        const existing = await repo.get(scope, endpoint, key);
        if (existing === null) {
          throw new ApiError('conflict', 'That idempotency key is being retried; try again in a moment.');
        }
        if (existing.requestHash !== requestHash) {
          throw new ApiError(
            'idempotency_key_conflict',
            'This idempotency key was already used with a different request body.',
            { details: { endpoint, key } },
          );
        }
        if (existing.state === 'in_progress') {
          throw new ApiError('conflict', 'An identical request is still in flight. Retry shortly.', {
            headers: { 'retry-after': '1' },
          });
        }
        logger.debug('idempotency.replay', { endpoint, key });
        return {
          status: existing.statusCode ?? 200,
          body: existing.responseBody === null ? undefined : (JSON.parse(existing.responseBody) as unknown),
          replayed: true,
        };
      }

      try {
        const result = await handler();
        await repo.complete(
          scope,
          endpoint,
          key,
          result.status,
          JSON.stringify(result.body ?? null),
          clock.isoNow(),
        );
        return { status: result.status, body: result.body, replayed: false };
      } catch (error) {
        await repo.release(scope, endpoint, key);
        throw error;
      }
    },
  };
}
