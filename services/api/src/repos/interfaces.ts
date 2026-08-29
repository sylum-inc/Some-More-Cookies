import type {
  Account,
  AuthorityRecord,
  Campsite,
  CampsiteInvite,
  CampfirePassport,
  Cart,
  IdempotencyRecord,
  Identity,
  IngestedEvent,
  Landmark,
  ModerationReport,
  Order,
  PhotoRef,
  Product,
  Promotion,
  RewardClaim,
  RewardDefinition,
  RewardGrant,
  SandwichRecord,
  Session,
  WorldTrace,
  Block,
} from '@somemore/protocol';

/*
 * Repository interfaces — one per aggregate, grouped by domain module.
 *
 * Rules:
 *  - Repositories own persistence only. No business rules, no validation
 *    beyond storage invariants, no cross-aggregate orchestration.
 *  - Every method is async so the Postgres adapter is a drop-in.
 *  - Reads return deep copies; callers may mutate what they receive freely.
 *
 * `services/api/sql/schema.sql` documents which table backs which interface.
 */

/* -------------------------------------------------------------------------- */
/* identity                                                                    */
/* -------------------------------------------------------------------------- */

export interface AccountRepository {
  create(account: Account): Promise<Account>;
  get(accountId: string): Promise<Account | null>;
  update(accountId: string, mutate: (current: Account) => Account): Promise<Account>;
  count(): Promise<number>;
}

export interface IdentityRepository {
  create(identity: Identity): Promise<Identity>;
  get(identityId: string): Promise<Identity | null>;
  findByProviderSubject(provider: Identity['provider'], subject: string): Promise<Identity | null>;
  findVerifiedByEmail(email: string): Promise<Identity | null>;
  listByAccount(accountId: string): Promise<Identity[]>;
  update(identityId: string, mutate: (current: Identity) => Identity): Promise<Identity>;
  /** Used by account merges. Returns the number of rows moved. */
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
  /** Anti-abuse: how many distinct accounts have bootstrapped on a device. */
  countAccountsByAnonymousSubject(subject: string): Promise<number>;
}

export interface MagicLinkRecord {
  readonly token: string;
  readonly email: string;
  readonly requestedByAccountId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  consumedAt: string | null;
}

export interface MagicLinkRepository {
  create(record: MagicLinkRecord): Promise<MagicLinkRecord>;
  get(token: string): Promise<MagicLinkRecord | null>;
  consume(token: string, at: string): Promise<MagicLinkRecord | null>;
}

/* -------------------------------------------------------------------------- */
/* passport                                                                    */
/* -------------------------------------------------------------------------- */

export interface PassportRepository {
  create(passport: CampfirePassport): Promise<CampfirePassport>;
  get(accountId: string): Promise<CampfirePassport | null>;
  update(accountId: string, mutate: (current: CampfirePassport) => CampfirePassport): Promise<CampfirePassport>;
  findByHandle(handle: string): Promise<CampfirePassport | null>;
  delete(accountId: string): Promise<void>;
}

