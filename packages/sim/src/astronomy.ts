/**
 * Sky state (spec §5.5).
 *
 * Real astronomy may drive the moon, stars, planets and meteor showers, all
 * rendered through the PS1 art direction. The maths here is the standard
 * low-precision astronomical approximation — accurate to about a degree, which
 * is far beyond what a dithered 320×240 night sky can show, and cheap enough
 * to run without a dependency.
 *
 * Nothing important is ever locked behind waiting for a real sky event.
 */

import { clamp01, TAU } from './math.js';

const DEG = Math.PI / 180;
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Days since the J2000.0 epoch. */
export function daysSinceJ2000(date: Date): number {
  return (date.getTime() - J2000) / 86400000;
}

export interface MoonState {
  /** 0 = new, 0.5 = full, approaching 1 = new again. */
  phase: number;
  /** Illuminated fraction, 0..1. */
  illumination: number;
  /** Altitude above the horizon, radians (negative = below). */
  altitude: number;
  /** Azimuth from north, radians. */
  azimuth: number;
  /** Whether the moon is up. */
  visible: boolean;
  /** Phase name for the Passport. */
  label: string;
}

/** Mean synodic month in days. */
const SYNODIC_MONTH = 29.530588853;

export function moonState(date: Date, latitudeDeg: number, longitudeDeg: number): MoonState {
  const d = daysSinceJ2000(date);

  // Phase from the mean elongation — plenty for a low-poly moon.
  const phase = ((d - 5.597661) / SYNODIC_MONTH) % 1;
  const normalisedPhase = phase < 0 ? phase + 1 : phase;
  const illumination = (1 - Math.cos(normalisedPhase * TAU)) / 2;

  // Low-precision lunar position.
  const L = (218.316 + 13.176396 * d) * DEG;
  const M = (134.963 + 13.064993 * d) * DEG;
  const F = (93.272 + 13.22935 * d) * DEG;
  const lambda = L + 6.289 * DEG * Math.sin(M);
  const beta = 5.128 * DEG * Math.sin(F);

  const obliquity = 23.4397 * DEG;
  const rightAscension = Math.atan2(
    Math.sin(lambda) * Math.cos(obliquity) - Math.tan(beta) * Math.sin(obliquity),
    Math.cos(lambda),
  );
  const declination = Math.asin(
    Math.sin(beta) * Math.cos(obliquity) + Math.cos(beta) * Math.sin(obliquity) * Math.sin(lambda),
  );

  const { altitude, azimuth } = equatorialToHorizontal(
    rightAscension,
    declination,
    date,
    latitudeDeg,
    longitudeDeg,
  );

  return {
    phase: normalisedPhase,
    illumination,
    altitude,
    azimuth,
    visible: altitude > -0.05,
    label: moonPhaseLabel(normalisedPhase),
  };
}

export function moonPhaseLabel(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.03 || p > 0.97) return 'New moon';
  if (p < 0.22) return 'Waxing crescent';
  if (p < 0.28) return 'First quarter';
  if (p < 0.47) return 'Waxing gibbous';
  if (p < 0.53) return 'Full moon';
  if (p < 0.72) return 'Waning gibbous';
  if (p < 0.78) return 'Last quarter';
  return 'Waning crescent';
}

export interface SunState {
  altitude: number;
  azimuth: number;
  /** 0 = full night, 1 = full day. */
  daylight: number;
  /** True during civil twilight — the campsite's best-looking hour. */
  twilight: boolean;
}

export function sunState(date: Date, latitudeDeg: number, longitudeDeg: number): SunState {
  const d = daysSinceJ2000(date);
  const meanAnomaly = (357.5291 + 0.98560028 * d) * DEG;
  const eclipticLongitude =
    meanAnomaly +
    (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG +
    102.9372 * DEG +
    Math.PI;
  const obliquity = 23.4397 * DEG;
  const rightAscension = Math.atan2(Math.sin(eclipticLongitude) * Math.cos(obliquity), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const { altitude, azimuth } = equatorialToHorizontal(
    rightAscension,
    declination,
    date,
    latitudeDeg,
    longitudeDeg,
  );
  const altitudeDeg = altitude / DEG;
  return {
    altitude,
    azimuth,
    daylight: clamp01((altitudeDeg + 6) / 12),
    twilight: altitudeDeg < 0 && altitudeDeg > -6,
  };
}

/**
 * Where an object with these catalogue coordinates is in the sky right now.
 *
 * Public so the stargazing model can place the constellation list on the
 * actual dome for the actual date, rather than scattering it decoratively:
 * Orion has to be where Orion is, or "findable" means nothing.
 */
export function horizonPositionOf(
  raHours: number,
  decDeg: number,
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
): { altitude: number; azimuth: number } {
  return equatorialToHorizontal(
    (raHours / 24) * TAU,
    decDeg * DEG,
    date,
    latitudeDeg,
    longitudeDeg,
  );
}

function equatorialToHorizontal(
  rightAscension: number,
  declination: number,
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
): { altitude: number; azimuth: number } {
  const d = daysSinceJ2000(date);
  // Greenwich mean sidereal time, then local hour angle.
  const gmst = (280.16 + 360.9856235 * d) * DEG;
  const hourAngle = gmst + longitudeDeg * DEG - rightAscension;
  const lat = latitudeDeg * DEG;
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat),
  );
  return { altitude, azimuth };
}

