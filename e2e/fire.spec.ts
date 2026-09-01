/**
 * The fire, as a thing you do with your hands.
 *
 * Everything here goes through real pointer input on the canvas. The point of
 * these tests is precisely the part the action bridge cannot see: whether the
 * wood in the pit can actually be picked up and put somewhere else by a person
 * with one finger, and whether doing that changes the fire.
 */
import { expect, test } from '@playwright/test';
import { act, capture } from './helpers.js';

interface FireReadout {
  logs: { id: string; grade: string; x: number; z: number; lean: number; moisture: number; steam: number; airflow: number }[];
  ashCover: number;
  draught: number;
  oxygen: number;
  flame: number;
  flameHeight: number;
  emberMass: number;
  emberTemp: number;
  arrangement: string;
}

async function readFire(page: import('@playwright/test').Page): Promise<FireReadout> {
  return page.evaluate(() => {
    const fire = (window.__someMore!.store.state.ritual as unknown as { fire: Record<string, never> })
      .fire as unknown as {
      logs: { id: string; grade: string; spot: { x: number; z: number; lean: number }; moisture: number; steam: number; airflow: number }[];
      ashCover: number;
      draught: number;
      oxygen: number;
      flame: number;
      flameHeight: number;
      emberMass: number;
      emberTemp: number;
    };
    const arrangement = (window.__someMore!.actions['arrangement'] as () => string)();
    return {
      logs: fire.logs.map((l) => ({
        id: l.id,
        grade: l.grade,
        x: l.spot.x,
        z: l.spot.z,
        lean: l.spot.lean,
        moisture: l.moisture,
        steam: l.steam,
        airflow: l.airflow,
      })),
      ashCover: fire.ashCover,
      draught: fire.draught,
      oxygen: fire.oxygen,
      flame: fire.flame,
      flameHeight: fire.flameHeight,
      emberMass: fire.emberMass,
      emberTemp: fire.emberTemp,
      arrangement,
    };
  });
}

/** Where a point in the pit lands on screen, so a test can aim at it. */
async function screenPoint(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
  z: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([px, py, pz]) => {
      const three = window.__someMore!.three as unknown as {
        camera: { projectionMatrix: unknown; matrixWorldInverse: unknown };
      };
      const camera = three.camera as unknown as {
        updateMatrixWorld: () => void;
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      camera.updateMatrixWorld();
      // Multiply by hand rather than importing three into the page.
      const apply = (m: number[], v: number[]): number[] => [
        m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]! * v[3]!,
        m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]! * v[3]!,
        m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]! * v[3]!,
        m[3]! * v[0]! + m[7]! * v[1]! + m[11]! * v[2]! + m[15]! * v[3]!,
      ];
      const view = apply(camera.matrixWorldInverse.elements, [px as number, py as number, pz as number, 1]);
      const clip = apply(camera.projectionMatrix.elements, view);
      const ndcX = clip[0]! / clip[3]!;
      const ndcY = clip[1]! / clip[3]!;
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((ndcX + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndcY) / 2) * rect.height,
      };
    },
    [x, y, z] as const,
  );
}

/**
 * Walks the player in to the pit the way tapping the ground does, and waits
 * until they are down at it. Everything about the fire that a player is now
 * meant to read — how the wood is stacked, what is steaming, whether the coals
 * are buried — is unreadable from the landing spot two and a half metres back.
 */
async function comeToTheFire(page: import('@playwright/test').Page): Promise<void> {
  const bearing = await page.evaluate(() => {
    const p = window.__someMore!.player!;
    return Math.atan2(p.position.z, p.position.x);
  });
  void bearing;
  /*
   * Aimed at the fire itself, which is how you come to a fire.
   *
   * Not at the ground in front of it: the nearer a ground point is, the lower
   * it is on screen, so the spot right beside the pit is below the bottom of
   * the frame and is the one place a tap cannot reach. Tapping a thing walks
   * you to the edge of its reach, which is what this is for.
   */
  const spot = await screenPoint(page, 0, 0.12, 0);
  expect(spot.y, 'the fire has to be on screen to be walked to').toBeLessThan(700);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForFunction(
    () => {
      const p = window.__someMore!.player!;
      return Math.hypot(p.position.x, p.position.z) < 1.4;
    },
    null,
    { timeout: 20_000 },
  );
  // Let the stance settle: getting down to a fire is eased, not snapped, and
  // the head turns toward what you walked to. A screen position sampled while
  // either is still moving is a position the wood is no longer at by the time
  // the finger gets there.
  let previous = { x: -1, y: -1 };
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(200);
    const now = await screenPoint(page, 0, 0.1, 0);
    if (Math.hypot(now.x - previous.x, now.y - previous.y) < 1.5) return;
    previous = now;
  }
}

