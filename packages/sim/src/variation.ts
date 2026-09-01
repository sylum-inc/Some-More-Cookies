/**
 * What is different about this campsite tonight (spec §5.4).
 *
 * Every environment in the catalogue declares five `SeededVariation`s: an id,
 * a human label, a numeric range, a unit, and a note. The notes are not
 * decoration — they are written as instructions to whoever implements them:
 *
 *     creek_level      "Low creek exposes the tin and quiets the ambience;
 *                       high creek raises the water bed and hides the stones."
 *     marine_layer     "Drives fog density, star visibility and how the point
 *                       light reads."
 *     duff_wetness     "Changes footstep sound and the moisture of gathered
 *                       kindling."
 *     driftwood_size   "Some nights the beach gives you a log; some nights,
 *                       kindling and patience."
 *
 * Sixty of those, across twelve campsites, and nothing had ever rolled one.
 * Every visit to a campsite was the same visit: the same amount of wood in the
 * same places at the same wetness, the same fog, the same water, the same
 * animals. `procedural` was the field that promised a place would be worth
 * coming back to, and it was a comment.
 *
 * **How this works.** A variation is rolled from a stream named after its own
 * id, mixed with the visit's seed, so the rolls are independent of each other
 * and of everything else — adding a sixth variation to a manifest cannot
 * change what the other five came out as, which is the whole point of
 * `seedStreams` (ADR-0001, and `ProceduralRules.seedStreams`' own docstring:
 * "so one system's rolls cannot shift another's").
 *
 * **What a roll does.** Ids are mapped, here, onto a small set of *roles* the
 * simulation understands, with each mapping justified by that variation's own
 * authored note. A role's value is the mean *normalised position* of the
 * variations that carry it — unit-free, so a tide measured in metres and a
 * marine layer measured 0..1 can be read by the same dial. Nothing consumes a
 * role's raw number: the systems downstream take a 0..1 and decide for
 * themselves what a high one means.
 *
 * **There is deliberately no readout.** A variation reaches a player as the
 * thing it changed — more wood lying about, fog that shortens the clearing, a
 * jay that comes closer — and never as a line saying what was rolled. Every
 * one of the authored notes is about perception ("changes footstep sound",
 * "how the site photographs", "draw distance collapses to twenty metres and
 * the site becomes a room"); none of them asks for a number on a page, and the
 * Passport's own rule is that a fact about a night is a sentence and a number
 * in a box is a statistic.
 *
 * Thirteen of the sixty carry no role, because the thing they describe does
 * not exist to be varied — the shape of a restacked cairn, what the pack rat
 * left, the candle stubs on the shelf. They are rolled anyway and reported by
 * {@link readout}, so a variation that later acquires a dial is one line of
 * table away from working. `VARIATION_ROLES` is exhaustive over the catalogue
 * and a test in `packages/content` holds it that way: a new variation id is a
 * failing test until somebody decides what it does.
 */

import { clamp, clamp01, lerp } from './math.js';
import { Rng, hashString, mixSeeds } from './rng.js';

/** The catalogue's shape, restated so the simulation does not import content. */
export interface SeededVariationSpec {
  readonly id: string;
  readonly label: string;
  readonly range: { readonly min: number; readonly max: number };
  readonly unit: string;
  readonly note: string;
}

/**
 * The dials a variation can turn.
 *
 * Deliberately few, and each one named for what a player would notice rather
 * than for the system that implements it. A role exists only where something
 * downstream already reads it.
 */
export type VariationRole =
  /** How much wood is lying about tonight. */
  | 'fuel-stock'
  /** Whether tonight's wood is logs or sticks and patience. */
  | 'fuel-size'
  /** How wet what is lying about is, before any weather. */
  | 'fuel-wetness'
  /** How thick the low scatter is — bracken, grass, moss, wrack, leaf fall. */
  | 'undergrowth'
  /** Fog, marine layer, cloud sitting in the bowl. How far you can see. */
  | 'air-haze'
  /** How high or full the water is. */
  | 'water-level'
  /** How close the surface is to a mirror. */
  | 'water-stillness'
  /** Band conditions: ionospheric skip, an inversion, a quiet magnetometer. */
  | 'reception'
  /** Aurora and the rest of the rare sky. */
  | 'sky-activity'
  /** How much else turns up tonight — animals, and the next site over. */
  | 'company'
  /** How far off tonight's weather is. */
  | 'storm-distance';

interface RoleMapping {
  readonly role: VariationRole;
  /**
   * True when a *high* roll means *less* of the role.
   *
   * A tide line 46 metres from the log is a low tide, and a cloud base 60
   * metres above the fold is a clear night.
   */
  readonly invert?: boolean;
  /** Why this id means this role — the author's own note, paraphrased. */
  readonly because: string;
}

