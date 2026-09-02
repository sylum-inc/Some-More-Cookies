/**
 * Hand-rolled runtime validation for the environment catalogue.
 *
 * No schema library here on purpose. `packages/content` sits below the client
 * in the dependency graph (architecture §2) and is loaded on the boot path of
 * a product whose first requirement is that the world starts fast; a validator
 * for a fixed, hand-authored catalogue is a few hundred lines of plain
 * predicates and costs nothing at runtime. `packages/protocol` owns the Zod
 * contracts for anything crossing the wire.
 *
 * The validator is exhaustive on purpose: live ops will eventually push
 * environment data (spec §14), and this is the gate that data has to pass.
 */

import { QUIRK_POOL, WOOD_TYPES, type SkyEvent, type WeatherKind } from '@somemore/sim';

import {
  ALL_ENVIRONMENTS,
  MAX_REGION_AFFINITY,
  MIN_REGION_AFFINITY,
  REGIONS,
  REVERB_SPACES,
  SEASONAL_EVENT_KINDS,
  type EnvironmentManifest,
  type SeasonalEventManifest,
  type StationProgrammingManifest,
} from './schema.js';

/* -------------------------------------------------------------------------- */
/* Issue reporting                                                            */
/* -------------------------------------------------------------------------- */

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `pine_hollow.secrets[2].rarity`. */
  readonly path: string;
  readonly message: string;
}

class Issues {
  readonly list: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

/* -------------------------------------------------------------------------- */
/* Allowed-value sets                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Written as exhaustive `Record`s so that adding a member to a union in
 * `@somemore/sim` or `./schema.ts` is a *compile* error here rather than a
 * validator that silently accepts or rejects the wrong thing.
 */
function keysOf<K extends string>(record: Record<K, true>): readonly K[] {
  return Object.keys(record) as K[];
}

export const WEATHER_KINDS = keysOf<WeatherKind>({
  clear: true,
  'high-cloud': true,
  overcast: true,
  'light-rain': true,
  rain: true,
  storm: true,
  fog: true,
  snow: true,
  'snow-squall': true,
  wind: true,
});

export const SKY_EVENTS = keysOf<SkyEvent>({
  'meteor-shower': true,
  'heat-lightning': true,
  aurora: true,
  moonbow: true,
  none: true,
});

const TEMPERATURE_BANDS = ['hot', 'warm', 'mild', 'cool', 'cold', 'freezing'];
const MOISTURE_BANDS = ['arid', 'dry', 'balanced', 'damp', 'wet'];
const ALTITUDE_BANDS = ['sea-level', 'lowland', 'upland', 'montane', 'alpine'];
const TREE_COVERS = ['none', 'sparse', 'open', 'moderate', 'dense', 'canopy'];
const WATER_KINDS = [
  'none',
  'creek',
  'river',
  'lake',
  'tarn',
  'sea',
  'blackwater',
  'hot-spring',
  'ephemeral-sheet',
];
const GROUND_MATERIALS = [
  'pine-duff',
  'moss-duff',
  'granite-slab',
  'shield-rock',
  'river-cobble',
  'fine-sand',
  'red-dust',
  'packed-snow',
  'peat-moss',
  'volcanic-ash',
  'grass-thatch',
  'gravel-pad',
  'salt-crust',
  'boardwalk-plank',
  'cracked-clay',
];
const ELEVATIONS = ['flat', 'gentle', 'rolling', 'terraced', 'basin', 'bench', 'ridge', 'steep'];
const LANDMARK_KINDS = ['natural', 'built', 'abandoned', 'signage', 'water', 'sky', 'camp'];
const WATER_FLOWS = ['still', 'slow', 'lapping', 'running', 'rushing', 'tidal', 'seeping'];
const ACTIVITY_WINDOWS = ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'];
const WILDLIFE_CUES = [
  'stillness',
  'quiet',
  'firelight',
  'ember-glow',
  'smoke',
  'food-smell',
  'marshmallow-smell',
  'crumbs',
  'flashlight',
  'camera-flash',
  'radio-music',
  'voices',
  'footsteps',
  'sudden-movement',
  'machine-hum',
  'compressor-noise',
  'vapour-plume',
  'warmth',
  'rain',
  'wind',
  'moonlight',
  'open-sky',
  'water-edge',
  'splashing',
  'singing',
  'shelter',
  'cold-air',
];
const WIND_CHARACTERS = [
  'still',
  'breathing',
  'steady',
  'gusting',
  'onshore',
  'channelled',
  'katabatic',
  'buffeting',
];
const ACTIVITY_IDS = [
  'fire-tending',
  'fishing',
  'stone-skipping',
  'stargazing',
  'binoculars',
  'telescope',
  'photography',
  'radio',
  'flashlight',
  'wildlife-watching',
  'strange-objects',
  'foraging',
  'wading',
  'swimming',
  'tide-pooling',
  'driftwood-gathering',
  'snow-tracking',
  'cairn-reading',
  'boardwalk-walk',
  'firefly-watching',
  'hot-spring-soak',
  'echo-calling',
  'rail-walking',
  'moth-sheet',
  'shadow-puppets',
  'grass-whistle',
  'sky-mirror-walking',
  'wind-listening',
  'loon-answering',
];
const ACTIVITY_PROMINENCE = ['available', 'notable', 'signature'];
const RADIO_BANDS = ['fm', 'am', 'shortwave'];
const STATION_CHARACTERS = ['lofi', 'ambient', 'environmental', 'strange', 'community', 'weather-service'];
const MYSTERY_CHANNELS = [
  'radio',
  'notes',
  'serial-numbers',
  'diagnostics',
  'strange-objects',
  'distant-sounds',
  'wildlife-behaviour',
  'recurring-figures',
  'campsite-changes',
];
const PERFORMANCE_COSTS = ['light', 'moderate', 'heavy'];

const QUIRK_IDS: readonly string[] = QUIRK_POOL.map((q) => q.id);

/* -------------------------------------------------------------------------- */
/* Budgets (architecture §10)                                                 */
/* -------------------------------------------------------------------------- */

export const MID_TIER_DRAW_CALL_BUDGET = 120;
export const MID_TIER_TRIANGLE_BUDGET = 60_000;
export const DYNAMIC_LIGHT_BUDGET = 6;

/** The catalogue size the spec commits to (§5.4). */
export const MIN_CATALOGUE_SIZE = 10;
export const MAX_CATALOGUE_SIZE = 12;

const ID_PATTERN = /^[a-z0-9_]+$/;
const KEY_PATTERN = /^[a-z0-9_]+$/;
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/* -------------------------------------------------------------------------- */
/* Primitive predicates                                                       */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(issues: Issues, path: string, value: unknown, maxLength = 4000): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.add(path, 'must be a non-empty string');
    return null;
  }
  if (value.length > maxLength) issues.add(path, `must be at most ${maxLength} characters`);
  return value;
}

