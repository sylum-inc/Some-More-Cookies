/**
 * Lookup helpers over the launch catalogue.
 *
 * Kept separate from `selection.ts` so that a caller which only needs "give me
 * the environment this campsite record points at" does not pull in the
 * discovery machinery.
 */
import { ENVIRONMENTS } from './environments/index.js';
const BY_ID = new Map(ENVIRONMENTS.map((environment) => [environment.id, environment]));
/** Every launch environment, in authoring order. */
export function listEnvironments() {
    return ENVIRONMENTS;
}
/** Every launch environment id. */
export function environmentIds() {
    return ENVIRONMENTS.map((environment) => environment.id);
}
/** Looks one up. Returns undefined for an unknown id rather than throwing. */
export function getEnvironment(id) {
    return BY_ID.get(id);
}
/**
 * Looks one up, throwing if it is missing.
 *
 * Use this where a missing environment is a programming error (a campsite
 * record pointing at content that was removed); use `getEnvironment` where it
 * is a data condition to handle.
 */
export function requireEnvironment(id) {
    const environment = BY_ID.get(id);
    if (!environment) {
        throw new Error(`Unknown environment id "${id}". Known ids: ${environmentIds().join(', ')}`);
    }
    return environment;
}
/** True if the id names a shipping environment. */
export function hasEnvironment(id) {
    return BY_ID.has(id);
}
/**
 * Environments sorted by how strongly a region favours them.
 *
 * For live-ops preview and for the Passport's "places people near you tend to
 * find first" copy. It is a *sort*, never a filter — the tail of this list is
 * still fully reachable.
 */
export function environmentsByRegionalAffinity(region, weightOf) {
    return [...ENVIRONMENTS].sort((a, b) => weightOf(b, region) - weightOf(a, region));
}
//# sourceMappingURL=catalogue.js.map