/**
 * Every variation id in the catalogue, and what it turns.
 *
 * `null` means the variation is rolled and reported but drives nothing,
 * because the thing it describes is not modelled. That is an honest answer and
 * a much better one than a role nobody reads.
 */
export const VARIATION_ROLES: Readonly<Record<string, RoleMapping | null>> = {
  /* pine_hollow */
  creek_level: { role: 'water-level', because: 'high creek raises the water bed' },
  firewood_stack: { role: 'fuel-stock', because: 'rounds left on the stack' },
  undergrowth_density: { role: 'undergrowth', because: 'seasonal variation in the low scatter' },
  neighbour_presence: { role: 'company', because: 'whether the next site over is occupied' },
  duff_wetness: { role: 'fuel-wetness', because: 'the moisture of gathered kindling' },

  /* longlight_shore */
  tide_state: { role: 'water-level', invert: true, because: 'metres from the log — further out is lower' },
  wrack_composition: { role: 'undergrowth', because: 'how much is lying along the wrack line' },
  marine_layer: { role: 'air-haze', because: 'drives fog density and star visibility' },
  driftwood_size: { role: 'fuel-size', because: 'a log some nights, kindling and patience others' },
  fox_schedule: { role: 'company', invert: true, because: 'same fox, later hour — less of the night with it' },

  /* lantern_mesa */
  pothole_level: { role: 'water-level', because: 'dry, dish, or full mirror' },
  dust_drift: null, // Footprints in the hollows. Nothing records footprints.
  mesquite_stack: { role: 'fuel-stock', because: 'pieces left on the stack' },
  cairn_state: null, // Which way the cairn was restacked, by nobody.
  inversion_strength: { role: 'reception', because: 'drives FM reception' },

  /* meltwater_cirque */
  snowfield_extent: { role: 'undergrowth', invert: true, because: 'snow over the ground covers the low scatter' },
  tarn_stillness: { role: 'water-stillness', because: 'governs the reflection' },
  cloud_in_the_bowl: { role: 'air-haze', because: 'draw distance collapses and the site becomes a room' },
  krummholz_fuel: { role: 'fuel-stock', because: 'available deadwood' },
  register_entries: null, // Who signed the register since. There is no register text.

  /* sweetgrass_coulee */
  river_level: { role: 'water-level', because: 'how much river there is' },
  grass_height: { role: 'undergrowth', because: 'the grass is the low scatter here' },
  storm_distance: { role: 'storm-distance', because: 'distance to tonight’s storm' },
  windmill_rate: null, // Revolutions per minute of a windmill that is a landmark, not a mechanism.
  am_skip: { role: 'reception', because: 'ionospheric skip quality' },

  /* cicada_bottoms */
  water_level: { role: 'water-level', because: 'how much water is in the bottoms' },
  firefly_count: { role: 'company', because: 'how much else is out tonight' },
  insect_pulse_period: null, // The cicada band's period is the ambience's own business.
  moss_density: { role: 'undergrowth', because: 'Spanish moss coverage' },
  duckweed_coverage: null, // Surface cover on water we draw as one material.

  /* ashfall_barrens */
  vent_intensity: { role: 'air-haze', because: 'the beam is a solid bar in the steam, or it is not' },
  ash_dune_shape: null, // Which profile the dunes took.
  tub_temperature: null, // The soak is an authored activity, not yet a system with a dial.
  geomagnetic: { role: 'sky-activity', because: 'geomagnetic activity is what makes the rare sky' },
  moss_ring_extent: { role: 'undergrowth', because: 'thermal moss rings are the low scatter' },

  /* mirror_flats */
  sheet_depth: { role: 'water-level', because: 'water depth on the pan' },
  crust_polygon_scale: null, // Salt polygon size, a ground-texture parameter.
  far_range_haze: { role: 'air-haze', because: 'haze on the far range' },
  fox_visit: { role: 'company', because: 'whether the kit fox comes at all' },
  mirage_strength: null, // Residual mirage — a horizon effect we do not draw.

  /* foxglove_fells */
  cloud_base: { role: 'air-haze', invert: true, because: 'a high cloud base is a clear night' },
  beck_flow: { role: 'water-level', because: 'how much beck there is' },
  sheep_present: { role: 'company', because: 'sheep in the fold' },
  dry_fuel_bag: { role: 'fuel-stock', because: 'kindling left by the last person' },
  foxglove_count: { role: 'undergrowth', because: 'the spires are the low scatter' },

  /* cedar_switchback */
  creek_volume: { role: 'water-level', because: 'creek flow' },
  fog_bands: { role: 'air-haze', because: 'layers of fog in the switchback' },
  canopy_drip: { role: 'fuel-wetness', because: 'what drips on the wood all night is how wet the wood is' },
  maple_stack: { role: 'fuel-stock', because: 'split maple in the hollow' },
  candle_stubs: null, // Stubs on a shelf. A count of props we place as one.

  /* copperline_halt */
  band_conditions: { role: 'reception', because: 'band conditions' },
  traded_object: null, // What the pack rat left. Wildlife trades its own objects.
  tank_level: { role: 'water-level', because: 'water in the stock tank' },
  aspen_leaf_fall: { role: 'undergrowth', because: 'leaf litter on the platform' },
  hut_condition: null, // How the hut was left. The hut is one landmark either way.

  /* loonwater_narrows */
  lake_stillness: { role: 'water-stillness', because: 'lake surface stillness' },
  fog_sheet: { role: 'air-haze', because: 'lake fog after midnight' },
  aurora_strength: { role: 'sky-activity', because: 'aurora activity' },
  birch_deadfall: { role: 'fuel-stock', because: 'available deadfall' },
  jay_boldness: { role: 'company', because: 'how bold the grey jay is tonight' },
};

