import { describe, expect, it } from 'vitest';
import {
  appetiteSignals,
  BITE_POSITIONS,
  biteColdness,
  createBiteState,
  deriveSandwich,
  finishingLine,
  provenanceLines,
  sandwichHeight,
  sandwichLayers,
  stampForClass,
  takeBite,
  type DeriveSandwichInput,
} from '../src/sandwich.js';
import type { RoastSummary } from '../src/roasting.js';
import type { AssemblySummary } from '../src/assembly.js';
import type { MachineRunRecord } from '../src/machine.js';
import { Rng } from '../src/rng.js';

function roast(overrides: Partial<RoastSummary> = {}): RoastSummary {
  return {
    brown: 0.5,
    char: 0.05,
    blister: 0.1,
    evenness: 0.8,
    sidedness: 0.1,
    peakTempC: 190,
    melt: 0.3,
    fallen: false,
    ignitionCount: 0,
    flameSeconds: 0,
    seconds: 80,
    rotationTravel: 40,
    descriptors: ['evenly-golden'],
    label: 'Evenly golden',
    ...overrides,
  };
}

function assembly(overrides: Partial<AssemblySummary> = {}): AssemblySummary {
  return {
    misalignment: 0.004,
    maxMisalignment: 0.006,
    lean: 0.02,
    squish: 0.4,
    crumbs: 0.3,
    smear: 0.2,
    seconds: 20,
    tidiness: 0.8,
    label: 'Neatly stacked',
    ...overrides,
  };
}

function machine(overrides: Partial<MachineRunRecord> = {}): MachineRunRecord {
  return {
    serial: 'SM01-1999K-12345-B',
    program: 'standard',
    durationSeconds: 50,
    peakFrost: 0.7,
    minChamberTempC: -28,
    quirkIds: [],
    firmness: 0.6,
    ...overrides,
  };
}

function input(overrides: Partial<DeriveSandwichInput> = {}): DeriveSandwichInput {
  return {
    roast: roast(),
    assembly: assembly(),
    machine: machine(),
    environmentId: 'pinewood',
    campsiteSeed: 'camp-1',
    createdAt: 1_700_000_000_000,
    index: 1,
    ...overrides,
  };
}

describe('derivation', () => {
  it('is deterministic', () => {
    expect(deriveSandwich(input())).toEqual(deriveSandwich(input()));
  });

  it('differs between campsites', () => {
    const a = deriveSandwich(input({ campsiteSeed: 'camp-1' }));
    const b = deriveSandwich(input({ campsiteSeed: 'camp-2' }));
    expect(a.id).not.toBe(b.id);
  });

  it('gives each sandwich in a session a distinct id', () => {
    const a = deriveSandwich(input({ index: 1 }));
    const b = deriveSandwich(input({ index: 2 }));
    expect(a.id).not.toBe(b.id);
  });

  it('carries the full provenance forward', () => {
    const s = deriveSandwich(input());
    expect(s.roast.label).toBe('Evenly golden');
    expect(s.machine.serial).toBe('SM01-1999K-12345-B');
    expect(s.environmentId).toBe('pinewood');
  });
});

describe('the roast shows up in the object', () => {
  it('more browning gives a deeper ice cream colour', () => {
    const pale = deriveSandwich(input({ roast: roast({ brown: 0.05 }) }));
    const deep = deriveSandwich(input({ roast: roast({ brown: 0.95 }) }));
    // Toasted cream is darker and warmer than pale cream.
    expect(deep.appearance.creamColor[2]).toBeLessThan(pale.appearance.creamColor[2]);
  });

  it('char becomes dark toasted flecks', () => {
    const clean = deriveSandwich(input({ roast: roast({ char: 0 }) }));
    const burnt = deriveSandwich(input({ roast: roast({ char: 0.8 }) }));
    expect(burnt.appearance.fleckDensity).toBeGreaterThan(clean.appearance.fleckDensity);
  });

  it('an uneven roast makes a more pronounced swirl', () => {
    // Deliberate: an imperfect roast produces a better-looking object, which
    // keeps "bad" outcomes desirable (spec §4.5).
    const even = deriveSandwich(input({ roast: roast({ evenness: 1, sidedness: 0 }) }));
    const uneven = deriveSandwich(input({ roast: roast({ evenness: 0.2, sidedness: 0.6 }) }));
    expect(uneven.appearance.swirlStrength).toBeGreaterThan(even.appearance.swirlStrength);
  });

  it('blistering becomes surface texture', () => {
    const smooth = deriveSandwich(input({ roast: roast({ blister: 0 }) }));
    const bubbled = deriveSandwich(input({ roast: roast({ blister: 0.9 }) }));
    expect(bubbled.appearance.surfaceTexture).toBeGreaterThan(smooth.appearance.surfaceTexture);
  });
});

