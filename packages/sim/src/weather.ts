/**
 * Weather (spec §5.5).
 *
 * Weather evolves during a session and affects fire, visibility, sound,
 * wildlife, exploration and roasting. Real local weather may drive it when the
 * player grants permission, but the curated simulation is the *default* path
 * and must be just as good — a player who declines permission is not getting a
 * degraded world.
 */

import { approach, clamp01, lerp, smoothstep } from './math.js';
import { fbm1D, type Rng } from './rng.js';

export type WeatherKind =
  | 'clear'
  | 'high-cloud'
  | 'overcast'
  | 'light-rain'
  | 'rain'
  | 'storm'
  | 'fog'
  | 'snow'
  | 'snow-squall'
  | 'wind';

/** Rare, memorable events. Gifts, never gates (spec §5.5). */
export type SkyEvent = 'meteor-shower' | 'heat-lightning' | 'aurora' | 'moonbow' | 'none';

/** A campsite's weather personality — content data. */
export interface WeatherProfile {
  readonly id: string;
  /** Relative likelihood of each weather kind at this campsite. */
  readonly weights: Partial<Record<WeatherKind, number>>;
  /** Baseline temperature in °C. */
  readonly baseTempC: number;
  /** Typical wind, m/s. */
  readonly baseWind: number;
  /** How exposed the pit is to wind, 0..1. */
  readonly exposure: number;
  /** How likely rare sky events are here, 0..1. */
  readonly skyEventChance: number;
  /** Sky events this campsite can produce. */
  readonly skyEvents: readonly SkyEvent[];
  /** Mean seconds between weather transitions. */
  readonly transitionSeconds: number;
}

export const DEFAULT_WEATHER_PROFILE: WeatherProfile = {
  id: 'temperate',
  weights: { clear: 4, 'high-cloud': 3, overcast: 2, 'light-rain': 1, fog: 1, wind: 1 },
  baseTempC: 14,
  baseWind: 1.1,
  exposure: 0.5,
  skyEventChance: 0.08,
  skyEvents: ['meteor-shower', 'heat-lightning'],
  transitionSeconds: 210,
};

export interface WeatherState {
  kind: WeatherKind;
  /** The kind being transitioned toward. */
  nextKind: WeatherKind;
  /** 0..1 blend between kind and nextKind. */
  transition: number;
  temperatureC: number;
  windSpeed: number;
  windDirection: number;
  /** Precipitation intensity, 0..1. */
  precipitation: number;
  /** Fog density, 0..1 — shortens draw distance. */
  fog: number;
  /** Cloud cover, 0..1 — hides stars. */
  cloudCover: number;
  /** Humidity, 0..1 — affects how wet found firewood is. */
  humidity: number;
  skyEvent: SkyEvent;
  skyEventSeconds: number;
  elapsed: number;
  secondsUntilTransition: number;
  profile: WeatherProfile;
}

interface KindCharacter {
  wind: number;
  precipitation: number;
  fog: number;
  cloud: number;
  humidity: number;
  tempOffset: number;
}

const CHARACTER: Record<WeatherKind, KindCharacter> = {
  clear: { wind: 0.6, precipitation: 0, fog: 0.04, cloud: 0.05, humidity: 0.35, tempOffset: -1 },
  'high-cloud': { wind: 0.9, precipitation: 0, fog: 0.06, cloud: 0.4, humidity: 0.45, tempOffset: 0 },
  overcast: { wind: 1.2, precipitation: 0, fog: 0.12, cloud: 0.92, humidity: 0.6, tempOffset: 1 },
  'light-rain': { wind: 1.4, precipitation: 0.3, fog: 0.2, cloud: 0.95, humidity: 0.82, tempOffset: 0 },
  rain: { wind: 2.2, precipitation: 0.7, fog: 0.3, cloud: 1, humidity: 0.95, tempOffset: -1 },
  storm: { wind: 4.4, precipitation: 1, fog: 0.35, cloud: 1, humidity: 1, tempOffset: -2 },
  fog: { wind: 0.35, precipitation: 0.02, fog: 0.9, cloud: 0.7, humidity: 0.95, tempOffset: -1.5 },
  snow: { wind: 1.3, precipitation: 0.5, fog: 0.45, cloud: 0.95, humidity: 0.7, tempOffset: -8 },
  'snow-squall': { wind: 4.8, precipitation: 0.9, fog: 0.75, cloud: 1, humidity: 0.75, tempOffset: -10 },
  wind: { wind: 4.2, precipitation: 0, fog: 0.03, cloud: 0.3, humidity: 0.3, tempOffset: -2 },
};

export function createWeather(profile: WeatherProfile, rng: Rng): WeatherState {
  const kind = pickKind(profile, rng);
  const character = CHARACTER[kind];
  return {
    kind,
    nextKind: kind,
    transition: 1,
    temperatureC: profile.baseTempC + character.tempOffset,
    windSpeed: profile.baseWind * character.wind,
    windDirection: rng.range(0, Math.PI * 2),
    precipitation: character.precipitation,
    fog: character.fog,
    cloudCover: character.cloud,
    humidity: character.humidity,
    skyEvent: 'none',
    skyEventSeconds: 0,
    elapsed: 0,
    secondsUntilTransition: profile.transitionSeconds * rng.range(0.6, 1.4),
    profile,
  };
}