function num(issues: Issues, path: string, value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.add(path, 'must be a finite number');
    return null;
  }
  if (value < min || value > max) issues.add(path, `must be within [${min}, ${max}] (got ${value})`);
  return value;
}

function unit(issues: Issues, path: string, value: unknown): number | null {
  return num(issues, path, value, 0, 1);
}

function oneOf(issues: Issues, path: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.add(path, `must be one of: ${allowed.join(', ')}`);
  }
}

function hex(issues: Issues, path: string, value: unknown): void {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
    issues.add(path, 'must be a #rrggbb colour');
  }
}

function range(issues: Issues, path: string, value: unknown, min = -1e9, max = 1e9): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be a { min, max } range');
    return;
  }
  const lo = num(issues, `${path}.min`, value['min'], min, max);
  const hi = num(issues, `${path}.max`, value['max'], min, max);
  if (lo !== null && hi !== null && lo > hi) issues.add(path, `min (${lo}) must not exceed max (${hi})`);
}

function arrayOf(issues: Issues, path: string, value: unknown, minLength: number, maxLength = 512): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.add(path, 'must be an array');
    return null;
  }
  if (value.length < minLength) issues.add(path, `must contain at least ${minLength} item(s)`);
  if (value.length > maxLength) issues.add(path, `must contain at most ${maxLength} items`);
  return value;
}

function stringsFrom(issues: Issues, path: string, value: unknown, allowed: readonly string[], minLength: number): void {
  const items = arrayOf(issues, path, value, minLength);
  if (!items) return;
  items.forEach((item, i) => oneOf(issues, `${path}[${i}]`, item, allowed));
}

function prose(issues: Issues, path: string, value: unknown, keys: readonly string[]): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  for (const key of keys) str(issues, `${path}.${key}`, value[key]);
}

/* -------------------------------------------------------------------------- */
/* Section validators                                                         */
/* -------------------------------------------------------------------------- */

function validateCharacter(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  oneOf(issues, `${path}.temperature`, value['temperature'], TEMPERATURE_BANDS);
  oneOf(issues, `${path}.moisture`, value['moisture'], MOISTURE_BANDS);
  oneOf(issues, `${path}.altitude`, value['altitude'], ALTITUDE_BANDS);
  oneOf(issues, `${path}.treeCover`, value['treeCover'], TREE_COVERS);
  oneOf(issues, `${path}.water`, value['water'], WATER_KINDS);
  const eeriness = num(issues, `${path}.eeriness`, value['eeriness'], 1, 5);
  if (eeriness !== null && !Number.isInteger(eeriness)) {
    issues.add(`${path}.eeriness`, 'must be an integer 1..5');
  }
}

function validateArrival(issues: Issues, path: string, value: unknown): void {
  prose(issues, path, value, ['approach', 'firstHeard', 'firstSeen', 'underfoot', 'arrivalBeat']);
  if (!isRecord(value)) return;
  range(issues, `${path}.walkSeconds`, value['walkSeconds'], 1, 300);
}

