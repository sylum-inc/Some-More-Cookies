/**
 * The pit as you left it, and what the weeks in between do to it.
 *
 * `createRitual` already knew the difference between a first night and a
 * return: the first opens on somebody else's established fire, every visit
 * after that opens on a banked pit. But it was a *binary*. Whether you spent
 * last night banking the coals under a careful cover of ash or walked away
 * from bare flame in the rain, tonight looked identical — grey ash, two
 * hundred degrees under it, every time. The one mechanic the product is built
 * around, the thing the fire model spends a hundred lines simulating, stopped
 * mattering the moment you closed the tab.
 *
 * This carries it. What you leave is what you find: the coals you buried, the
 * ash you raked over them, the wood you did not burn. Time and weather work on
 * all three while you are away, and ash is what decides how much survives —
 * which is not a rule invented here, it is what banking a fire *is*.
 *
 * Nothing counts nights. There is no streak, no total, and nowhere in the
 * product that a number about this reaches a player (§5.3, and `assertNoGating`
 * in the discovery model for the same reason). What a long run of kept fires
 * produces is a deeper ember bed and more ash, which is a description of a
 * hearth rather than a score for one. What losing it produces is a cold pit and
 * a soaked woodpile, which the place says in its own words for a visit or two
 * and then stops mentioning.
 *
 * Deterministic and clock-free (ADR-0001): the hours away arrive as a number
 * from the client, which is the only part of this that needs a wall clock.
 */

import { clamp, clamp01, lerp } from './math.js';
import type { Rng } from './rng.js';
import { createFire, type FireConfig, type FireState } from './fire.js';
import type { WeatherProfile } from './weather.js';

export interface Hearth {
  /** Glowing coals left in the bed, in the fire model's own mass units. */
  readonly emberMass: number;
  /** What those coals were holding, °C. */
  readonly emberTemp: number;
  /** Ash raked over them, 0..1. The whole of whether any of this survives. */
  readonly ashCover: number;
  /** Unburnt fuel left in the pit, in log masses. */
  readonly unburnt: number;
  /** How wet the pit and the wood beside it got, 0..1. */
  readonly soaked: number;
  /**
   * Visits of evidence still to run after a fire went out.
   *
   * Not a penalty and not a counter the player ever sees: it is how long the
   * place goes on showing what happened — cold ash gone to paste, wood that
   * will not take — before it stops mentioning it. Two, so that coming
   * straight back finds it and the visit after that does not.
   */
  readonly cold: number;
}

/** A pit nobody has used. The first night at a campsite starts here. */
export const NEW_HEARTH: Hearth = {
  emberMass: 0,
  emberTemp: 0,
  ashCover: 0,
  unburnt: 0,
  soaked: 0,
  cold: 0,
};

/** Visits a cold pit goes on showing it. */
const COLD_VISITS = 2;

/**
 * Below this the bed cannot be woken: there is nothing left to blow on.
 *
 * `createBankedFire` leaves 0.13 at 232 °C and expects a player to find it, so
 * the floor has to sit well under that or a fire kept perfectly would still
 * read as lost.
 */
const WAKEABLE_MASS = 0.03;

/** And below this the coals are grey right through, whatever their mass. */
const WAKEABLE_TEMP = 140;

/**
 * How long a bare, unbanked bed takes to lose half of itself, in hours.
 *
 * Short, because a bare bed genuinely is: coals left open go out in a couple of
 * hours. Everything that makes a fire survive a night comes from the ash, which
 * is the point.
 */
const BARE_HALF_LIFE_H = 1.6;

/** And how much a full cover of ash multiplies that by. */
const BANKED_MULTIPLIER = 9.5;

/**
 * How long a gap between two visits counts as, in hours, however long it was.
 *
 * Eleven: dusk to dawn, which is the span a banked fire is banked *for*.
 */
const NIGHT_HOURS = 11;

/**
 * How wet this campsite tends to be, from the weather it is authored to have.
 *
 * The catalogue gives every environment a weight per weather kind; this reads
 * the ones that fall on a fire. A campsite written as a rain forest loses
 * hearths that a high desert keeps, without anybody adding a `hearthDifficulty`
 * field to the manifest to say so.
 */