function pickKind(profile: WeatherProfile, rng: Rng): WeatherKind {
  const entries = Object.entries(profile.weights) as [WeatherKind, number][];
  const picked = rng.weightedPick(entries, ([, weight]) => weight);
  return picked ? picked[0] : 'clear';
}

export function stepWeather(weather: WeatherState, dt: number, rng: Rng): void {
  weather.elapsed += dt;

  // Transition scheduling.
  weather.secondsUntilTransition -= dt;
  if (weather.secondsUntilTransition <= 0 && weather.transition >= 1) {
    weather.nextKind = pickKind(weather.profile, rng);
    if (weather.nextKind !== weather.kind) weather.transition = 0;
    weather.secondsUntilTransition = weather.profile.transitionSeconds * rng.range(0.7, 1.5);
  }

  if (weather.transition < 1) {
    // Weather changes over a minute or so, never instantly.
    weather.transition = clamp01(weather.transition + dt / 55);
    if (weather.transition >= 1) weather.kind = weather.nextKind;
  }

  const from = CHARACTER[weather.kind];
  const to = CHARACTER[weather.nextKind];
  const t = weather.transition;

  const targetWind = lerp(from.wind, to.wind, t) * weather.profile.baseWind;
  // Gusts on top of the base, so wind has texture rather than a flat value.
  const gust = fbm1D(0x3d21, weather.elapsed * 0.22, 3);
  weather.windSpeed = approach(weather.windSpeed, targetWind * lerp(0.55, 1.55, gust), 0.35, dt);
  weather.windDirection += (fbm1D(0x9c4a, weather.elapsed * 0.04, 2) - 0.5) * 0.22 * dt;

  weather.precipitation = approach(weather.precipitation, lerp(from.precipitation, to.precipitation, t), 0.3, dt);
  weather.fog = approach(weather.fog, lerp(from.fog, to.fog, t), 0.16, dt);
  weather.cloudCover = approach(weather.cloudCover, lerp(from.cloud, to.cloud, t), 0.2, dt);
  weather.humidity = approach(weather.humidity, lerp(from.humidity, to.humidity, t), 0.25, dt);
  weather.temperatureC = approach(
    weather.temperatureC,
    weather.profile.baseTempC + lerp(from.tempOffset, to.tempOffset, t),
    0.08,
    dt,
  );

  // --- Rare sky events ---------------------------------------------------
  if (weather.skyEvent !== 'none') {
    weather.skyEventSeconds -= dt;
    if (weather.skyEventSeconds <= 0) weather.skyEvent = 'none';
  } else if (weather.cloudCover < 0.35 && weather.profile.skyEvents.length > 0) {
    // Checked rarely and only under clear sky, so an event is a genuine gift.
    const chancePerSecond = (weather.profile.skyEventChance / 600) * dt;
    if (rng.chance(chancePerSecond)) {
      weather.skyEvent = rng.pick(weather.profile.skyEvents) ?? 'none';
      weather.skyEventSeconds = rng.range(45, 210);
    }
  }
}

/** How weather modifies fire behaviour. */
export interface WeatherFireEffect {
  /** Multiplier on wind reaching the pit. */
  windMultiplier: number;
  /** Extra moisture added to newly gathered fuel, 0..1. */
  fuelMoisture: number;
  /** Direct suppression of flame from falling precipitation, 0..1. */
  suppression: number;
  ambientC: number;
}

export function weatherFireEffect(weather: WeatherState): WeatherFireEffect {
  return {
    windMultiplier: 1 + weather.windSpeed * 0.12,
    fuelMoisture: clamp01(weather.humidity * 0.5 + weather.precipitation * 0.45),
    // Kept gentle on purpose: rain should change the mood of a fire, not end
    // the session. This is not a survival game.
    suppression: clamp01(weather.precipitation * 0.35),
    ambientC: weather.temperatureC,
  };
}

/** Draw distance in metres, shortened by fog and precipitation. */
export function visibilityDistance(weather: WeatherState, baseDistance: number): number {
  const reduction = clamp01(weather.fog * 0.8 + weather.precipitation * 0.3);
  return lerp(baseDistance, baseDistance * 0.22, reduction);
}

/** How audible the night is — rain and wind mask insects and distant sound. */
export function ambienceMasking(weather: WeatherState): number {
  return clamp01(weather.precipitation * 0.7 + smoothstep(1.5, 6, weather.windSpeed) * 0.5);
}

/** A short, human phrase for the Passport and subtitles. */
export function describeWeather(weather: WeatherState): string {
  const labels: Record<WeatherKind, string> = {
    clear: 'Clear',
    'high-cloud': 'High cloud',
    overcast: 'Overcast',
    'light-rain': 'Light rain',
    rain: 'Rain',
    storm: 'Storm',
    fog: 'Fog',
    snow: 'Snow',
    'snow-squall': 'Snow squall',
    wind: 'Windy',
  };
  const base = labels[weather.kind];
  if (weather.skyEvent === 'meteor-shower') return `${base}, meteors`;
  if (weather.skyEvent === 'heat-lightning') return `${base}, heat lightning`;
  if (weather.skyEvent === 'aurora') return `${base}, aurora`;
  if (weather.skyEvent === 'moonbow') return `${base}, moonbow`;
  return base;
}