/** Annual meteor showers worth showing. Dates are approximate peaks. */
export interface MeteorShower {
  readonly id: string;
  readonly label: string;
  /** Month (1-12) and day of the peak. */
  readonly peakMonth: number;
  readonly peakDay: number;
  /** Days either side during which it is active. */
  readonly window: number;
  /** Peak rate, used only to scale the visual density. */
  readonly intensity: number;
}

export const METEOR_SHOWERS: readonly MeteorShower[] = [
  { id: 'quadrantids', label: 'Quadrantids', peakMonth: 1, peakDay: 3, window: 3, intensity: 0.7 },
  { id: 'lyrids', label: 'Lyrids', peakMonth: 4, peakDay: 22, window: 4, intensity: 0.4 },
  { id: 'eta-aquariids', label: 'Eta Aquariids', peakMonth: 5, peakDay: 6, window: 5, intensity: 0.5 },
  { id: 'perseids', label: 'Perseids', peakMonth: 8, peakDay: 12, window: 8, intensity: 1 },
  { id: 'orionids', label: 'Orionids', peakMonth: 10, peakDay: 21, window: 6, intensity: 0.45 },
  { id: 'leonids', label: 'Leonids', peakMonth: 11, peakDay: 17, window: 4, intensity: 0.5 },
  { id: 'geminids', label: 'Geminids', peakMonth: 12, peakDay: 14, window: 6, intensity: 0.95 },
];

/** Returns the active shower and its strength (0..1) for a date, if any. */
export function activeMeteorShower(date: Date): { shower: MeteorShower; strength: number } | null {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let best: { shower: MeteorShower; strength: number } | null = null;
  for (const shower of METEOR_SHOWERS) {
    // Compare within a month-neighbourhood so a window can straddle a boundary.
    const dayDiff = approximateDayDifference(month, day, shower.peakMonth, shower.peakDay);
    if (Math.abs(dayDiff) <= shower.window) {
      const strength = clamp01(1 - Math.abs(dayDiff) / shower.window) * shower.intensity;
      if (!best || strength > best.strength) best = { shower, strength };
    }
  }
  return best;
}

function approximateDayDifference(m1: number, d1: number, m2: number, d2: number): number {
  const dayOfYear = (m: number, d: number) => (m - 1) * 30.44 + d;
  let diff = dayOfYear(m1, d1) - dayOfYear(m2, d2);
  if (diff > 182) diff -= 365;
  if (diff < -182) diff += 365;
  return diff;
}

/** Named constellations rendered as low-poly star clusters. */
export interface Constellation {
  readonly id: string;
  readonly label: string;
  /** Approximate right ascension in hours and declination in degrees. */
  readonly raHours: number;
  readonly decDeg: number;
  /** Star positions in a local 2D frame, normalised. */
  readonly stars: readonly (readonly [number, number, number])[];
}