function validateScene(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  oneOf(issues, `${path}.ground`, value['ground'], GROUND_MATERIALS);
  str(issues, `${path}.groundNote`, value['groundNote']);
  oneOf(issues, `${path}.elevation`, value['elevation'], ELEVATIONS);
  str(issues, `${path}.elevationNote`, value['elevationNote']);
  num(issues, `${path}.drawDistanceM`, value['drawDistanceM'], 10, 1000);
  unit(issues, `${path}.skyOpenness`, value['skyOpenness']);
  num(issues, `${path}.walkableRadiusM`, value['walkableRadiusM'], 12, 200);

  const kits = arrayOf(issues, `${path}.vegetation`, value['vegetation'], 1, 12);
  kits?.forEach((kit, i) => {
    const kitPath = `${path}.vegetation[${i}]`;
    if (!isRecord(kit)) {
      issues.add(kitPath, 'must be an object');
      return;
    }
    const kitId = str(issues, `${kitPath}.kitId`, kit['kitId'], 64);
    if (kitId !== null && !KEY_PATTERN.test(kitId)) issues.add(`${kitPath}.kitId`, 'must match ^[a-z0-9_]+$');
    str(issues, `${kitPath}.label`, kit['label']);
    num(issues, `${kitPath}.density`, kit['density'], 0, 1000);
    range(issues, `${kitPath}.heightRange`, kit['heightRange'], 0, 120);
    if (typeof kit['lowTierDrop'] !== 'boolean') issues.add(`${kitPath}.lowTierDrop`, 'must be a boolean');
    str(issues, `${kitPath}.note`, kit['note']);
  });

  const landmarks = arrayOf(issues, `${path}.landmarks`, value['landmarks'], 2, 16);
  landmarks?.forEach((landmark, i) => {
    const lmPath = `${path}.landmarks[${i}]`;
    if (!isRecord(landmark)) {
      issues.add(lmPath, 'must be an object');
      return;
    }
    const lmId = str(issues, `${lmPath}.id`, landmark['id'], 64);
    if (lmId !== null && !KEY_PATTERN.test(lmId)) issues.add(`${lmPath}.id`, 'must match ^[a-z0-9_]+$');
    str(issues, `${lmPath}.label`, landmark['label']);
    oneOf(issues, `${lmPath}.kind`, landmark['kind'], LANDMARK_KINDS);
    if (typeof landmark['handcrafted'] !== 'boolean') issues.add(`${lmPath}.handcrafted`, 'must be a boolean');
    str(issues, `${lmPath}.note`, landmark['note']);
  });

  const water = value['water'];
  if (water !== undefined) {
    const wPath = `${path}.water`;
    if (!isRecord(water)) {
      issues.add(wPath, 'must be an object when present');
    } else {
      oneOf(issues, `${wPath}.kind`, water['kind'], WATER_KINDS);
      if (water['kind'] === 'none') issues.add(`${wPath}.kind`, 'omit the water feature entirely instead of using "none"');
      str(issues, `${wPath}.label`, water['label']);
      num(issues, `${wPath}.widthM`, water['widthM'], 0.1, 100_000);
      oneOf(issues, `${wPath}.flow`, water['flow'], WATER_FLOWS);
      unit(issues, `${wPath}.clarity`, water['clarity']);
      if (typeof water['fishable'] !== 'boolean') issues.add(`${wPath}.fishable`, 'must be a boolean');
      if (typeof water['skippable'] !== 'boolean') issues.add(`${wPath}.skippable`, 'must be a boolean');
      str(issues, `${wPath}.note`, water['note']);
    }
  }

  const fog = value['fog'];
  if (!isRecord(fog)) {
    issues.add(`${path}.fog`, 'must be an object');
  } else {
    hex(issues, `${path}.fog.colour`, fog['colour']);
    num(issues, `${path}.fog.density`, fog['density'], 0, 1);
    str(issues, `${path}.fog.note`, fog['note']);
  }

  const palette = value['nightPalette'];
  if (!isRecord(palette)) {
    issues.add(`${path}.nightPalette`, 'must be an object');
  } else {
    for (const key of ['zenith', 'horizon', 'ground', 'foliage', 'rock', 'fireGlow', 'moonlight', 'shadow']) {
      hex(issues, `${path}.nightPalette.${key}`, palette[key]);
    }
    const water2 = palette['water'];
    if (water2 !== null) hex(issues, `${path}.nightPalette.water`, water2);
  }
}

function validateWeather(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  str(issues, `${path}.id`, value['id'], 64);

  const weights = value['weights'];
  if (!isRecord(weights)) {
    issues.add(`${path}.weights`, 'must be an object');
  } else {
    const entries = Object.entries(weights);
    if (entries.length === 0) issues.add(`${path}.weights`, 'must weight at least one weather kind');
    for (const [kind, weight] of entries) {
      if (!WEATHER_KINDS.includes(kind as WeatherKind)) {
        issues.add(`${path}.weights.${kind}`, `is not a WeatherKind (one of: ${WEATHER_KINDS.join(', ')})`);
        continue;
      }
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        issues.add(`${path}.weights.${kind}`, 'must be a finite weight greater than zero');
      }
    }
  }

  num(issues, `${path}.baseTempC`, value['baseTempC'], -60, 55);
  num(issues, `${path}.baseWind`, value['baseWind'], 0, 30);
  unit(issues, `${path}.exposure`, value['exposure']);
  unit(issues, `${path}.skyEventChance`, value['skyEventChance']);
  num(issues, `${path}.transitionSeconds`, value['transitionSeconds'], 10, 3600);

  const events = arrayOf(issues, `${path}.skyEvents`, value['skyEvents'], 0, 8);
  events?.forEach((event, i) => {
    const ePath = `${path}.skyEvents[${i}]`;
    if (typeof event !== 'string' || !SKY_EVENTS.includes(event as SkyEvent)) {
      issues.add(ePath, `must be a SkyEvent (one of: ${SKY_EVENTS.join(', ')})`);
    } else if (event === 'none') {
      issues.add(ePath, '"none" is the absence of an event and must not be listed');
    }
  });
}

