import { describe, expect, it } from 'vitest';
import {
  ambienceMasking,
  createWeather,
  DEFAULT_WEATHER_PROFILE,
  describeWeather,
  stepWeather,
  visibilityDistance,
  weatherFireEffect,
  type WeatherProfile,
  type WeatherState,
} from '../src/weather.js';
import {
  activeMeteorShower,
  CONSTELLATIONS,
  curatedSky,
  daysSinceJ2000,
  METEOR_SHOWERS,
  moonPhaseLabel,
  moonState,
  skyState,
  sunState,
} from '../src/astronomy.js';
import {
  activeTraces,
  createEvidence,
  createTrace,
  decideTrace,
  describeReturn,
  expiredTraces,
  tracePresence,
} from '../src/significance.js';
import { advance, createClock, MAX_CATCH_UP_SECONDS } from '../src/time.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

function runWeather(profile: WeatherProfile, seconds: number, seed = 1): WeatherState {
  const rng = new Rng(seed);
  const weather = createWeather(profile, rng);
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepWeather(weather, SIM_DT, rng);
  return weather;
}

describe('weather', () => {
  it('is deterministic', () => {
    const a = runWeather(DEFAULT_WEATHER_PROFILE, 300, 4);
    const b = runWeather(DEFAULT_WEATHER_PROFILE, 300, 4);
    expect(a.kind).toBe(b.kind);
    expect(a.windSpeed).toBe(b.windSpeed);
  });

  it('respects profile weights', () => {
    const foggy: WeatherProfile = { ...DEFAULT_WEATHER_PROFILE, weights: { fog: 1 } };
    expect(createWeather(foggy, new Rng(1)).kind).toBe('fog');
  });

  it('falls back to clear for an empty weight table', () => {
    const empty: WeatherProfile = { ...DEFAULT_WEATHER_PROFILE, weights: {} };
    expect(createWeather(empty, new Rng(1)).kind).toBe('clear');
  });

  it('evolves during a session', () => {
    const profile: WeatherProfile = {
      ...DEFAULT_WEATHER_PROFILE,
      transitionSeconds: 20,
      weights: { clear: 1, rain: 1, fog: 1 },
    };
    const rng = new Rng(3);
    const weather = createWeather(profile, rng);
    const start = weather.kind;
    let changed = false;
    for (let i = 0; i < Math.round(600 / SIM_DT); i++) {
      stepWeather(weather, SIM_DT, rng);
      if (weather.kind !== start) changed = true;
    }
    expect(changed).toBe(true);
  });

  it('transitions gradually rather than snapping', () => {
    const profile: WeatherProfile = { ...DEFAULT_WEATHER_PROFILE, transitionSeconds: 5, weights: { clear: 1, storm: 1 } };
    const rng = new Rng(9);
    const weather = createWeather(profile, rng);
    let maxJump = 0;
    let previous = weather.fog;
    for (let i = 0; i < Math.round(400 / SIM_DT); i++) {
      stepWeather(weather, SIM_DT, rng);
      maxJump = Math.max(maxJump, Math.abs(weather.fog - previous));
      previous = weather.fog;
    }
    expect(maxJump).toBeLessThan(0.02);
  });

  it('keeps every value in a sane range', () => {
    const rng = new Rng(11);
    const weather = createWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { storm: 1, snow: 1, fog: 1 }, transitionSeconds: 15 }, rng);
    for (let i = 0; i < Math.round(1200 / SIM_DT); i++) {
      stepWeather(weather, SIM_DT, rng);
      // Assert once a second rather than 72,000 times — the values are
      // continuous, so sampling catches any excursion.
      if (i % 60 !== 0) continue;
      for (const key of ['precipitation', 'fog', 'cloudCover', 'humidity'] as const) {
        expect(weather[key]).toBeGreaterThanOrEqual(0);
        expect(weather[key]).toBeLessThanOrEqual(1.001);
      }
      expect(weather.windSpeed).toBeGreaterThanOrEqual(0);
      expect(weather.windSpeed).toBeLessThan(30);
      expect(Number.isFinite(weather.temperatureC)).toBe(true);
    }
  });

  describe('effect on the world', () => {
    it('rain dampens fuel but never ends the session', () => {
      const wet = runWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { rain: 1 } }, 120);
      const effect = weatherFireEffect(wet);
      expect(effect.fuelMoisture).toBeGreaterThan(0.3);
      // Spec §4.1 — this is not a survival game.
      expect(effect.suppression).toBeLessThan(0.5);
    });

    it('fog shortens draw distance', () => {
      const foggy = runWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { fog: 1 } }, 200);
      const clear = runWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { clear: 1 } }, 200);
      expect(visibilityDistance(foggy, 60)).toBeLessThan(visibilityDistance(clear, 60));
      expect(visibilityDistance(foggy, 60)).toBeGreaterThan(0);
    });

    it('rain and wind mask the night ambience', () => {
      const stormy = runWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { storm: 1 } }, 200);
      const calm = runWeather({ ...DEFAULT_WEATHER_PROFILE, weights: { clear: 1 } }, 200);
      expect(ambienceMasking(stormy)).toBeGreaterThan(ambienceMasking(calm));
    });

    it('describes itself in plain words', () => {
      const weather = runWeather(DEFAULT_WEATHER_PROFILE, 60);
      expect(describeWeather(weather).length).toBeGreaterThan(0);
      weather.skyEvent = 'meteor-shower';
      expect(describeWeather(weather)).toContain('meteors');
    });
  });

  it('sky events are rare and only under clear sky', () => {
    const profile: WeatherProfile = {
      ...DEFAULT_WEATHER_PROFILE,
      weights: { overcast: 1 },
      skyEventChance: 1,
      skyEvents: ['meteor-shower'],
    };
    const weather = runWeather(profile, 1800, 2);
    expect(weather.skyEvent).toBe('none');
  });
});

