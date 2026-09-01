import { describe, expect, it } from 'vitest';
import {
  addLog,
  createEstablishedFire,
  createFire,
  createLog,
  fanFire,
  fireLightIntensity,
  fireSignals,
  isEmberBed,
  rakeEmbers,
  repositionLog,
  bankFire,
  createBankedFire,
  describeArrangement,
  isBanked,
  spotFrom,
  PIT,
  stepFire,
  WOOD_TYPES,
  woodType,
  type FireState,
} from '../src/fire.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

function run(fire: FireState, seconds: number, rng = new Rng(1)): FireState {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) stepFire(fire, SIM_DT, rng);
  return fire;
}

describe('wood types', () => {
  it('falls back to pine for an unknown id', () => {
    expect(woodType('unobtainium').id).toBe('pine');
  });

  it('has coherent physical relationships', () => {
    // Denser hardwoods should burn slower and leave more coals than softwoods.
    const oak = WOOD_TYPES['oak']!;
    const pine = WOOD_TYPES['pine']!;
    expect(oak.burnRate).toBeLessThan(pine.burnRate);
    expect(oak.emberYield).toBeGreaterThan(pine.emberYield);
    expect(oak.heatOutput).toBeGreaterThan(pine.heatOutput);
    // Softwood catches more easily.
    expect(pine.ignitability).toBeGreaterThan(oak.ignitability);
  });

  it('gives every wood type sane bounds', () => {
    for (const wood of Object.values(WOOD_TYPES)) {
      expect(wood.burnRate).toBeGreaterThan(0);
      expect(wood.emberYield).toBeGreaterThanOrEqual(0);
      expect(wood.emberYield).toBeLessThanOrEqual(1);
      expect(wood.defaultMoisture).toBeGreaterThanOrEqual(0);
      expect(wood.defaultMoisture).toBeLessThan(1);
    }
  });
});