function validateFuel(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  str(issues, `${path}.note`, value['note']);
  const sources = arrayOf(issues, `${path}.sources`, value['sources'], 1, 8);
  sources?.forEach((source, i) => {
    const sPath = `${path}.sources[${i}]`;
    if (!isRecord(source)) {
      issues.add(sPath, 'must be an object');
      return;
    }
    const woodId = source['woodId'];
    if (typeof woodId !== 'string' || WOOD_TYPES[woodId] === undefined) {
      issues.add(
        `${sPath}.woodId`,
        `must be a WOOD_TYPES id (one of: ${Object.keys(WOOD_TYPES).join(', ')})`,
      );
    }
    const weight = source['weight'];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      issues.add(`${sPath}.weight`, 'must be a finite availability weight greater than zero');
    }
    str(issues, `${sPath}.foundAs`, source['foundAs']);
    num(issues, `${sPath}.moistureBias`, source['moistureBias'], -1, 1);
  });
}

function validateWildlife(issues: Issues, path: string, value: unknown): void {
  const roster = arrayOf(issues, path, value, 1, 12);
  if (!roster) return;
  const seen = new Set<string>();
  roster.forEach((entry, i) => {
    const ePath = `${path}[${i}]`;
    if (!isRecord(entry)) {
      issues.add(ePath, 'must be an object');
      return;
    }
    const id = str(issues, `${ePath}.id`, entry['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${ePath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${ePath}.id`, `duplicate wildlife id "${id}"`);
      seen.add(id);
    }
    str(issues, `${ePath}.label`, entry['label']);
    unit(issues, `${ePath}.shyness`, entry['shyness']);
    unit(issues, `${ePath}.curiosity`, entry['curiosity']);
    stringsFrom(issues, `${ePath}.window`, entry['window'], ACTIVITY_WINDOWS, 1);
    stringsFrom(issues, `${ePath}.attractedBy`, entry['attractedBy'], WILDLIFE_CUES, 1);
    stringsFrom(issues, `${ePath}.repelledBy`, entry['repelledBy'], WILDLIFE_CUES, 0);
    if (typeof entry['canPersist'] !== 'boolean') issues.add(`${ePath}.canPersist`, 'must be a boolean');
    if (typeof entry['investigatesObjects'] !== 'boolean') {
      issues.add(`${ePath}.investigatesObjects`, 'must be a boolean');
    }
    const traces = arrayOf(issues, `${ePath}.traces`, entry['traces'], 1, 8);
    traces?.forEach((trace, t) => str(issues, `${ePath}.traces[${t}]`, trace));
    str(issues, `${ePath}.note`, entry['note']);
  });
}

function validateAmbience(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  const wind = value['wind'];
  if (!isRecord(wind)) {
    issues.add(`${path}.wind`, 'must be an object');
  } else {
    oneOf(issues, `${path}.wind.character`, wind['character'], WIND_CHARACTERS);
    unit(issues, `${path}.wind.baseLevel`, wind['baseLevel']);
    unit(issues, `${path}.wind.gustiness`, wind['gustiness']);
    str(issues, `${path}.wind.material`, wind['material']);
  }
  unit(issues, `${path}.insectDensity`, value['insectDensity']);
  str(issues, `${path}.insectNote`, value['insectNote']);
  unit(issues, `${path}.waterPresence`, value['waterPresence']);
  oneOf(issues, `${path}.reverb`, value['reverb'], REVERB_SPACES);
  str(issues, `${path}.reverbNote`, value['reverbNote']);
  num(issues, `${path}.nightFloorDb`, value['nightFloorDb'], -90, -10);

  const events = arrayOf(issues, `${path}.distantEvents`, value['distantEvents'], 1, 10);
  const seen = new Set<string>();
  events?.forEach((event, i) => {
    const ePath = `${path}.distantEvents[${i}]`;
    if (!isRecord(event)) {
      issues.add(ePath, 'must be an object');
      return;
    }
    const id = str(issues, `${ePath}.id`, event['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${ePath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${ePath}.id`, `duplicate distant sound id "${id}"`);
      seen.add(id);
    }
    str(issues, `${ePath}.label`, event['label']);
    const weight = event['weight'];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      issues.add(`${ePath}.weight`, 'must be a finite weight greater than zero');
    }
    num(issues, `${ePath}.minGapSeconds`, event['minGapSeconds'], 1, 3600);
    str(issues, `${ePath}.note`, event['note']);
  });
}

function validateActivities(issues: Issues, path: string, value: unknown): void {
  const list = arrayOf(issues, path, value, 3, 16);
  if (!list) return;
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const ePath = `${path}[${i}]`;
    if (!isRecord(entry)) {
      issues.add(ePath, 'must be an object');
      return;
    }
    const id = entry['id'];
    oneOf(issues, `${ePath}.id`, id, ACTIVITY_IDS);
    if (typeof id === 'string') {
      if (seen.has(id)) issues.add(`${ePath}.id`, `duplicate activity "${id}"`);
      seen.add(id);
    }
    str(issues, `${ePath}.label`, entry['label']);
    oneOf(issues, `${ePath}.prominence`, entry['prominence'], ACTIVITY_PROMINENCE);
    str(issues, `${ePath}.note`, entry['note']);
  });
  if (!list.some((entry) => isRecord(entry) && entry['prominence'] === 'signature')) {
    issues.add(path, 'must include at least one signature activity — every environment needs something only it has');
  }
}