test.describe('arranging the fire', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__someMore));
    // Walk in the way a person does — tap the title card and wait out the
    // dolly. The bridge's `arrive` skips the walk and leaves the camera and
    // the title where they were, which is fine for a state machine and no use
    // at all to anybody trying to look at the fire.
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage !== 'arriving', null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(800);
  });

  test('a log can be picked up with one finger and put somewhere else', async ({ page }) => {
    await comeToTheFire(page);
    // Two pieces of wood, laid apart so neither is resting on the other.
    await act(page, 'layFuel', 'oak', 'log', 0.3, 0.4);
    await act(page, 'layFuel', 'oak', 'log', 0.3, 3.6);
    await page.waitForTimeout(300);

    // The pit already has a fire in it, so work with the two just laid.
    const before = await readFire(page);
    const laid = before.logs.slice(-2);
    expect(laid).toHaveLength(2);
    const target = laid[0]!;
    expect(target.lean).toBeLessThan(0.2);

    const from = await screenPoint(page, target.x, 0.06, target.z);
    // Drag it in over the coals, next to the other one.
    const other = laid[1]!;
    const to = await screenPoint(page, other.x * 0.55, 0.06, other.z * 0.55);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Several small steps: one jump is not a drag and would not tell us
    // whether the pointer stays captured once it leaves the wood.
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await readFire(page);
    const moved = after.logs.find((l) => l.id === target.id)!;
    const travelled = Math.hypot(moved.x - target.x, moved.z - target.z);
    expect(travelled).toBeGreaterThan(0.08);
    // And it ended up where it was put, not merely somewhere else.
    expect(Math.hypot(moved.x - other.x * 0.55, moved.z - other.z * 0.55)).toBeLessThan(0.09);
    await capture(page, '40-fire-arranged');
  });

  test('dragging a log does not also turn the player’s head', async ({ page }) => {
    await comeToTheFire(page);
    await act(page, 'layFuel', 'oak', 'log', 0.3, 0.4);
    await page.waitForTimeout(300);
    const before = await readFire(page);
    const facingBefore = await page.evaluate(() => window.__someMore!.player!.facing);

    const target = before.logs[before.logs.length - 1]!;
    const from = await screenPoint(page, target.x, 0.06, target.z);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.x - i * 14, from.y - i * 6);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(200);

    const facingAfter = await page.evaluate(() => window.__someMore!.player!.facing);
    expect(Math.abs(facingAfter - facingBefore)).toBeLessThan(0.02);
    // The wood moved, though — otherwise this proves nothing.
    const after = await readFire(page);
    const moved = after.logs.find((l) => l.id === target.id)!;
    expect(Math.hypot(moved.x - target.x, moved.z - target.z)).toBeGreaterThan(0.05);
  });

  test('wood laid across the pile leans on it, and the fire draws harder', async ({ page }) => {
    await comeToTheFire(page);
    // Three logs laid in on top of each other: a tepee, built the only way the
    // game offers, which is by putting wood next to wood.
    await act(page, 'layFuel', 'oak', 'log', 0.14, 0.4);
    await act(page, 'layFuel', 'oak', 'log', 0.11, 1.1);
    await act(page, 'layFuel', 'oak', 'log', 0.08, 1.8);
    await page.waitForTimeout(300);
    const stacked = await readFire(page);
    expect(stacked.arrangement).not.toBe('empty');
    const leaned = stacked.logs.slice(-3).filter((l) => l.lean > 0.4).length;
    expect(leaned).toBeGreaterThan(0);

    // Rake it, and the same wood is lying flat and spread.
    await act(page, 'rake');
    await page.waitForTimeout(200);
    const raked = await readFire(page);
    expect(raked.draught).toBeLessThan(stacked.draught + 0.001);
    for (const log of raked.logs) expect(log.lean).toBeLessThan(1);
  });
});

