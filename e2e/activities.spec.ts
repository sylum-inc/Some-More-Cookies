import { expect, test } from '@playwright/test';
import { act, advanceSeconds, capture } from './helpers.js';

/**
 * The things there are to do at a campsite besides make a s'more (spec §5.2).
 *
 * This drives the real simulation through the real client, the same way
 * `ritual.spec.ts` does, and screenshots every activity so somebody can look at
 * it. That last part is the point: the repo's own bar is "do not declare a
 * feature complete because it compiles", and the defects this project has
 * actually shipped — an unlit sandwich, a whiteout reveal — were all invisible
 * to a green suite and obvious in a picture.
 *
 * `advanceSeconds` is used wherever the model has to get somewhere: the fixed
 * timestep deliberately lets simulated time fall behind wall-clock under a
 * software renderer, so waiting in real time measures SwiftShader rather than
 * the world. It runs the real `stepRitual` at the real timestep.
 */

/** Loonwater: a lake you can skip a stone on and fish in. */
const LAKE = '/?camp=camp-activities&env=loonwater_narrows';
/** Lantern Mesa: no water at all, which has to be an ordinary campsite. */
const DRY = '/?camp=camp-dry&env=lantern_mesa';

/** Reads the parts of the world these activities live in. */
function readActivities(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const r = window.__someMore!.store.state.ritual as unknown as {
      water: { chop: number; glass: number; spec: { label: string }; ripples: unknown[] } | null;
      skipping: { phase: string; skips: number; held: unknown; distanceM: number };
      torch: { held: boolean; on: boolean; sweep: number; rangeM: number; focus: number };
      fishing: { phase: string; soakSeconds: number; casts: number };
      stargazing: { posture: string; binoculars: boolean; recognised: string[]; meteors: unknown[] };
      seat: { seated: boolean; settled: number };
      wildlife: { stillnessSeconds: number; calm: number; cues: Record<string, number> };
      traces: { id: string; disposition: string }[];
    };
    return {
      hasWater: r.water !== null,
      chop: r.water ? Number(r.water.chop.toFixed(3)) : null,
      skipPhase: r.skipping.phase,
      skips: r.skipping.skips,
      holdingStone: r.skipping.held !== null,
      torch: { ...r.torch, sweep: Number(r.torch.sweep.toFixed(3)) },
      fishing: r.fishing.phase,
      casts: r.fishing.casts,
      reclined: r.stargazing.posture === 'reclined',
      binoculars: r.stargazing.binoculars,
      recognised: r.stargazing.recognised.length,
      meteors: r.stargazing.meteors.length,
      seated: r.seat.seated,
      settled: Number(r.seat.settled.toFixed(3)),
      stillness: Number(r.wildlife.stillnessSeconds.toFixed(1)),
      flashlightCue: Number((r.wildlife.cues['flashlight'] ?? 0).toFixed(3)),
      skipTraces: r.traces.filter((t) => t.id.startsWith('skip:')).length,
    };
  });
}

/** Stands the player somewhere and points them at the water. */
async function standAtTheWater(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const handle = window.__someMore!;
    const player = handle.player!;
    const water = (handle.store.state.ritual as unknown as {
      water: { shore: { bearing: number; distanceM: number } };
    }).water;
    const bearing = water.shore.bearing;
    player.position.x = Math.cos(bearing) * (water.shore.distanceM - 0.9);
    player.position.z = Math.sin(bearing) * (water.shore.distanceM - 0.9);
    player.facing = bearing;
    player.pitch = -0.12;
    player.moveTarget = null;
  });
  await page.waitForTimeout(400);
}