function validateRadio(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  unit(issues, `${path}.baseReception`, value['baseReception']);
  str(issues, `${path}.receptionNote`, value['receptionNote']);
  str(issues, `${path}.betweenStations`, value['betweenStations']);

  const stations = arrayOf(issues, `${path}.stations`, value['stations'], 1, 12);
  const seen = new Set<string>();
  stations?.forEach((station, i) => {
    const sPath = `${path}.stations[${i}]`;
    if (!isRecord(station)) {
      issues.add(sPath, 'must be an object');
      return;
    }
    const id = str(issues, `${sPath}.id`, station['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${sPath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${sPath}.id`, `duplicate station id "${id}"`);
      seen.add(id);
    }
    num(issues, `${sPath}.dial`, station['dial'], 0.1, 30_000);
    oneOf(issues, `${sPath}.band`, station['band'], RADIO_BANDS);
    str(issues, `${sPath}.name`, station['name']);
    oneOf(issues, `${sPath}.character`, station['character'], STATION_CHARACTERS);
    unit(issues, `${sPath}.reception`, station['reception']);
    str(issues, `${sPath}.note`, station['note']);
  });
}

function validateSecrets(issues: Issues, path: string, value: unknown): void {
  // Spec §8: two to four optional discoveries per environment.
  const list = arrayOf(issues, path, value, 2, 4);
  if (!list) return;
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const ePath = `${path}[${i}]`;
    if (!isRecord(entry)) {
      issues.add(ePath, 'must be an object');
      return;
    }
    const id = str(issues, `${ePath}.id`, entry['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${ePath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${ePath}.id`, `duplicate secret id "${id}"`);
      seen.add(id);
    }
    str(issues, `${ePath}.title`, entry['title']);
    str(issues, `${ePath}.discovery`, entry['discovery']);
    str(issues, `${ePath}.telling`, entry['telling']);
    stringsFrom(issues, `${ePath}.channels`, entry['channels'], MYSTERY_CHANNELS, 1);
    unit(issues, `${ePath}.rarity`, entry['rarity']);

    // The two rules that are not negotiable (spec §8).
    if (entry['optional'] !== true) {
      issues.add(`${ePath}.optional`, 'must be literally true — all mystery is optional');
    }
    if (entry['gatesNothing'] !== true) {
      issues.add(
        `${ePath}.gatesNothing`,
        'must be literally true — a discovery may never gate essential functionality or a major reward',
      );
    }

    const oneTime = entry['oneTime'];
    if (typeof oneTime !== 'boolean') {
      issues.add(`${ePath}.oneTime`, 'must be a boolean');
      return;
    }
    const evidence = entry['leavesEvidence'];
    if (oneTime) {
      if (typeof evidence !== 'string' || evidence.trim().length === 0) {
        issues.add(
          `${ePath}.leavesEvidence`,
          'a one-time discovery must leave evidence afterward — a missed event never strands anyone (spec §8)',
        );
      }
    } else if (evidence !== null) {
      issues.add(`${ePath}.leavesEvidence`, 'must be null for a repeatable discovery');
    }
  });
}

function validateMachine(issues: Issues, path: string, value: unknown): void {
  prose(issues, path, value, ['flavourNote', 'stickerHint', 'frostNote']);
  if (!isRecord(value)) return;
  const weights = value['quirkWeights'];
  if (!isRecord(weights)) {
    issues.add(`${path}.quirkWeights`, 'must be an object');
    return;
  }
  const entries = Object.entries(weights);
  if (entries.length === 0) issues.add(`${path}.quirkWeights`, 'must weight at least one quirk');
  for (const [quirkId, weight] of entries) {
    if (!QUIRK_IDS.includes(quirkId)) {
      issues.add(`${path}.quirkWeights.${quirkId}`, `is not a QUIRK_POOL id (one of: ${QUIRK_IDS.join(', ')})`);
      continue;
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      issues.add(`${path}.quirkWeights.${quirkId}`, 'must be a finite weight greater than zero');
    }
  }
}

