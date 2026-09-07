import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEATHER_PROFILE,
  NEW_HEARTH,
  Rng,
  bankHearth,
  createBankedFire,
  addLog,
  createFire,
  describeHearth,
  isWarm,
  restHearth,
  spendCold,
  stepFire,
  strikeSpark,
  wakeFire,
  wetnessOf,
  type FireState,
  type Hearth,
} from '../src/index.js';

/**
 * The pit you left, a few weeks later.
 *
 * `createRitual` knew a first night from a return and nothing else: bank the
 * coals under a careful cover of ash or walk away from bare flame in the rain,
 * and the next visit opened on the identical banked pit either way. The whole
 * of what the fire model simulates stopped mattering the moment the tab
 * closed. These are about whether it matters now.
 */

function hearth(over: Partial<Hearth> = {}): Hearth {
  return { emberMass: 0.5, emberTemp: 620, ashCover: 0, unburnt: 0, soaked: 0, cold: 0, ...over };
}

function rest(from: Hearth, hours: number, wetness = 0.2, seed = 'rest'): Hearth {
  return restHearth(from, { hours, ambientC: 10, wetness, rng: new Rng(seed) });
}

describe('banking the coals', () => {
  it('is the difference between finding a fire and finding a pit', () => {
    /*
     * The claim the whole mechanic rests on. Same coals, same night away, same
     * weather; one of them raked ash over the bed before leaving.
     */
    const bare = rest(hearth({ ashCover: 0 }), 10);
    const banked = rest(hearth({ ashCover: 0.94 }), 10);

    expect(isWarm(bare), 'a bare bed survived the night').toBe(false);
    expect(isWarm(banked), 'a banked bed did not').toBe(true);
  });

  it('does not tax a player for having a life', () => {
    /*
     * Coming back in a month must not be harder than coming back tomorrow.
     *
     * Coals cool in hours, so cooling against the wall clock would mean the
     * skill being rewarded is opening the tab often and the thing being
     * punished is having a job. Every visit here is a night, and between two
     * nights a fire has one night to survive.
     */
    const tomorrow = rest(hearth({ ashCover: 0.9 }), 14, 0.2, 'gap');
    const nextMonth = rest(hearth({ ashCover: 0.9 }), 24 * 30, 0.2, 'gap');
    expect(isWarm(tomorrow)).toBe(true);
    expect(isWarm(nextMonth), 'a month away lost a fire that a night away kept').toBe(true);
  });

  it('still lets a long absence go wrong, by way of the weather', () => {
    /*
     * What a month does cost is chances of rain. So the gap is not free — it is
     * just not a clock the player is racing.
     */
    const short = rest(hearth({ ashCover: 0.9 }), 8, 0.85, 'wet-gap');
    const long = rest(hearth({ ashCover: 0.9 }), 24 * 30, 0.85, 'wet-gap');
    expect(long.soaked).toBeGreaterThan(short.soaked);
  });

  it('never keeps a bed that was left bare', () => {
    // The one thing that must always be true, whatever the weather and however
    // long the gap: walking away from open coals loses them.
    for (const wetness of [0.05, 0.4, 0.85]) {
      for (let seed = 0; seed < 12; seed++) {
        expect(isWarm(rest(hearth({ ashCover: 0 }), 12, wetness, `bare-${seed}`))).toBe(false);
      }
    }
  });

  it('makes a wet campsite a harder place to keep one', () => {
    // Half-banked is where the place decides it. Well-banked survives anywhere
    // and bare survives nowhere, which is the skill mattering more than the
    // weather — but a rain forest is still a rain forest.
    const count = (wetness: number): number => {
      let kept = 0;
      for (let seed = 0; seed < 60; seed++) {
        if (isWarm(rest(hearth({ ashCover: 0.3 }), 36, wetness, `w${seed}`))) kept += 1;
      }
      return kept;
    };
    expect(count(0.85)).toBeLessThan(count(0.05));
  });

  it('keeps more the better it was done', () => {
    const poor = rest(hearth({ ashCover: 0.3 }), 8);
    const good = rest(hearth({ ashCover: 0.95 }), 8);
    expect(good.emberMass).toBeGreaterThan(poor.emberMass);
    expect(good.emberTemp).toBeGreaterThan(poor.emberTemp);
  });

  it('lets the coals cool to the night and no further', () => {
    // Toward the air, not toward zero: a pit does not go colder than the
    // clearing it is in. A bare bed is the case that actually gets there.
    const cold = rest(hearth({ ashCover: 0 }), 11);
    expect(cold.emberTemp).toBeGreaterThanOrEqual(9.9);
    expect(cold.emberTemp).toBeLessThan(14);
  });

  it('reads the pit as it actually is, rather than as a fixed opening', () => {
    const fire = createBankedFire({ ambientC: 10 });
    const banked = bankHearth(fire);
    expect(banked.emberMass).toBeCloseTo(fire.emberMass, 6);
    expect(banked.ashCover).toBeCloseTo(fire.ashCover, 6);

    const bare = createFire({ ambientC: 10 });
    bare.emberMass = 0.4;
    bare.ashCover = 0;
    expect(bankHearth(bare).ashCover).toBe(0);
  });

  it('counts the wood you did not burn', () => {
    const fire = createFire({ ambientC: 10 });
    fire.logs = [
      { mass: 0.8 } as unknown as (typeof fire.logs)[number],
      { mass: 0.5 } as unknown as (typeof fire.logs)[number],
    ];
    expect(bankHearth(fire).unburnt).toBeCloseTo(1.3, 6);
  });
});

