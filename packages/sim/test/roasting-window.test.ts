/**
 * Is there a golden window?
 *
 * `roasting.test.ts` proves the thermal model is right. This file asks the
 * product question behind it: over each of the two fires a player will
 * actually meet, is there a stretch of time where the marshmallow is *toasted
 * golden* — not pale, not blackening — and is it wide enough to hit with a
 * thumb on a phone?
 *
 * It exists because the answer was once no. Both the browning and the charring
 * sigmoids saturate over a hot fire, and charring had the higher rate, so char
 * outpaced brown at every step: over open flame a marshmallow went from pale
 * straight to blackening **without ever passing through golden**. The single
 * outcome the whole product is named after was unreachable on the first fire a
 * player meets, and every unit test passed, because nothing was broken — the
 * two reactions were simply in the wrong order.
 */

import { describe, expect, it } from 'vitest';
import { beginRoasting, createRitual, moveMarshmallow, stepRitual } from '../src/ritual.js';
import { summariseRoast, type RoastSummary } from '../src/roasting.js';
import { isEmberBed } from '../src/fire.js';
import { SIM_DT, vec3 } from '../src/types.js';

/** Holds the marshmallow at one distance, turning steadily, and samples it. */
function roastCurve(options: { radius: number; coals: boolean; seconds: number }): RoastSummary[] {
  const ritual = createRitual({ campsiteSeed: 'golden-window', environmentId: 'pine_hollow' });
  if (options.coals) {
    for (let i = 0; i < 60 * 200; i += 1) {
      stepRitual(ritual, SIM_DT);
      if (isEmberBed(ritual.fire)) break;
    }
  } else {
    for (let i = 0; i < 60 * 3; i += 1) stepRitual(ritual, SIM_DT);
  }
  beginRoasting(ritual);

  const samples: RoastSummary[] = [];
  let rotation = 0;
  const steps = Math.round(options.seconds / SIM_DT);
  for (let i = 0; i < steps; i += 1) {
    rotation += 1.2 * SIM_DT;
    moveMarshmallow(ritual, vec3(options.radius, 0.1, 0), rotation);
    stepRitual(ritual, SIM_DT);
    // One sample a second is plenty and keeps this test quick.
    if (i % 60 === 0) samples.push(summariseRoast(ritual.marshmallow));
    if (ritual.marshmallow.fallen) break;
  }
  return samples;
}

/** Seconds during which the marshmallow is genuinely toasted, not burnt. */
function goldenSeconds(samples: readonly RoastSummary[]): number {
  return samples.filter((s) => s.brown >= 0.3 && s.brown <= 0.8 && s.char <= 0.15).length;
}

describe('browning always leads charring', () => {
  it.each([
    ['flame, in close', { radius: 0.14, coals: false, seconds: 80 }],
    ['flame, at the edge', { radius: 0.24, coals: false, seconds: 80 }],
    ['coals, in close', { radius: 0.2, coals: true, seconds: 90 }],
    ['coals, at the edge', { radius: 0.26, coals: true, seconds: 90 }],
  ] as const)('%s never chars ahead of browning', (_name, options) => {
    for (const sample of roastCurve(options)) {
      // Sugar caramelises and then carbonises through the caramel. The reverse
      // ordering is what removed the golden window.
      expect(sample.char).toBeLessThanOrEqual(sample.brown + 1e-9);
    }
  });
});

describe('both fires have a golden window a person could hit', () => {
  it('open flame gives a window, and it is a hurried one', () => {
    const samples = roastCurve({ radius: 0.14, coals: false, seconds: 80 });
    const window = goldenSeconds(samples);
    expect(window).toBeGreaterThanOrEqual(8);
    // Flames are the impatient fire: the window exists but it closes.
    expect(window).toBeLessThan(40);
  });

  it('coals give a far wider one — which is the whole reason to tend the fire', () => {
    const flame = goldenSeconds(roastCurve({ radius: 0.14, coals: false, seconds: 80 }));
    const coals = goldenSeconds(roastCurve({ radius: 0.26, coals: true, seconds: 90 }));
    expect(coals).toBeGreaterThan(flame * 1.5);
  });

  it('rewards patience over coals rather than punishing it', () => {
    // Ninety seconds at the edge of a good ember bed should be a fine
    // marshmallow, not a cinder. Deviation D4 is the claim; this is the check.
    const samples = roastCurve({ radius: 0.26, coals: true, seconds: 90 });
    const final = samples[samples.length - 1];
    expect(final).toBeDefined();
    expect(final?.brown ?? 0).toBeGreaterThan(0.5);
    expect(final?.char ?? 1).toBeLessThan(0.1);
  });
});

describe('catching fire is a story, not the median outcome', () => {
  it('takes real neglect over flame', () => {
    const ritual = createRitual({ campsiteSeed: 'ignition', environmentId: 'pine_hollow' });
    for (let i = 0; i < 60 * 3; i += 1) stepRitual(ritual, SIM_DT);
    beginRoasting(ritual);
    let rotation = 0;
    let ignitedAt = -1;
    for (let i = 0; i < 60 * 120; i += 1) {
      rotation += 1.2 * SIM_DT;
      moveMarshmallow(ritual, vec3(0.14, 0.1, 0), rotation);
      stepRitual(ritual, SIM_DT);
      if (ritual.marshmallow.burning && ignitedAt < 0) ignitedAt = i * SIM_DT;
      if (ritual.marshmallow.fallen) break;
    }
    expect(ignitedAt).toBeGreaterThan(45);
  });

  it('does not happen at all over coals at a sensible distance', () => {
    const samples = roastCurve({ radius: 0.26, coals: true, seconds: 90 });
    const final = samples[samples.length - 1];
    expect(final?.ignitionCount ?? 1).toBe(0);
  });
});

describe('turning it is what makes it even', () => {
  const sidedness = (spin: number): number => {
    const ritual = createRitual({ campsiteSeed: 'turning', environmentId: 'pine_hollow' });
    for (let i = 0; i < 60 * 200; i += 1) {
      stepRitual(ritual, SIM_DT);
      if (isEmberBed(ritual.fire)) break;
    }
    beginRoasting(ritual);
    let rotation = 0;
    for (let i = 0; i < 60 * 60; i += 1) {
      rotation += spin * SIM_DT;
      moveMarshmallow(ritual, vec3(0.24, 0.1, 0), rotation);
      stepRitual(ritual, SIM_DT);
    }
    return summariseRoast(ritual.marshmallow).sidedness;
  };

  it('leaves a still marshmallow visibly one-sided', () => {
    expect(sidedness(0)).toBeGreaterThan(0.8);
  });

  it('forgives a slow, uneven turn', () => {
    // The control does not demand a metronome: a lazy quarter-turn a second is
    // already enough. Demanding more would be a dexterity tax (§12).
    expect(sidedness(0.4)).toBeLessThan(0.2);
  });
});
