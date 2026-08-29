/**
 * The campfire.
 *
 * Crunchy and PS1 on the surface, driven entirely by the simulation
 * underneath. Fire is one of the places the spec explicitly allows modern
 * rendering, so the flames are additive billboard sprites with animated
 * vertex colours rather than flat quads — but they are still quantised and
 * dithered by the post pass, which is what keeps them of this world.
 */
import { type FireState } from '@somemore/sim';
import type { RenderSettings } from '../render/ps1.js';
export interface FireProps {
    fire: FireState;
    settings: RenderSettings;
    maxParticles: number;
}
export declare function Fire({ fire, settings, maxParticles }: FireProps): React.ReactElement;
//# sourceMappingURL=Fire.d.ts.map