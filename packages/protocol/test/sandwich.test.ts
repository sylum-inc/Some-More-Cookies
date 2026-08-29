import { describe, expect, it } from 'vitest';
import {
  CreateSandwichRequestSchema,
  MachineRunSchema,
  RoastTelemetrySummarySchema,
  SandwichRecordSchema,
  UpdateSandwichRequestSchema,
  rarityForScore,
  scoreSandwich,
} from '../src/index.js';
import { NOW, goodAssembly, goodRoast, goodRun } from './fixtures.js';

const record = {
  id: 'swh_1',
  accountId: 'acct_1',
  campsiteId: 'cmp_1',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: '1.0.0',
  roast: goodRoast,
  assembly: goodAssembly,
  machineRun: goodRun,
  overallScore: 0.9,
  rarity: 'rare',
};

describe('sandwich record', () => {
  it('accepts a complete record and defaults the mutable tail', () => {
    const parsed = SandwichRecordSchema.parse(record);
    expect(parsed.shareState).toBe('private');
    expect(parsed.savedToPassport).toBe(true);
    expect(parsed.consumedAt).toBeNull();
    expect(parsed.orderId).toBeNull();
  });

  it('rejects an impossible roast summary', () => {
    expect(RoastTelemetrySummarySchema.safeParse({ ...goodRoast, evenness: 1.4 }).success).toBe(false);
    expect(RoastTelemetrySummarySchema.safeParse({ ...goodRoast, grade: 'incinerated' }).success).toBe(false);
    expect(RoastTelemetrySummarySchema.safeParse({ ...goodRoast, durationMs: -5 }).success).toBe(false);
    expect(RoastTelemetrySummarySchema.safeParse({ ...goodRoast, simVersion: 'latest' }).success).toBe(false);
  });

  it('rejects a machine run with a bad serial or unknown anomaly', () => {
    expect(MachineRunSchema.safeParse({ ...goodRun, machineSerial: 'SM01-nope' }).success).toBe(false);
    expect(MachineRunSchema.safeParse({ ...goodRun, anomalies: ['gremlins'] }).success).toBe(false);
    expect(MachineRunSchema.safeParse({ ...goodRun, outcome: 'delicious' }).success).toBe(false);
  });

  it('rejects a record missing its provenance', () => {
    const { roast: _roast, ...withoutRoast } = record;
    expect(SandwichRecordSchema.safeParse(withoutRoast).success).toBe(false);
    expect(SandwichRecordSchema.safeParse({ ...record, overallScore: 2 }).success).toBe(false);
  });
});

describe('create request', () => {
  it('does not let the client set the run id, score or rarity', () => {
    const shape = Object.keys(CreateSandwichRequestSchema.shape);
    expect(shape).not.toContain('overallScore');
    expect(shape).not.toContain('rarity');
    expect(shape).not.toContain('id');
    const runShape = Object.keys(CreateSandwichRequestSchema.shape.machineRun.shape);
    expect(runShape).not.toContain('runId');
  });

  it('requires an idempotency key and a campsite', () => {
    const { machineRun, ...rest } = { machineRun: goodRun, roast: goodRoast, assembly: goodAssembly };
    const { runId: _runId, ...runWithoutId } = machineRun;
    expect(
      CreateSandwichRequestSchema.safeParse({ ...rest, machineRun: runWithoutId, campsiteId: 'cmp_1' }).success,
    ).toBe(false);
    expect(
      CreateSandwichRequestSchema.safeParse({
        ...rest,
        machineRun: runWithoutId,
        campsiteId: 'cmp_1',
        idempotencyKey: 'swh-0001',
      }).success,
    ).toBe(true);
  });
});

describe('scoring', () => {
  it('rewards a golden even roast with a clean run', () => {
    const score = scoreSandwich({ roast: goodRoast, assembly: goodAssembly, machineRun: goodRun });
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('punishes a cremated roast, a dropped marshmallow and a jam', () => {
    const perfect = scoreSandwich({ roast: goodRoast, assembly: goodAssembly, machineRun: goodRun });
    const cremated = scoreSandwich({
      roast: { ...goodRoast, grade: 'cremated', evenness: 0.2, dropped: true },
      assembly: goodAssembly,
      machineRun: goodRun,
    });
    expect(cremated).toBeLessThan(perfect - 0.35);
    const jammed = scoreSandwich({
      roast: goodRoast,
      assembly: goodAssembly,
      machineRun: { ...goodRun, outcome: 'jam', anomalies: ['belt_stall', 'press_slip'] },
    });
    expect(jammed).toBeLessThan(perfect - 0.15);
    expect(jammed).toBeGreaterThanOrEqual(0);
  });

  it('maps scores onto rarity bands', () => {
    expect(rarityForScore(0.99)).toBe('legendary');
    expect(rarityForScore(0.86)).toBe('rare');
    expect(rarityForScore(0.7)).toBe('uncommon');
    expect(rarityForScore(0.1)).toBe('common');
  });
});

describe('update request', () => {
  it('only exposes the mutable tail', () => {
    const shape = Object.keys(UpdateSandwichRequestSchema.shape);
    expect(shape.sort()).toEqual(['consumed', 'heroPhotoId', 'name', 'savedToPassport', 'shareState']);
    expect(UpdateSandwichRequestSchema.safeParse({ shareState: 'everywhere' }).success).toBe(false);
  });
});