describe('fire simulation', () => {
  it('is deterministic', () => {
    const a = run(createEstablishedFire(), 30, new Rng(5));
    const b = run(createEstablishedFire(), 30, new Rng(5));
    expect(a.flame).toBe(b.flame);
    expect(a.emberMass).toBe(b.emberMass);
    expect(a.emberTemp).toBe(b.emberTemp);
  });

  it('an established fire is already burning', () => {
    const fire = createEstablishedFire();
    expect(fire.flame).toBeGreaterThan(0.3);
    expect(fire.emberMass).toBeGreaterThan(0.2);
  });

  it('an empty pit produces no flame', () => {
    const fire = run(createFire(), 20);
    expect(fire.flame).toBeLessThan(0.05);
    expect(fire.emberMass).toBe(0);
  });

  it('consumes fuel over time', () => {
    const fire = createEstablishedFire();
    const before = fire.logs.reduce((t, l) => t + l.mass, 0);
    run(fire, 60);
    const after = fire.logs.reduce((t, l) => t + l.mass, 0);
    expect(after).toBeLessThan(before);
  });

  it('converts burned fuel into an ember bed', () => {
    const fire = createFire();
    addLog(fire, 'oak');
    fire.emberMass = 0.3;
    fire.emberTemp = 600;
    const before = fire.emberMass;
    run(fire, 120);
    expect(fire.emberMass).toBeGreaterThan(before * 0.5);
  });

  it('removes fully spent logs', () => {
    const fire = createFire();
    const log = createLog('aspen', { mass: 0.02, moisture: 0, ignition: 1 });
    fire.logs.push(log);
    fire.emberMass = 0.5;
    fire.emberTemp = 700;
    run(fire, 90);
    expect(fire.logs.find((l) => l.id === log.id)).toBeUndefined();
  });

  describe('moisture', () => {
    it('wet wood resists burning and smokes', () => {
      const dry = createFire();
      dry.emberMass = 0.5;
      dry.emberTemp = 650;
      addLog(dry, 'birch').moisture = 0.02;

      const wet = createFire();
      wet.emberMass = 0.5;
      wet.emberTemp = 650;
      addLog(wet, 'birch').moisture = 0.95;

      run(dry, 45);
      run(wet, 45);

      expect(wet.logs[0]!.ignition).toBeLessThan(dry.logs[0]!.ignition);
      expect(wet.flame).toBeLessThan(dry.flame);
    });

    it('wet wood dries out and eventually catches', () => {
      const fire = createFire();
      fire.emberMass = 0.8;
      fire.emberTemp = 700;
      const log = addLog(fire, 'pine');
      log.moisture = 0.8;
      run(fire, 200);
      expect(log.moisture).toBeLessThan(0.8);
    });
  });

  describe('oxygen', () => {
    it('wood leaned into a tepee breathes better than wood heaped flat', () => {
      const airy = createEstablishedFire();
      airy.logs.forEach((l, i) => (l.spot = spotFrom(0.14, i * 2.1, 1)));
      const smothered = createEstablishedFire();
      // Same logs, same place, lying on top of each other.
      smothered.logs.forEach((l) => (l.spot = spotFrom(0.03, 0, 0)));
      run(airy, 20);
      run(smothered, 20);
      expect(airy.oxygen).toBeGreaterThan(smothered.oxygen);
      expect(describeArrangement(airy)).toBe('tepee');
      expect(describeArrangement(smothered)).toBe('heaped');
    });

    it('piling on too much fuel chokes the fire', () => {
      const normal = createEstablishedFire();
      const crowded = createEstablishedFire();
      for (let i = 0; i < 6; i++) addLog(crowded, 'oak');
      run(normal, 25);
      run(crowded, 25);
      expect(crowded.oxygen).toBeLessThan(normal.oxygen);
    });

    it('fanning gives a temporary oxygen boost that decays', () => {
      const fire = createEstablishedFire();
      run(fire, 10);
      const base = fire.oxygen;
      fanFire(fire, 1);
      run(fire, 0.5);
      expect(fire.oxygen).toBeGreaterThan(base);
      run(fire, 15);
      expect(fire.oxygen).toBeLessThan(base + 0.15);
    });

    it('raking knocks the stack flat and pulls the ash back', () => {
      const fire = createEstablishedFire();
      fire.logs.forEach((l) => (l.spot = spotFrom(0.1, 0.3, 0.9)));
      fire.ashCover = 0.6;
      rakeEmbers(fire, 1);
      expect(fire.ashCover).toBeCloseTo(0.05, 5);
      expect(fire.logs.every((l) => l.spot.lean < 0.9)).toBe(true);
      // And spreads the pile outward rather than leaving it in a heap.
      expect(fire.logs.every((l) => Math.hypot(l.spot.x, l.spot.z) > 0.1)).toBe(true);
    });

    it('repositionLog keeps wood inside the stone ring', () => {
      const fire = createEstablishedFire();
      const id = fire.logs[0]!.id;
      repositionLog(fire, id, { x: 9, z: 0, lean: 5 });
      expect(Math.hypot(fire.logs[0]!.spot.x, fire.logs[0]!.spot.z)).toBeCloseTo(PIT.ringRadius, 6);
      expect(fire.logs[0]!.spot.lean).toBe(1);
      repositionLog(fire, id, { lean: -3 });
      expect(fire.logs[0]!.spot.lean).toBe(0);
      // A partial spot moves only what it names.
      expect(Math.hypot(fire.logs[0]!.spot.x, fire.logs[0]!.spot.z)).toBeCloseTo(PIT.ringRadius, 6);
    });

    it('ignores an unknown log id', () => {
      const fire = createEstablishedFire();
      expect(() => repositionLog(fire, 'nope', { lean: 0.5 })).not.toThrow();
    });
  });

  it('is forgiving — embers persist long after flames die', () => {
    // Spec §4.1: the fire must never go out irrecoverably during a session.
    const fire = createEstablishedFire();
    fire.logs = [];
    run(fire, 300);
    expect(fire.emberMass).toBeGreaterThan(0.05);
    expect(fire.emberTemp).toBeGreaterThan(200);
  });

  it('reports an ember bed once flames die down', () => {
    const fire = createEstablishedFire();
    fire.logs = [];
    run(fire, 120);
    expect(isEmberBed(fire)).toBe(true);
  });

  it('wind stays bounded and responds to exposure', () => {
    const sheltered = createFire({ exposure: 0.05 });
    const exposed = createFire({ exposure: 1 });
    run(sheltered, 120);
    run(exposed, 120);
    expect(sheltered.windSpeed).toBeLessThan(exposed.windSpeed);
    expect(exposed.windSpeed).toBeLessThan(6);
    expect(sheltered.windSpeed).toBeGreaterThanOrEqual(0);
  });

  it('emits crackles while burning', () => {
    const fire = createEstablishedFire();
    const rng = new Rng(3);
    let crackles = 0;
    for (let i = 0; i < 60 * 30; i++) {
      stepFire(fire, SIM_DT, rng);
      crackles += fire.cracklesThisStep;
    }
    expect(crackles).toBeGreaterThan(10);
  });

  it('signals stay normalised', () => {
    const fire = createEstablishedFire();
    for (let i = 0; i < 600; i++) {
      stepFire(fire, SIM_DT, new Rng(i));
      const s = fireSignals(fire);
      for (const key of ['intensity', 'emberHeat', 'fuelLoad', 'smoke', 'colorBias'] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(1);
      }
      expect(fireLightIntensity(fire)).toBeGreaterThanOrEqual(0);
      expect(fireLightIntensity(fire)).toBeLessThanOrEqual(1);
    }
  });

  it('never produces NaN', () => {
    const fire = createEstablishedFire();
    for (let i = 0; i < 60 * 120; i++) stepFire(fire, SIM_DT, new Rng(i % 100));
    expect(Number.isFinite(fire.flame)).toBe(true);
    expect(Number.isFinite(fire.emberTemp)).toBe(true);
    expect(Number.isFinite(fire.emberMass)).toBe(true);
    expect(Number.isFinite(fire.flameHeight)).toBe(true);
  });
});

