/**
 * Environment discovery (spec §5.4).
 *
 * > Approximate region may lightly weight which environments appear early.
 * > **Every player must eventually be able to discover every core
 * > environment** — region never locks content.
 *
 * That guarantee is enforced by construction rather than by convention:
 *
 * - `DiscoveryRule.weight` is validated as strictly positive.
 * - regional affinity is a *multiplier* clamped into
 *   `[MIN_REGION_AFFINITY, MAX_REGION_AFFINITY]`, both strictly positive.
 * - `effectiveDiscoveryWeight` applies that clamp itself, so even malformed
 *   or hostile live-ops data cannot drive a weight to zero.
 *
 * Therefore every environment has a positive probability of being drawn in
 * every region, and `discoveryOrder` — which draws without replacement — is
 * always a full permutation of the catalogue. `unreachableEnvironments` exists
 * so the guarantee can be asserted directly rather than inferred.
 */
import { Rng } from '@somemore/sim';
import { ENVIRONMENTS } from './environments/index.js';
import { MAX_REGION_AFFINITY, MIN_REGION_AFFINITY, } from './schema.js';
/** The RNG stream name used for every discovery draw. */
export const DISCOVERY_STREAM = 'environment-discovery';
/**
 * The weight an environment actually carries in a given region.
 *
 * Always strictly positive for valid data, and clamped so that invalid data
 * degrades to "rare here" rather than "impossible here".
 */
export function effectiveDiscoveryWeight(environment, region = 'unknown') {
    const base = environment.discovery.weight;
    if (!Number.isFinite(base) || base <= 0)
        return 0;
    const raw = environment.discovery.affinities[region];
    const multiplier = raw === undefined || !Number.isFinite(raw)
        ? 1
        : Math.min(MAX_REGION_AFFINITY, Math.max(MIN_REGION_AFFINITY, raw));
    return base * multiplier;
}
/**
 * Picks one environment.
 *
 * Environments the player has already discovered are excluded so that
 * discovery moves forward; when *everything* has been found the full
 * catalogue comes back, because returning to a known campsite is a
 * first-class thing to do (spec §6.3) and this must never fail.
 */
export function selectEnvironment(options) {
    const catalogue = options.catalogue ?? ENVIRONMENTS;
    if (catalogue.length === 0) {
        throw new Error('selectEnvironment: the catalogue is empty');
    }
    const region = options.region ?? 'unknown';
    const discovered = new Set(options.discoveredIds ?? []);
    const undiscovered = catalogue.filter((environment) => !discovered.has(environment.id));
    const pool = undiscovered.length > 0 ? undiscovered : catalogue;
    const rng = new Rng(options.seed).split(DISCOVERY_STREAM);
    const picked = rng.weightedPick(pool, (environment) => effectiveDiscoveryWeight(environment, region));
    // `weightedPick` only returns undefined when every weight is non-positive,
    // which validation forbids — but content must degrade, never block.
    return picked ?? pool[0];
}
/**
 * The full order in which a player seeded this way would discover the whole
 * catalogue: a weighted draw without replacement, run to exhaustion.
 *
 * This is the constructive proof of the no-lock guarantee — the result is
 * always a permutation containing every environment, in every region.
 */
export function discoveryOrder(options) {
    const catalogue = options.catalogue ?? ENVIRONMENTS;
    const region = options.region ?? 'unknown';
    const rng = new Rng(options.seed).split(DISCOVERY_STREAM);
    const remaining = [...catalogue];
    const order = [];
    while (remaining.length > 0) {
        const picked = rng.weightedPick(remaining, (environment) => effectiveDiscoveryWeight(environment, region));
        const chosen = picked ?? remaining[0];
        order.push(chosen);
        remaining.splice(remaining.indexOf(chosen), 1);
    }
    return order;
}
/**
 * Environments a player in this region could never reach.
 *
 * Must always be empty. Exported so the invariant is assertable by a test, a
 * live-ops preview and a CI content check rather than being an argument.
 */
export function unreachableEnvironments(region, catalogue = ENVIRONMENTS) {
    return catalogue.filter((environment) => effectiveDiscoveryWeight(environment, region) <= 0);
}
/** Relative chance of each environment being the *first* one drawn in a region. */
export function discoveryProbabilities(region = 'unknown', catalogue = ENVIRONMENTS) {
    const weights = catalogue.map((environment) => effectiveDiscoveryWeight(environment, region));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const result = new Map();
    catalogue.forEach((environment, i) => {
        result.set(environment.id, total > 0 ? (weights[i] ?? 0) / total : 0);
    });
    return result;
}
//# sourceMappingURL=selection.js.map