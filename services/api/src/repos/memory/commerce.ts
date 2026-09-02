import type { Cart, IdempotencyRecord, Order, Product, Promotion } from '@somemore/protocol';
import type {
  CartRepository,
  IdempotencyRepository,
  OrderRepository,
  ProductRepository,
  PromotionRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `products` + `product_variants`. Seeded from domain/seed.ts. */
export function createMemoryProductRepository(seed: readonly Product[] = []): ProductRepository {
  const table = new MemoryTable<Product>('product', (p) => p.id);
  for (const product of seed) table.put(product);
  return {
    async list() {
      return table.all();
    },
    async get(productId) {
      return table.find(productId);
    },
    async update(productId, mutate) {
      return table.mutate(productId, mutate);
    },
  };
}

/** Backs `carts` + `cart_items`. */
export function createMemoryCartRepository(): CartRepository {
  const table = new MemoryTable<Cart>('cart', (c) => c.id);
  return {
    async create(cart) {
      return table.insert(cart);
    },
    async get(cartId) {
      return table.find(cartId);
    },
    async findOpenByAccount(accountId) {
      return table.first((c) => c.accountId === accountId && c.convertedOrderId === null);
    },
    async update(cartId, mutate) {
      return table.mutate(cartId, mutate);
    },
  };
}

/** Backs `orders`, `order_lines`, `order_status_events`, `refunds`. */
export function createMemoryOrderRepository(): OrderRepository {
  const table = new MemoryTable<Order>('order', (o) => o.id);
  return {
    async create(order) {
      return table.insert(order);
    },
    async get(orderId) {
      return table.find(orderId);
    },
    async listByAccount(accountId) {
      return table
        .filter((o) => o.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async findByPaymentIntentId(intentId) {
      return table.first((o) => o.payment !== null && o.payment.intentId === intentId);
    },
    async update(orderId, mutate) {
      return table.mutate(orderId, mutate);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const order of table.filter((o) => o.accountId === fromAccountId)) {
        table.put({ ...order, accountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
  };
}

/** Backs `promotions` + `promotion_redemptions`. */
export function createMemoryPromotionRepository(seed: readonly Promotion[] = []): PromotionRepository {
  const table = new MemoryTable<Promotion>('promotion', (p) => p.id);
  for (const promotion of seed) table.put(promotion);
  const redemptions: Array<{ promotionId: string; accountId: string; orderId: string }> = [];
  return {
    async getByCode(code) {
      return table.first((p) => p.code === code.toUpperCase());
    },
    async update(promotionId, mutate) {
      return table.mutate(promotionId, mutate);
    },
    async countRedemptionsForAccount(promotionId, accountId) {
      return redemptions.filter((r) => r.promotionId === promotionId && r.accountId === accountId).length;
    },
    async recordRedemption(promotionId, accountId, orderId) {
      redemptions.push({ promotionId, accountId, orderId });
    },
  };
}

/**
 * Backs `idempotency_records`. The (account_scope, endpoint, key) tuple is the
 * primary key, exactly as in Postgres; `begin` is the INSERT ... ON CONFLICT DO
 * NOTHING that makes concurrent replays safe.
 */
export function createMemoryIdempotencyRepository(): IdempotencyRepository {
  const rows = new Map<string, IdempotencyRecord>();
  const keyOf = (scope: string, endpoint: string, key: string) => `${scope} ${endpoint} ${key}`;

  return {
    async get(accountScope, endpoint, key) {
      const row = rows.get(keyOf(accountScope, endpoint, key));
      return row === undefined ? null : structuredClone(row);
    },
    async begin(record) {
      const k = keyOf(record.accountId, record.endpoint, record.key);
      if (rows.has(k)) return 'exists';
      rows.set(k, structuredClone(record));
      return 'started';
    },
    async complete(accountScope, endpoint, key, statusCode, responseBody, completedAt) {
      const k = keyOf(accountScope, endpoint, key);
      const existing = rows.get(k);
      if (existing === undefined) return;
      rows.set(k, { ...existing, state: 'completed', statusCode, responseBody, completedAt });
    },
    async release(accountScope, endpoint, key) {
      rows.delete(keyOf(accountScope, endpoint, key));
    },
    async purgeExpired(nowIso) {
      let purged = 0;
      for (const [k, row] of rows) {
        if (row.expiresAt <= nowIso) {
          rows.delete(k);
          purged += 1;
        }
      }
      return purged;
    },
  };
}