describe('where you camped', () => {
  it('decides how hard the pit is to keep', () => {
    /*
     * Out of the catalogue rather than out of a difficulty field: a campsite
     * authored to rain loses hearths that a dry one keeps, because of what it
     * was written to be.
     */
    const dry = wetnessOf({ ...DEFAULT_WEATHER_PROFILE, weights: { clear: 9, 'high-cloud': 1 } });
    const wet = wetnessOf({ ...DEFAULT_WEATHER_PROFILE, weights: { rain: 6, storm: 3, overcast: 1 } });
    expect(wet).toBeGreaterThan(dry);

    const kept = rest(hearth({ ashCover: 0.94 }), 12, dry, 'weather');
    const lost = rest(hearth({ ashCover: 0.94 }), 12, wet, 'weather');
    expect(kept.emberMass).toBeGreaterThan(lost.emberMass);
  });

  it('is never certain either way', () => {
    // Nowhere is proof against weather and nowhere rains every night; a 0 or a
    // 1 here would make a campsite a rule rather than a place.
    for (const weights of [{ clear: 1 }, { storm: 1 }, {}]) {
      const wetness = wetnessOf({ ...DEFAULT_WEATHER_PROFILE, weights });
      expect(wetness).toBeGreaterThan(0);
      expect(wetness).toBeLessThan(1);
    }
  });

  it('finds the same pit on every device', () => {
    // ADR-0006: two people at one campsite are looking at one fire.
    const a = rest(hearth({ ashCover: 0.8 }), 9, 0.5, 'shared');
    const b = rest(hearth({ ashCover: 0.8 }), 9, 0.5, 'shared');
    expect(b).toEqual(a);
  });
});

describe('a night that was lost', () => {
  it('leaves a cold pit that the place carries for a visit or two', () => {
    const out = rest(hearth({ ashCover: 0 }), 12);
    expect(isWarm(out)).toBe(false);
    expect(out.cold).toBe(2);

    // And it fades: found on the visit straight after, gone by the one after
    // that. Never locking anything, never permanent.
    const second = spendCold(out);
    expect(second.cold).toBe(1);
    const third = spendCold(second);
    expect(third.cold).toBe(0);
    expect(spendCold(third).cold).toBe(0);
  });

  it('does not throw away the ash or the wood along with the coals', () => {
    // The coals died. The woodpile did not evaporate.
    const out = rest(hearth({ ashCover: 0, unburnt: 2.4 }), 24 * 8);
    expect(out.emberMass).toBe(0);
    expect(out.unburnt).toBeCloseTo(2.4, 6);
  });

  it('says so, in the world’s own words and without a number in them', () => {
    const out = rest(hearth({ ashCover: 0 }), 12);
    const said = describeHearth(out) ?? '';
    expect(said.length).toBeGreaterThan(20);
    expect(said, 'the pit reported a total').not.toMatch(/\d/);

    // And a kept one says something different, also without a number.
    const kept = describeHearth(rest(hearth({ ashCover: 0.94 }), 10)) ?? '';
    expect(kept.length).toBeGreaterThan(20);
    expect(kept).not.toEqual(said);
    expect(kept).not.toMatch(/\d/);
  });

  it('is silent about a pit nobody has used', () => {
    // A first night is not a failure and is not commented on.
    expect(describeHearth(NEW_HEARTH)).toBeNull();
  });
});

