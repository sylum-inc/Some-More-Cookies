import { expect, test } from '@playwright/test';

import { act, waitForWorld } from './helpers.js';
import { driveRitual, openWorld } from './stages.js';

/**
 * The class of bug this codebase keeps writing, caught at the seam.
 *
 * Ten times in a single session a render feature was computed correctly and
 * never reached a pixel. Every one compiled, every one had tests, and every
 * one was found by a person looking at a picture — usually several rounds of
 * art work after it stopped working:
 *
 *   - `PointsMaterial.fog` and `LineBasicMaterial.fog` default to **true**,
 *     and three.js's `fog_fragment` *replaces* the fragment colour at fog
 *     factor 1 rather than tinting it. Every star in the game painted the fog
 *     colour.
 *   - Tone bands computed as sRGB byte ratios and multiplied into albedo in
 *     the renderer's **linear** working space.
 *   - `vertexColors: true` on a material whose geometry supplied no colour
 *     attribute, under a comment stating that it did.
 *   - A sky dome outside the far plane.
 *   - A shadow camera whose far plane sat on the campsite.
 *   - A point light whose `distance` drew a hard-edged ellipse on the ground.
 *   - A ground mat wound clockwise seen from above, entirely back-face culled,
 *     pixel-identical to no mat at all.
 *   - A quantiser working in linear light where the real signal rounded to
 *     zero.
 *   - A quantised value written per *vertex* and interpolated straight back
 *     out into the smooth gradient it existed to prevent.
 *   - A click handler on the sandwich with nothing wired to its output, so the
 *     object the whole ritual produces could not be touched.
 *
 * They are not ten unrelated mistakes. They are one mistake — a declaration
 * whose precondition is not met, in a renderer that fails silently rather than
 * loudly — and the place to catch it is the live scene graph, because that is
 * the only place where the declaration and its precondition are both present.
 *
 * This is a **net, not a style guide.** Every rule here fires on something that
 * has actually shipped broken. Anything deliberate goes in `EXEMPT` with a
 * reason, so the exemption is a decision somebody made rather than a hole.
 */

/**
 * Objects allowed to break a rule, by name, with why.
 *
 * Keyed on the rule so an exemption cannot quietly cover a second failure in
 * the same object.
 */
/**
 * What was already broken when the net went up, and is allowed to stay broken
 * until somebody gets to it.
 *
 * A guard that starts red is a guard people delete, and a guard with no
 * baseline can never be added to a codebase that already has the bug. So this
 * is a ratchet: everything here is reported on every run and does not fail the
 * build, anything NOT here fails immediately, and an entry that stops
 * appearing must be deleted from this list — which is asserted below, so the
 * baseline cannot rot into a list of things that were fixed years ago.
 *
 * Every line is a real defect of the same family as the ten that shipped. None
 * of them is currently visible: the fogged materials are all within a couple
 * of metres of the camera where the fog factor is nil, and the untextured ones
 * are small. That is exactly what the ten looked like the day before they
 * became visible.
 */
const KNOWN: readonly string[] = [
  // Additive glows and the SM-01's interior dust, all leaving `fog` at its
  // dangerous default. Harmless at two metres, and the same shape as the bug
  // that painted every star in the game the colour of fog.
  'fog::(unnamed mesh) MeshBasicMaterial#c9f49d',
  'fog::(unnamed mesh) MeshBasicMaterial#ffffff',
  'fog::(unnamed points under sm-01) PointsMaterial#d8ecf8',
  // Lit surfaces with no texture and no vertex colours: flat plastic. Most of
  // these are the SM-01's own panels and are being rebuilt as this goes in.
  'untextured::(unnamed mesh under sm-01) MeshStandardMaterial#14181c',
  'untextured::(unnamed mesh under torch) MeshStandardMaterial#9aa5ae',
  'untextured::(unnamed mesh) MeshStandardMaterial#6c6a66',
  'untextured::(unnamed mesh) MeshStandardMaterial#8b8880',
  'untextured::(unnamed mesh) MeshStandardMaterial#9a968c',
  'untextured::(unnamed mesh) MeshStandardMaterial#d8d4c8',
  'untextured::(unnamed mesh) MeshStandardMaterial#e8e5de',
];

