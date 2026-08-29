/**
 * Photo mode (spec §10).
 *
 * Captures the actual rendered frame and applies a disposable-camera
 * treatment: date stamp, grain, light leak, slight misalignment. The frame is
 * already low-resolution and dithered, so the result reads as a photograph of
 * a PS1 world rather than a screenshot with a filter over it.
 */
import type { RitualStage } from '@somemore/sim';
import type { PassportPhoto } from '../state/store.js';
export interface PhotoOptions {
    environmentId: string;
    stage: RitualStage;
    caption: string;
    /** Output width; height follows the source aspect. */
    width?: number;
    /** Disposable-camera treatment strength, 0..1. */
    treatment?: number;
    /** Injected for deterministic tests. */
    now?: Date;
    random?: () => number;
}
/**
 * Renders the treated photo. Returns null when there is no canvas to read
 * (server-side, or a lost WebGL context).
 */
export declare function capturePhoto(source: HTMLCanvasElement, options: PhotoOptions): PassportPhoto | null;
/** `'24 08 12` — the format those cameras actually printed. */
export declare function formatDateStamp(date: Date): string;
//# sourceMappingURL=photo.d.ts.map