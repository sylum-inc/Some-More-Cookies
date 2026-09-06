import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRitual, LOCOMOTION } from '@somemore/sim';
import { ENVIRONMENTS } from '@somemore/content';
import { campsiteRadiusM, worldContentFor, RADIUS_CAP_M } from '../src/state/worldContent.js';

/**
 * Everything the simulation places is somewhere the player can stand.
 *
 * This is the test that was missing, and its absence cost the product most of
 * its own content. The simulation was handed the manifest's authored radius
 * (26 to 70 m) while the client fenced the player at 16 m, and both placement
 * algorithms scale their distances by the radius they are given — so 38 of 58
 * landmarks and 43 of 90 fuel patches stood outside the fence, and every
 * landmark at Copperline Halt, Lantern Mesa and Mirror Flats was somewhere
 * nobody could go.
 *
 * `e2e/place.spec.ts` has a test called "every landmark the catalogue names is
 * somewhere you can walk to" and it passed throughout, because it compares
 * against `ritual.options.walkableRadiusM` — the number the simulation was
 * given, not the fence the player is inside. Comparing a value against itself
 * is the failure mode; this compares against the same helper the app's
 * walkable world is built from, so the two cannot drift apart again without
 * this going red.
 *
 * It runs over all twelve environments rather than the one the device is
 * pinned to, because eleven of them are unreachable in the shipped client and
 * would otherwise be tested by nothing at all.
 */

/** The fence, less the room a body takes up, and a little clearance. */
function standableRadius(radius: number): number {
  return radius - LOCOMOTION.bodyRadius - 0.5;
}

describe('what the simulation places', () => {
  const built = ENVIRONMENTS.map((environment) => {
    const radius = campsiteRadiusM(environment);
    const ritual = createRitual({
      // A fixed seed per environment: this is a test about placement rules,
      // not about one night's roll, and a wandering seed would make a failure
      // impossible to reproduce.
      campsiteSeed: `reachable-${environment.id}`,
      environmentId: environment.id,
      now: 0,
      world: worldContentFor(environment),
      walkableRadiusM: radius,
    });
    return { environment, radius, ritual };
  });

  it('covers every environment in the catalogue', () => {
    expect(built.length).toBeGreaterThanOrEqual(12);
  });

  for (const { environment, radius, ritual } of built) {
    describe(environment.id, () => {
      it('puts every landmark somewhere you can walk to', () => {
        expect(ritual.landmarks.length).toBeGreaterThan(0);
        for (const landmark of ritual.landmarks) {
          const distance = Math.hypot(landmark.x, landmark.z);
          expect(distance, `${landmark.id} is ${distance.toFixed(1)} m out, past a ${radius} m fence`).toBeLessThanOrEqual(
            standableRadius(radius),
          );
        }
      });

      it('puts every patch of firewood somewhere you can reach', () => {
        for (const patch of ritual.gathering.patches) {
          const distance = Math.hypot(patch.x, patch.z);
          expect(distance, `${patch.id} is ${distance.toFixed(1)} m out, past a ${radius} m fence`).toBeLessThanOrEqual(
            standableRadius(radius),
          );
        }
      });
    });
  }

  it('never asks for a world larger than the one that gets drawn', () => {
    /*
     * The cap is not arbitrary and it is not the manifests' ceiling: the
     * ground, the treeline and the understorey are all sized from this number,
     * so a fence beyond it is a fence around fog. If the cap rises, the drawn
     * world has to rise with it, and this is the line that says so.
     */
    for (const { environment, radius } of built) {
      expect(radius, `${environment.id}`).toBeLessThanOrEqual(RADIUS_CAP_M);
      expect(radius, `${environment.id}`).toBeGreaterThanOrEqual(8);
    }
  });

  it('places inside whatever radius it is handed, which is why one helper is enough', () => {
    /*
     * The simulation was never the broken half. Handed the authored radius it
     * places inside the authored radius; handed the fence it places inside the
     * fence. The defect was entirely that the two halves of the client handed
     * it different numbers. This pins the sim's side of that contract, so
     * "just use one helper" stays a sufficient fix.
     */
    for (const environment of ENVIRONMENTS) {
      const authored = environment.scene.walkableRadiusM;
      const ritual = createRitual({
        campsiteSeed: `authored-${environment.id}`,
        environmentId: environment.id,
        now: 0,
        world: worldContentFor(environment),
        walkableRadiusM: authored,
      });
      for (const placed of [...ritual.landmarks, ...ritual.gathering.patches]) {
        const distance = Math.hypot(placed.x, placed.z);
        expect(distance, `${environment.id} placed something ${distance.toFixed(1)} m out`).toBeLessThanOrEqual(
          standableRadius(authored),
        );
      }
    }
  });
});

/**
 * The fence and the simulation read the same number.
 *
 * A source check, because this is not a property of any one value — it is a
 * property of the call sites, and the original defect was two of them
 * disagreeing. Asserting it on built state is what `place.spec.ts` does, and
 * that is how the bug survived: it compared the placement against the very
 * radius the placement was computed from, so it could only ever pass.
 */
describe('the radius call sites', () => {
  const sources = ['apps/web/src/App.tsx', 'apps/web/src/main.tsx'];

  it('all go through campsiteRadiusM, with none reading the manifest directly', () => {
    for (const path of sources) {
      const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
      const direct = [...source.matchAll(/^.*scene\.walkableRadiusM.*$/gm)]
        .map((match) => match[0].trim())
        .filter((line) => !line.includes('campsiteRadiusM'));
      expect(direct, `${path} reads the authored radius without the cap: ${direct.join(' | ')}`).toEqual([]);
      expect(source, `${path} never calls campsiteRadiusM`).toContain('campsiteRadiusM(');
    }
  });
});