export interface PhotoRepository {
  create(photo: PhotoRef): Promise<PhotoRef>;
  get(photoId: string): Promise<PhotoRef | null>;
  listByAccount(accountId: string): Promise<PhotoRef[]>;
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* campsites                                                                   */
/* -------------------------------------------------------------------------- */

export interface CampsiteRepository {
  create(campsite: Campsite): Promise<Campsite>;
  get(campsiteId: string): Promise<Campsite | null>;
  update(campsiteId: string, mutate: (current: Campsite) => Campsite): Promise<Campsite>;
  findByCampCode(campCode: string): Promise<Campsite | null>;
  listByMember(accountId: string): Promise<Campsite[]>;
  listByOwner(accountId: string): Promise<Campsite[]>;
  /** Merge support: move ownership and membership rows to the surviving account. */
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

export interface InviteRepository {
  create(invite: CampsiteInvite): Promise<CampsiteInvite>;
  get(inviteId: string): Promise<CampsiteInvite | null>;
  findByToken(token: string): Promise<CampsiteInvite | null>;
  findByCampCode(campCode: string): Promise<CampsiteInvite | null>;
  listByCampsite(campsiteId: string): Promise<CampsiteInvite[]>;
  update(inviteId: string, mutate: (current: CampsiteInvite) => CampsiteInvite): Promise<CampsiteInvite>;
}

/* -------------------------------------------------------------------------- */
/* worldState                                                                  */
/* -------------------------------------------------------------------------- */

export interface WorldTraceRepository {
  create(trace: WorldTrace): Promise<WorldTrace>;
  get(traceId: string): Promise<WorldTrace | null>;
  listByCampsite(campsiteId: string): Promise<WorldTrace[]>;
  update(traceId: string, mutate: (current: WorldTrace) => WorldTrace): Promise<WorldTrace>;
  delete(traceId: string): Promise<void>;
}

export interface LandmarkRepository {
  create(landmark: Landmark): Promise<Landmark>;
  get(landmarkId: string): Promise<Landmark | null>;
  listByCampsite(campsiteId: string): Promise<Landmark[]>;
  update(landmarkId: string, mutate: (current: Landmark) => Landmark): Promise<Landmark>;
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  get(sessionId: string): Promise<Session | null>;
  listByCampsite(campsiteId: string): Promise<Session[]>;
  findActiveByCampsite(campsiteId: string): Promise<Session | null>;
  update(sessionId: string, mutate: (current: Session) => Session): Promise<Session>;
}

export interface AuthorityRepository {
  get(sessionId: string, objectId: string): Promise<AuthorityRecord | null>;
  put(record: AuthorityRecord): Promise<AuthorityRecord>;
  listBySession(sessionId: string): Promise<AuthorityRecord[]>;
  /** Release everything a disconnecting player was holding. */
  releaseAllHeldBy(sessionId: string, accountId: string, at: string): Promise<AuthorityRecord[]>;
}

/* -------------------------------------------------------------------------- */
/* sandwiches                                                                  */
/* -------------------------------------------------------------------------- */

export interface SandwichRepository {
  create(record: SandwichRecord): Promise<SandwichRecord>;
  get(sandwichId: string): Promise<SandwichRecord | null>;
  listByAccount(accountId: string): Promise<SandwichRecord[]>;
  countByAccount(accountId: string): Promise<number>;
  bestScoreForAccount(accountId: string): Promise<number>;
  update(sandwichId: string, mutate: (current: SandwichRecord) => SandwichRecord): Promise<SandwichRecord>;
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* rewards                                                                     */
/* -------------------------------------------------------------------------- */

export interface RewardDefinitionRepository {
  list(): Promise<RewardDefinition[]>;
  getByCode(code: string): Promise<RewardDefinition | null>;
  get(rewardId: string): Promise<RewardDefinition | null>;
  update(rewardId: string, mutate: (current: RewardDefinition) => RewardDefinition): Promise<RewardDefinition>;
}

export interface RewardGrantRepository {
  create(grant: RewardGrant): Promise<RewardGrant>;
  get(grantId: string): Promise<RewardGrant | null>;
  listByAccount(accountId: string): Promise<RewardGrant[]>;
  countForAccountAndReward(accountId: string, rewardId: string): Promise<number>;
  update(grantId: string, mutate: (current: RewardGrant) => RewardGrant): Promise<RewardGrant>;
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

export interface RewardClaimRepository {
  create(claim: RewardClaim): Promise<RewardClaim>;
  get(claimId: string): Promise<RewardClaim | null>;
  listByAccount(accountId: string): Promise<RewardClaim[]>;
  findByAccountAndReward(accountId: string, rewardId: string): Promise<RewardClaim | null>;
  findByNonce(nonce: string): Promise<RewardClaim | null>;
  countSince(accountId: string, sinceIso: string): Promise<number>;
  update(claimId: string, mutate: (current: RewardClaim) => RewardClaim): Promise<RewardClaim>;
}

/* -------------------------------------------------------------------------- */
/* commerce                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProductRepository {
  list(): Promise<Product[]>;
  get(productId: string): Promise<Product | null>;
  update(productId: string, mutate: (current: Product) => Product): Promise<Product>;
}

export interface CartRepository {
  create(cart: Cart): Promise<Cart>;
  get(cartId: string): Promise<Cart | null>;
  findOpenByAccount(accountId: string): Promise<Cart | null>;
  update(cartId: string, mutate: (current: Cart) => Cart): Promise<Cart>;
}

export interface OrderRepository {
  create(order: Order): Promise<Order>;
  get(orderId: string): Promise<Order | null>;
  listByAccount(accountId: string): Promise<Order[]>;
  findByPaymentIntentId(intentId: string): Promise<Order | null>;
  update(orderId: string, mutate: (current: Order) => Order): Promise<Order>;
  reassignAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

export interface PromotionRepository {
  getByCode(code: string): Promise<Promotion | null>;
  update(promotionId: string, mutate: (current: Promotion) => Promotion): Promise<Promotion>;
  countRedemptionsForAccount(promotionId: string, accountId: string): Promise<number>;
  recordRedemption(promotionId: string, accountId: string, orderId: string): Promise<void>;
}

/** Backs the replay-safety layer for every mutating endpoint. */
export interface IdempotencyRepository {
  get(accountScope: string, endpoint: string, key: string): Promise<IdempotencyRecord | null>;
  begin(record: IdempotencyRecord): Promise<'started' | 'exists'>;
  complete(
    accountScope: string,
    endpoint: string,
    key: string,
    statusCode: number,
    responseBody: string,
    completedAt: string,
  ): Promise<void>;
  release(accountScope: string, endpoint: string, key: string): Promise<void>;
  purgeExpired(nowIso: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* moderation                                                                  */
/* -------------------------------------------------------------------------- */

export interface ModerationRepository {
  createReport(report: ModerationReport): Promise<ModerationReport>;
  getReport(reportId: string): Promise<ModerationReport | null>;
  listReportsByReporter(accountId: string): Promise<ModerationReport[]>;
  updateReport(reportId: string, mutate: (current: ModerationReport) => ModerationReport): Promise<ModerationReport>;
  createBlock(block: Block): Promise<Block>;
  deleteBlock(blockerAccountId: string, blockedAccountId: string): Promise<boolean>;
  listBlocks(blockerAccountId: string): Promise<Block[]>;
  isBlocked(blockerAccountId: string, blockedAccountId: string): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* analytics                                                                   */
/* -------------------------------------------------------------------------- */

export interface AnalyticsRepository {
  append(events: readonly IngestedEvent[]): Promise<{ accepted: number; duplicates: number }>;
  list(limit?: number): Promise<IngestedEvent[]>;
  count(): Promise<number>;
  remapAccount(fromAccountId: string, toAccountId: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface Repositories {
  readonly accounts: AccountRepository;
  readonly identities: IdentityRepository;
  readonly magicLinks: MagicLinkRepository;
  readonly passports: PassportRepository;
  readonly photos: PhotoRepository;
  readonly campsites: CampsiteRepository;
  readonly invites: InviteRepository;
  readonly traces: WorldTraceRepository;
  readonly landmarks: LandmarkRepository;
  readonly sessions: SessionRepository;
  readonly authority: AuthorityRepository;
  readonly sandwiches: SandwichRepository;
  readonly rewardDefinitions: RewardDefinitionRepository;
  readonly rewardGrants: RewardGrantRepository;
  readonly rewardClaims: RewardClaimRepository;
  readonly products: ProductRepository;
  readonly carts: CartRepository;
  readonly orders: OrderRepository;
  readonly promotions: PromotionRepository;
  readonly idempotency: IdempotencyRepository;
  readonly moderation: ModerationRepository;
  readonly analytics: AnalyticsRepository;
}