describe('astronomy', () => {
  it('measures days from J2000 correctly', () => {
    expect(daysSinceJ2000(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)))).toBeCloseTo(0, 6);
    expect(daysSinceJ2000(new Date(Date.UTC(2000, 0, 2, 12, 0, 0)))).toBeCloseTo(1, 6);
  });

  it('cycles the moon through its phases over a synodic month', () => {
    const labels = new Set<string>();
    for (let day = 0; day < 30; day++) {
      const date = new Date(Date.UTC(2024, 5, 1 + day, 22, 0, 0));
      labels.add(moonState(date, 44, -73).label);
    }
    expect(labels.size).toBeGreaterThanOrEqual(6);
  });

  it('reports full moon illumination near the middle of the cycle', () => {
    expect(moonPhaseLabel(0.5)).toBe('Full moon');
    expect(moonPhaseLabel(0)).toBe('New moon');
    expect(moonPhaseLabel(1)).toBe('New moon');
  });

  it('keeps moon illumination in range', () => {
    for (let day = 0; day < 400; day += 3) {
      const m = moonState(new Date(Date.UTC(2024, 0, 1 + day, 22, 0, 0)), 44, -73);
      expect(m.illumination).toBeGreaterThanOrEqual(0);
      expect(m.illumination).toBeLessThanOrEqual(1);
      expect(Math.abs(m.altitude)).toBeLessThanOrEqual(Math.PI / 2 + 0.001);
    }
  });

  it('puts the sun below the horizon at local midnight in summer', () => {
    // 04:00 UTC is midnight at -60° longitude.
    const sun = sunState(new Date(Date.UTC(2024, 6, 15, 4, 0, 0)), 44, -60);
    expect(sun.altitude).toBeLessThan(0);
    expect(sun.daylight).toBe(0);
  });

  it('puts the sun above the horizon at local noon', () => {
    const sun = sunState(new Date(Date.UTC(2024, 6, 15, 16, 0, 0)), 44, -60);
    expect(sun.altitude).toBeGreaterThan(0);
    expect(sun.daylight).toBeGreaterThan(0.5);
  });

  it('finds the Perseids in mid-August', () => {
    const active = activeMeteorShower(new Date(Date.UTC(2024, 7, 12)));
    expect(active?.shower.id).toBe('perseids');
    expect(active?.strength).toBeGreaterThan(0.5);
  });

  it('finds no shower on a quiet date', () => {
    expect(activeMeteorShower(new Date(Date.UTC(2024, 2, 15)))).toBeNull();
  });

  it('every shower is findable at its own peak', () => {
    for (const shower of METEOR_SHOWERS) {
      const date = new Date(Date.UTC(2024, shower.peakMonth - 1, shower.peakDay));
      expect(activeMeteorShower(date), shower.id).not.toBeNull();
    }
  });

  it('hides stars under cloud and a bright moon', () => {
    const date = new Date(Date.UTC(2024, 6, 15, 4, 0, 0));
    const clear = skyState(date, 44, -60, 0);
    const cloudy = skyState(date, 44, -60, 1);
    expect(cloudy.starVisibility).toBeLessThan(clear.starVisibility);
    expect(cloudy.starVisibility).toBeGreaterThanOrEqual(0);
  });

  it('offers a good curated night when permission is declined', () => {
    // Spec §5.5: the fallback must be as good as the real thing.
    const sky = curatedSky();
    expect(sky.starVisibility).toBeGreaterThan(0.5);
    expect(sky.sun.daylight).toBe(0);
    expect(sky.ambientLight).toBeGreaterThan(0);
  });

  it('ships recognisable constellations with plausible data', () => {
    expect(CONSTELLATIONS.length).toBeGreaterThanOrEqual(5);
    for (const c of CONSTELLATIONS) {
      expect(c.stars.length).toBeGreaterThanOrEqual(4);
      expect(c.raHours).toBeGreaterThanOrEqual(0);
      expect(c.raHours).toBeLessThan(24);
      expect(Math.abs(c.decDeg)).toBeLessThanOrEqual(90);
    }
  });
});

