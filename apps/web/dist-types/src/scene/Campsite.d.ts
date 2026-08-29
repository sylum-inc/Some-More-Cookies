/**
 * The campsite: terrain, trees, sky, props.
 *
 * Compact but genuinely explorable (spec §5.1) — a walkable clearing with
 * real corners, not a corridor. Short draw distance and heavy fog do the
 * PS1 work while also being the reason the world is cheap to render.
 */
import { type WeatherState } from '@somemore/sim';
import { type RenderSettings } from '../render/ps1.js';
export interface CampsiteProps {
    seed: number;
    weather: WeatherState;
    settings: RenderSettings;
    drawDistance: number;
    /** Night palette, linear RGB. */
    palette?: {
        ground: string;
        foliage: string;
        fog: string;
        sky: string;
    };
}
export declare function Campsite({ seed, weather, settings, drawDistance, palette }: CampsiteProps): React.ReactElement;
//# sourceMappingURL=Campsite.d.ts.map