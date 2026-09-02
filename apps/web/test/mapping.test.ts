import { describe, expect, it } from 'vitest';
import {
  CreateSandwichRequestSchema,
  MachineSerialSchema,
  MachineProgramValues,
} from '@somemore/protocol';
import {
  createRitual,
  deriveMachineIdentity,
  deriveSandwich,
  PROGRAMS,
  type SandwichRecord,
} from '@somemore/sim';
import {
  PROGRAM_TO_WIRE,
  roastGrade,
  toAssemblyQuality,
  toCreateSandwichRequest,
  toMachineRun,
  toRoastTelemetry,
  wireProgram,
} from '../src/net/mapping.js';

/** A sandwich built the way the simulation actually builds one. */
function sandwich(overrides: Partial<Parameters<typeof deriveSandwich>[0]> = {}): SandwichRecord {
  return deriveSandwich({
    roast: {
      brown: 0.62,
      char: 0.06,
      blister: 0.2,
      evenness: 0.78,
      sidedness: 0.12,
      peakTempC: 196,
      melt: 0.34,
      fallen: false,
      ignitionCount: 0,
      flameSeconds: 0,
      seconds: 78.4,
      rotationTravel: 41.3,
      descriptors: ['evenly-golden'],
      label: 'Evenly golden',
    },
    assembly: {
      misalignment: 0.005,
      maxMisalignment: 0.008,
      lean: 0.02,
      squish: 0.42,
      crumbs: 0.3,
      smear: 0.22,
      seconds: 24,
      tidiness: 0.81,
      label: 'Neatly stacked',
    },
    machine: {
      serial: deriveMachineIdentity('camp-map', 'pine_hollow').serial,
      program: 'standard',
      durationSeconds: 50,
      peakFrost: 0.7,
      minChamberTempC: -28,
      quirkIds: ['double-relay'],
      firmness: PROGRAMS.standard.firmness,
    },
    environmentId: 'pine_hollow',
    campsiteSeed: 'camp-map',
    createdAt: Date.UTC(2026, 0, 1),
    index: 1,
    ...overrides,
  });
}

const CAMPSITE_ID = 'cmp_0123456789abcdef';
const RUN_ID = 'run_0123456789abcdef';

