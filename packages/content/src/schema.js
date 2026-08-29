/**
 * The environment content schema (spec §5.4, architecture §9).
 *
 * An environment is **data**. Adding one requires no engine change: the
 * renderer, the audio engine, the wildlife system and the radio all read from
 * the shapes below. Nothing in this file imports a renderer, touches the DOM,
 * or knows what a frame is.
 *
 * Two rules from the spec are encoded structurally rather than left to
 * discipline:
 *
 * 1. **Region never locks content** (§5.4). A `DiscoveryRule` carries a
 *    strictly positive base weight and regional *multipliers* clamped into
 *    `[MIN_REGION_AFFINITY, MAX_REGION_AFFINITY]`, both above zero — so the
 *    effective weight of every environment in every region is always positive.
 *    There is no representation for "unavailable here".
 * 2. **Mystery is optional** (§8). `SecretEntry.optional` and
 *    `SecretEntry.gatesNothing` are literal `true`; a secret that gates
 *    something is not expressible, and the validator rejects any attempt.
 */
/** sRGB hex → linear RGB triple, for renderers that work in linear space. */
export function hexToLinearRgb(hex) {
    const clean = hex.replace('#', '');
    const toLinear = (byte) => {
        const s = byte / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return [
        toLinear(parseInt(clean.slice(0, 2), 16)),
        toLinear(parseInt(clean.slice(2, 4), 16)),
        toLinear(parseInt(clean.slice(4, 6), 16)),
    ];
}
export const REVERB_SPACES = [
    'openForest',
    'clearing',
    'canyon',
    'snowfield',
    'indoorSmall',
];
export const REGIONS = [
    'boreal',
    'maritime-west',
    'maritime-east',
    'continental-interior',
    'arid-interior',
    'highland',
    'humid-subtropical',
    'mediterranean',
    'unknown',
];
/**
 * Affinity multipliers are clamped into this band. Both ends are strictly
 * positive, which is *the* mechanism behind "region never locks content":
 * an environment's effective weight can be nudged down to a quarter, never
 * to nothing.
 */
export const MIN_REGION_AFFINITY = 0.25;
export const MAX_REGION_AFFINITY = 4;
export const SEASONAL_EVENT_KINDS = [
    'sky-event',
    'weather',
    'campsite',
    'flavour',
    'station',
];
/** `['*']` means every environment in the catalogue, present and future. */
export const ALL_ENVIRONMENTS = '*';
//# sourceMappingURL=schema.js.map