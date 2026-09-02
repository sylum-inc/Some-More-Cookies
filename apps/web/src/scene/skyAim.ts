/**
 * Looking at the sky is looking at the sky.
 *
 * The stargazing model reads an azimuth and an altitude, and the only thing
 * that supplies them is the player's own head: facing, pitch, and the tip that
 * lying back adds. `World.tsx` writes that aim on every step, so nothing else
 * can steer it — a hook that wrote an aim straight into the model was
 * overwritten by the next frame, and whether a constellation was ever
 * recognised came down to where the body happened to be looking and what the
 * real clock said. Both directions of the conversion live here so the frame
 * loop and anything that turns the head cannot disagree about what "up" is.
 */

import { LOCOMOTION, type RitualState } from '@somemore/sim';

/** How far lying back tips the head up, radians. About fifty degrees. */
export const RECLINE_LIFT = 0.9;

export function reclineLift(ritual: RitualState): number {
  return ritual.stargazing.posture === 'reclined' ? RECLINE_LIFT : 0;
}

/**
 * The player's facing as a sky azimuth.
 *
 * Azimuth is measured from north, and +Z is north in this scene (the same
 * convention `Campsite.tsx` places the moon with), while a yaw of 0 looks
 * along +X. So the two are a quarter turn apart, and this is that quarter turn
 * written down once instead of three times.
 */
export function skyAzimuth(facing: number): number {
  return Math.atan2(Math.cos(facing), Math.sin(facing));
}

/**
 * The facing that puts a sky azimuth straight ahead.
 *
 * The quarter turn is its own inverse — both directions are `π/2 − angle` —
 * so this is {@link skyAzimuth} again, named for what it is being used for.
 */
export function facingForSkyAzimuth(azimuth: number): number {
  return Math.atan2(Math.cos(azimuth), Math.sin(azimuth));
}

/**
 * The pitch that puts a sky altitude in view, given how far the head is
 * already tipped by lying back. Clamped to what a neck can do: aiming at the
 * zenith standing up gets as close as standing up can, which is the model's
 * own rule about craning.
 */
export function pitchForSkyAltitude(altitude: number, lift: number): number {
  return Math.min(LOCOMOTION.maxPitch, Math.max(LOCOMOTION.minPitch, altitude - lift));
}