export function wetnessOf(profile: WeatherProfile): number {
  const weights = profile.weights;
  let total = 0;
  let wet = 0;
  for (const [kind, weight] of Object.entries(weights)) {
    const w = weight ?? 0;
    total += w;
    if (kind === 'light-rain') wet += w * 0.5;
    else if (kind === 'rain') wet += w * 0.85;
    else if (kind === 'storm') wet += w;
    else if (kind === 'snow') wet += w * 0.6;
    else if (kind === 'fog') wet += w * 0.25;
  }
  if (total <= 0) return 0.3;
  // Never zero and never one: nowhere is proof against weather, and nowhere
  // rains every single night either.
  return clamp(wet / total, 0.05, 0.85);
}

/**
 * Reads the pit as the player walks away from it.
 *
 * `previous` is tonight's hearth, and it is here so that a visit spent is a
 * visit spent: arriving at a cold pit and leaving it cold has to count down,
 * or the evidence of one lost night would be permanent. A fire that is alight
 * again clears it outright, because the place has recovered and saying
 * otherwise would be the world sulking.
 */
export function bankHearth(fire: FireState, previous: Hearth = NEW_HEARTH): Hearth {
  const unburnt = fire.logs.reduce((sum, log) => sum + log.mass, 0);
  const recovered = fire.emberMass >= WAKEABLE_MASS && fire.emberTemp >= WAKEABLE_TEMP;
  return {
    emberMass: fire.emberMass,
    emberTemp: fire.emberTemp,
    ashCover: fire.ashCover,
    unburnt,
    soaked: 0,
    cold: recovered ? 0 : spendCold(previous).cold,
  };
}

export interface RestOptions {
  /** Hours between leaving and coming back. */
  readonly hours: number;
  /** What the air is like here, °C. */
  readonly ambientC: number;
  /** How wet this campsite tends to be, from `wetnessOf`. */
  readonly wetness: number;
  /** Seeded, so two devices at one campsite find the same pit (ADR-0006). */
  readonly rng: Rng;
}

/**
 * What the time away does to it.
 *
 * The ash is the whole mechanic: a bare bed halves in about an hour and a half
 * and a well-banked one takes most of a day, so a player who learns to rake
 * before leaving finds coals and one who does not finds a grey pit. Weather
 * shortens both, by however much this campsite tends to get rained on.
 *
 * A hearth that falls under what can be woken comes back cold, and the pit
 * carries that for a couple of visits. Coming back to it does not reset it —
 * that is what makes it evidence rather than a message.
 */
export function restHearth(hearth: Hearth, options: RestOptions): Hearth {
  const { hours, ambientC, wetness, rng } = options;
  if (hours <= 0) return hearth;

  /*
   * What fell on it while you were gone.
   *
   * Rolled rather than assumed, so two identical fires at two identical
   * campsites are not two identical stories — and drawn from this campsite's
   * own weather, so the roll is about where you camped rather than about luck
   * alone. Long absences get wetter: a week has more chances to rain than an
   * evening.
   */
  const chances = clamp01(hours / 30);
  const rain = clamp01(rng.range(0, 1) * wetness * (0.35 + 0.9 * chances));
  const soaked = clamp01(hearth.soaked + rain);

  /*
   * A gap is a night, however long it really was.
   *
   * Coals cool in hours, so cooling against the wall clock means a player who
   * comes back tomorrow can keep a fire and one who comes back next month
   * cannot, whatever either of them did before leaving. That is not a
   * mechanic, it is a tax on having a job: the skill it rewards is opening the
   * tab often, and the thing it punishes is a life. Every visit here is *a
   * night*, and between two nights a fire has one night to survive — which is
   * the length banking is a technique for in the first place.
   *
   * What a long absence does cost is above: more time is more chances of rain,
   * so a month away in a wet place is genuinely worse than a night away, by
   * way of the weather rather than by way of the calendar.
   */
  const thermal = Math.min(hours, NIGHT_HOURS);

  /*
   * Ash keeps heat in and rain out, which is the entire reason banking is a
   * technique and not a flourish.
   */
  const cover = clamp01(hearth.ashCover);
  const shelter = lerp(1, BANKED_MULTIPLIER, cover);
  const halfLife = Math.max(0.2, BARE_HALF_LIFE_H * shelter * (1 - 0.6 * rain));
  const survival = Math.pow(0.5, thermal / halfLife);

  const emberMass = hearth.emberMass * survival;
  // Toward the air, not toward zero: coals do not go colder than the night.
  const emberTemp = ambientC + (hearth.emberTemp - ambientC) * survival;

  /*
   * Ash settles and blows about, and rain packs what is left into a crust.
   * Some of it always goes: a cover that stayed at 0.94 for a month would make
   * one good night of banking last forever.
   */
  const ashCover = clamp01(cover * (1 - clamp01(thermal / 90)) * (1 - 0.3 * rain));

  const alive = emberMass >= WAKEABLE_MASS && emberTemp >= WAKEABLE_TEMP;
  if (alive) {
    return { emberMass, emberTemp, ashCover, unburnt: hearth.unburnt, soaked, cold: 0 };
  }

  /*
   * Out. The pit keeps its ash and its unburnt wood — those do not vanish
   * because the coals died — and the place carries it for a couple of visits.
   */
  return {
    emberMass: 0,
    emberTemp: ambientC,
    ashCover,
    unburnt: hearth.unburnt,
    soaked,
    cold: hearth.cold > 0 ? hearth.cold : COLD_VISITS,
  };
}

