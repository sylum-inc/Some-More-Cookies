import { describe, expect, it } from 'vitest';
import {
  assertNoGating,
  conditionsHold,
  createDiscovery,
  createObservation,
  defaultConditions,
  discoveredSecrets,
  discoveryEvidence,
  discoverySignals,
  drainDiscoveryEvents,
  hasDiscovered,
  outcomeOf,
  permanentEvidence,
  secretStream,
  stepDiscovery,
  type DiscoveryEvent,
  type DiscoveryObservation,
  type DiscoveryRecord,
  type DiscoveryState,
  type SecretConditions,
  type SecretDefinition,
} from '../src/discovery.js';
import { decideTrace } from '../src/significance.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

/**
 * Secrets in the shape the content package emits — `SecretEntry` from
 * `@somemore/content` has exactly these fields, `optional` and `gatesNothing`
 * included.
 */
const TIN: SecretDefinition = {
  id: 'ph_creek_tin',
  title: 'The tin in the creek',
  discovery: 'A dented tin wedged under the wobbling stepping stone.',
  telling: 'A photograph of this exact site with a different fire ring, and a note that reads "put it back".',
  channels: ['strange-objects', 'notes'],
  oneTime: true,
  leavesEvidence: 'The tin sits closed on the picnic table on every later visit, and the stone stops wobbling.',
  rarity: 0.3,
  optional: true,
  gatesNothing: true,
};

const LANTERN: SecretDefinition = {
  id: 'ph_lantern_on_the_road',
  title: 'The lantern on the loop road',
  discovery: 'A single warm light moves along the loop road and does not stop.',
  telling: 'It is going the wrong way for a car and too steadily for a person.',
  channels: ['recurring-figures', 'distant-sounds'],
  oneTime: false,
  leavesEvidence: null,
  rarity: 0.6,
  optional: true,
  gatesNothing: true,
};

const CARRIER: SecretDefinition = {
  id: 'ph_carrier',
  title: 'The carrier that hums',
  discovery: 'A carrier with a room tone under it, at the bottom of the band.',
  telling: 'Under the hum, a radio playing the station you are listening to, a few seconds behind.',
  channels: ['radio'],
  oneTime: false,
  leavesEvidence: null,
  rarity: 0.5,
  optional: true,
  gatesNothing: true,
};

const SECRETS: readonly SecretDefinition[] = [TIN, LANTERN, CARRIER];

function inspecting(targetId: string): DiscoveryObservation {
  return createObservation({ inspecting: targetId, stillnessSeconds: 200 });
}

function run(
  state: DiscoveryState,
  observation: DiscoveryObservation,
  seconds: number,
  seed = 1,
): DiscoveryEvent[] {
  const rng = new Rng(seed);
  const events: DiscoveryEvent[] = [];
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    stepDiscovery(state, observation, SIM_DT, rng);
    events.push(...drainDiscoveryEvents(state));
  }
  return events;
}

describe('the no-gating guarantee', () => {
  it('cannot express a secret that gates something', () => {
    const gating: SecretDefinition = {
      ...TIN,
      id: 'not_allowed',
      // @ts-expect-error — `gatesNothing` is literal `true`; a gating secret is
      // not a representable value (spec §8).
      gatesNothing: false,
    };
    // The cast above is the only way to build one, and it is rejected at runtime.
    expect(() => assertNoGating([gating])).toThrow(/gate/i);
  });

  it('rejects an optional flag turned off, whatever route the data arrived by', () => {
    const fromJson = JSON.parse(JSON.stringify({ ...TIN, optional: false })) as SecretDefinition;
    expect(() => assertNoGating([fromJson])).toThrow();
    expect(() => createDiscovery({ campsiteSeed: 1, secrets: [fromJson] })).toThrow();
  });

  it('refuses a one-time secret that would leave nobody anything', () => {
    const stranding = { ...TIN, leavesEvidence: null } as SecretDefinition;
    expect(() => assertNoGating([stranding])).toThrow(/strand/i);
  });

  it('produces an outcome with nothing to unlock', () => {
    const outcome = outcomeOf(TIN);
    expect(outcome.telling).toBe(TIN.telling);
    expect(outcome.evidence).toBe(TIN.leavesEvidence);
    const banned = ['unlock', 'unlocks', 'reward', 'grants', 'grant', 'flag', 'key', 'gate', 'requires'];
    for (const key of Object.keys(outcome)) expect(banned).not.toContain(key.toLowerCase());
    const state = createDiscovery({ campsiteSeed: 1, secrets: SECRETS });
    const events = run(state, inspecting('ph_creek_tin'), 400);
    const discovered = events.find((event) => event.kind === 'discovered');
    expect(discovered).toBeDefined();
    for (const key of Object.keys(discovered as object)) expect(banned).not.toContain(key.toLowerCase());
  });

  it('reports what was found without a denominator', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: SECRETS });
    run(state, inspecting('ph_creek_tin'), 400);
    const signals = discoverySignals(state);
    expect(signals.found).toBeGreaterThan(0);
    const banned = ['total', 'outof', 'remaining', 'percent', 'progress', 'completion'];
    for (const key of Object.keys(signals)) expect(banned).not.toContain(key.toLowerCase());
  });
});