interface Finding {
  readonly rule: string;
  readonly object: string;
  readonly detail: string;
}

async function audit(page: import('@playwright/test').Page): Promise<Finding[]> {
  return page.evaluate(() => {
    const three = window.__someMore!.three!;
    const scene = three.scene as unknown as {
      traverse(fn: (o: Record<string, unknown>) => void): void;
    };
    const camera = three.camera as unknown as { far: number; position: { x: number; y: number; z: number } };
    const findings: { rule: string; object: string; detail: string }[] = [];
    /** Enough of a material to tell two unnamed meshes apart in a report. */
    const fingerprint = (m: Record<string, unknown>): string => {
      const colour = (m['color'] as { getHexString(): string } | undefined)?.getHexString();
      return `${String(m['type'] ?? '?')}#${colour ?? '??????'}`;
    };
    const name = (o: Record<string, unknown>): string => {
      const own = String(o['name'] ?? '');
      if (own !== '') return own;
      const parent = o['parent'] as Record<string, unknown> | null;
      const under = parent === null ? '' : String(parent['name'] ?? '');
      const kind = o['isPoints'] === true ? 'points' : o['isLine'] === true ? 'line' : 'mesh';
      return under === '' ? `(unnamed ${kind})` : `(unnamed ${kind} under ${under})`;
    };

    let anyLightCasts = false;
    let anyMeshCasts = false;

    scene.traverse((o) => {
      // Declared, not currently visible: the sun is hidden at night by
      // design, and a rule that reads the night as a broken shadow map
      // fires on every frame the game is mostly played in.
      if (o['isLight'] === true && o['castShadow'] === true) anyLightCasts = true;
      if (o['isMesh'] === true && o['castShadow'] === true) anyMeshCasts = true;

      const isDrawable = o['isMesh'] === true || o['isPoints'] === true || o['isLine'] === true;
      if (!isDrawable || o['visible'] !== true) return;

      const geometry = o['geometry'] as
        | { attributes?: Record<string, unknown>; boundingSphere?: { radius: number } | null; computeBoundingSphere?: () => void }
        | undefined;
      const materials = Array.isArray(o['material'])
        ? (o['material'] as Record<string, unknown>[])
        : [o['material'] as Record<string, unknown> | undefined].filter(Boolean) as Record<string, unknown>[];

      for (const material of materials) {
        if (material === undefined) continue;

        /*
         * Rule 1 — a material that reads a vertex colour must be given one.
         *
         * Without the attribute the shader reads the generic vertex attribute,
         * and every band, tint and tone the geometry meant to carry is thrown
         * away. This shipped on the terrain under a comment saying the tint
         * was baked in.
         */
        if (material['vertexColors'] === true && geometry?.attributes?.['color'] === undefined) {
          findings.push({
            rule: 'vertex-colours-declared-but-not-supplied',
            object: `${name(o)} ${fingerprint(material)}`,
            detail: 'material sets vertexColors: true and the geometry has no colour attribute',
          });
        }

        /*
         * Rule 2 — anything additive, and every point cloud and line, must say
         * what it wants from the fog.
         *
         * `fog` defaults to true, and at fog factor 1 the fragment colour is
         * *replaced* rather than tinted, so an additive effect at distance
         * becomes a solid rectangle of fog colour. Declaring it either way is
         * the whole ask; the default is what is dangerous.
         */
        const additive = material['blending'] === 2; // THREE.AdditiveBlending
        if ((additive || o['isPoints'] === true || o['isLine'] === true) && material['fog'] !== false) {
          findings.push({
            rule: 'fog',
            object: `${name(o)} ${fingerprint(material)}`,
            detail: `${additive ? 'additive' : o['isPoints'] === true ? 'points' : 'line'} material leaves fog on; fog_fragment replaces rather than tints`,
          });
        }

        /*
         * Rule 3 — a surface with neither a texture nor vertex colours is a
         * flat plastic slab, and every one found so far was an oversight
         * rather than a choice.
         */
        /*
         * Lit materials only. `MeshBasicMaterial` is unlit by definition and
         * is what this build uses for glows, markers and screen-lit panels,
         * where one flat colour is the entire intent; `ShaderMaterial` brings
         * its own colour. Flagging those made the rule fire eleven times on
         * things that were right, which is how a net becomes something people
         * switch off.
         */
        const lit = material['type'] === 'MeshStandardMaterial' || material['type'] === 'MeshPhysicalMaterial';
        const untextured =
          o['isMesh'] === true &&
          lit &&
          material['map'] == null &&
          material['vertexColors'] !== true &&
          material['emissiveMap'] == null &&
          material['transparent'] !== true;
        if (untextured) {
          findings.push({
            rule: 'untextured',
            object: `${name(o)} ${fingerprint(material)}`,
            detail: 'mesh has no map, no vertex colours and no emissive map',
          });
        }
      }

      /*
       * Rule 4 — nothing may sit outside the far plane.
       *
       * The sky dome did, and the sky it was drawing was simply not there.
       */
      if (geometry !== undefined) {
        if (geometry.boundingSphere == null && typeof geometry.computeBoundingSphere === 'function') {
          geometry.computeBoundingSphere();
        }
        const mw = (o['matrixWorld'] as { elements: number[] } | undefined)?.elements;
        const radius = geometry.boundingSphere?.radius ?? 0;
        if (mw !== undefined && radius > 0) {
          const dx = mw[12]! - camera.position.x;
          const dy = mw[13]! - camera.position.y;
          const dz = mw[14]! - camera.position.z;
          const nearestEdge = Math.hypot(dx, dy, dz) - radius;
          if (nearestEdge > camera.far) {
            findings.push({
              rule: 'beyond-the-far-plane',
              object: name(o),
              detail: `nearest edge is ${nearestEdge.toFixed(1)} m away, far plane is ${camera.far}`,
            });
          }
        }
      }
    });

    /*
     * Rule 5 — if anything declares that it casts, something must be able to
     * receive that declaration.
     *
     * Props all over this campsite carried `castShadow` for months while no
     * light in the scene had `castShadow` set, so the shadow map had no caster
     * and the whole system was inert. That is expensive prose doing nothing.
     */
    if (anyMeshCasts && !anyLightCasts) {
      findings.push({
        rule: 'casters-with-no-casting-light',
        object: '(scene)',
        detail: 'meshes declare castShadow and no visible light does',
      });
    }
    return findings;
  });
}