describe('the assembly shows up in the object', () => {
  it('squish thins the ice cream layer and bulges the edge', () => {
    const light = deriveSandwich(input({ assembly: assembly({ squish: 0 }) }));
    const pressed = deriveSandwich(input({ assembly: assembly({ squish: 1 }) }));
    expect(pressed.appearance.creamThickness).toBeLessThan(light.appearance.creamThickness);
    expect(pressed.appearance.edgeBulge).toBeGreaterThan(light.appearance.edgeBulge);
  });

  it('misalignment survives into the frozen object', () => {
    const neat = deriveSandwich(input({ assembly: assembly({ misalignment: 0 }) }));
    const messy = deriveSandwich(input({ assembly: assembly({ misalignment: 0.03 }) }));
    const spread = (s: typeof neat) => s.appearance.layerOffsets.reduce((t, o) => t + Math.abs(o), 0);
    expect(spread(messy)).toBeGreaterThan(spread(neat));
  });

  it('lean carries through', () => {
    const s = deriveSandwich(input({ assembly: assembly({ lean: 0.2 }) }));
    expect(s.appearance.lean).toBe(0.2);
  });
});

describe('the machine shows up in the object', () => {
  it('a deep freeze frosts more', () => {
    const soft = deriveSandwich(input({ machine: machine({ peakFrost: 0.2 }) }));
    const deep = deriveSandwich(input({ machine: machine({ peakFrost: 1 }) }));
    expect(deep.appearance.frost).toBeGreaterThan(soft.appearance.frost);
  });

  it('less frost means more condensation', () => {
    const soft = deriveSandwich(input({ machine: machine({ peakFrost: 0.1 }) }));
    const deep = deriveSandwich(input({ machine: machine({ peakFrost: 1 }) }));
    expect(soft.appearance.condensation).toBeGreaterThan(deep.appearance.condensation);
  });
});

describe('classification', () => {
  it('names an Ember for a marshmallow that caught fire', () => {
    const s = deriveSandwich(input({ roast: roast({ char: 0.7, flameSeconds: 8, ignitionCount: 1 }) }));
    expect(s.class).toBe('Ember');
    expect(s.caption).toContain('Blown out');
  });

  it('names Immaculate only for a careful roast and a square stack', () => {
    const s = deriveSandwich(
      input({
        roast: roast({ brown: 0.6, evenness: 0.9, char: 0 }),
        assembly: assembly({ tidiness: 0.95 }),
      }),
    );
    expect(s.class).toBe('Immaculate');
  });

  it('names Lopsided without scolding', () => {
    const s = deriveSandwich(input({ assembly: assembly({ tidiness: 0.1 }) }));
    expect(s.class).toBe('Lopsided');
    expect(s.caption).toContain('Still perfect');
  });

  it('names Snowdrift for a heavily frosted deep freeze', () => {
    const s = deriveSandwich(input({ machine: machine({ program: 'deep-freeze', peakFrost: 0.95 }) }));
    expect(s.class).toBe('Snowdrift');
  });

  it('names Midnight for a barely warmed marshmallow', () => {
    const s = deriveSandwich(input({ roast: roast({ brown: 0.02, evenness: 0.9 }) }));
    expect(s.class).toBe('Midnight');
  });

  it('gives every class a caption and a stamp', () => {
    const classes = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const s = deriveSandwich(
        input({
          index: i,
          roast: roast({ brown: (i % 10) / 10, char: (i % 5) / 8, evenness: ((i % 7) + 1) / 8 }),
          assembly: assembly({ tidiness: ((i % 9) + 1) / 10 }),
        }),
      );
      classes.add(s.class);
      expect(s.caption.length).toBeGreaterThan(0);
      expect(stampForClass(s.class)).toMatch(/^stamp-[a-z]+$/);
    }
    expect(classes.size).toBeGreaterThan(3);
  });
});

describe('appetite', () => {
  it('stays warm-toned and contrasty across the whole outcome space', () => {
    // Guards risk R3: the derivation must never produce a grey or flat object.
    for (let b = 0; b <= 10; b++) {
      for (let c = 0; c <= 5; c++) {
        const s = deriveSandwich(
          input({ roast: roast({ brown: b / 10, char: c / 5 }) }),
        );
        const signals = appetiteSignals(s);
        expect(signals.warmth, `brown=${b / 10} char=${c / 5}`).toBeGreaterThan(0.5);
        expect(signals.contrast).toBeGreaterThan(0.05);
        const a = s.appearance;
        // Never black, never washed out.
        expect(Math.max(...a.creamColor)).toBeGreaterThan(0.5);
        expect(a.sheen).toBeGreaterThan(0.2);
      }
    }
  });
});

