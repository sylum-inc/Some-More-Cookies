/**
 * AudioContext lifecycle guards.
 *
 * Browsers refuse to start an AudioContext outside a user gesture, and Node has
 * no WebAudio at all. Nothing in this module constructs a context at import
 * time; `AudioEngine` calls `createAudioContext` only from `resume()`, and every
 * call site tolerates `null`.
 */
/** A factory the engine can be handed for tests or for a custom sample rate. */
export type AudioContextFactory = (options?: AudioContextOptions) => AudioContext;
/** The constructor to use, or `null` when WebAudio is unavailable (Node, SSR, old Safari). */
export declare function resolveAudioContextConstructor(): (new (options?: AudioContextOptions) => AudioContext) | null;
export declare function isAudioContextSupported(): boolean;
/**
 * Construct a context, or return `null` if unsupported or blocked. Never
 * throws: a browser that refuses (autoplay policy, exhausted context limit)
 * must degrade to a silent engine, not crash the game.
 */
export declare function createAudioContext(options?: AudioContextOptions): AudioContext | null;
/** Chain nodes left to right; returns the last node so callers can keep building. */
export declare function connectChain<T extends AudioNode>(first: AudioNode, ...rest: AudioNode[]): T;
/** Disconnect without throwing when a node was never connected. */
export declare function safeDisconnect(node: AudioNode | null | undefined): void;
/** Stop a source without throwing when it already ended or never started. */
export declare function safeStop(source: AudioScheduledSourceNode | null | undefined, when?: number): void;
/**
 * Copy JS-generated sample data into an `AudioBuffer`. Falls back to
 * `getChannelData` when `copyToChannel` is missing (older Safari).
 */
export declare function toAudioBuffer(ctx: BaseAudioContext, channels: readonly Float32Array[], sampleRate?: number): AudioBuffer;
//# sourceMappingURL=context.d.ts.map