test.describe('what the renderer is actually being told', () => {
  test('every declaration in the scene has its precondition met', async ({ page }) => {
    await openWorld(page, 'invariants', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);
    await page.waitForTimeout(1500);

    const seen = new Map<string, Finding>();
    const collect = async (): Promise<void> => {
      for (const finding of await audit(page)) {
        seen.set(`${finding.rule}::${finding.object}`, finding);
      }
    };

    // The whole ritual, because most of these objects are only mounted for one
    // stage of it and a scene audited at the fire audits about a third of the
    // build.
    await collect();
    await driveRitual(page, collect);

    const line = (f: Finding): string => `  ${f.rule}: ${f.object} — ${f.detail}`;
    const keys = [...seen.keys()].sort();
    const fresh = keys.filter((key) => !KNOWN.includes(key));
    const carried = keys.filter((key) => KNOWN.includes(key));

    // eslint-disable-next-line no-console
    console.log(
      `\n  ${carried.length} of ${KNOWN.length} known declarations still unmet, ${fresh.length} new\n` +
        keys.map((key) => line(seen.get(key)!)).join('\n') +
        '\n',
    );

    /*
     * The ratchet, in both directions.
     *
     * New findings fail, which is the point. And a baseline entry that has
     * stopped appearing must be removed from `KNOWN` in the same change that
     * fixed it — otherwise the list slowly becomes a record of things that
     * used to be wrong, and the next person reads it as permission.
     */
    const stale = KNOWN.filter((key) => !seen.has(key));
    expect(
      stale,
      `these are fixed and should be deleted from KNOWN in e2e/invariants.spec.ts:\n${stale.join('\n')}`,
    ).toEqual([]);
    expect(
      fresh.map((key) => line(seen.get(key)!)),
      'a declaration whose precondition is not met, and which is not in the recorded baseline',
    ).toEqual([]);
  });
});