describe('layers', () => {
  it('is graham, chocolate, cream, chocolate, graham', () => {
    expect(sandwichLayers(deriveSandwich(input())).map((l) => l.kind)).toEqual([
      'graham',
      'chocolate',
      'cream',
      'chocolate',
      'graham',
    ]);
  });

  it('has a plausible total height', () => {
    const h = sandwichHeight(deriveSandwich(input()));
    expect(h).toBeGreaterThan(0.02);
    expect(h).toBeLessThan(0.06);
  });

  it('offsets layers in different directions', () => {
    const layers = sandwichLayers(deriveSandwich(input({ assembly: assembly({ misalignment: 0.02 }) })));
    const angles = layers.slice(1).map((l) => Math.atan2(l.offsetZ, l.offsetX));
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBeGreaterThan(1);
  });
});

describe('eating', () => {
  it('starts whole', () => {
    const bite = createBiteState();
    expect(bite.eaten).toBe(0);
    expect(bite.finished).toBe(false);
    expect(bite.depths).toHaveLength(BITE_POSITIONS);
  });

  it('removes material from the bitten side', () => {
    const s = deriveSandwich(input());
    const bite = takeBite(createBiteState(), s, 2, new Rng(1));
    expect(bite.depths[2]!).toBeGreaterThan(0);
    expect(bite.depths[5]!).toBe(0);
    expect(bite.eaten).toBeGreaterThan(0);
  });

  it('erodes neighbouring positions slightly', () => {
    const bite = takeBite(createBiteState(), deriveSandwich(input()), 3, new Rng(1));
    expect(bite.depths[2]!).toBeGreaterThan(0);
    expect(bite.depths[4]!).toBeGreaterThan(0);
    expect(bite.depths[3]!).toBeGreaterThan(bite.depths[2]!);
  });

  it('wraps around the perimeter', () => {
    const bite = takeBite(createBiteState(), deriveSandwich(input()), 0, new Rng(1));
    expect(bite.depths[BITE_POSITIONS - 1]!).toBeGreaterThan(0);
  });

  it('handles out-of-range and negative positions', () => {
    const s = deriveSandwich(input());
    expect(() => takeBite(createBiteState(), s, 99, new Rng(1))).not.toThrow();
    expect(() => takeBite(createBiteState(), s, -3, new Rng(1))).not.toThrow();
  });

  it('finishes after enough bites and stops accepting more', () => {
    const s = deriveSandwich(input());
    let bite = createBiteState();
    const rng = new Rng(1);
    for (let i = 0; i < 40 && !bite.finished; i++) bite = takeBite(bite, s, i % BITE_POSITIONS, rng);
    expect(bite.finished).toBe(true);
    const bitesWhenDone = bite.bites;
    takeBite(bite, s, 0, rng);
    expect(bite.bites).toBe(bitesWhenDone);
  });

  it('takes a believable number of bites', () => {
    const s = deriveSandwich(input());
    let bite = createBiteState();
    const rng = new Rng(1);
    let count = 0;
    while (!bite.finished && count < 100) {
      bite = takeBite(bite, s, count % BITE_POSITIONS, rng);
      count++;
    }
    expect(count).toBeGreaterThan(3);
    expect(count).toBeLessThan(30);
  });

  it('firm chocolate fractures more often than soft', () => {
    const firm = deriveSandwich(input({ machine: machine({ firmness: 1 }) }));
    const soft = deriveSandwich(input({ machine: machine({ firmness: 0 }) }));
    let firmFractures = 0;
    let softFractures = 0;
    for (let i = 0; i < 200; i++) {
      if (takeBite(createBiteState(), firm, 0, new Rng(i)).fracturedThisBite) firmFractures++;
      if (takeBite(createBiteState(), soft, 0, new Rng(i)).fracturedThisBite) softFractures++;
    }
    expect(firmFractures).toBeGreaterThan(softFractures);
  });

  it('warms up as it sits out', () => {
    const s = deriveSandwich(input());
    const bite = createBiteState();
    expect(biteColdness(bite, s, 0)).toBeGreaterThan(biteColdness(bite, s, 240));
  });

  it('closes quietly rather than with a fanfare', () => {
    const s = deriveSandwich(input());
    let bite = createBiteState();
    expect(finishingLine(s, bite)).toBeNull();
    const rng = new Rng(1);
    for (let i = 0; i < 40 && !bite.finished; i++) bite = takeBite(bite, s, i % BITE_POSITIONS, rng);
    const line = finishingLine(s, bite);
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/congratulations|score|points|\+\d/i);
  });
});

describe('provenance readout', () => {
  it('reads like a receipt, not a scorecard', () => {
    const lines = provenanceLines(deriveSandwich(input()));
    expect(lines.some((l) => l.startsWith('CLASS'))).toBe(true);
    expect(lines.some((l) => l.startsWith('UNIT'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/score|rating|stars|\d+\/\d+|%/i);
  });

  it('notes heavy frost', () => {
    const lines = provenanceLines(deriveSandwich(input({ machine: machine({ peakFrost: 1 }) })));
    expect(lines.some((l) => l.includes('Heavy frost'))).toBe(true);
  });
});
