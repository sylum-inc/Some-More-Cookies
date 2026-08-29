/**
 * Shared synthesis primitives.
 *
 * Three building blocks cover almost every one-shot in the game:
 *
 *  - `noiseBurst`  — band-passed noise with a percussive envelope and an
 *                    optional filter sweep. Air, scrape, hiss, fizz, crunch.
 *  - `modalRing`   — a noise grain fed through parallel high-Q band-passes.
 *                    Struck solids: steel panels, plastic bodies, wood, ice.
 *  - `thump`       — a pitched oscillator with a downward glide. Mass, impact,
 *                    pressure, the low half of anything heavy.
 *
 * Every one applies the mixer's reduced-intensity shaping, so accessibility is
 * enforced at the primitive rather than at each call site.
 */
import type { PercussiveEnvelope } from './envelopes.js';
import type { LayerDeps } from './layer.js';
import type { NoiseKind } from './noise.js';
import type { Rng } from './rng.js';
import type { NoiseBank } from './buffers.js';
export declare class Synth {
    private readonly deps;
    readonly output: AudioNode;
    /** Reused envelope object — the one-shot path allocates no envelopes. */
    private readonly env;
    constructor(deps: LayerDeps, output: AudioNode);
    get ctx(): BaseAudioContext;
    get rng(): Rng;
    get bank(): NoiseBank;
    /** Never schedule in the past; a few ms of slack avoids glitching. */
    at(when?: number): number;
    /** Build a percussive envelope with reduced-intensity shaping applied. */
    shaped(attack: number, decay: number, peak: number): PercussiveEnvelope;
    /** Peak scaling only, for envelopes written by hand. */
    get shaping(): import("./envelopes.js").IntensityShaping;
    /**
     * A filtered slice of the shared noise loop with a percussive envelope.
     * `sweepTo` glides the filter across the envelope, which is what turns a
     * static hiss into something escaping, tearing or moving.
     */
    noiseBurst(time: number, centerHz: number, q: number, attack: number, decay: number, peak: number, type?: BiquadFilterType, sweepTo?: number, destination?: AudioNode, noiseKind?: NoiseKind): number;
    /**
     * Modal synthesis: excite parallel high-Q band-passes with a noise grain.
     * Pass *inharmonic* partial ratios for metal, glass and ice; near-harmonic
     * ratios read as pitched and wooden.
     */
    modalRing(time: number, partials: readonly number[], q: number, decay: number, peak: number, destination?: AudioNode, brightness?: number): number;
    /** A pitched body/impact: an oscillator with a downward glide and a fast tail. */
    thump(time: number, fromHz: number, toHz: number, glide: number, decay: number, peak: number, wave?: OscillatorType, destination?: AudioNode): number;
    /**
     * A single pre-rendered grain from the bank, band-passed and panned. Cheaper
     * than `noiseBurst` (no loop offset maths) and the right tool for crunch,
     * crumble and tick clusters.
     */
    grain(time: number, brightness: number, centerHz: number, q: number, attack: number, decay: number, peak: number, playbackRate?: number, pan?: number, destination?: AudioNode): number;
    /**
     * Disconnect nodes once their sources have finished. Uses the host timer when
     * there is one; headlessly the nodes are left attached to a silent chain,
     * which is harmless.
     */
    cleanupLater(nodes: readonly (AudioNode | null | undefined)[], delaySeconds: number): void;
}
//# sourceMappingURL=synth.d.ts.map