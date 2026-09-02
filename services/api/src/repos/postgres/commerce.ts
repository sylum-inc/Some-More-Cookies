import type { Cart, IdempotencyRecord, Order, Product, Promotion } from '@somemore/protocol';
import type { PgClient, PgPool } from '../../db/wire/index.js';
import type {
  CartRepository,
  IdempotencyRepository,
  OrderRepository,
  ProductRepository,
  PromotionRepository,
} from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `products` (variants live inside the product document). */
export function createPostgresProductRepository(pool: PgPool): ProductRepository {
  const table = new DocTable<Product>(pool, {
    table: 'products',
    entityName: 'product',
    primaryKey: ['id'],
    keyOf: (p) => [p.id],
    project: () => ({}),
  });

  return {
    async list() {
      return table.all('seq');
    },
    async get(productId) {
      return table.find([productId]);
    },
    async update(productId, mutate) {
      return table.mutate([productId], mutate);
    },
  };
}

/** Seeds the catalog without clobbering inventory on redeploy. */
export async function seedProductCatalog(client: PgClient, seed: readonly Product[]): Promise<void> {
  for (const product of seed) {
    await client.query(
      'INSERT INTO somemore.products (id, doc) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
      [product.id, product],
    );
  }
}

/** Backs `carts`. `carts_one_open_per_account` is the invariant that matters. */
export function createPostgresCartRepository(pool: PgPool): CartRepository {
  const table = new DocTable<Cart>(pool, {
    table: 'carts',
    entityName: 'cart',
    primaryKey: ['id'],
    keyOf: (c) => [c.id],
    project: (c) => ({
      account_id: c.accountId,
      converted_order_id: c.convertedOrderId,
      created_at: c.createdAt,
    }),
  });

  return {
    async create(cart) {
      return table.insert(cart);
    },
    async get(cartId) {
      return table.find([cartId]);
    },
    async findOpenByAccount(accountId) {
      return table.first('account_id = $1 AND converted_order_id IS NULL', [accountId], 'seq');
    },
    async update(cartId, mutate) {
      return table.mutate([cartId], mutate);
    },
  };
}

/** Backs `orders`, including their lines, status history and refunds. */
export function createPostgresOrderRepository(pool: PgPool): OrderRepository {
  const table = new DocTable<Order>(pool, {
    table: 'orders',
    entityName: 'order',
    primaryKey: ['id'],
    keyOf: (o) => [o.id],
    project: (o) => ({
      account_id: o.accountId,
      payment_intent_id: o.payment === null ? null : o.payment.intentId,
      status: o.status,
      created_at: o.createdAt,
    }),
  });

  return {
    async create(order) {
      return table.insert(order);
    },
    async get(orderId) {
      return table.find([orderId]);
    },
    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'created_at DESC, seq');
    },
    async findByPaymentIntentId(intentId) {
      return table.first('payment_intent_id = $1', [intentId], 'seq');
    },
    async update(orderId, mutate) {
      return table.mutate([orderId], mutate);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      return table.reassign('account_id', 'accountId', fromAccountId, toAccountId);
    },
  };
}

/** Backs `promotions` + `promotion_redemptions`. */
export function createPostgresPromotionRepository(pool: PgPool): PromotionRepository {
  const table = new DocTable<Promotion>(pool, {
    table: 'promotions',
    entityName: 'promotion',
    primaryKey: ['id'],
    keyOf: (p) => [p.id],
    project: (p) => ({ code: p.code }),
  });

  return {
    async getByCode(code) {
      return table.first('code = $1', [code.toUpperCase()]);
    },
    async update(promotionId, mutate) {
      return table.mutate([promotionId], mutate);
    },
    async countRedemptionsForAccount(promotionId, accountId) {
      const row = await pool.maybeOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM somemore.promotion_redemptions
          WHERE promotion_id = $1 AND account_id = $2`,
        [promotionId, accountId],
      );
      return row?.n ?? 0;
    },
    async recordRedemption(promotionId, accountId, orderId) {
      await pool.query(
        `INSERT INTO somemore.promotion_redemptions (promotion_id, account_id, order_id)
         VALUES ($1, $2, $3)`,
        [promotionId, accountId, orderId],
      );
    },
  };
}

export async function seedPromotionCatalog(client: PgClient, seed: readonly Promotion[]): Promise<void> {
  for (const promotion of seed) {
    await client.query(
      'INSERT INTO somemore.promotions (id, code, doc) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING',
      [promotion.id, promotion.code, promotion],
    );
  }
}

/**
 * Backs `idempotency_records`.
 *
 * This is the one repository where the difference between "in memory" and
 * "durable" is load-bearing for correctness rather than for durability. `begin`
 * is a single `INSERT … ON CONFLICT DO NOTHING`: whichever of two racing
 * replays inserts the row runs the handler, and the other is told the key
 * already exists and falls through to the replay/conflict branches. There is no
 * window between the check and the claim, because there is no check.
 */
export function createPostgresIdempotencyRepository(pool: PgPool): IdempotencyRepository {
  const toRecord = (row: {
    account_scope: string;
    endpoint: string;
    key: string;
    request_hash: string;
    state: string;
    status_code: number | null;
    response_body: string | null;
    created_at: string;
    completed_at: string | null;
    expires_at: string;
  }): IdempotencyRecord => ({
    key: row.key,
    accountId: row.account_scope,
    endpoint: row.endpoint,
    requestHash: row.request_hash,
    state: row.state === 'completed' ? 'completed' : 'in_progress',
    statusCode: row.status_code,
    responseBody: row.response_body,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  });

  const SELECT_COLUMNS = `account_scope, endpoint, key, request_hash, state, status_code, response_body,
    to_char(created_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
    to_char(expires_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`;

  return {
    async get(accountScope, endpoint, key) {
      const row = await pool.maybeOne<Parameters<typeof toRecord>[0]>(
        `SELECT ${SELECT_COLUMNS} FROM somemore.idempotency_records
          WHERE account_scope = $1 AND endpoint = $2 AND key = $3`,
        [accountScope, endpoint, key],
      );
      return row === null ? null : toRecord(row);
    },

    async begin(record) {
      const result = await pool.query(
        `INSERT INTO somemore.idempotency_records
           (account_scope, endpoint, key, request_hash, state, status_code, response_body,
            created_at, completed_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz)
         ON CONFLICT (account_scope, endpoint, key) DO NOTHING`,
        [
          record.accountId,
          record.endpoint,
          record.key,
          record.requestHash,
          record.state,
          record.statusCode,
          record.responseBody,
          record.createdAt,
          record.completedAt,
          record.expiresAt,
        ],
      );
      return result.rowCount > 0 ? 'started' : 'exists';
    },

    async complete(accountScope, endpoint, key, statusCode, responseBody, completedAt) {
      await pool.query(
        `UPDATE somemore.idempotency_records
            SET state = 'completed', status_code = $4, response_body = $5, completed_at = $6::timestamptz
          WHERE account_scope = $1 AND endpoint = $2 AND key = $3`,
        [accountScope, endpoint, key, statusCode, responseBody, completedAt],
      );
    },

    async release(accountScope, endpoint, key) {
      await pool.query(
        `DELETE FROM somemore.idempotency_records
          WHERE account_scope = $1 AND endpoint = $2 AND key = $3`,
        [accountScope, endpoint, key],
      );
    },

    async purgeExpired(nowIso) {
      const result = await pool.query(
        'DELETE FROM somemore.idempotency_records WHERE expires_at <= $1::timestamptz',
        [nowIso],
      );
      return result.rowCount;
    },
  };
}
