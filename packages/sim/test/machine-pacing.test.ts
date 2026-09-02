/**
 * How the SM-01 run *feels*, measured.
 *
 * `machine.test.ts` proves the state machine is correct. This file is about a
 * different question, and the riskiest one in the product after roasting: does
 * a fifty-second wait read as a ritual or as a loading bar (§3.4, risk R2)?
 *
 * That is a question about rhythm, and rhythm is measurable even though
 * "satisfying" is not. Two things were wrong when it was first measured, and
 * neither could fail a test, because nothing was broken — the machine simply
 * had nothing to say:
 *
 *  - **An 11.9-second silence** in a standard run, from the fan ramping at 2.1s
 *    to the changeover at 14s. A quarter of the run, sitting exactly where
 *    anticipation is highest: right after the lever comes down.
 *  - **129 frost crackles**, metronomically even at four a second for the
 *    entire back half. A texture that regular stops being a machine and
 *    becomes a loop.
 *
 * These tests assert the shape rather than the numbers, so the model can be
 * retuned without rewriting them — but they will fail if either failure mode
 * comes back.
 */

import { describe, expect, it } from 'vitest';
import {
  PROGRAMS,
  createMachine,
  performAction,
  stepMachine,
  type MachineEvent,
  type MachineProgram,
  type MachineState,
} from '../src/machine.js';
import { SIM_DT } from '../src/types.js';

interface Beat {
  at: number;
  event: MachineEvent;
}

/** Runs one complete program and returns every beat, with its timestamp. */
function runProgram(program: MachineProgram, campsiteSeed: string | number = 'pacing'): Beat[] {
  const machine = createMachine(campsiteSeed, 'pine_hollow');
  // An idle SM-01 sits with its door open. Wait for it rather than opening it:
  // `open-door` is the post-run control and means something different.
  for (let i = 0; i < 1800 && machine.door <= 0.65; i += 1) stepMachine(machine, SIM_DT);

  const must = (accepted: boolean, what: string): void => {
    if (!accepted) throw new Error(`${what} was refused at stage ${machine.stage}`);
  };
  must(performAction(machine, { type: 'load' }), 'load');
  must(performAction(machine, { type: 'close-door' }), 'close-door');
  for (let i = 0; i < 900 && machine.stage !== 'door-closed'; i += 1) stepMachine(machine, SIM_DT);
  must(performAction(machine, { type: 'engage-latch' }), 'engage-latch');
  must(performAction(machine, { type: 'set-program', program }), 'set-program');
  must(performAction(machine, { type: 'confirm' }), 'confirm');
  must(performAction(machine, { type: 'pull-lever' }), 'pull-lever');

  const beats: Beat[] = [];
  let at = 0;
  for (let i = 0; i < 60 * 200; i += 1) {
    stepMachine(machine, SIM_DT);
    at += SIM_DT;
    for (const event of machine.events) beats.push({ at, event });
    if (machine.stage === 'complete') break;
  }
  return beats;
}

function runSeconds(program: MachineProgram): number {
  const p = PROGRAMS[program];
  return p.processSeconds + p.freezeSeconds + p.transformSeconds;
}

/** The longest stretch with no beat at all, including the tail. */
function longestSilence(beats: readonly Beat[], total: number): { seconds: number; at: number } {
  let worst = 0;
  let worstAt = 0;
  let previous = 0;
  for (const beat of beats) {
    if (beat.at - previous > worst) {
      worst = beat.at - previous;
      worstAt = previous;
    }
    previous = beat.at;
  }
  if (total - previous > worst) {
    worst = total - previous;
    worstAt = previous;
  }
  return { seconds: worst, at: worstAt };
}

const ALL_PROGRAMS: MachineProgram[] = ['soft-set', 'standard', 'deep-freeze'];

