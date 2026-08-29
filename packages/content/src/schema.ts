/**
 * The environment content schema (spec §5.4, architecture §9).
 *
 * An environment is **data**. Adding one requires no engine change: the
 * renderer, the audio engine, the wildlife system and the radio all read from
 * the shapes below. Nothing in this file imports a renderer, touches the DOM,
 * or knows what a frame is.
 *
 * Two rules from the spec are encoded structurally rather than left to
 * discipline:
 *
 * 1. **Region never locks content** (§5.4). A `DiscoveryRule` carries a
 *    strictly positive base weight and regional *multipliers* clamped into
 *    `[MIN_REGION_AFFINITY, MAX_REGION_AFFINITY]`, both above zero — so the
 *    effective weight of every environment in every region is always positive.
 *    There is no representation for "unavailable here".
 * 2. **Mystery is optional** (§8). `SecretEntry.optional` and
 *    `SecretEntry.gatesNothing` are literal `true`; a secret that gates
 *    something is not expressible, and the validator rejects any attempt.
 */

import type { WeatherProfile } from '@somemore/sim';

/* -------------------------------------------------------------------------- */
/* Small shared shapes                                                        */
/* -------------------------------------------------------------------------- */

/** An inclusive numeric range. Used for seeded variation and soft bounds. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** `#rrggbb`. Palettes are authored as hex because artists read hex. */
export type Hex = string;

/** Linear-space RGB, 0..1 — what a shader actually wants. */
export type LinearRgb = readonly [number, number, number];

