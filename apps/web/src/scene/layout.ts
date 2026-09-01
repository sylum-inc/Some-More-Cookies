/**
 * Where everything at a campsite stands.
 *
 * Split out of `World.tsx` because it is data and arithmetic with no React and
 * no three.js in it, and because three different layers now need to agree
 * about it: the scene that draws the props, the walkable world that decides
 * what you can bump into, and the simulation that has to place the campsite's
 * own landmarks somewhere that is not inside the freezer. One of those used to
 * be impossible without importing the renderer into the state layer.
 */

/** Where everything stands. The fire pit is the origin of the world. */
export const LAYOUT = {
  /** The player's bearing around the fire, radians. */
  playerBearing: 0.42,
  /** How far the player stands from the fire while roasting. */
  playerDistance: 1.5,
  assemblyTable: [1.42, 0.34, 1.32] as [number, number, number],
  /** The log people sit on, and where the radio has been left. */
  logSeat: [-1.5, 0, 0.9] as [number, number, number],
  radio: [-1.72, 0.36, 0.54] as [number, number, number],
  /** The torch, lying on the same log. */
  torch: [-1.24, 0.4, 1.33] as [number, number, number],
  machine: [-2.75, 0, 1.75] as [number, number, number],
  /** Yaw so the machine's face (+Z in its local frame) looks into the clearing. */
  machineRotation: 1.03,
  trailStart: [7.5, 0, 6.2] as [number, number, number],
};

/** Transforms a point in the machine's local frame into world space. */
export function machineToWorld(local: [number, number, number]): [number, number, number] {
  const yaw = LAYOUT.machineRotation;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    LAYOUT.machine[0] + local[0] * cos + local[2] * sin,
    LAYOUT.machine[1] + local[1],
    LAYOUT.machine[2] - local[0] * sin + local[2] * cos,
  ];
}

/**
 * The things that stand at every campsite, whatever environment it is.
 *
 * One list, used for what you can walk into and for where a landmark may not
 * be put. They were two lists until a bear box was placed inside the SM-01.
 */
export function campFurniture(): readonly { x: number; z: number; radius: number }[] {
  return [
    { x: 0, z: 0, radius: 0.62 },
    { x: LAYOUT.machine[0], z: LAYOUT.machine[2], radius: 0.9 },
    { x: LAYOUT.assemblyTable[0], z: LAYOUT.assemblyTable[2], radius: 0.5 },
    { x: LAYOUT.logSeat[0], z: LAYOUT.logSeat[2], radius: 1.1 },
    { x: 1.7, z: -0.9, radius: 0.6 },
  ];
}

/** Stable numeric seed from a campsite id. Shared with the app. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