function validateProcedural(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  const streams = arrayOf(issues, `${path}.seedStreams`, value['seedStreams'], 1, 16);
  streams?.forEach((stream, i) => {
    const sPath = `${path}.seedStreams[${i}]`;
    const name = str(issues, sPath, stream, 64);
    if (name !== null && !KEY_PATTERN.test(name)) issues.add(sPath, 'must match ^[a-z0-9_]+$');
  });

  const variations = arrayOf(issues, `${path}.variations`, value['variations'], 2, 12);
  const seen = new Set<string>();
  variations?.forEach((variation, i) => {
    const vPath = `${path}.variations[${i}]`;
    if (!isRecord(variation)) {
      issues.add(vPath, 'must be an object');
      return;
    }
    const id = str(issues, `${vPath}.id`, variation['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${vPath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${vPath}.id`, `duplicate variation id "${id}"`);
      seen.add(id);
    }
    str(issues, `${vPath}.label`, variation['label']);
    range(issues, `${vPath}.range`, variation['range']);
    str(issues, `${vPath}.unit`, variation['unit']);
    str(issues, `${vPath}.note`, variation['note']);
  });

  const invariants = arrayOf(issues, `${path}.invariants`, value['invariants'], 2, 12);
  invariants?.forEach((item, i) => str(issues, `${path}.invariants[${i}]`, item));
}

function validateDiscovery(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  const weight = value['weight'];
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
    issues.add(
      `${path}.weight`,
      'must be a finite weight greater than zero — every core environment must remain discoverable (spec §5.4)',
    );
  }
  str(issues, `${path}.note`, value['note']);

  const affinities = value['affinities'];
  if (!isRecord(affinities)) {
    issues.add(`${path}.affinities`, 'must be an object (an empty one is fine)');
    return;
  }
  for (const [region, multiplier] of Object.entries(affinities)) {
    const aPath = `${path}.affinities.${region}`;
    if (!REGIONS.includes(region as (typeof REGIONS)[number])) {
      issues.add(aPath, `is not a RegionId (one of: ${REGIONS.join(', ')})`);
      continue;
    }
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
      issues.add(aPath, 'must be a finite multiplier');
      continue;
    }
    if (multiplier < MIN_REGION_AFFINITY || multiplier > MAX_REGION_AFFINITY) {
      issues.add(
        aPath,
        `must be within [${MIN_REGION_AFFINITY}, ${MAX_REGION_AFFINITY}] — region weights early appearance and may never lock an environment out`,
      );
    }
  }
}

function validatePerformance(issues: Issues, path: string, value: unknown): void {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return;
  }
  oneOf(issues, `${path}.cost`, value['cost'], PERFORMANCE_COSTS);
  num(issues, `${path}.midTierDrawCalls`, value['midTierDrawCalls'], 1, MID_TIER_DRAW_CALL_BUDGET);
  num(issues, `${path}.midTierTriangles`, value['midTierTriangles'], 1, MID_TIER_TRIANGLE_BUDGET);
  num(issues, `${path}.dynamicLights`, value['dynamicLights'], 1, DYNAMIC_LIGHT_BUDGET);
  str(issues, `${path}.note`, value['note']);
  const cuts = arrayOf(issues, `${path}.lowTierCuts`, value['lowTierCuts'], 2, 10);
  cuts?.forEach((cut, i) => str(issues, `${path}.lowTierCuts[${i}]`, cut));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Validates one manifest. Returns every problem found, not just the first. */
export function validateEnvironment(value: unknown, pathPrefix?: string): readonly ValidationIssue[] {
  const issues = new Issues();
  if (!isRecord(value)) {
    issues.add(pathPrefix ?? '<environment>', 'must be an object');
    return issues.list;
  }

  const rawId = value['id'];
  const path = pathPrefix ?? (typeof rawId === 'string' && rawId.length > 0 ? rawId : '<environment>');

  const id = str(issues, `${path}.id`, rawId, 64);
  if (id !== null && !ID_PATTERN.test(id)) {
    issues.add(`${path}.id`, 'must match ^[a-z0-9_]+$ so it can be persisted as a protocol environmentId');
  }
  str(issues, `${path}.name`, value['name'], 60);
  str(issues, `${path}.tagline`, value['tagline'], 240);
  str(issues, `${path}.inspiration`, value['inspiration']);

  const tags = arrayOf(issues, `${path}.biomeTags`, value['biomeTags'], 1, 8);
  tags?.forEach((tag, i) => {
    const tPath = `${path}.biomeTags[${i}]`;
    const text = str(issues, tPath, tag, 48);
    if (text !== null && !/^[a-z0-9-]+$/.test(text)) issues.add(tPath, 'must match ^[a-z0-9-]+$');
  });

  validateCharacter(issues, `${path}.character`, value['character']);
  validateArrival(issues, `${path}.arrival`, value['arrival']);
  validateScene(issues, `${path}.scene`, value['scene']);
  validateWeather(issues, `${path}.weather`, value['weather']);
  prose(issues, `${path}.weatherCharacter`, value['weatherCharacter'], [
    'temperatureNote',
    'windNote',
    'exposureNote',
  ]);
  if (isRecord(value['weatherCharacter'])) {
    range(issues, `${path}.weatherCharacter.nightRangeC`, value['weatherCharacter']['nightRangeC'], -60, 55);
  }
  validateFuel(issues, `${path}.fuel`, value['fuel']);
  validateWildlife(issues, `${path}.wildlife`, value['wildlife']);
  validateAmbience(issues, `${path}.ambience`, value['ambience']);
  validateActivities(issues, `${path}.activities`, value['activities']);
  validateRadio(issues, `${path}.radio`, value['radio']);
  validateSecrets(issues, `${path}.secrets`, value['secrets']);
  validateMachine(issues, `${path}.machine`, value['machine']);
  validateProcedural(issues, `${path}.procedural`, value['procedural']);
  validateDiscovery(issues, `${path}.discovery`, value['discovery']);
  validatePerformance(issues, `${path}.performance`, value['performance']);

  // Cross-field coherence: a site whose character says it has water must have
  // the feature, and vice versa. This is the check that stops a copy-paste
  // producing a lake with no water in the scene manifest.
  const character = value['character'];
  const scene = value['scene'];
  if (isRecord(character) && isRecord(scene)) {
    const declared = character['water'];
    const feature = scene['water'];
    if (declared === 'none' && feature !== undefined) {
      issues.add(`${path}.scene.water`, 'character.water is "none" but the scene declares a water feature');
    }
    if (declared !== 'none' && feature === undefined) {
      issues.add(`${path}.scene.water`, `character.water is "${String(declared)}" but the scene has no water feature`);
    }
    if (isRecord(feature) && declared !== 'none' && feature['kind'] !== declared) {
      issues.add(
        `${path}.scene.water.kind`,
        `must match character.water ("${String(declared)}"), got "${String(feature['kind'])}"`,
      );
    }
    if (isRecord(scene['nightPalette'])) {
      const paletteWater = (scene['nightPalette'] as Record<string, unknown>)['water'];
      if (declared === 'none' && paletteWater !== null) {
        issues.add(`${path}.scene.nightPalette.water`, 'must be null where the environment has no water surface');
      }
      if (declared !== 'none' && paletteWater === null) {
        issues.add(`${path}.scene.nightPalette.water`, 'must be a colour where the environment has water');
      }
    }
  }

  return issues.list;
}

