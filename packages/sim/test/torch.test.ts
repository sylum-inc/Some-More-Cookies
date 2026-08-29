import { describe, expect, it } from 'vitest';
import {
  TORCH_BEAM,
  aimTorch,
  createTorch,
  describeTorch,
  focusTorch,
  illumination,
  stepTorch,
  stowTorch,
  switchTorch,
  takeTorch,
  torchCue,
  torchSteadiness,
  type TorchState,
} from '../src/torch.js';
import { assertNoScoring } from '../src/activity.js';
import { SIM_DT, vec3 } from '../src/types.js';

const AT_THE_FIRE = vec3(0, 1.5, 0);

/** Holds the beam perfectly still for a while. */
function hold(torch: TorchState, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepTorch(torch, SIM_DT);
}

/** Rakes the beam back and forth across the treeline. */
function sweep(torch: TorchState, seconds: number, radPerSecond = 2.5): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    aimTorch(torch, torch.yaw + radPerSecond * SIM_DT, torch.pitch);
    stepTorch(torch, SIM_DT);
  }
}

describe('picking it up', () => {
  it('does nothing at all until it has been picked up', () => {
    const torch = createTorch();
    expect(torch.held).toBe(false);
    expect(switchTorch(torch, true)).toBe(false);
    expect(torchCue(torch)).toBe(0);
    expect(illumination(torch, AT_THE_FIRE, vec3(2, 1, 0))).toBe(0);
  });

  it('comes on when it is picked up, because nobody picks up a dead torch', () => {
    const torch = createTorch();
    takeTorch(torch);
    expect(torch.held).toBe(true);
    expect(torch.on).toBe(true);
    stowTorch(torch);
    expect(torch.on).toBe(false);
  });
});

describe('the beam', () => {
  it('lights what it is pointed at and nothing else', () => {
    const torch = createTorch();
    takeTorch(torch);
    aimTorch(torch, 0, 0);
    // Straight ahead, well inside the cone.
    expect(illumination(torch, AT_THE_FIRE, vec3(4, 1.5, 0))).toBeGreaterThan(0.5);
    // Ninety degrees off it.
    expect(illumination(torch, AT_THE_FIRE, vec3(0, 1.5, 4))).toBe(0);
    // Directly behind.
    expect(illumination(torch, AT_THE_FIRE, vec3(-4, 1.5, 0))).toBe(0);
  });

  it('trades width for reach when the head is twisted', () => {
    const flood = createTorch();
    takeTorch(flood);
    focusTorch(flood, 0);
    const spot = createTorch();
    takeTorch(spot);
    focusTorch(spot, 1);

    expect(spot.rangeM).toBe(TORCH_BEAM.spotRangeM);
    expect(flood.rangeM).toBe(TORCH_BEAM.floodRangeM);

    // Out at the treeline only the focused beam reaches.
    const treeline = vec3(15, 1.5, 0);
    expect(illumination(flood, AT_THE_FIRE, treeline)).toBe(0);
    expect(illumination(spot, AT_THE_FIRE, treeline)).toBeGreaterThan(0.3);

    // Close in and off to one side, only the flood covers it.
    const beside = vec3(3, 1.5, 1.4);
    expect(illumination(flood, AT_THE_FIRE, beside)).toBeGreaterThan(0);
    expect(illumination(spot, AT_THE_FIRE, beside)).toBe(0);
  });

  it('has a soft edge rather than a hard circle', () => {
    const torch = createTorch();
    takeTorch(torch);
    focusTorch(torch, 0.5);
    aimTorch(torch, 0, 0);
    const centre = illumination(torch, AT_THE_FIRE, vec3(5, 1.5, 0));
    const edge = illumination(torch, AT_THE_FIRE, vec3(5, 1.5, 5 * Math.tan(torch.beamAngle * 0.85)));
    expect(centre).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
  });
});