describe('conditions', () => {
  it('derives sensible defaults from the content channels', () => {
    expect(defaultConditions(CARRIER)).toEqual([{ kind: 'tuned', clarity: 0.4 }]);
    expect(defaultConditions(LANTERN).map((condition) => condition.kind)).toEqual(['quiet', 'quiet']);
    expect(defaultConditions(TIN).every((condition) => condition.kind === 'inspecting')).toBe(true);
  });

  it('evaluates every condition kind against the world', () => {
    const conditions: readonly SecretConditions[] = [
      {
        secretId: TIN.id,
        conditions: [
          { kind: 'at-place', placeId: 'creek_stones' },
          { kind: 'quiet', seconds: 30 },
          { kind: 'weather', kinds: ['fog', 'clear'] },
          { kind: 'sky-event', event: 'meteor-shower' },
          { kind: 'tuned', stationId: 'khol_887', clarity: 0.5 },
          { kind: 'photographed', subjectId: 'leaning_snag' },
          { kind: 'inspecting', targetId: 'creek_tin' },
          { kind: 'wildlife', speciesId: 'squirrel', persistentOnly: true },
          { kind: 'visits', count: 2 },
          { kind: 'time-of-night', window: 'deep-night' },
          { kind: 'fire', minIntensity: 0.4 },
        ],
      },
    ];
    const state = createDiscovery({ campsiteSeed: 1, secrets: [TIN], conditions, visitIndex: 3 });

    const everything = createObservation({
      places: ['creek_stones'],
      stillnessSeconds: 45,
      weatherKind: 'fog',
      skyEvent: 'meteor-shower',
      radio: { stationId: 'khol_887', dial: 88.7, band: 'fm', clarity: 0.8 },
      photographed: ['leaning_snag'],
      wildlife: [{ speciesId: 'squirrel', persistent: true }],
      inspecting: 'creek_tin',
      window: 'deep-night',
      fireIntensity: 0.7,
    });
    // `photographed` latches, so it takes one step to register.
    stepDiscovery(state, everything, SIM_DT, new Rng(1));
    expect(conditionsHold(state, TIN.id, everything)).toBe(true);

    // Every single one of them is load-bearing.
    expect(conditionsHold(state, TIN.id, { ...everything, places: [] })).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, stillnessSeconds: 5 })).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, weatherKind: 'storm' })).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, skyEvent: 'none' })).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, radio: null })).toBe(false);
    expect(
      conditionsHold(state, TIN.id, {
        ...everything,
        radio: { stationId: 'khol_887', dial: 88.7, band: 'fm', clarity: 0.2 },
      }),
    ).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, inspecting: null })).toBe(false);
    expect(
      conditionsHold(state, TIN.id, { ...everything, wildlife: [{ speciesId: 'squirrel', persistent: false }] }),
    ).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, window: 'dawn' })).toBe(false);
    expect(conditionsHold(state, TIN.id, { ...everything, fireIntensity: 0.1 })).toBe(false);
  });

  it('never surfaces a secret whose conditions are not met', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: SECRETS });
    const events = run(state, createObservation(), 3600);
    expect(events).toHaveLength(0);
    expect(discoveredSecrets(state)).toHaveLength(0);
  });

  it('needs the conditions held, not merely brushed past', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: [TIN] });
    const rng = new Rng(1);
    // Two seconds looking, then away, over and over.
    for (let cycle = 0; cycle < 200; cycle++) {
      for (let i = 0; i < Math.round(2 / SIM_DT); i++) stepDiscovery(state, inspecting('ph_creek_tin'), SIM_DT, rng);
      for (let i = 0; i < Math.round(4 / SIM_DT); i++) stepDiscovery(state, createObservation(), SIM_DT, rng);
    }
    expect(hasDiscovered(state, TIN.id)).toBe(false);
  });

  it('leans in before it surfaces', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: [TIN] });
    const events = run(state, inspecting('ph_creek_tin'), 400);
    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe('noticing');
    expect(kinds).toContain('discovered');
  });

  it('surfaces a radio secret only while it is actually tuned in', () => {
    const tuned = createObservation({
      radio: { stationId: 'the_halt_carrier', dial: 1440, band: 'am', clarity: 0.75 },
    });
    const found = createDiscovery({ campsiteSeed: 4, secrets: [CARRIER] });
    expect(run(found, tuned, 600).some((event) => event.kind === 'discovered')).toBe(true);

    const hissing = createObservation({
      radio: { stationId: null, dial: 1400, band: 'am', clarity: 0.05 },
    });
    const missed = createDiscovery({ campsiteSeed: 4, secrets: [CARRIER] });
    expect(run(missed, hissing, 600).some((event) => event.kind === 'discovered')).toBe(false);
  });
});