describe('the arrival fire', () => {
  it('is burning brightly when the player walks in', () => {
    // The product's opening image is a person walking through the dark toward
    // a campfire. If the fire has already collapsed to coals, there is no
    // image.
    const fire = createEstablishedFire();
    const rng = new Rng(1);
    let peak = 0;
    for (let i = 0; i < 60 * 30; i++) {
      stepFire(fire, SIM_DT, rng);
      peak = Math.max(peak, fire.flame);
    }
    expect(peak).toBeGreaterThan(0.75);
  });

  it('settles to an ember bed inside the ritual’s window', () => {
    // Spec §5.1: the ritual is 5-8 minutes. Coals arriving at ~3 minutes means
    // a player who looks around first finds the better roasting surface
    // waiting for them; coals at 8 minutes would be a chore.
    const fire = createEstablishedFire();
    const rng = new Rng(1);
    let bedAt = -1;
    for (let i = 0; i < 60 * 600; i++) {
      stepFire(fire, SIM_DT, rng);
      if (bedAt < 0 && isEmberBed(fire)) bedAt = (i + 1) * SIM_DT;
    }
    expect(bedAt).toBeGreaterThan(60);
    expect(bedAt).toBeLessThan(260);
  });

  it('leaves a substantial bed of coals behind, not a dying scrape', () => {
    const fire = createEstablishedFire();
    const rng = new Rng(1);
    for (let i = 0; i < 60 * 300; i++) stepFire(fire, SIM_DT, rng);
    expect(fire.emberMass).toBeGreaterThan(0.4);
    expect(fire.emberTemp).toBeGreaterThan(500);
  });

  it('a fresh log brings the flames straight back — sooner if you rake first', () => {
    const neglected = createEstablishedFire();
    const tended = createEstablishedFire();
    const rng = new Rng(1);
    for (const fire of [neglected, tended]) {
      const own = new Rng(1);
      for (let i = 0; i < 60 * 300; i++) stepFire(fire, SIM_DT, own);
      expect(fire.flame).toBeLessThan(0.25);
      // Five minutes alone and there is ash over it, which is the fire asking
      // for a rake rather than the fire being in trouble.
      expect(fire.ashCover).toBeGreaterThan(0.25);
    }

    rakeEmbers(tended, 1);
    for (const fire of [neglected, tended]) {
      addLog(fire, 'pine', { spot: spotFrom(0.1, 1.2, 0.6) });
    }
    for (let i = 0; i < 60 * 45; i++) stepFire(neglected, SIM_DT, rng);
    const own = new Rng(1);
    for (let i = 0; i < 60 * 45; i++) stepFire(tended, SIM_DT, own);

    // Either way you get your fire back. Skipping the rake costs you the time
    // it takes the new log to burn its way out from under the ash, which is
    // the only thing neglect ever costs (spec §4.1).
    expect(neglected.flame).toBeGreaterThan(0.45);
    expect(tended.flame).toBeGreaterThan(neglected.flame);
    expect(tended.flame).toBeGreaterThan(0.75);
  });
});