export const CONSTELLATIONS: readonly Constellation[] = [
  {
    id: 'ursa-major',
    label: 'The Plough',
    raHours: 11,
    decDeg: 55,
    stars: [
      [-0.9, 0.1, 1.8],
      [-0.5, 0.24, 1.8],
      [-0.14, 0.2, 2.4],
      [0.16, 0.05, 2.4],
      [0.5, -0.1, 1.8],
      [0.78, -0.32, 2.2],
      [0.95, -0.05, 1.9],
    ],
  },
  {
    id: 'cassiopeia',
    label: 'Cassiopeia',
    raHours: 1,
    decDeg: 60,
    stars: [
      [-0.8, -0.1, 2.2],
      [-0.4, 0.2, 2.3],
      [0, -0.05, 2.5],
      [0.4, 0.25, 2.7],
      [0.8, 0.05, 3.4],
    ],
  },
  {
    id: 'orion',
    label: 'Orion',
    raHours: 5.5,
    decDeg: 0,
    stars: [
      [-0.5, 0.8, 0.5],
      [0.5, 0.75, 1.6],
      [-0.12, 0.05, 2.2],
      [0, 0, 1.7],
      [0.12, -0.05, 2],
      [-0.55, -0.8, 2.1],
      [0.5, -0.75, 0.2],
    ],
  },
  {
    id: 'cygnus',
    label: 'Cygnus',
    raHours: 20.5,
    decDeg: 42,
    stars: [
      [0, 0.9, 1.3],
      [0, 0.3, 2.9],
      [0, -0.1, 2.2],
      [-0.7, -0.1, 2.5],
      [0.7, -0.15, 2.5],
      [0, -0.85, 1.3],
    ],
  },
  {
    id: 'scorpius',
    label: 'Scorpius',
    raHours: 16.5,
    decDeg: -30,
    stars: [
      [-0.8, 0.5, 1.1],
      [-0.5, 0.3, 2.6],
      [-0.2, 0, 2.3],
      [0.1, -0.35, 1.9],
      [0.45, -0.6, 2.4],
      [0.8, -0.5, 1.6],
    ],
  },
];

export interface SkyState {
  sun: SunState;
  moon: MoonState;
  /** Star brightness, 0..1, after moonlight and cloud. */
  starVisibility: number;
  meteorShower: { shower: MeteorShower; strength: number } | null;
  /** Meteors per minute to render. */
  meteorRate: number;
  /** Ambient night light level, 0..1. */
  ambientLight: number;
}

/**
 * Full sky state for a moment and place.
 *
 * `cloudCover` comes from the weather system so the sky and the weather never
 * disagree — a common failure in games where the two are separate systems.
 */
export function skyState(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  cloudCover: number,
): SkyState {
  const sun = sunState(date, latitudeDeg, longitudeDeg);
  const moon = moonState(date, latitudeDeg, longitudeDeg);
  const shower = activeMeteorShower(date);

  const moonWash = moon.visible ? moon.illumination * 0.55 : 0;
  const starVisibility = clamp01((1 - sun.daylight) * (1 - cloudCover * 0.95) * (1 - moonWash));
  const meteorRate = shower ? shower.strength * 8 * starVisibility : starVisibility * 0.35;
  const ambientLight = clamp01(
    sun.daylight * 0.9 + (moon.visible ? moon.illumination * 0.22 : 0) + 0.05,
  );

  return { sun, moon, starVisibility, meteorShower: shower, meteorRate, ambientLight };
}

/**
 * The epoch of the campsite's own night on a given date.
 *
 * The world is always night — the fire, the dark, the whole mood — but the
 * player's clock is whatever it happens to be, and a session at five in the
 * afternoon would put a blazing sun over a campfire and no stars at all in the
 * sky. That is not a hypothetical: it is what a real clock does for most of
 * the hours anybody plays.
 *
 * So the *date* is real, which is what makes real astronomy worth having —
 * tonight's real moon phase, tonight's real meteor shower, the constellations
 * that are genuinely up in this month — and the *hour* is the campsite's,
 * around two in the morning. Spec §5.5 asks for real astronomy and for a
 * fallback as good as the real thing; this is both at once.
 */
export function nightEpoch(date: Date, longitudeDeg: number, localHour = 2): number {
  const utcHour = localHour - (longitudeDeg / 180) * 12;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + utcHour * 3600_000;
}

/**
 * Fallback sky for when the player has not granted time/region access.
 *
 * Spec §5.5 requires this to be as good as the real thing, so it is a
 * deliberately excellent night: late, clear, a modest moon, and mid-Perseids.
 *
 * `localHour` is *local* solar-ish time at the reference longitude, converted
 * to UTC here — passing it straight to `Date.UTC` would put the campsite in
 * late afternoon daylight.
 */
export function curatedSky(localHour = 22): SkyState {
  const latitude = 44;
  const longitude = -73;
  const utcHour = localHour - (longitude / 180) * 12;
  const date = new Date(Date.UTC(2024, 7, 12, 0, 0, 0) + utcHour * 3600_000);
  return skyState(date, latitude, longitude, 0.12);
}
