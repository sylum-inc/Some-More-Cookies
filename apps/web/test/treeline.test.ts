/**
 * How closed the horizon is, from the axis the catalogue grades campsites on.
 *
 * The renderer used to count trees by summing the density of every vegetation
 * kit taller than 2.5 m. That is a reasonable-sounding rule which contradicted
 * `character.treeCover` outright wherever the two disagreed — the cedar
 * switchback is authored `canopy`, the densest cover in the catalogue, sky
 * openness 0.08, and was drawn with half the trees of a `moderate` lake shore.
 *
 * The kits are the authority on *what grows here*. They were never the
 * authority on how much sky is left.
 */

import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '@somemore/content';
import { treesForCover, type TreeCover } from '../src/scene/layout.js';

const canopyDensity = (id: string): number => {
  const environment = ENVIRONMENTS.find((e) => e.id === id);
  if (!environment) throw new Error(`no environment ${id}`);
  return environment.scene.vegetation
    .filter((kit) => kit.heightRange.max >= 2.5)
    .reduce((total, kit) => total + kit.density, 0);
};

const drawnFor = (id: string): number => {
  const environment = ENVIRONMENTS.find((e) => e.id === id);
  if (!environment) throw new Error(`no environment ${id}`);
  return treesForCover(environment.character.treeCover, canopyDensity(id));
};

describe('the treeline a cover value means', () => {
  it('puts no trees at all at a campsite whose manifest says none', () => {
    for (const density of [0, 1.2, 40]) expect(treesForCover('none', density)).toBe(0);
  });

  it('rises with every step of the axis', () => {
    const order: TreeCover[] = ['none', 'sparse', 'open', 'moderate', 'dense', 'canopy'];
    for (let i = 1; i < order.length; i++) {
      const lower = treesForCover(order[i - 1]!, 20);
      const higher = treesForCover(order[i]!, 20);
      expect(higher, `${order[i]} should be denser than ${order[i - 1]}`).toBeGreaterThan(lower);
    }
  });

  it('still lets the kits decide where in a band a campsite sits', () => {
    // Two dense woods are not the same wood.
    expect(treesForCover('dense', 40)).toBeGreaterThan(treesForCover('dense', 2));
  });

  it('does not run away when a manifest declares an enormous density', () => {
    expect(treesForCover('canopy', 10_000)).toBeLessThanOrEqual(110);
  });

  /*
   * The four campsites the old rule got most wrong. These are the numbers a
   * player sees, so they are worth pinning: `canopy` reading as thinner than
   * `moderate` is exactly the drift this replaced.
   */
  it('draws the catalogue’s closed-in places as closed in', () => {
    expect(drawnFor('cedar_switchback')).toBeGreaterThan(drawnFor('loonwater_narrows') * 1.4);
    expect(drawnFor('cicada_bottoms')).toBeGreaterThan(drawnFor('pine_hollow'));
    expect(drawnFor('lantern_mesa')).toBe(0);
    expect(drawnFor('mirror_flats')).toBe(0);
  });

  it('orders every campsite in the catalogue by its own cover value', () => {
    const rank: Record<TreeCover, number> = {
      none: 0,
      sparse: 1,
      open: 2,
      moderate: 3,
      dense: 4,
      canopy: 5,
    };
    const rows = ENVIRONMENTS.map((environment) => ({
      id: environment.id,
      rank: rank[environment.character.treeCover],
      trees: drawnFor(environment.id),
    }));
    for (const a of rows) {
      for (const b of rows) {
        if (a.rank <= b.rank) continue;
        expect(a.trees, `${a.id} is more closed in than ${b.id} and must be drawn so`).toBeGreaterThan(
          b.trees,
        );
      }
    }
  });

  /*
   * A campsite is a place with trees around a clearing, and the whole treeline
   * is instanced across four shared geometries — so the cost of the change is
   * triangles, not draw calls. At roughly fifty triangles a tree, the biggest
   * increase in the catalogue is about three thousand against a sixty
   * thousand budget.
   */
  it('never asks for more trees than the scene budget can carry', () => {
    for (const environment of ENVIRONMENTS) {
      expect(drawnFor(environment.id), environment.id).toBeLessThanOrEqual(110);
    }
  });
});