/** Whether there is anything in the bed worth blowing on. */
export function isWarm(hearth: Hearth): boolean {
  return hearth.emberMass >= WAKEABLE_MASS && hearth.emberTemp >= WAKEABLE_TEMP;
}

/** One visit of the evidence spent. Called as a night at the campsite begins. */
export function spendCold(hearth: Hearth): Hearth {
  if (hearth.cold <= 0) return hearth;
  return { ...hearth, cold: hearth.cold - 1 };
}

/**
 * The pit this hearth arrives as.
 *
 * `createBankedFire` is still what a kept fire looks like; the difference is
 * that it is now the fire you left rather than a fixed opening. A cold hearth
 * gets a real cold pit — no heat, ash gone to paste if it rained — which is
 * the first night's work again, and is meant to be.
 */
export function wakeFire(hearth: Hearth, config: Partial<FireConfig> = {}): FireState {
  const fire = createFire(config);
  if (!isWarm(hearth)) {
    fire.emberMass = 0;
    fire.emberTemp = config.ambientC ?? 12;
    fire.ashCover = clamp01(hearth.ashCover);
    fire.oxygen = clamp01(0.5 - 0.3 * hearth.soaked);
    fire.flame = 0;
    fire.flameHeight = 0;
    fire.combustion = 0;
    return fire;
  }
  fire.emberMass = hearth.emberMass;
  fire.emberTemp = hearth.emberTemp;
  fire.ashCover = clamp01(hearth.ashCover);
  // Under a cover, with what got in overnight: a damp pit takes more coaxing.
  fire.oxygen = clamp01(0.24 + 0.2 * (1 - hearth.ashCover) - 0.15 * hearth.soaked);
  fire.flame = 0;
  fire.flameHeight = 0;
  fire.combustion = 0;
  return fire;
}

/**
 * What the place says about its own pit, on the way in.
 *
 * In the simulation rather than the client for the same reason
 * `describeReception` and `describeSighting` are: the world is the thing that
 * knows, and a line the client composed would be a second voice describing a
 * model it does not own. Never a number, and never an instruction.
 */
export function describeHearth(hearth: Hearth): string | null {
  if (hearth.cold > 0) {
    if (hearth.soaked > 0.55) {
      return 'The pit is cold and the ash has gone to grey paste. Whatever is stacked beside it is wet through.';
    }
    return 'The pit is cold all the way down. Nothing has been alight here for a while.';
  }
  if (!isWarm(hearth)) return null;
  if (hearth.ashCover > 0.75 && hearth.emberTemp > 260) {
    return 'The ash is undisturbed, and there is heat coming up through it.';
  }
  if (hearth.soaked > 0.5) {
    return 'Something is still going under there, but the pit took rain while you were away.';
  }
  return 'There is a little warmth left in the bed.';
}