describe('where you put the wood', () => {
  it('wood on the stones dries without ever catching', () => {
    const fire = createEstablishedFire();
    const rack = addLog(fire, 'birch', { spot: spotFrom(PIT.ringRadius * 0.95, 1.4, 0) });
    rack.moisture = 0.85;
    run(fire, 240);
    expect(rack.moisture).toBeLessThan(0.6);
    expect(rack.ignition).toBeLessThan(0.1);
    expect(rack.mass).toBeGreaterThan(0.98);
  });

  it('the same wet log in the middle of the bed catches once it has dried', () => {
    const fire = createEstablishedFire();
    const inside = addLog(fire, 'birch', { spot: spotFrom(0.05, 1.4, 0.5) });
    inside.moisture = 0.85;
    run(fire, 240);
    expect(inside.ignition).toBeGreaterThan(0.25);
  });

  it('steams while it dries and stops when it is dry', () => {
    const fire = createEstablishedFire();
    const log = addLog(fire, 'birch', { spot: spotFrom(0.06, 0.2, 0.3) });
    log.moisture = 0.7;
    run(fire, 20);
    expect(log.steam).toBeGreaterThan(0.05);
    log.moisture = 0;
    run(fire, 20);
    expect(log.steam).toBeLessThan(0.02);
  });

  it('a tepee draws hard and eats wood; flat wood burns slow and banks it', () => {
    const tepee = createEstablishedFire();
    const flat = createEstablishedFire();
    for (const f of [tepee, flat]) {
      f.logs = [];
      f.emberMass = 0.5;
      f.emberTemp = 680;
    }
    const laid = 3;
    for (let i = 0; i < laid; i++) {
      addLog(tepee, 'oak', { spot: spotFrom(0.13, i * 2.1, 1) }).moisture = 0.02;
      addLog(flat, 'oak', { spot: spotFrom(0.15, i * 2.1, 0) }).moisture = 0.02;
    }
    const tepeeEmbers = tepee.emberMass;
    const flatEmbers = flat.emberMass;
    // Three minutes in, while both still have wood: the chimney is a column,
    // the flat bed is a glow.
    run(tepee, 200);
    run(flat, 200);
    expect(tepee.draught).toBeGreaterThan(0.8);
    expect(flat.draught).toBeLessThan(0.2);
    expect(tepee.flameHeight).toBeGreaterThan(flat.flameHeight * 1.5);

    // A quarter of an hour in, the tepee has eaten all three logs and the flat
    // fire is still working through its first.
    run(tepee, 700);
    run(flat, 700);
    const left = (f: FireState) => f.logs.reduce((sum, l) => sum + l.mass, 0);
    expect(left(tepee)).toBeLessThan(0.1);
    expect(left(flat)).toBeGreaterThan(1);

    // And the trade for it: per log actually spent, the flat fire keeps far
    // more of the wood as coals instead of sending it up the column. Build a
    // tepee to get heat now; lay it flat to make the wood last the night.
    const yieldOf = (f: FireState, before: number) => (f.emberMass - before) / (laid - left(f));
    expect(yieldOf(flat, flatEmbers)).toBeGreaterThan(yieldOf(tepee, tepeeEmbers) * 1.3);
  });
});