describe('the trade', () => {
  it('is worse for the wildlife the more it is swept about', () => {
    // The whole mechanic: finding something with the torch and scaring it off
    // with the same torch.
    const still = createTorch();
    takeTorch(still);
    hold(still, 3);

    const swept = createTorch();
    takeTorch(swept);
    sweep(swept, 3);

    expect(torchCue(still)).toBeGreaterThan(0);
    expect(torchCue(swept)).toBeGreaterThan(torchCue(still) * 2);
    expect(torchCue(swept)).toBeGreaterThan(0.9);
  });

  it('produces no cue at all when it is off, however hard it is waved', () => {
    // The client used to derive this from walking speed, which meant walking
    // about with the torch switched off still emptied the treeline.
    const torch = createTorch();
    takeTorch(torch);
    switchTorch(torch, false);
    sweep(torch, 3);
    expect(torchCue(torch)).toBe(0);
  });

  it('rewards holding it steady, which is what the rest of the world rewards', () => {
    const torch = createTorch();
    takeTorch(torch);
    hold(torch, 4);
    expect(torchSteadiness(torch)).toBeGreaterThan(0.9);

    // One flick across and the steadiness is gone.
    aimTorch(torch, torch.yaw + 0.6, torch.pitch);
    stepTorch(torch, SIM_DT);
    expect(torchSteadiness(torch)).toBe(0);
  });

  it('does not relax the instant the beam stops moving', () => {
    // An animal that has just been swept over stays alarmed for a moment.
    const torch = createTorch();
    takeTorch(torch);
    sweep(torch, 2);
    const duringSweep = torchCue(torch);
    hold(torch, 0.25);
    const justAfter = torchCue(torch);
    expect(justAfter).toBeLessThan(duringSweep);
    expect(justAfter).toBeGreaterThan(0.5);
    hold(torch, 4);
    expect(torchCue(torch)).toBeLessThan(0.35);
  });
});

describe('determinism and honesty', () => {
  it('measures the sweep from the aim it was given rather than trusting one', () => {
    // The rate is derived, so a caller cannot assert a light sweep it is not
    // producing, and cannot hide one it is.
    const torch = createTorch();
    takeTorch(torch);
    aimTorch(torch, 1.4, 0.1);
    stepTorch(torch, SIM_DT);
    expect(torch.slewRate).toBeGreaterThan(50);
    hold(torch, 1);
    expect(torch.slewRate).toBe(0);
  });

  it('replays identically from the same aim timeline', () => {
    const run = (): TorchState => {
      const torch = createTorch();
      takeTorch(torch);
      for (let i = 0; i < 600; i++) {
        aimTorch(torch, Math.sin(i * 0.031) * 1.2, Math.cos(i * 0.017) * 0.3);
        stepTorch(torch, SIM_DT);
      }
      return torch;
    };
    expect(run()).toEqual(run());
  });

  it('cannot run out: there is no battery and nowhere to put one', () => {
    const torch = createTorch();
    takeTorch(torch);
    // Two hours of continuous use.
    hold(torch, 7200);
    expect(torch.on).toBe(true);
    expect(illumination(torch, AT_THE_FIRE, vec3(3, 1.5, 0))).toBeGreaterThan(0);
    assertNoScoring('torch', {
      held: torch.held,
      on: torch.on,
      focus: torch.focus,
      sweep: torch.sweep,
      steadySeconds: torch.steadySeconds,
    });
    expect(Object.keys(torch)).not.toContain('battery');
    expect(Object.keys(torch)).not.toContain('charge');
  });

  it('says out loud what it is doing, for the subtitle layer', () => {
    const torch = createTorch();
    expect(describeTorch(torch)).toBe('');
    takeTorch(torch);
    focusTorch(torch, 1);
    expect(describeTorch(torch)).toContain('narrow');
    switchTorch(torch, false);
    expect(describeTorch(torch)).toContain('off');
  });
});
