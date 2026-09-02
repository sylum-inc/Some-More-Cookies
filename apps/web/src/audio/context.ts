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

interface AudioContextGlobals {
  AudioContext?: new (options?: AudioContextOptions) => AudioContext;
  webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext;
}

function globalScope(): AudioContextGlobals {
  return globalThis as unknown as AudioContextGlobals;
}

/** The constructor to use, or `null` when WebAudio is unavailable (Node, SSR, old Safari). */
export function resolveAudioContextConstructor():
  | (new (options?: AudioContextOptions) => AudioContext)
  | null {
  const scope = globalScope();
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function isAudioContextSupported(): boolean {
  return resolveAudioContextConstructor() !== null;
}

/**
 * Construct a context, or return `null` if unsupported or blocked. Never
 * throws: a browser that refuses (autoplay policy, exhausted context limit)
 * must degrade to a silent engine, not crash the game.
 */
export function createAudioContext(options?: AudioContextOptions): AudioContext | null {
  const Ctor = resolveAudioContextConstructor();
  if (!Ctor) return null;
  try {
    return new Ctor(options);
  } catch {
    return null;
  }
}

/** Chain nodes left to right; returns the last node so callers can keep building. */
export function connectChain<T extends AudioNode>(first: AudioNode, ...rest: AudioNode[]): T {
  let current = first;
  for (let i = 0; i < rest.length; i += 1) {
    const next = rest[i];
    if (!next) continue;
    current.connect(next);
    current = next;
  }
  return current as T;
}

/** Disconnect without throwing when a node was never connected. */
export function safeDisconnect(node: AudioNode | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* already detached */
  }
}

/** Stop a source without throwing when it already ended or never started. */
export function safeStop(source: AudioScheduledSourceNode | null | undefined, when?: number): void {
  if (!source) return;
  try {
    source.stop(when);
  } catch {
    /* already stopped */
  }
}

/**
 * Copy JS-generated sample data into an `AudioBuffer`. Falls back to
 * `getChannelData` when `copyToChannel` is missing (older Safari).
 */
export function toAudioBuffer(
  ctx: BaseAudioContext,
  channels: readonly Float32Array[],
  sampleRate?: number,
): AudioBuffer {
  const first = channels[0];
  const length = first ? first.length : 1;
  const buffer = ctx.createBuffer(Math.max(1, channels.length), Math.max(1, length), sampleRate ?? ctx.sampleRate);
  for (let c = 0; c < channels.length; c += 1) {
    const data = channels[c];
    if (!data) continue;
    // `getChannelData().set()` is universally available and avoids the
    // ArrayBufferLike/ArrayBuffer variance friction of `copyToChannel`.
    if (typeof buffer.getChannelData === 'function') {
      buffer.getChannelData(c).set(data);
    } else {
      (buffer as { copyToChannel: (s: Float32Array, c: number) => void }).copyToChannel(data, c);
    }
  }
  return buffer;
}