describe('the fire you come back to', () => {
  it('is the one you left, not a fixed opening', () => {
    const careful = wakeFire(rest(hearth({ ashCover: 0.95 }), 8), { ambientC: 10 });
    const careless = wakeFire(rest(hearth({ ashCover: 0.05 }), 8), { ambientC: 10 });
    expect(careful.emberMass).toBeGreaterThan(careless.emberMass);
    expect(careful.emberTemp).toBeGreaterThan(careless.emberTemp);
    // Neither arrives alight: waking it is the player's first job either way.
    expect(careful.flame).toBe(0);
    expect(careless.flame).toBe(0);
  });

  it('is harder to breathe on when it rained', () => {
    const dryPit = wakeFire(hearth({ ashCover: 0.9, soaked: 0 }), { ambientC: 10 });
    const wetPit = wakeFire(hearth({ ashCover: 0.9, soaked: 0.9 }), { ambientC: 10 });
    expect(wetPit.oxygen).toBeLessThan(dryPit.oxygen);
  });

  it('is a genuinely cold pit when it went out', () => {
    const out = wakeFire(rest(hearth({ ashCover: 0 }), 20), { ambientC: 8 });
    expect(out.emberMass).toBe(0);
    expect(out.emberTemp).toBeLessThan(20);
  });

  it('leaves a first night alone', () => {
    // The opening image of the product: somebody's fire is going when you walk
    // in. A hearth nobody has used must not quietly turn that into a cold pit.
    expect(isWarm(NEW_HEARTH)).toBe(false);
    expect(NEW_HEARTH.cold).toBe(0);
  });
});

/**
 * Getting a cold pit going again.
 *
 * The dead end this nearly shipped with. `stepFire` has exactly one route to
 * ignition — heat already in the pit — and until a night could be lost there
 * was always some: the opening fire is established, and a return was always a
 * banked bed holding two hundred degrees. The moment a hearth could genuinely
 * go out, a player could arrive at a cold pit, gather every stick in the wood,
 * lay all of it on, and watch nothing happen for as long as they cared to
 * wait. It was found by opening a screenshot of a cold pit and reading the
 * button under it, which said "Poke the coals".
 */
describe('lighting a cold pit', () => {
  function coldPit(ashCover = 0.3): FireState {
    const fire = createFire({ ambientC: 10 });
    fire.emberMass = 0;
    fire.emberTemp = 10;
    fire.ashCover = ashCover;
    return fire;
  }

  it('needs something fine and dry in it', () => {
    // A match held to an empty pit, and to a pit with nothing but a log in it.
    expect(strikeSpark(coldPit(), new Rng('empty'))).toBe(false);

    const logsOnly = coldPit();
    addLog(logsOnly, 'oak', { grade: 'log', moisture: 0.1 });
    expect(strikeSpark(logsOnly, new Rng('logs'))).toBe(false);
  });

  it('takes far more often when the tinder is dry', () => {
    const struck = (moisture: number): number => {
      let lit = 0;
      for (let seed = 0; seed < 40; seed++) {
        const fire = coldPit();
        addLog(fire, 'pine', { grade: 'tinder', moisture });
        if (strikeSpark(fire, new Rng(`s${seed}`))) lit += 1;
      }
      return lit;
    };
    const dry = struck(0.05);
    const sodden = struck(0.9);
    expect(dry).toBeGreaterThan(30);
    expect(sodden).toBeLessThan(15);
    // Never quite never: a fire lit from wet tinder on the fourth attempt is a
    // real evening, and a zero here would be a wall rather than a difficulty.
    expect(sodden).toBeGreaterThan(0);
  });

  it('will not light something that is already going', () => {
    const going = createBankedFire({ ambientC: 10 });
    addLog(going, 'pine', { grade: 'tinder', moisture: 0.05 });
    expect(strikeSpark(going, new Rng('going'))).toBe(false);
  });

  it('gets a real fire going, laid the way a fire is laid', () => {
    /*
     * The whole recovery loop, and the assertion that the night is genuinely
     * not lost: tinder and kindling in the pit, a light to it, more kindling
     * as it takes, then wood.
     *
     * Tinder straight under a log does *not* do this, and should not — the
     * first attempt at this test put oak on a match, concluded the model was
     * broken, and was wrong about it.
     */
    let established = 0;
    for (let seed = 0; seed < 20; seed++) {
      const fire = coldPit(0.1);
      const rng = new Rng(`b${seed}`);
      addLog(fire, 'pine', { grade: 'tinder', moisture: 0.08 });
      addLog(fire, 'pine', { grade: 'tinder', moisture: 0.08 });
      addLog(fire, 'pine', { grade: 'kindling', moisture: 0.08 });
      addLog(fire, 'pine', { grade: 'kindling', moisture: 0.08 });
      if (!strikeSpark(fire, rng)) continue;
      for (let s = 0; s < 15 * 30; s++) stepFire(fire, 1 / 30, rng);
      addLog(fire, 'pine', { grade: 'kindling', moisture: 0.08 });
      addLog(fire, 'pine', { grade: 'kindling', moisture: 0.08 });
      for (let s = 0; s < 20 * 30; s++) stepFire(fire, 1 / 30, rng);
      addLog(fire, 'pine', { grade: 'log', moisture: 0.12 });
      for (let s = 0; s < 60 * 30; s++) stepFire(fire, 1 / 30, rng);
      if (fire.flame > 0.15 || fire.emberMass > 0.12) established += 1;
    }
    expect(established, 'a cold pit could not be brought back at all').toBeGreaterThan(15);
  });
});