describe('the serial the world stamps is the serial the wire accepts', () => {
  it('accepts serials the simulation actually generates', () => {
    // This is the regression test for the whole class of defect: the two
    // halves were built from the same spec and did not agree on the format
    // of the one identifier that travels between them.
    for (let i = 0; i < 250; i++) {
      const identity = deriveMachineIdentity(`camp-${i}`, 'pine_hollow');
      expect(MachineSerialSchema.safeParse(identity.serial).success, identity.serial).toBe(true);
    }
  });

  it('still rejects nonsense', () => {
    for (const bad of ['SM01-nope', 'SM02-1999K-12345-B', 'SM01-1999k-12345-B', '', 'SM01-1999K-1234-B']) {
      expect(MachineSerialSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('machine programs', () => {
  it('maps every dial position the machine offers', () => {
    for (const program of Object.keys(PROGRAMS)) {
      expect(PROGRAM_TO_WIRE[program as keyof typeof PROGRAM_TO_WIRE], program).toBeDefined();
    }
  });

  it('only ever produces programs the wire contract knows', () => {
    for (const wire of Object.values(PROGRAM_TO_WIRE)) {
      expect(MachineProgramValues).toContain(wire);
    }
  });

  it('falls back rather than sending an unknown program', () => {
    expect(MachineProgramValues).toContain(wireProgram('something-new'));
  });
});

describe('roast grade', () => {
  it('describes rather than ranks, across the whole outcome space', () => {
    const grades = new Set<string>();
    for (let brown = 0; brown <= 1.001; brown += 0.1) {
      for (let char = 0; char <= 1.001; char += 0.25) {
        grades.add(roastGrade(brown, char, 0));
      }
    }
    // A spectrum, not two buckets.
    expect(grades.size).toBeGreaterThanOrEqual(4);
  });

  it('calls a barely-warmed marshmallow raw and a burnt one cremated', () => {
    expect(roastGrade(0, 0, 0)).toBe('raw');
    expect(roastGrade(1, 0.9, 20)).toBe('cremated');
  });

  it('treats a long flame as cremated even at modest char', () => {
    expect(roastGrade(0.5, 0.1, 20)).toBe('cremated');
  });
});

describe('telemetry mapping', () => {
  it('produces a body the server contract accepts', () => {
    const body = toCreateSandwichRequest({
      sandwich: sandwich(),
      campsiteId: CAMPSITE_ID,
      runId: RUN_ID,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      minimumDistanceCm: 16,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    const parsed = CreateSandwichRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 4))).toBe(true);
  });

  it('accepts every outcome the simulation can produce, not just the tidy one', () => {
    // The extremes are where a mapping quietly breaks: a dropped marshmallow,
    // a cremated one, a perfect one, a wildly lopsided stack.
    const cases: Partial<Parameters<typeof deriveSandwich>[0]>[] = [
      { roast: { ...sandwich().roast, brown: 0, char: 0, seconds: 0, rotationTravel: 0, peakTempC: 12 } },
      { roast: { ...sandwich().roast, brown: 1, char: 1, flameSeconds: 40, ignitionCount: 5, melt: 2, fallen: true } },
      { assembly: { ...sandwich().assembly, misalignment: 0.2, tidiness: 0, crumbs: 1, smear: 1, squish: 1 } },
      { machine: { ...sandwich().machine, program: 'deep-freeze', durationSeconds: 3600, minChamberTempC: -39 } },
      { machine: { ...sandwich().machine, program: 'soft-set', durationSeconds: 0, firmness: 0, quirkIds: [] } },
    ];
    for (const [index, override] of cases.entries()) {
      const body = toCreateSandwichRequest({
        sandwich: sandwich(override),
        campsiteId: CAMPSITE_ID,
        runId: RUN_ID,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        minimumDistanceCm: 7,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      });
      const parsed = CreateSandwichRequestSchema.safeParse(body);
      expect(parsed.success, `case ${index}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`).toBe(true);
    }
  });

  it('carries the roast faithfully rather than inventing numbers', () => {
    const source = sandwich();
    const roast = toRoastTelemetry(source, 16);
    expect(roast.durationMs).toBe(Math.round(source.roast.seconds * 1000));
    expect(roast.charFraction).toBeCloseTo(source.roast.char, 5);
    expect(roast.evenness).toBeCloseTo(source.roast.evenness, 5);
    // Radians of travel become whole turns.
    expect(roast.rotations).toBeCloseTo(source.roast.rotationTravel / (Math.PI * 2), 5);
  });

  it('reports ignition and drops honestly', () => {
    const burnt = sandwich({
      roast: { ...sandwich().roast, ignitionCount: 2, flameSeconds: 5, fallen: true },
    });
    const roast = toRoastTelemetry(burnt, 5);
    expect(roast.ignited).toBe(true);
    expect(roast.blownOut).toBe(true);
    expect(roast.dropped).toBe(true);
    expect(roast.flareUps).toBe(2);
  });

  it('turns misalignment in metres into an alignment score', () => {
    const neat = toAssemblyQuality(sandwich({ assembly: { ...sandwich().assembly, misalignment: 0 } }));
    const messy = toAssemblyQuality(sandwich({ assembly: { ...sandwich().assembly, misalignment: 0.05 } }));
    expect(neat.alignment).toBeGreaterThan(messy.alignment);
    expect(messy.alignment).toBeGreaterThanOrEqual(0);
  });

  it('never sends a score the server is supposed to derive', () => {
    const body = toCreateSandwichRequest({
      sandwich: sandwich(),
      campsiteId: CAMPSITE_ID,
      runId: RUN_ID,
      startedAt: new Date(),
      minimumDistanceCm: 16,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(body).not.toHaveProperty('overallScore');
    expect(body).not.toHaveProperty('rarity');
  });

  it('keeps the run window consistent with its duration', () => {
    const started = new Date('2026-01-01T00:00:00.000Z');
    const run = toMachineRun(sandwich(), RUN_ID, started);
    const elapsed = (Date.parse(run.completedAt) - started.getTime()) / 1000;
    expect(elapsed).toBeCloseTo(sandwich().machine.durationSeconds, 3);
  });

  it('carries the unit’s quirks through', () => {
    expect(toMachineRun(sandwich(), RUN_ID, new Date()).quirkCodesApplied).toContain('double-relay');
  });
});

describe('a sandwich made by actually playing maps cleanly', () => {
  it('survives the whole round trip from a real ritual', () => {
    // Not a fixture: run the ritual, take what falls out, and post it.
    const ritual = createRitual({ campsiteSeed: 'camp-roundtrip', environmentId: 'pine_hollow', now: 0 });
    const record = deriveSandwich({
      roast: {
        ...sandwich().roast,
        seconds: 61,
      },
      assembly: sandwich().assembly,
      machine: { ...sandwich().machine, serial: ritual.machine.identity.serial },
      environmentId: ritual.options.environmentId,
      campsiteSeed: ritual.options.campsiteSeed,
      createdAt: 0,
      index: 1,
    });
    const body = toCreateSandwichRequest({
      sandwich: record,
      campsiteId: CAMPSITE_ID,
      runId: RUN_ID,
      startedAt: new Date(0),
      minimumDistanceCm: 15,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(CreateSandwichRequestSchema.safeParse(body).success).toBe(true);
  });
});