describe('ash, banking, and waking a fire up', () => {
  it('ash builds on its own but never far enough to spoil the coals', () => {
    const fire = createEstablishedFire();
    fire.logs = [];
    run(fire, 900);
    expect(fire.ashCover).toBeGreaterThan(0.2);
    expect(fire.ashCover).toBeLessThan(0.45);
    // Which is to say: still roastable, just asking for a rake.
    expect(isEmberBed(fire)).toBe(true);
  });

  it('banking puts the flames out and keeps the heat', () => {
    const open = createEstablishedFire();
    const banked = createEstablishedFire();
    bankFire(banked, 1);
    bankFire(banked, 1);
    run(open, 400);
    run(banked, 400);
    expect(banked.flame).toBeLessThan(0.05);
    expect(isBanked(banked)).toBe(true);
    // Kept, not spent: the banked bed still has more coals than the open one.
    expect(banked.emberMass).toBeGreaterThan(open.emberMass);
    expect(banked.emberTemp).toBeGreaterThan(300);
  });

  it('a banked bed sheds rain that would knock an open one down', () => {
    // Two beds of coals, no fuel: the state a fire is actually left in when a
    // shower comes through, and the state it is left in overnight.
    const open = createEstablishedFire();
    const banked = createEstablishedFire();
    for (const fire of [open, banked]) fire.logs = [];
    bankFire(banked, 1);
    bankFire(banked, 1);
    run(open, 60);
    run(banked, 60);
    const openBefore = open.emberTemp;

    open.rain = 1;
    banked.rain = 1;
    run(open, 150);
    run(banked, 150);

    expect(open.emberTemp).toBeLessThan(openBefore);
    expect(banked.emberTemp).toBeGreaterThan(open.emberTemp + 40);
    // And there is still a fire under there when the rain stops.
    expect(isBanked(banked)).toBe(true);
  });

  it('rain wets wood parked at the edge but not wood standing in the fire', () => {
    const fire = createEstablishedFire();
    const edge = addLog(fire, 'oak', { spot: spotFrom(PIT.ringRadius * 0.95, 0.5, 0) });
    const middle = addLog(fire, 'oak', { spot: spotFrom(0.04, 3.4, 0.6) });
    edge.moisture = 0.1;
    middle.moisture = 0.1;
    fire.rain = 1;
    run(fire, 120);
    expect(edge.moisture).toBeGreaterThan(middle.moisture);
  });

  it('last night\u2019s coals can be woken, and a split log alone will not do it', () => {
    // A banked pit reads dead. It is not.
    const fire = createBankedFire();
    expect(isBanked(fire)).toBe(true);
    expect(fire.flame).toBe(0);
    expect(fire.emberTemp).toBeGreaterThan(200);

    // Dropping a split log on it achieves nothing, which is the lesson oak's
    // own description is trying to teach.
    const stubborn = createBankedFire();
    rakeEmbers(stubborn, 1);
    rakeEmbers(stubborn, 1);
    addLog(stubborn, 'oak', { moisture: 0.05 });
    run(stubborn, 240);
    expect(stubborn.flame).toBeLessThan(0.2);

    // Rake the ash back, lay an armful of fine fuel on the coals, blow on it.
    rakeEmbers(fire, 1);
    rakeEmbers(fire, 1);
    fanFire(fire, 1);
    addLog(fire, 'pine', { grade: 'tinder', moisture: 0.02 });
    addLog(fire, 'pine', { grade: 'tinder', moisture: 0.02 });
    for (let i = 0; i < 3; i++) addLog(fire, 'birch', { grade: 'kindling', moisture: 0.04 });
    run(fire, 3);
    fanFire(fire, 1);
    run(fire, 3);
    fanFire(fire, 1);
    run(fire, 4);
    // Ten seconds in it is properly alight, and the bed is already hotter.
    expect(fire.flame).toBeGreaterThan(0.8);
    expect(fire.emberTemp).toBeGreaterThan(450);

    // Kindling does not last. What it leaves behind is a bed twice the size,
    // and that is the bed a real log will take from.
    run(fire, 50);
    expect(fire.emberMass).toBeGreaterThan(0.24);
    addLog(fire, 'pine', { moisture: 0.12, spot: spotFrom(0.11, 1.1, 0.7) });
    run(fire, 90);
    expect(fire.flame).toBeGreaterThan(0.8);
    addLog(fire, 'oak', { moisture: 0.06, spot: spotFrom(0.12, 4.2, 0.7) });
    run(fire, 240);
    // Five minutes of tending and you have a fire worth cooking on.
    expect(fire.emberMass).toBeGreaterThan(0.38);
    expect(fire.emberTemp).toBeGreaterThan(560);
  });

  it('blowing on open coals makes them hotter; blowing through ash does not', () => {
    const open = createBankedFire();
    rakeEmbers(open, 1);
    rakeEmbers(open, 1);
    const buried = createBankedFire();
    const openBefore = open.emberTemp;
    const buriedBefore = buried.emberTemp;
    fanFire(open, 1);
    fanFire(buried, 1);
    expect(open.emberTemp - openBefore).toBeGreaterThan(3 * (buried.emberTemp - buriedBefore));
  });
});