describe('the run never goes quiet for long', () => {
  it.each(ALL_PROGRAMS)('%s keeps talking throughout', (program) => {
    const beats = runProgram(program);
    const silence = longestSilence(beats, runSeconds(program));
    // Six seconds is the outer limit of "the machine is holding" before it
    // becomes "is this thing still on?". The compressor drone runs underneath
    // all of this, so these are one-shots on top of a continuous bed.
    expect(silence.seconds).toBeLessThan(6);
  });

  it('says something during the pull-down, which used to be a dead stretch', () => {
    // The amber phase: the machine dragging a hot s'more down to freezing. It
    // is the hardest work the machine does and it used to be silent for it.
    const beats = runProgram('standard');
    const amber = beats.filter((b) => b.at <= PROGRAMS.standard.processSeconds);
    expect(amber.length).toBeGreaterThanOrEqual(8);

    const silence = longestSilence(amber, PROGRAMS.standard.processSeconds);
    expect(silence.seconds).toBeLessThan(3.5);
  });

  it('scales its beats with the program rather than bunching at the front', () => {
    // A long program must not be a short program's opening followed by a wait.
    for (const program of ALL_PROGRAMS) {
      const process = PROGRAMS[program].processSeconds;
      const beats = runProgram(program).filter((b) => b.at <= process);
      const late = beats.filter((b) => b.at > process * 0.5);
      expect(late.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('frost ticks like frost, not like a metronome', () => {
  const crackleGaps = (program: MachineProgram, seed: string | number = 'pacing'): number[] => {
    const crackles = runProgram(program, seed).filter((b) => b.event === 'frost-crackle');
    const gaps: number[] = [];
    for (let i = 1; i < crackles.length; i += 1) {
      gaps.push((crackles[i] as Beat).at - (crackles[i - 1] as Beat).at);
    }
    return gaps;
  };

  it('is not a wall of noise', () => {
    // 129 in a standard run was not a rhythm, it was wallpaper.
    for (const program of ALL_PROGRAMS) {
      const count = crackleGaps(program).length + 1;
      expect(count).toBeGreaterThan(20);
      expect(count).toBeLessThan(100);
    }
  });

  it('clusters, the way frost nucleating on a surface does', () => {
    const gaps = crackleGaps('standard');
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    const spread = Math.sqrt(variance) / mean;
    // A metronome has a spread of zero. Bursts separated by quiet have a
    // spread comfortably above one.
    expect(spread).toBeGreaterThan(0.9);
  });

  it('is busiest while the frost is actually forming, and settles after', () => {
    const crackles = runProgram('standard').filter((b) => b.event === 'frost-crackle');
    const start = PROGRAMS.standard.processSeconds;
    const total = runSeconds('standard');
    const midpoint = start + (total - start) / 2;
    const early = crackles.filter((b) => b.at < midpoint).length;
    const late = crackles.filter((b) => b.at >= midpoint).length;
    // The old model did the opposite: it accelerated into the back half.
    expect(early).toBeGreaterThan(late);
  });

  it('is this unit’s frost — two campsites do not tick alike', () => {
    const a = crackleGaps('standard', 'campsite-a');
    const b = crackleGaps('standard', 'campsite-b');
    expect(a).not.toEqual(b);
  });

  it('is the same every time for the same unit', () => {
    expect(crackleGaps('standard', 'campsite-a')).toEqual(crackleGaps('standard', 'campsite-a'));
  });
});

describe('the machine cannot be wedged by looking inside it', () => {
  /**
   * Opening the empty SM-01 to see what is in there is an entirely reasonable
   * thing to do with the machine at the centre of the whole product, and §3.5
   * invites it — the machine is explicitly *not* a mystery. Closing it again
   * used to leave it in `door-closed`, where the only legal action was the
   * latch, the latch led to a lever that refuses to run empty, and nothing in
   * the product ever calls `reset`. The machine was dead for the session.
   */
  it('returns to idle when an empty machine is shut', () => {
    const machine: MachineState = createMachine('curious', 'pine_hollow');
    const settle = (seconds: number): void => {
      for (let i = 0; i < 60 * seconds; i += 1) stepMachine(machine, SIM_DT);
    };
    settle(20);
    expect(machine.door).toBeGreaterThan(0.65);

    performAction(machine, { type: 'open-door' });
    settle(20);
    performAction(machine, { type: 'close-door' });
    settle(20);

    expect(machine.stage).toBe('idle');
    // And the door eases open again, so it is ready to be used.
    expect(machine.door).toBeGreaterThan(0.65);
    expect(performAction(machine, { type: 'load' })).toBe(true);
  });

  it('still waits for the latch when there is something inside', () => {
    const machine = createMachine('loaded', 'pine_hollow');
    for (let i = 0; i < 1800 && machine.door <= 0.65; i += 1) stepMachine(machine, SIM_DT);
    performAction(machine, { type: 'load' });
    performAction(machine, { type: 'close-door' });
    for (let i = 0; i < 900 && machine.stage !== 'door-closed'; i += 1) stepMachine(machine, SIM_DT);
    expect(machine.stage).toBe('door-closed');
  });
});