describe('one-time events', () => {
  it('fires once, and only once, in a session', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: [TIN] });
    const events = run(state, inspecting('ph_creek_tin'), 7200);
    const found = events.filter((event) => event.kind === 'discovered');
    expect(found).toHaveLength(1);
    expect(found[0]?.oneTime).toBe(true);
    expect(found[0]?.evidence).toBe(TIN.leavesEvidence);
  });

  it('leaves permanent evidence, and never fires again on a later visit', () => {
    const first = createDiscovery({ campsiteSeed: 1, secrets: [TIN], visitIndex: 1 });
    run(first, inspecting('ph_creek_tin'), 1200);
    expect(hasDiscovered(first, TIN.id)).toBe(true);
    const marks = permanentEvidence(first);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.evidence).toBe(TIN.leavesEvidence);

    const known: readonly DiscoveryRecord[] = discoveredSecrets(first);
    const second = createDiscovery({ campsiteSeed: 1, secrets: [TIN], visitIndex: 2, known });
    const events = run(second, inspecting('ph_creek_tin'), 7200, 99);
    expect(events).toHaveLength(0);
    // The story is still standing in the world for the second visit.
    expect(permanentEvidence(second)).toHaveLength(1);
    expect(permanentEvidence(second)[0]?.title).toBe(TIN.title);
    expect(permanentEvidence(second)[0]?.visitIndex).toBe(1);
  });

  it('lets a repeatable secret happen again on a later visit', () => {
    const first = createDiscovery({ campsiteSeed: 2, secrets: [LANTERN] });
    const quiet = createObservation({ stillnessSeconds: 120 });
    expect(run(first, quiet, 1200).some((event) => event.kind === 'discovered')).toBe(true);
    const second = createDiscovery({
      campsiteSeed: 2,
      secrets: [LANTERN],
      visitIndex: 2,
      known: discoveredSecrets(first),
    });
    expect(run(second, quiet, 1200, 5).some((event) => event.kind === 'discovered')).toBe(true);
    // Nothing repeatable leaves a permanent mark.
    expect(permanentEvidence(second)).toHaveLength(0);
  });
});

describe('determinism', () => {
  it('surfaces the same secrets at the same moment for a seed', () => {
    const a = createDiscovery({ campsiteSeed: 'pine_hollow', secrets: SECRETS });
    const b = createDiscovery({ campsiteSeed: 'pine_hollow', secrets: SECRETS });
    const observation = createObservation({
      inspecting: 'ph_creek_tin',
      stillnessSeconds: 300,
      radio: { stationId: 'gap', dial: 104.1, band: 'fm', clarity: 0.7 },
    });
    const eventsA = run(a, observation, 900, 42);
    const eventsB = run(b, observation, 900, 42);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA).toEqual(eventsB);
  });

  it('gives each secret its own presentation stream, stable per campsite', () => {
    const a = createDiscovery({ campsiteSeed: 'pine_hollow', secrets: SECRETS });
    const b = createDiscovery({ campsiteSeed: 'pine_hollow', secrets: SECRETS });
    const c = createDiscovery({ campsiteSeed: 'mirror_flats', secrets: SECRETS });
    expect(secretStream(a, TIN.id).next()).toBe(secretStream(b, TIN.id).next());
    expect(secretStream(a, TIN.id).next()).not.toBe(secretStream(a, LANTERN.id).next());
    expect(secretStream(a, TIN.id).next()).not.toBe(secretStream(c, TIN.id).next());
  });
});

describe('significance', () => {
  it('emits evidence the memory model can weigh, and persists nothing itself', () => {
    const state = createDiscovery({ campsiteSeed: 1, secrets: [TIN] });
    const events = run(state, inspecting('ph_creek_tin'), 1200);
    const discovered = events.find((event) => event.kind === 'discovered');
    expect(discovered).toBeDefined();

    const evidence = discoveryEvidence(discovered as DiscoveryEvent, { photographed: true, dwellSeconds: 120 });
    expect(evidence.kind).toBe('discovery');
    // A secret that rarely surfaces is a rare thing to have seen.
    expect(evidence.rarity).toBeCloseTo(0.7, 6);
    expect(evidence.isFirst).toBe(true);
    const decision = decideTrace(evidence);
    expect(decision.disposition === 'passport' || decision.disposition === 'landmark').toBe(true);

    // Nothing left the module except decisions: the caller still owns storage.
    expect(Object.keys(state)).not.toContain('storage');
  });
});