/** Validates the whole catalogue, including catalogue-level invariants. */
export function validateCatalogue(value: unknown): readonly ValidationIssue[] {
  const issues = new Issues();
  const list = arrayOf(issues, 'catalogue', value, MIN_CATALOGUE_SIZE, MAX_CATALOGUE_SIZE);
  if (!list) return issues.list;

  const seen = new Set<string>();
  list.forEach((entry, i) => {
    for (const issue of validateEnvironment(entry, `catalogue[${i}]`)) issues.list.push(issue);
    if (isRecord(entry) && typeof entry['id'] === 'string') {
      const id = entry['id'];
      if (seen.has(id)) issues.add(`catalogue[${i}].id`, `duplicate environment id "${id}"`);
      seen.add(id);
    }
  });

  return issues.list;
}

/** Throws with every problem listed. Used by tests and by content tooling. */
export function assertValidCatalogue(value: unknown): asserts value is readonly EnvironmentManifest[] {
  const issues = validateCatalogue(value);
  if (issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
    throw new Error(`Environment catalogue failed validation (${issues.length} issue(s)):\n${lines}`);
  }
}

/** Convenience for one manifest. */
export function assertValidEnvironment(value: unknown): asserts value is EnvironmentManifest {
  const issues = validateEnvironment(value);
  if (issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
    throw new Error(`Environment failed validation (${issues.length} issue(s)):\n${lines}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Live-ops documents (§14)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The same predicates, pointed at the small shapes live ops publishes.
 *
 * These run **before** a document is published, on our machine, against the
 * operator's request — never on a player's phone at render time. The whole
 * reason the CMS reuses this file rather than growing its own validator is that
 * an environment pushed by live ops must pass exactly the checks an environment
 * compiled into the client passes. Two validators is two answers to the same
 * question, and one of them would be wrong.
 */

/** Shared by both live-ops shapes: a list of environment ids, or `['*']`. */
function validateEnvironmentTargets(issues: Issues, path: string, value: unknown): void {
  const list = arrayOf(issues, path, value, 1, 64);
  if (!list) return;
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const ePath = `${path}[${i}]`;
    const id = str(issues, ePath, entry, 64);
    if (id === null) return;
    if (id !== ALL_ENVIRONMENTS && !ID_PATTERN.test(id)) {
      issues.add(ePath, `must be an environment id matching ^[a-z0-9_]+$, or "${ALL_ENVIRONMENTS}"`);
    }
    if (seen.has(id)) issues.add(ePath, `duplicate environment target "${id}"`);
    seen.add(id);
  });
  if (list.includes(ALL_ENVIRONMENTS) && list.length > 1) {
    issues.add(path, `"${ALL_ENVIRONMENTS}" already means every environment; list nothing beside it`);
  }
}

/** Stations, wherever they appear: in an environment's radio profile or an event's. */
function validateStationList(
  issues: Issues,
  path: string,
  value: unknown,
  minLength: number,
  maxLength: number,
): void {
  const stations = arrayOf(issues, path, value, minLength, maxLength);
  if (!stations) return;
  const seen = new Set<string>();
  stations.forEach((station, i) => {
    const sPath = `${path}[${i}]`;
    if (!isRecord(station)) {
      issues.add(sPath, 'must be an object');
      return;
    }
    const id = str(issues, `${sPath}.id`, station['id'], 64);
    if (id !== null) {
      if (!KEY_PATTERN.test(id)) issues.add(`${sPath}.id`, 'must match ^[a-z0-9_]+$');
      if (seen.has(id)) issues.add(`${sPath}.id`, `duplicate station id "${id}"`);
      seen.add(id);
    }
    num(issues, `${sPath}.dial`, station['dial'], 0.1, 30_000);
    oneOf(issues, `${sPath}.band`, station['band'], RADIO_BANDS);
    str(issues, `${sPath}.name`, station['name']);
    oneOf(issues, `${sPath}.character`, station['character'], STATION_CHARACTERS);
    unit(issues, `${sPath}.reception`, station['reception']);
    str(issues, `${sPath}.note`, station['note']);
  });
}

/**
 * A seasonal event: a meteor-shower weekend, a winter campsite, a limited
 * flavour. Time-bounded content that leans on the world without replacing it.
 */
export function validateSeasonalEvent(value: unknown, pathPrefix?: string): readonly ValidationIssue[] {
  const issues = new Issues();
  if (!isRecord(value)) {
    issues.add(pathPrefix ?? '<event>', 'must be an object');
    return issues.list;
  }
  const rawId = value['id'];
  const path = pathPrefix ?? (typeof rawId === 'string' && rawId.length > 0 ? rawId : '<event>');

  const id = str(issues, `${path}.id`, rawId, 64);
  if (id !== null && !ID_PATTERN.test(id)) {
    issues.add(`${path}.id`, 'must match ^[a-z0-9_]+$ so it can be persisted as a content slug');
  }
  str(issues, `${path}.name`, value['name'], 80);
  str(issues, `${path}.tagline`, value['tagline'], 240);
  str(issues, `${path}.note`, value['note']);
  oneOf(issues, `${path}.kind`, value['kind'], SEASONAL_EVENT_KINDS);
  validateEnvironmentTargets(issues, `${path}.environments`, value['environments']);
  unit(issues, `${path}.intensity`, value['intensity']);
  oneOf(issues, `${path}.performanceCost`, value['performanceCost'], PERFORMANCE_COSTS);

  const rewardCodes = arrayOf(issues, `${path}.rewardCodes`, value['rewardCodes'], 0, 16);
  rewardCodes?.forEach((code, i) => {
    const cPath = `${path}.rewardCodes[${i}]`;
    const text = str(issues, cPath, code, 64);
    if (text !== null && !KEY_PATTERN.test(text)) issues.add(cPath, 'must match ^[a-z0-9_]+$');
  });

  validateStationList(issues, `${path}.stations`, value['stations'], 0, 8);

  // Kind-specific requirements. A `sky-event` with no sky event is a document
  // that would publish cleanly and then do nothing at all, which is worse than
  // a rejection because nobody would notice for a week.
  const kind = value['kind'];
  if (kind === 'sky-event') {
    oneOf(issues, `${path}.skyEvent`, value['skyEvent'], SKY_EVENTS);
    if (value['skyEvent'] === 'none') {
      issues.add(`${path}.skyEvent`, 'a sky-event with skyEvent "none" would change nothing');
    }
  } else if (value['skyEvent'] !== undefined) {
    issues.add(`${path}.skyEvent`, `is only meaningful when kind is "sky-event" (kind is "${String(kind)}")`);
  }

  if (kind === 'weather') {
    oneOf(issues, `${path}.weather`, value['weather'], WEATHER_KINDS);
  } else if (value['weather'] !== undefined) {
    issues.add(`${path}.weather`, `is only meaningful when kind is "weather" (kind is "${String(kind)}")`);
  }

  if (kind === 'station' && (!Array.isArray(value['stations']) || value['stations'].length === 0)) {
    issues.add(`${path}.stations`, 'a station event must carry at least one station');
  }

  // Spec §5.5 and §8: rare events are gifts, not gates. An event may add reward
  // codes, and the reward definitions themselves decide reachability — but an
  // event that is the *only* path to something is a design error we can catch
  // here cheaply, so `exclusive` is simply not expressible.
  if (value['exclusive'] !== undefined || value['gates'] !== undefined) {
    issues.add(
      `${path}.exclusive`,
      'seasonal content may never gate anything; a missed window must strand nobody (spec §5.5, §8)',
    );
  }

  return issues.list;
}

/** A block of radio programming pushed at one or more environments. */
export function validateStationProgramming(value: unknown, pathPrefix?: string): readonly ValidationIssue[] {
  const issues = new Issues();
  if (!isRecord(value)) {
    issues.add(pathPrefix ?? '<programming>', 'must be an object');
    return issues.list;
  }
  const rawId = value['id'];
  const path = pathPrefix ?? (typeof rawId === 'string' && rawId.length > 0 ? rawId : '<programming>');

  const id = str(issues, `${path}.id`, rawId, 64);
  if (id !== null && !ID_PATTERN.test(id)) {
    issues.add(`${path}.id`, 'must match ^[a-z0-9_]+$ so it can be persisted as a content slug');
  }
  str(issues, `${path}.name`, value['name'], 80);
  str(issues, `${path}.note`, value['note']);
  validateEnvironmentTargets(issues, `${path}.environments`, value['environments']);
  validateStationList(issues, `${path}.stations`, value['stations'], 1, 12);
  return issues.list;
}

/** Throws with every problem listed. Mirrors `assertValidEnvironment`. */
export function assertValidSeasonalEvent(value: unknown): asserts value is SeasonalEventManifest {
  const issues = validateSeasonalEvent(value);
  if (issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
    throw new Error(`Seasonal event failed validation (${issues.length} issue(s)):\n${lines}`);
  }
}

/** Throws with every problem listed. Mirrors `assertValidEnvironment`. */
export function assertValidStationProgramming(value: unknown): asserts value is StationProgrammingManifest {
  const issues = validateStationProgramming(value);
  if (issues.length > 0) {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
    throw new Error(`Station programming failed validation (${issues.length} issue(s)):\n${lines}`);
  }
}
