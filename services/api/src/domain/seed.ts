import {
  ProductSchema,
  PromotionSchema,
  RewardDefinitionSchema,
  type Product,
  type Promotion,
  type RewardDefinition,
} from '@somemore/protocol';

/**
 * Launch content. Deliberately tiny: ONE flagship product, two promotions and
 * the reward definitions the game grants. Commerce is subordinate to the
 * experience — this is the entire shop.
 */
const EPOCH = '2026-01-01T00:00:00.000Z';

export const FLAGSHIP_PRODUCT_ID = 'prd_some_more_kit';
export const FOUR_PACK_VARIANT_ID = 'var_four_pack';
export const EIGHT_PACK_VARIANT_ID = 'var_eight_pack';

export function seedProducts(): Product[] {
  return [
    ProductSchema.parse({
      id: FLAGSHIP_PRODUCT_ID,
      sku: 'SM-KIT-001',
      name: 'The Some More Kit',
      subtitle: 'The sandwich you made, made real.',
      description:
        'Roasted-marshmallow ice cream sandwiches, pressed the way the SM-01 presses them, packed in dry ice and '
        + 'shipped frozen. Graham shells, torched marshmallow swirl, a seam of dark chocolate.',
      kind: 'physical',
      status: 'active',
      basePrice: { currency: 'USD', amountMinor: 3200 },
      variants: [
        {
          id: FOUR_PACK_VARIANT_ID,
          sku: 'SM-KIT-001-4',
          name: 'Four pack',
          priceDelta: { currency: 'USD', amountMinor: 0 },
          inventoryPolicy: 'track',
          inventoryQuantity: 500,
          weightGrams: 900,
          attributes: { count: '4' },
        },
        {
          id: EIGHT_PACK_VARIANT_ID,
          sku: 'SM-KIT-001-8',
          name: 'Eight pack',
          priceDelta: { currency: 'USD', amountMinor: 2400 },
          inventoryPolicy: 'track',
          inventoryQuantity: 250,
          weightGrams: 1700,
          attributes: { count: '8' },
        },
      ],
      imageKeys: ['catalog/some-more-kit/hero.jpg'],
      requiresShipping: true,
      taxCode: 'food_frozen',
      maxPerOrder: 4,
      shipsToCountries: ['US'],
      createdAt: EPOCH,
      updatedAt: EPOCH,
    }),
  ];
}

export function seedPromotions(): Promotion[] {
  return [
    PromotionSchema.parse({
      id: 'pro_first_fire',
      code: 'FIRSTFIRE',
      name: 'First Fire',
      rule: { kind: 'percent_off', percent: 15 },
      startsAt: EPOCH,
      perAccountLimit: 1,
      stackable: false,
    }),
    PromotionSchema.parse({
      id: 'pro_cold_chain',
      code: 'FREESHIP',
      name: 'Free Cold Chain',
      rule: { kind: 'free_shipping' },
      startsAt: EPOCH,
      minSubtotal: { currency: 'USD', amountMinor: 6000 },
      perAccountLimit: 2,
      stackable: true,
    }),
  ];
}

export function seedRewards(): RewardDefinition[] {
  return [
    RewardDefinitionSchema.parse({
      id: 'rwd_first_roast',
      code: 'first_roast',
      kind: 'stamp',
      name: 'First Roast',
      description: 'You held a marshmallow over a fire and did not drop it. Mostly.',
      rarity: 'common',
      points: 10,
      payloadCode: 'first_roast',
    }),
    RewardDefinitionSchema.parse({
      id: 'rwd_golden_brown',
      code: 'golden_brown',
      kind: 'patch',
      name: 'Golden Brown',
      description: 'An evenly toasted marshmallow, all the way around.',
      rarity: 'uncommon',
      points: 25,
      payloadCode: 'golden_brown',
      prerequisites: [{ kind: 'min_sandwich_score', score: 0.85 }],
    }),
    RewardDefinitionSchema.parse({
      id: 'rwd_machine_whisperer',
      code: 'machine_whisperer',
      kind: 'unlock',
      name: 'Machine Whisperer',
      description: 'Ten clean runs through the SM-01.',
      rarity: 'rare',
      points: 100,
      payloadCode: 'sm01_finish_brushed_brass',
      prerequisites: [{ kind: 'sandwiches_made', count: 10 }],
    }),
    RewardDefinitionSchema.parse({
      id: 'rwd_free_kit',
      code: 'free_kit',
      kind: 'perk',
      name: 'A Kit, On Us',
      description: 'One real Some More Kit, shipped free. Server-validated, one per player, ever.',
      rarity: 'legendary',
      valueTier: 'high',
      points: 0,
      payloadCode: 'SM-KIT-001-4',
      prerequisites: [
        { kind: 'sandwiches_made', count: 1 },
        { kind: 'min_sandwich_score', score: 0.8 },
      ],
      perAccountLimit: 1,
      globalLimit: 500,
    }),
    RewardDefinitionSchema.parse({
      id: 'rwd_founders_ticket',
      code: 'founders_ticket',
      kind: 'perk',
      name: "Founder's Ticket",
      description: 'A stub for the opening night campfire. Requires a linked account so we can actually reach you.',
      rarity: 'legendary',
      valueTier: 'high',
      payloadCode: 'ticket_opening_night',
      prerequisites: [{ kind: 'linked_identity', provider: 'email' }],
      perAccountLimit: 1,
      globalLimit: 100,
    }),
  ];
}