/** sRGB hex → linear RGB triple, for renderers that work in linear space. */
export function hexToLinearRgb(hex: Hex): LinearRgb {
  const clean = hex.replace('#', '');
  const toLinear = (byte: number): number => {
    const s = byte / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [
    toLinear(parseInt(clean.slice(0, 2), 16)),
    toLinear(parseInt(clean.slice(2, 4), 16)),
    toLinear(parseInt(clean.slice(4, 6), 16)),
  ];
}

/* -------------------------------------------------------------------------- */
/* Character axes — what makes the launch set *varied*                        */
/* -------------------------------------------------------------------------- */

export type TemperatureBand = 'hot' | 'warm' | 'mild' | 'cool' | 'cold' | 'freezing';
export type MoistureBand = 'arid' | 'dry' | 'balanced' | 'damp' | 'wet';
export type AltitudeBand = 'sea-level' | 'lowland' | 'upland' | 'montane' | 'alpine';
export type TreeCover = 'none' | 'sparse' | 'open' | 'moderate' | 'dense' | 'canopy';

export type WaterKind =
  | 'none'
  | 'creek'
  | 'river'
  | 'lake'
  | 'tarn'
  | 'sea'
  | 'blackwater'
  | 'hot-spring'
  | 'ephemeral-sheet';

/**
 * How liminal the place feels, 1 (homely) to 5 (deeply strange).
 *
 * Calibration rule (§2.2): this axis never reaches *threatening*. 5 means
 * "a salt flat at 2am that reflects the whole sky", never "something is out
 * there". Nothing stalks, chases or endangers the player at any value.
 */
export type Eeriness = 1 | 2 | 3 | 4 | 5;

export interface EnvironmentCharacter {
  readonly temperature: TemperatureBand;
  readonly moisture: MoistureBand;
  readonly altitude: AltitudeBand;
  readonly treeCover: TreeCover;
  readonly water: WaterKind;
  readonly eeriness: Eeriness;
}

/* -------------------------------------------------------------------------- */
/* Arrival — the walk in the dark toward the fire (§5.1)                      */
/* -------------------------------------------------------------------------- */

export interface ArrivalSequence {
  /** The path in: surface, width, what the player is walking through. */
  readonly approach: string;
  /** The very first thing audible, before anything is visible. */
  readonly firstHeard: string;
  /** The first thing that resolves out of the fog/dark. */
  readonly firstSeen: string;
  /** What the ground does underfoot on the way in. */
  readonly underfoot: string;
  /** The beat where the campsite is finally *there*. */
  readonly arrivalBeat: string;
  /** Seconds of unhurried walking before the fire is reachable. */
  readonly walkSeconds: Range;
}

/* -------------------------------------------------------------------------- */
/* Scene manifest — everything the renderer composes a place from             */
/* -------------------------------------------------------------------------- */

export type GroundMaterial =
  | 'pine-duff'
  | 'moss-duff'
  | 'granite-slab'
  | 'shield-rock'
  | 'river-cobble'
  | 'fine-sand'
  | 'red-dust'
  | 'packed-snow'
  | 'peat-moss'
  | 'volcanic-ash'
  | 'grass-thatch'
  | 'gravel-pad'
  | 'salt-crust'
  | 'boardwalk-plank'
  | 'cracked-clay';

export type ElevationCharacter = 'flat' | 'gentle' | 'rolling' | 'terraced' | 'basin' | 'bench' | 'ridge' | 'steep';

/** One entry of a modular biome kit (§5.4 "modular biome kits"). */
export interface VegetationKit {
  readonly kitId: string;
  readonly label: string;
  /** Instances per 100 m², 0 = absent. Drives scatter density. */
  readonly density: number;
  /** Metres. */
  readonly heightRange: Range;
  /** Which tier drops this kit first. */
  readonly lowTierDrop: boolean;
  readonly note: string;
}

export type LandmarkKind = 'natural' | 'built' | 'abandoned' | 'signage' | 'water' | 'sky' | 'camp';

export interface LandmarkProp {
  readonly id: string;
  readonly label: string;
  readonly kind: LandmarkKind;
  /** True for the one or two shapes that *are* this place and never vary. */
  readonly handcrafted: boolean;
  readonly note: string;
}

export type WaterFlow = 'still' | 'slow' | 'lapping' | 'running' | 'rushing' | 'tidal' | 'seeping';

export interface WaterFeature {
  readonly kind: WaterKind;
  readonly label: string;
  /** Approximate width/extent in metres. */
  readonly widthM: number;
  readonly flow: WaterFlow;
  /** 0 = opaque, 1 = glass. Drives reflection and fishing sightlines. */
  readonly clarity: number;
  readonly fishable: boolean;
  readonly skippable: boolean;
  readonly note: string;
}

export interface FogSettings {
  readonly colour: Hex;
  /** Exponential fog density coefficient. */
  readonly density: number;
  readonly note: string;
}

export interface NightPalette {
  readonly zenith: Hex;
  readonly horizon: Hex;
  readonly ground: Hex;
  readonly foliage: Hex;
  readonly rock: Hex;
  /** Null where the environment has no water surface to tint. */
  readonly water: Hex | null;
  readonly fireGlow: Hex;
  readonly moonlight: Hex;
  readonly shadow: Hex;
}

export interface SceneManifest {
  readonly ground: GroundMaterial;
  readonly groundNote: string;
  readonly vegetation: readonly VegetationKit[];
  readonly landmarks: readonly LandmarkProp[];
  readonly elevation: ElevationCharacter;
  readonly elevationNote: string;
  /** Omitted entirely for dry sites. */
  readonly water?: WaterFeature;
  /** Base draw distance in metres before weather shortens it. */
  readonly drawDistanceM: number;
  readonly fog: FogSettings;
  readonly nightPalette: NightPalette;
  /** 0..1 fraction of sky visible from the fire — drives stargazing quality. */
  readonly skyOpenness: number;
  /** Walkable radius in metres. Compact but with real corners (§5.1). */
  readonly walkableRadiusM: number;
}

/* -------------------------------------------------------------------------- */
/* Weather character                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Prose and bounds that sit alongside the simulation's `WeatherProfile`.
 * The profile drives the model; this drives subtitles, Passport lines and
 * the fire's exposure feel.
 */
export interface WeatherCharacter {
  readonly temperatureNote: string;
  readonly windNote: string;
  readonly exposureNote: string;
  /** Typical overnight low/high in °C, for wardrobe and breath vapour. */
  readonly nightRangeC: Range;
}

/* -------------------------------------------------------------------------- */
/* Fuels                                                                      */
/* -------------------------------------------------------------------------- */

/** A wood found here. `woodId` must exist in `WOOD_TYPES` from `@somemore/sim`. */
export interface FuelSource {
  readonly woodId: string;
  /** Relative availability at this campsite. Positive. */
  readonly weight: number;
  /** How the player finds it — a stack, a drift line, a fallen limb. */
  readonly foundAs: string;
  /** Added to the wood's default moisture. Negative = drier than usual. */
  readonly moistureBias: number;
}

export interface FuelProfile {
  readonly sources: readonly FuelSource[];
  /** What burning here smells, sounds and looks like. */
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Wildlife (§7)                                                              */
/* -------------------------------------------------------------------------- */

export type ActivityWindow = 'dusk' | 'early-night' | 'deep-night' | 'pre-dawn' | 'dawn';

export type WildlifeCue =
  | 'stillness'
  | 'quiet'
  | 'firelight'
  | 'ember-glow'
  | 'smoke'
  | 'food-smell'
  | 'marshmallow-smell'
  | 'crumbs'
  | 'flashlight'
  | 'camera-flash'
  | 'radio-music'
  | 'voices'
  | 'footsteps'
  | 'sudden-movement'
  | 'machine-hum'
  | 'compressor-noise'
  | 'vapour-plume'
  | 'warmth'
  | 'rain'
  | 'wind'
  | 'moonlight'
  | 'open-sky'
  | 'water-edge'
  | 'splashing'
  | 'singing'
  | 'shelter'
  | 'cold-air';

/**
 * A species roster entry. Not a collectible (§7): there is no taming meter,
 * no feeding quest and no compendium. `canPersist` marks the species whose
 * *individuals* the world may remember and the player may come to recognise.
 */
export interface WildlifeEntry {
  readonly id: string;
  readonly label: string;
  /** 0 = walks up to you, 1 = you will only ever hear it. */
  readonly shyness: number;
  /** 0 = ignores the camp, 1 = investigates everything. */
  readonly curiosity: number;
  readonly window: readonly ActivityWindow[];
  readonly attractedBy: readonly WildlifeCue[];
  readonly repelledBy: readonly WildlifeCue[];
  /** May recur as a recognisable individual across visits. */
  readonly canPersist: boolean;
  /** May pick up and move (never destroy) an unattended object. */
  readonly investigatesObjects: boolean;
  /** Evidence left behind — tracks, scat, feathers, a moved cup. */
  readonly traces: readonly string[];
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Audio / ambience (§2.3, architecture §5)                                   */
/* -------------------------------------------------------------------------- */

/** Procedural impulse-response space types the audio engine can build. */
export type ReverbSpace = 'openForest' | 'clearing' | 'canyon' | 'snowfield' | 'indoorSmall';

export const REVERB_SPACES: readonly ReverbSpace[] = [
  'openForest',
  'clearing',
  'canyon',
  'snowfield',
  'indoorSmall',
];

export type WindCharacter =
  | 'still'
  | 'breathing'
  | 'steady'
  | 'gusting'
  | 'onshore'
  | 'channelled'
  | 'katabatic'
  | 'buffeting';

export interface WindAmbience {
  readonly character: WindCharacter;
  /** 0..1 resting level of wind in the mix. */
  readonly baseLevel: number;
  /** 0..1 how much the level swings. */
  readonly gustiness: number;
  /** What the wind is moving *through* — needles, grass, tin, nothing. */
  readonly material: string;
}

export interface DistantSound {
  readonly id: string;
  readonly label: string;
  /** Relative likelihood among this site's distant events. Positive. */
  readonly weight: number;
  /** Minimum seconds between two firings, so it stays rare. */
  readonly minGapSeconds: number;
  readonly note: string;
}

export interface AmbienceProfile {
  readonly wind: WindAmbience;
  /** 0..1 — drives the insect layer's voice count. */
  readonly insectDensity: number;
  readonly insectNote: string;
  /** 0..1 — how much of the bed is moving water. */
  readonly waterPresence: number;
  readonly reverb: ReverbSpace;
  readonly reverbNote: string;
  readonly distantEvents: readonly DistantSound[];
  /** Approx dBFS of the quiet floor. Silence is used deliberately (§2.3). */
  readonly nightFloorDb: number;
}

/* -------------------------------------------------------------------------- */
/* Secondary activities (§5.2)                                                */
/* -------------------------------------------------------------------------- */

export type ActivityId =
  | 'fire-tending'
  | 'fishing'
  | 'stone-skipping'
  | 'stargazing'
  | 'binoculars'
  | 'telescope'
  | 'photography'
  | 'radio'
  | 'flashlight'
  | 'wildlife-watching'
  | 'strange-objects'
  | 'foraging'
  | 'wading'
  | 'swimming'
  | 'tide-pooling'
  | 'driftwood-gathering'
  | 'snow-tracking'
  | 'cairn-reading'
  | 'boardwalk-walk'
  | 'firefly-watching'
  | 'hot-spring-soak'
  | 'echo-calling'
  | 'rail-walking'
  | 'moth-sheet'
  | 'shadow-puppets'
  | 'grass-whistle'
  | 'sky-mirror-walking'
  | 'wind-listening'
  | 'loon-answering';

/**
 * `signature` marks the one activity that only exists here.
 *
 * No activity generates currency, XP or obligation (§5.2) — there is no field
 * on this shape for a reward, and there never will be.
 */
export type ActivityProminence = 'available' | 'notable' | 'signature';

export interface ActivityEntry {
  readonly id: ActivityId;
  readonly label: string;
  readonly prominence: ActivityProminence;
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Radio (§8)                                                                 */
/* -------------------------------------------------------------------------- */

export type RadioBand = 'fm' | 'am' | 'shortwave';

export type StationCharacter =
  | 'lofi'
  | 'ambient'
  | 'environmental'
  | 'strange'
  | 'community'
  | 'weather-service';

export interface RadioStation {
  readonly id: string;
  /** Dial position. MHz on FM, kHz on AM and shortwave. */
  readonly dial: number;
  readonly band: RadioBand;
  readonly name: string;
  readonly character: StationCharacter;
  /** 0..1 signal quality here. Low is atmosphere, not punishment. */
  readonly reception: number;
  readonly note: string;
}

export interface RadioProfile {
  readonly stations: readonly RadioStation[];
  /** 0..1 baseline reception before per-station quality. */
  readonly baseReception: number;
  readonly receptionNote: string;
  /** What the empty dial sounds like between stations. */
  readonly betweenStations: string;
}

/* -------------------------------------------------------------------------- */
/* Secrets and mystery (§8)                                                   */
/* -------------------------------------------------------------------------- */

export type MysteryChannel =
  | 'radio'
  | 'notes'
  | 'serial-numbers'
  | 'diagnostics'
  | 'strange-objects'
  | 'distant-sounds'
  | 'wildlife-behaviour'
  | 'recurring-figures'
  | 'campsite-changes';

/**
 * An optional discovery, told environmentally.
 *
 * `optional` and `gatesNothing` are literal `true` by type: the schema has no
 * way to express a secret that blocks essential functionality or a major
 * reward (§8). A one-time discovery must name the evidence it leaves behind,
 * so a player who was elsewhere still finds the story.
 */
export interface SecretEntry {
  readonly id: string;
  readonly title: string;
  /** How a player stumbles into it. */
  readonly discovery: string;
  /** What it says, without saying it. */
  readonly telling: string;
  readonly channels: readonly MysteryChannel[];
  /** Fires at most once per campsite per player. */
  readonly oneTime: boolean;
  /** Required when `oneTime`: what remains afterward for everyone else. */
  readonly leavesEvidence: string | null;
  /** 0..1 how often it surfaces at all. */
  readonly rarity: number;
  readonly optional: true;
  readonly gatesNothing: true;
}

/* -------------------------------------------------------------------------- */
/* SM-01 flavour (§3.3)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The machine is not a mystery (§3.5) — this is *recognition* data. Quirk
 * weights bias which quirks a local unit tends to have; they never change how
 * hard the machine is to operate.
 */
export interface MachineFlavour {
  /** Quirk id (from `QUIRK_POOL`) → relative weight here. */
  readonly quirkWeights: Readonly<Record<string, number>>;
  /** One line about *this site's* unit. */
  readonly flavourNote: string;
  /** The sticker or stamp the local unit tends to carry. */
  readonly stickerHint: string;
  /** How frost reads against this environment's air. */
  readonly frostNote: string;
}

/* -------------------------------------------------------------------------- */
/* Procedural rules (§5.4)                                                    */
/* -------------------------------------------------------------------------- */

export interface SeededVariation {
  readonly id: string;
  readonly label: string;
  readonly range: Range;
  readonly unit: string;
  readonly note: string;
}

export interface ProceduralRules {
  /** Named RNG streams so one system's rolls cannot shift another's. */
  readonly seedStreams: readonly string[];
  readonly variations: readonly SeededVariation[];
  /** What is identical on every visit — the anchors that make it *this* place. */
  readonly invariants: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Discovery weighting — the no-lock guarantee (§5.4)                         */
/* -------------------------------------------------------------------------- */

/**
 * Coarse regional buckets. Deliberately continental-scale: precise location is
 * never required (§5.5), and `unknown` is a first-class value used whenever
 * permission is denied or lookup fails.
 */
export type RegionId =
  | 'boreal'
  | 'maritime-west'
  | 'maritime-east'
  | 'continental-interior'
  | 'arid-interior'
  | 'highland'
  | 'humid-subtropical'
  | 'mediterranean'
  | 'unknown';

export const REGIONS: readonly RegionId[] = [
  'boreal',
  'maritime-west',
  'maritime-east',
  'continental-interior',
  'arid-interior',
  'highland',
  'humid-subtropical',
  'mediterranean',
  'unknown',
];

/**
 * Affinity multipliers are clamped into this band. Both ends are strictly
 * positive, which is *the* mechanism behind "region never locks content":
 * an environment's effective weight can be nudged down to a quarter, never
 * to nothing.
 */
export const MIN_REGION_AFFINITY = 0.25;
export const MAX_REGION_AFFINITY = 4;

export interface DiscoveryRule {
  /** Base likelihood of surfacing. Strictly positive — always discoverable. */
  readonly weight: number;
  /** Region → multiplier. Omitted regions use 1. */
  readonly affinities: Partial<Record<RegionId, number>>;
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Performance hints (§13, architecture §10)                                  */
/* -------------------------------------------------------------------------- */

export type PerformanceCost = 'light' | 'moderate' | 'heavy';

export interface PerformanceHints {
  readonly cost: PerformanceCost;
  /** Expected draw calls at the mid tier. Budget: ≤ 120. */
  readonly midTierDrawCalls: number;
  /** Expected visible triangles at the mid tier. Budget: ≤ 60000. */
  readonly midTierTriangles: number;
  /** Dynamic lights including the fire. Budget: ≤ 6. */
  readonly dynamicLights: number;
  /** What the low tier drops first, in order. */
  readonly lowTierCuts: readonly string[];
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* The manifest                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A complete campsite environment.
 *
 * `id` matches the protocol's `environmentId` pattern (`^[a-z0-9_]+$`) so a
 * manifest id can be persisted on a campsite record without translation.
 */
export interface EnvironmentManifest {
  readonly id: string;
  readonly name: string;
  /** One evocative line. Shows up on the Passport page for the site. */
  readonly tagline: string;
  /** Fictional, but honest about what it is standing near. */
  readonly inspiration: string;
  readonly biomeTags: readonly string[];
  readonly character: EnvironmentCharacter;
  readonly arrival: ArrivalSequence;
  readonly scene: SceneManifest;
  readonly weather: WeatherProfile;
  readonly weatherCharacter: WeatherCharacter;
  readonly fuel: FuelProfile;
  readonly wildlife: readonly WildlifeEntry[];
  readonly ambience: AmbienceProfile;
  readonly activities: readonly ActivityEntry[];
  readonly radio: RadioProfile;
  readonly secrets: readonly SecretEntry[];
  readonly machine: MachineFlavour;
  readonly procedural: ProceduralRules;
  readonly discovery: DiscoveryRule;
  readonly performance: PerformanceHints;
}