describe('significance', () => {
  it('fades an ordinary trace', () => {
    expect(decideTrace(createEvidence('moved-object')).disposition).toBe('fade');
  });

  it('always keeps what the player explicitly preserved', () => {
    const decision = decideTrace(createEvidence('moved-object', { explicitlyPreserved: true }));
    expect(decision.disposition).toBe('landmark');
    expect(decision.lifetimeSeconds).toBe(Infinity);
  });

  it('weighs photographs, firsts, rarity and company', () => {
    const plain = decideTrace(createEvidence('wildlife-encounter'));
    const meaningful = decideTrace(
      createEvidence('wildlife-encounter', {
        rarity: 0.9,
        isFirst: true,
        photographed: true,
        social: true,
        dwellSeconds: 120,
        interactionCount: 6,
      }),
    );
    expect(meaningful.lifetimeSeconds).toBeGreaterThan(plain.lifetimeSeconds);
  });

  it('makes landmarks genuinely rare', () => {
    // Spec §6.3: a tiny number of especially meaningful moments.
    let landmarks = 0;
    const rng = new Rng(1);
    const kinds = ['moved-object', 'photo', 'discovery', 'note', 'machine-run', 'sandwich', 'wildlife-encounter'] as const;
    const total = 4000;
    for (let i = 0; i < total; i++) {
      const decision = decideTrace(
        createEvidence(kinds[rng.int(0, kinds.length - 1)]!, {
          rarity: rng.next(),
          isFirst: rng.chance(0.15),
          photographed: rng.chance(0.3),
          social: rng.chance(0.25),
          duringWorldEvent: rng.chance(0.1),
          interactionCount: rng.int(1, 10),
          dwellSeconds: rng.range(0, 120),
        }),
      );
      if (decision.disposition === 'landmark') landmarks++;
    }
    expect(landmarks / total).toBeLessThan(0.02);
  });

  it('never exposes a numeric score', () => {
    // Spec §6.4 — the model must be invisible.
    const decision = decideTrace(createEvidence('sandwich', { isFirst: true }));
    expect(Object.keys(decision).sort()).toEqual(['disposition', 'lifetimeSeconds']);
  });

  it('fades traces gently over their lifetime', () => {
    const now = 1_700_000_000_000;
    const trace = createTrace('t1', createEvidence('photo', { photographed: true }), now);
    expect(tracePresence(trace, now)).toBe(1);
    // Holds full strength early, then eases out.
    const quarter = now + trace.lifetimeSeconds * 1000 * 0.15;
    expect(tracePresence(trace, quarter)).toBe(1);
    const late = now + trace.lifetimeSeconds * 1000 * 0.9;
    expect(tracePresence(trace, late)).toBeLessThan(0.3);
    const past = now + trace.lifetimeSeconds * 1000 * 1.5;
    expect(tracePresence(trace, past)).toBe(0);
  });

  it('landmarks never fade', () => {
    const now = 0;
    const landmark = createTrace('l', createEvidence('note', { explicitlyPreserved: true }), now);
    expect(tracePresence(landmark, now + 1e12)).toBe(1);
  });

  it('lists active traces strongest first and expires the rest', () => {
    const now = 1_000_000_000;
    const fresh = createTrace('fresh', createEvidence('sandwich', { isFirst: true }), now);
    const old = createTrace('old', createEvidence('moved-object'), now - 10 * 86400 * 1000);
    const active = activeTraces([old, fresh], now);
    expect(active[0]?.id).toBe('fresh');
    expect(expiredTraces([old, fresh], now).map((t) => t.id)).toContain('old');
  });

  it('limits how many traces are returned', () => {
    const now = 0;
    const traces = Array.from({ length: 200 }, (_, i) =>
      createTrace(`t${i}`, createEvidence('photo', { photographed: true }), now),
    );
    expect(activeTraces(traces, now, 32)).toHaveLength(32);
  });

  it('welcomes a returning player without punishing them', () => {
    const now = 1_700_000_000_000;
    const traces = [createTrace('l', createEvidence('note', { explicitlyPreserved: true }), now - 1000)];
    const lines = describeReturn(96 * 3600, traces, now).map((o) => o.line).join(' ');
    expect(lines).toContain('fire has gone out');
    expect(lines).toContain('still here');
    // Spec §6.3: never punish absence.
    expect(lines).not.toMatch(/lost|failed|penalt|expired|forfeit|ruin/i);
  });

  it('says nothing dramatic after a short absence', () => {
    expect(describeReturn(60, [], Date.now())).toHaveLength(0);
  });
});

