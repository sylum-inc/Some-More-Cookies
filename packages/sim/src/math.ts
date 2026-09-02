/** Small, allocation-free math helpers shared across the simulation. */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp to [0,1] — by far the most common case. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, safe when a === b. */
export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return clamp01((value - a) / (b - a));
}

export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = inverseLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Smoother Hermite curve — used where an ease must not show its seams. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = inverseLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Framerate-independent exponential approach.
 *
 * `rate` is the fraction of the remaining distance covered per second, so the
 * result is identical whether called at 30 Hz or 120 Hz. Every "ease toward"
 * in the simulation uses this rather than `lerp(a, b, 0.1)`, which would make
 * behaviour depend on timestep and break determinism across devices.
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0) return current;
  const factor = 1 - Math.exp(-rate * dt);
  return current + (target - current) * factor;
}

/** Moves toward a target at a fixed maximum speed. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Wraps an angle into [0, TAU). */
export function wrapAngle(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = wrapAngle(b - a);
  if (d > Math.PI) d -= TAU;
  return d;
}

/** Logistic curve. Used for temperature-gated reaction rates. */
export function sigmoid(x: number, midpoint = 0, steepness = 1): number {
  return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i] as number;
  return total;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Population standard deviation — used to measure roast *evenness*. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const d = (values[i] as number) - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

export function maxOf(values: readonly number[]): number {
  let best = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (v > best) best = v;
  }
  return values.length === 0 ? 0 : best;
}

export function minOf(values: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (v < best) best = v;
  }
  return values.length === 0 ? 0 : best;
}

/** Rounds to a fixed number of decimals — for stable serialisation. */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
