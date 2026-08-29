/**
 * Convolution reverb send, fed by procedurally generated impulse responses.
 *
 * One shared reverb bus; every submix sends into it at a fixed ratio. That is
 * a lot cheaper than per-layer convolvers and it is also more convincing —
 * the fire and the machine sharing one space is what makes them feel co-located.
 */
import type { ImpulseSpec, SpaceType } from './impulse.js';
import { ImpulseCache } from './impulse.js';
import type { BusName } from './buses.js';
/** How much of each submix is sent into the shared reverb. */
export declare const DEFAULT_REVERB_SENDS: Readonly<Record<BusName, number>>;
export interface ReverbOptions {
    space: SpaceType;
    /** Overall reverb return level, 0..1. */
    wet: number;
    /** Rolls off the top of the return so tails sit behind the dry signal. */
    dampingHz: number;
}
export declare const DEFAULT_REVERB_OPTIONS: Readonly<ReverbOptions>;
export declare class ReverbBus {
    private readonly ctx;
    /** Connect submix sends here. */
    readonly input: GainNode;
    private readonly convolver;
    private readonly tone;
    private readonly output;
    private readonly cache;
    private currentSpace;
    private wetLevel;
    constructor(ctx: BaseAudioContext, destination: AudioNode, options?: Partial<ReverbOptions>, cache?: ImpulseCache);
    private applyImpulse;
    get space(): SpaceType;
    get wet(): number;
    specFor(space: SpaceType): ImpulseSpec;
    /** Swap spaces. Cross-fades the return so a campsite change does not click. */
    setSpace(space: SpaceType, crossfadeSeconds?: number): void;
    setWet(wet: number, smoothingSeconds?: number): void;
    setDamping(hz: number): void;
    /** Build the per-bus send node for `bus`. Returns null when the bus is dry by design. */
    createSend(bus: BusName, source: AudioNode, amount?: number): GainNode | null;
    dispose(): void;
}
//# sourceMappingURL=reverb.d.ts.map