test.describe('what the pit looks like when you get down to it', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__someMore));
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage !== 'arriving', null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(800);
  });

  test('coming to the fire gets you down to it, and the fire is legible there', async ({ page }) => {
    const standing = await page.evaluate(() => window.__someMore!.player!.stance);
    expect(standing).toBeGreaterThan(0.9);

    await comeToTheFire(page);
    const crouched = await page.evaluate(() => window.__someMore!.player!.stance);
    expect(crouched).toBeLessThan(0.75);

    // A tepee: three pieces laid in on each other.
    await act(page, 'layFuel', 'oak', 'log', 0.14, 0.4);
    await act(page, 'layFuel', 'birch', 'log', 0.11, 1.1);
    await act(page, 'layFuel', 'oak', 'log', 0.08, 1.8);
    await act(page, 'advanceSeconds', 12);
    await page.waitForTimeout(400);
    const tepee = await readFire(page);
    await capture(page, '42-fire-tepee');

    // Raked down: the same wood, flat, and a fire you could cook on.
    await act(page, 'rake');
    await act(page, 'advanceSeconds', 25);
    await page.waitForTimeout(400);
    const flat = await readFire(page);
    await capture(page, '43-fire-raked');
    expect(flat.draught).toBeLessThan(tepee.draught);

    // Wet wood parked out on the stones, steaming while it dries.
    await act(page, 'layFuel', 'oak', 'log', 0.38, 0.15);
    await page.evaluate(() => {
      const fire = (window.__someMore!.store.state.ritual as unknown as {
        fire: { logs: { moisture: number }[] };
      }).fire;
      fire.logs[fire.logs.length - 1]!.moisture = 0.92;
    });
    await act(page, 'advanceSeconds', 20);
    await page.waitForTimeout(400);
    const drying = await readFire(page);
    const onTheStones = drying.logs[drying.logs.length - 1]!;
    expect(onTheStones.steam).toBeGreaterThan(0.4);
    await capture(page, '44-fire-drying');

    // And put away for the night.
    const burning = drying.flame;
    await act(page, 'bank');
    await act(page, 'bank');
    await act(page, 'advanceSeconds', 150);
    await page.waitForTimeout(400);
    const banked = await readFire(page);
    /*
     * Not out — put away.
     *
     * A pit with five pieces of wood alight in it does not go dark because
     * somebody raked ash over it, and it should not: what is left is a
     * smoulder somewhere under there, no column, nothing to see. The bed is
     * the part that matters, and the bed is hotter for being covered.
     */
    expect(banked.flame).toBeLessThan(burning * 0.5);
    expect(banked.flame).toBeLessThan(0.12);
    // Nothing standing up out of the pit at all.
    expect(banked.flameHeight).toBeLessThan(0.24);
    expect(banked.ashCover).toBeGreaterThan(0.8);
    expect(banked.emberTemp).toBeGreaterThan(300);
    await capture(page, '45-fire-banked-close');
  });
});

test.describe('ash', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__someMore));
    // Walk in the way a person does — tap the title card and wait out the
    // dolly. The bridge's `arrive` skips the walk and leaves the camera and
    // the title where they were, which is fine for a state machine and no use
    // at all to anybody trying to look at the fire.
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage !== 'arriving', null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(800);
  });

  test('banking puts the fire away and raking brings it back', async ({ page }) => {
    await comeToTheFire(page);
    const before = await readFire(page);
    expect(before.ashCover).toBeLessThan(0.3);

    await act(page, 'bank');
    await act(page, 'bank');
    await act(page, 'advanceSeconds', 120);
    await page.waitForTimeout(400);
    const banked = await readFire(page);
    expect(banked.ashCover).toBeGreaterThan(0.7);
    expect(banked.flame).toBeLessThan(0.1);
    // Put away, not put out.
    expect(banked.emberTemp).toBeGreaterThan(300);
    await capture(page, '41-fire-banked');

    await act(page, 'rake');
    await act(page, 'rake');
    await act(page, 'advanceSeconds', 20);
    await page.waitForTimeout(400);
    const raked = await readFire(page);
    expect(raked.ashCover).toBeLessThan(0.2);
    expect(raked.oxygen).toBeGreaterThan(banked.oxygen);
  });
});