/** One variation, rolled. */
export interface RolledVariation {
  readonly spec: SeededVariationSpec;
  /** The rolled value, in the variation's own unit. */
  readonly value: number;
  /** Where in its own range it landed, 0..1. */
  readonly position: number;
  readonly role: VariationRole | null;
}

export interface VariationSet {
  readonly rolled: readonly RolledVariation[];
  /**
   * A role's value, 0..1, or `null` where this campsite declares nothing that
   * carries it.
   *
   * `null` rather than 0.5 on purpose: a campsite with no water variation
   * should be left exactly as its manifest describes it, not nudged toward
   * some notional middle.
   */
  role(role: VariationRole): number | null;
  /** A role's value, or the given default where the campsite has none. */
  roleOr(role: VariationRole, fallback: number): number;
  /** One variation by id, for a system that genuinely wants that one. */
  at(id: string): RolledVariation | null;
}

/**
 * Rolls a campsite's variations for one visit.
 *
 * `seed` should be the visit's seed, not the campsite's: the same campsite on
 * a different night is the case this whole module exists for. (A caller that
 * wants the *same* night back — a replay, a shared session — passes the same
 * seed and gets the same night, which is ADR-0001 and the reason none of this
 * uses `Math.random`.)
 */
export function rollVariations(specs: readonly SeededVariationSpec[], seed: number): VariationSet {
  const rolled: RolledVariation[] = [];
  const byId = new Map<string, RolledVariation>();
  const byRole = new Map<VariationRole, number[]>();

  for (const spec of specs) {
    // Named per variation, so the roll does not depend on how many others the
    // manifest happens to declare or in what order.
    const rng = new Rng(mixSeeds(seed, hashString(`variation:${spec.id}`)));
    const { min, max } = spec.range;
    const position = clamp01(rng.next());
    const value = min + position * (max - min);
    const mapping = VARIATION_ROLES[spec.id];
    const entry: RolledVariation = {
      spec,
      value,
      position,
      role: mapping ? mapping.role : null,
    };
    rolled.push(entry);
    byId.set(spec.id, entry);
    if (mapping) {
      const contribution = mapping.invert === true ? 1 - position : position;
      const list = byRole.get(mapping.role);
      if (list) list.push(contribution);
      else byRole.set(mapping.role, [contribution]);
    }
  }

  const role = (want: VariationRole): number | null => {
    const list = byRole.get(want);
    if (!list || list.length === 0) return null;
    let total = 0;
    for (const v of list) total += v;
    return clamp01(total / list.length);
  };

  return {
    rolled,
    role,
    roleOr: (want, fallback) => role(want) ?? fallback,
    at: (id) => byId.get(id) ?? null,
  };
}

/** A campsite that declares no variations. Every role reads `null`. */
export const NO_VARIATIONS: VariationSet = rollVariations([], 1);

/* -------------------------------------------------------------------------- */
/* Reading a role                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A role read as a multiplier around 1.
 *
 * The shape every consumer of these wants: `scale(set, 'undergrowth', 0.4)`
 * is "between 0.6x and 1.4x as much low scatter, and exactly 1x at a campsite
 * that never said anything about it".
 */
export function scale(set: VariationSet, role: VariationRole, swing: number): number {
  const value = set.role(role);
  if (value === null) return 1;
  return lerp(1 - swing, 1 + swing, value);
}

/** A role read as a signed nudge in [-amount, +amount], zero when absent. */
export function nudge(set: VariationSet, role: VariationRole, amount: number): number {
  const value = set.role(role);
  if (value === null) return 0;
  return clamp((value - 0.5) * 2 * amount, -amount, amount);
}