describe('fixed clock', () => {
  it('runs a whole number of steps and keeps the remainder', () => {
    const clock = createClock();
    const steps = advance(clock, SIM_DT * 2.5, () => {});
    expect(steps).toBe(2);
    expect(clock.accumulator).toBeCloseTo(SIM_DT * 0.5, 6);
    expect(clock.alpha).toBeCloseTo(0.5, 3);
  });

  it('accumulates fractional frames into steps', () => {
    const clock = createClock();
    let total = 0;
    for (let i = 0; i < 100; i++) total += advance(clock, 1 / 61, () => {});
    // 100 frames at slightly under the sim rate should be ~98 steps.
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThanOrEqual(100);
  });

  it('clamps a long stall instead of spiralling', () => {
    // A tab restored after a minute must resume, not freeze while it catches up.
    const clock = createClock();
    const steps = advance(clock, 60, () => {});
    expect(steps).toBeLessThanOrEqual(Math.ceil(MAX_CATCH_UP_SECONDS / SIM_DT));
  });

  it('ignores negative deltas', () => {
    const clock = createClock();
    expect(advance(clock, -5, () => {})).toBe(0);
  });

  it('tracks simulated time', () => {
    const clock = createClock();
    for (let i = 0; i < 60; i++) advance(clock, SIM_DT, () => {});
    expect(clock.simulatedTime).toBeCloseTo(1, 5);
    expect(clock.totalSteps).toBe(60);
  });
});