test.describe('the torch', () => {
  test('is picked up off the log, lights what it is aimed at, and is what the wildlife feel', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(1200);

    // Nothing until it is picked up. A torch on a log is a torch on a log.
    let world = await readActivities(page);
    expect(world.torch.held).toBe(false);
    expect(world.flashlightCue).toBe(0);
    await capture(page, 'act-01-before-torch');

    // Walk up to it and reach for it — the diegetic route, not a menu.
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      // Standing over the log and looking down at it, which is what somebody
      // reaching for a torch is actually doing.
      player.position.x = -1.2;
      player.position.z = 0.5;
      player.facing = Math.PI / 2;
      player.pitch = -0.8;
      player.moveTarget = null;
    });
    await page.waitForTimeout(700);
    await expect(page.getByRole('button', { name: 'Take the torch' })).toBeVisible();
    await capture(page, 'act-02-torch-in-reach');
    await page.getByRole('button', { name: 'Take the torch' }).click();
    await page.waitForTimeout(600);

    world = await readActivities(page);
    expect(world.torch.held).toBe(true);
    expect(world.torch.on).toBe(true);

    // Point it out at the trees and let a frame or two render.
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      player.facing = 2.4;
      player.pitch = -0.05;
    });
    await advanceSeconds(page, 1);
    await page.waitForTimeout(600);
    await capture(page, 'act-03-torch-beam');

    // A lit torch is always something the animals notice.
    world = await readActivities(page);
    expect(world.flashlightCue).toBeGreaterThan(0);
    const heldStill = world.flashlightCue;

    /*
     * Rake it across the treeline: the same torch, far more intrusive. This is
     * the trade — finding something with it and scaring it off with it.
     *
     * Driven over *real frames* rather than through `advanceSeconds`. The
     * fast-forward hook runs `stepRitual` directly, so it deliberately skips
     * the per-frame client writes — where the player is looking, and therefore
     * where the beam is pointing. Fast-forwarding a sweep would measure a
     * torch nobody was moving. The turn rate is taken from the real clock so
     * the software renderer's frame rate cannot change the answer.
     */
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const player = window.__someMore!.player!;
          const started = performance.now();
          let last = started;
          const tick = (): void => {
            const now = performance.now();
            player.facing += 2.6 * ((now - last) / 1000);
            last = now;
            if (now - started > 900) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const swept = await readActivities(page);
    expect(swept.flashlightCue).toBeGreaterThan(heldStill);
    expect(swept.torch.sweep).toBeGreaterThan(0.5);
    await capture(page, 'act-04-torch-swept');

    // Focusing it trades width for reach.
    await act(page, 'focusTorch', 1);
    await page.waitForTimeout(300);
    expect((await readActivities(page)).torch.rangeM).toBeGreaterThan(15);
    await capture(page, 'act-05-torch-focused');

    // And switching it off ends it, however much anyone waves it about.
    await act(page, 'toggleTorch', false);
    await advanceSeconds(page, 2);
    expect((await readActivities(page)).flashlightCue).toBe(0);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('has a keyboard path, like everything else', async ({ page }) => {
    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(900);

    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    expect((await readActivities(page)).torch.held).toBe(true);

    await page.keyboard.press('g');
    await page.waitForTimeout(300);
    expect((await readActivities(page)).torch.focus).toBeGreaterThan(0.5);

    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    expect((await readActivities(page)).torch.on).toBe(false);
  });
});

test.describe('skipping stones', () => {
  test('is reached by walking to the water, and the throw is a real throw', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(1200);

    expect((await readActivities(page)).hasWater).toBe(true);

    await standAtTheWater(page);
    await capture(page, 'act-06-at-the-water');

    // The world offers the stones because you are standing on them.
    await expect(page.getByRole('button', { name: /Pick up a stone|The water/ })).toBeVisible();
    await page.getByRole('button', { name: /Pick up a stone/ }).click();
    await page.waitForTimeout(400);
    expect((await readActivities(page)).holdingStone).toBe(true);
    // The interface says how it is sitting in your hand, in words.
    await expect(page.getByText(/wound|edge-on|face/i).first()).toBeVisible();
    await capture(page, 'act-07-stone-in-hand');

    // Throw it flat and hard with a good wrist. The skips are not rolled:
    // they come out of the angle, the speed and the state of the water.
    await act(page, 'skipStone', 0.92, 0.06, 0.32, 0.9);
    await page.waitForTimeout(150);
    expect((await readActivities(page)).skipPhase).toBe('flying');
    await capture(page, 'act-08-stone-in-flight');

    await advanceSeconds(page, 6);
    const thrown = await readActivities(page);
    expect(['sunk', 'shore']).toContain(thrown.skipPhase);
    expect(thrown.skips).toBeGreaterThan(2);
    await capture(page, 'act-09-after-the-throw');

    // A good throw is a thing the world remembers, through the significance
    // model — never as a score, only as a trace with a disposition.
    expect(thrown.skipTraces).toBeGreaterThan(0);

    // A stone cocked back like a spade goes straight in, and that is fine.
    await act(page, 'takeStone');
    await act(page, 'skipStone', 0.92, 0.06, 1, 0.9);
    await advanceSeconds(page, 6);
    const ploughed = await readActivities(page);
    expect(ploughed.skips).toBe(0);
    expect(ploughed.skipPhase).toBe('sunk');

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('offers nothing to throw at a campsite with no water', async ({ page }) => {
    await page.goto(DRY);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(1000);

    const world = await readActivities(page);
    expect(world.hasWater).toBe(false);
    expect(world.holdingStone).toBe(false);
    // And the campsite is otherwise entirely ordinary.
    await capture(page, 'act-10-dry-campsite');
    await expect(page.getByRole('button', { name: /Pick up a stone/ })).toHaveCount(0);
  });
});

test.describe('sitting, stargazing and the rod', () => {
  test('sitting banks stillness far faster than standing about', async ({ page }) => {
    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(900);

    await advanceSeconds(page, 60);
    const standing = await readActivities(page);

    await act(page, 'sit');
    await advanceSeconds(page, 60);
    const seated = await readActivities(page);

    expect(seated.seated).toBe(true);
    expect(seated.settled).toBeGreaterThan(0.85);
    // Two minutes of standing still versus one of standing and one of sitting.
    expect(seated.stillness - standing.stillness).toBeGreaterThan(standing.stillness);
    await capture(page, 'act-11-sitting');
  });

  test('the sky is up there, and a constellation can be picked out of it', async ({ page }) => {
    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(900);

    // Lie back and look at whatever is actually clearest tonight. Nothing in
    // the world says where it is — the sky turns, so a fixed bearing would be
    // a coin flip, and the test has to find it the way a player would.
    await act(page, 'lieBack', true);
    const target = (await act(page, 'skyTargets')) as {
      id: string;
      label: string;
      azimuth: number;
      altitude: number;
      clarity: number;
      up: boolean;
      known: boolean;
    }[];
    const clearest = target
      .filter((candidate) => candidate.up)
      .sort((a, b) => b.clarity - a.clarity || b.altitude - a.altitude)[0];
    expect(clearest, 'something should be above the horizon').toBeDefined();
    // It is not named until it has been held in view.
    expect(clearest!.known).toBe(false);

    /*
     * `lookAtSky` turns the head, and the head is what the model reads: the
     * frame loop derives the aim from the player's facing and pitch on every
     * step, so an aim written past the body lasted exactly one frame, and
     * whether anything was recognised depended on where the body happened to
     * be looking and on what the real clock said. The hold runs on the
     * model's own clock rather than the renderer's.
     */
    const readGaze = () =>
      page.evaluate(() => {
        const sky = (window.__someMore!.store.state.ritual as unknown as {
          stargazing: {
            azimuth: number;
            altitude: number;
            holdingId: string | null;
            holdSeconds: number;
            steadiness: number;
          };
        }).stargazing;
        return {
          azimuth: Number(sky.azimuth.toFixed(3)),
          altitude: Number(sky.altitude.toFixed(3)),
          holding: sky.holdingId,
          heldSeconds: Number(sky.holdSeconds.toFixed(2)),
          steadiness: Number(sky.steadiness.toFixed(2)),
        };
      });
    const aimed = `${clearest!.id} (azimuth ${clearest!.azimuth.toFixed(3)}, altitude ${clearest!.altitude.toFixed(3)}, clarity ${clearest!.clarity.toFixed(2)})`;

    await act(page, 'lookAtSky', clearest!.azimuth, clearest!.altitude);
    // Let frames run before the hold, deliberately. A frame later the model
    // must still be looking where the head is — the assertion the old test
    // could not make, because it aimed the model and hoped no frame ran.
    await page.waitForTimeout(500);
    const aim = await readGaze();
    const gap = Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          Math.sin(aim.altitude) * Math.sin(clearest!.altitude) +
            Math.cos(aim.altitude) * Math.cos(clearest!.altitude) * Math.cos(aim.azimuth - clearest!.azimuth),
        ),
      ),
    );
    expect(gap, `a frame after looking at ${aimed} the model was aimed at ${JSON.stringify(aim)}`).toBeLessThan(0.15);

    await advanceSeconds(page, 10);
    await page.waitForTimeout(600);
    await capture(page, 'act-12-lying-back');

    const found = await readActivities(page);
    expect(found.reclined).toBe(true);
    expect(
      found.recognised,
      `nothing was recognised. Aimed at ${aimed}; the model saw ${JSON.stringify(await readGaze())}`,
    ).toBeGreaterThan(0);

    // Binoculars narrow the field and are drawn as a real optical frame.
    await act(page, 'binoculars', true);
    await page.waitForTimeout(500);
    expect((await readActivities(page)).binoculars).toBe(true);
    await expect(page.getByTestId('binoculars')).toBeVisible();
    await capture(page, 'act-13-binoculars');
  });

  test('the rod goes in the water and mostly nothing happens, which is the point', async ({ page }) => {
    await page.goto(LAKE);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(900);
    await standAtTheWater(page);

    await act(page, 'takeRod');
    await act(page, 'cast', 0.7);
    await advanceSeconds(page, 30);
    await page.waitForTimeout(500);

    const world = await readActivities(page);
    expect(world.casts).toBe(1);
    // Thirty seconds in, the overwhelmingly likely state is still "soaking".
    expect(['soaking', 'nibble', 'playing']).toContain(world.fishing);
    await capture(page, 'act-14-fishing');
  });
});
