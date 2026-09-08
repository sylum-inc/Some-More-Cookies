/**
 * The night sky, measured.
 *
 * The review that produced this file called the sky "80% of the frame …
 * featureless near-black with uniformly sized, uniformly bright 1px dots —
 * sensor noise, not a sky", and called it the headline asset for a game whose
 * premise is sitting outside at night.
 *
 * Two of those three complaints turned out to be a bug rather than a choice —
 * a defaulted `fog` flag was replacing every star's colour with the fog colour
 * one stage after its magnitude was computed — which is exactly the kind of
 * thing a screenshot cannot distinguish from a deliberately flat art
 * direction. So the flag is asserted here, and so is everything else that can
 * be turned into a number: where the galaxy is, how wide it is, how the tiers
 * separate, and whether the whole thing agrees with the astronomy the sim
 * already computes.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONSTELLATIONS, horizonPositionOf } from '@somemore/sim';
import {
  STAR_SLOTS,
  bandBrightness,
  bandHalfWidth,
  buildGalaxy,
  buildHalo,
  fadeAtHorizon,
  createSkyMaterials,
  galacticToEquatorial,
  skyBasis,
  starTier,
  type StarTier,
} from '../src/scene/NightSky.js';

const DOME = 118;
/**
 * Pixels per degree in the world camera.
 *
 * 62 degree vertical field over a 240-line internal buffer. Every "how many
 * pixels" number in this file goes through it, because the direction speaks
 * in pixels and the geometry speaks in degrees.
 */
const PX_PER_DEGREE = 240 / 62;

const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const toByte = (linear: number): number =>
  255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055);

describe('the fog that was eating the sky', () => {
  it('keeps every sky material out of the scene fog', () => {
    const materials = createSkyMaterials();
    for (const [name, material] of Object.entries(materials)) {
      expect(material.fog, `${name} must not take scene fog`).toBe(false);
      material.dispose();
    }
  });

  it('shows what fog would have done, which is why the flag matters', () => {
    /*
     * Not a tautology: this is the mechanism, from Three's own shader source.
     * `points_frag` includes `<fog_fragment>`, and that chunk *replaces* the
     * colour by `mix( gl_FragColor.rgb, fogColor, fogFactor )`. The campsite
     * sets `sceneFog.far = drawDistance * 1.35` and `sceneFog.color` to the
     * manifest's own fog colour, so on the most open site in the catalogue
     * that far plane is about 65 m. Everything in this file is at 118 m.
     */
    expect(THREE.ShaderLib.points.fragmentShader).toContain('#include <fog_fragment>');
    expect(THREE.ShaderChunk.fog_fragment).toContain('fogFactor');
    expect(THREE.ShaderChunk.fog_fragment).toContain('mix( gl_FragColor.rgb, fogColor, fogFactor )');
    const near = 2.5;
    const far = 48 * 1.35;
    const fogFactor = Math.min(1, Math.max(0, (DOME - near) / (far - near)));
    expect(fogFactor, 'at the dome, fog is total').toBe(1);
  });
});

describe('three star tiers, from real magnitudes', () => {
  const rows = [...STAR_SLOTS.entries()];
  const stars = rows.flatMap(([id, slots]) => {
    const constellation = CONSTELLATIONS.find((c) => c.id === id);
    if (!constellation) throw new Error(`no constellation ${id}`);
    return slots.map((slot, i) => ({ slot, magnitude: constellation.stars[i]![2] }));
  });

  it('puts about a dozen stars in the top tier and never crosses the tiers over', () => {
    const count = (tier: StarTier): number => stars.filter((s) => s.slot.tier === tier).length;
    expect(count('bright'), 'the two-pixel tier').toBeGreaterThanOrEqual(10);
    expect(count('bright')).toBeLessThanOrEqual(14);
    expect(count('mid')).toBeGreaterThan(6);
    expect(count('faint')).toBeGreaterThan(4);

    // The tier is the magnitude, not a roll: no star in a lower tier may be
    // brighter than any star in a higher one.
    const order: StarTier[] = ['bright', 'mid', 'faint'];
    for (let i = 1; i < order.length; i++) {
      const above = stars.filter((s) => s.slot.tier === order[i - 1]);
      const below = stars.filter((s) => s.slot.tier === order[i]);
      expect(Math.max(...above.map((s) => s.magnitude))).toBeLessThan(
        Math.min(...below.map((s) => s.magnitude)),
      );
    }
    expect(starTier(0.2)).toBe('bright');
    expect(starTier(2.2)).toBe('mid');
    expect(starTier(3.4)).toBe('faint');
  });

  it('separates the tiers by more than the dither can smear', () => {
    /*
     * The direction's #6a7080 / #c8cede / #ffffff. What matters is that they
     * are three *steps* and not a ramp: the old sky's stars ranged smoothly
     * from 0.25 to 1.2 and then had all of it thrown away by fog. In sRGB
     * bytes these land near 112, 206 and 255 — roughly 90 and 50 apart, where
     * the eight-step ordered dither resolves about 8.
     */
    const seen = new Map<StarTier, number>();
    for (const { slot } of stars) seen.set(slot.tier, toByte(luminance(slot.tint)));
    const faint = seen.get('faint') as number;
    const mid = seen.get('mid') as number;
    const bright = seen.get('bright') as number;
    expect(mid - faint).toBeGreaterThan(60);
    expect(bright - mid).toBeGreaterThan(30);
    expect(Math.round(faint)).toBeGreaterThan(95);
    expect(Math.round(faint), 'the faint tier is still a star, not black').toBeLessThan(130);
  });

  it('still varies within a tier, so three tiers is not three colours', () => {
    const nudges = new Set(stars.map((s) => s.slot.nudge.toFixed(3)));
    expect(nudges.size).toBeGreaterThan(8);
    for (const { slot } of stars) {
      expect(slot.nudge).toBeGreaterThan(0.85);
      expect(slot.nudge).toBeLessThan(1.15);
    }
  });

  it('gives every catalogue star a fixed slot', () => {
    // The old loop numbered stars with a running counter over the *visible*
    // constellations, so a star's buffer index moved as things rose and set.
    // Harmless while every star was one colour; a scramble the moment they
    // are not.
    const bright = stars.filter((s) => s.slot.bright).map((s) => s.slot.index);
    const soft = stars.filter((s) => !s.slot.bright).map((s) => s.slot.index);
    expect(new Set(bright).size).toBe(bright.length);
    expect(new Set(soft).size).toBe(soft.length);
    expect(Math.max(...bright)).toBe(bright.length - 1);
    expect(Math.max(...soft)).toBe(soft.length - 1);
  });
});

describe('the Milky Way is where the Milky Way is', () => {
  it('puts the galactic centre in Sagittarius', () => {
    // The galactic centre is at RA 17h45.6m, Dec -28.94 (J2000). If this ever
    // drifts, the band is decoration again.
    const centre = galacticToEquatorial(0, 0);
    expect(centre.raHours).toBeCloseTo(17.76, 1);
    expect(centre.decDeg).toBeCloseTo(-28.94, 0);

    // And the north galactic pole where the pole is, in Coma Berenices.
    const pole = galacticToEquatorial(0, 90);
    expect(pole.raHours).toBeCloseTo(12.857, 2);
    expect(pole.decDeg).toBeCloseTo(27.128, 2);

    // Cygnus, l = 90: the summer band overhead in the north.
    const cygnus = galacticToEquatorial(90, 0);
    expect(cygnus.raHours).toBeCloseTo(21.2, 1);
    expect(cygnus.decDeg).toBeCloseTo(48.3, 0);
  });

  it('rotates into the sky with exactly the transform the stars use', () => {
    /*
     * The band's positions are static and the group carries the rotation, so
     * the only thing that can put the galaxy in the wrong place is that
     * matrix. It is built from the images of two points on the celestial
     * equator; this checks it against `horizonPositionOf` for points it was
     * *not* built from, at four latitudes and three epochs.
     *
     * The first version took the cross product the other way round and got a
     * proper rotation instead of the reflection the sim's south-reckoned
     * azimuth actually is. It agreed on the two axes it was built from and
     * mirrored everything else through the meridian — and looked completely
     * plausible.
     */
    const basis = new THREE.Matrix4();
    const equatorial = (raHours: number, decDeg: number): THREE.Vector3 => {
      const ra = (raHours / 24) * Math.PI * 2;
      const dec = (decDeg * Math.PI) / 180;
      return new THREE.Vector3(
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
      );
    };
    for (const [latitude, longitude] of [[44, -73], [-33, 151], [64, -21], [0, 0]] as const) {
      for (const offset of [0, 3.7e7, 9.1e8]) {
        const date = new Date(Date.UTC(2024, 7, 12, 3, 0, 0) + offset);
        skyBasis(date, latitude, longitude, basis);
        for (const [ra, dec] of [[12, 45], [18, -30], [3, 80], [21, -75], [9, 12]] as const) {
          const { altitude, azimuth } = horizonPositionOf(ra, dec, date, latitude, longitude);
          const cosAlt = Math.cos(altitude);
          const expected = new THREE.Vector3(
            Math.sin(azimuth) * cosAlt,
            Math.sin(altitude),
            Math.cos(azimuth) * cosAlt,
          );
          const got = equatorial(ra, dec).applyMatrix4(basis).normalize();
          expect(
            expected.distanceTo(got),
            `${latitude}/${longitude} +${offset} at ${ra}h ${dec}deg`,
          ).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('is about forty pixels wide, which is what was asked for', () => {
    const widths = Array.from({ length: 36 }, (_, i) => bandHalfWidth(i * 10) * 2 * PX_PER_DEGREE);
    expect(Math.min(...widths)).toBeGreaterThan(28);
    expect(Math.max(...widths)).toBeLessThan(52);
    // Widest through the bulge, narrowest towards the anticentre — a constant
    // width is a painted stripe.
    expect(bandHalfWidth(0)).toBeGreaterThan(bandHalfWidth(180) * 1.3);
  });

  it('is brightest towards the centre and has the Great Rift cut into it', () => {
    const sagittarius = bandBrightness(0);
    const anticentre = bandBrightness(180);
    expect(sagittarius).toBeGreaterThan(anticentre * 2.5);
    // The rift: a local minimum around l = 50, between two brighter shoulders.
    expect(bandBrightness(50)).toBeLessThan(bandBrightness(10) * 0.75);
    expect(bandBrightness(50)).toBeLessThan(bandBrightness(95) * 0.9);
  });

  it('lands on the colour the direction named, and fades to nothing at the edge', () => {
    const { band } = buildGalaxy();
    const baked = band.getAttribute('baked') as THREE.BufferAttribute;
    const rows = 5;
    let axisPeak = 0;
    let edgePeak = 0;
    for (let i = 0; i < baked.count; i++) {
      const green = baked.getY(i);
      if (i % rows === 2) axisPeak = Math.max(axisPeak, green);
      if (i % rows === 0 || i % rows === rows - 1) edgePeak = Math.max(edgePeak, green);
    }
    // #2a3040 is 48/255 of green. The seeded mottle scales the axis between
    // 0.72 and 1.28 of it, so the peak sits a little over.
    expect(toByte(axisPeak)).toBeGreaterThan(38);
    expect(toByte(axisPeak)).toBeLessThan(70);
    expect(edgePeak, 'the edge of the galaxy is not an edge').toBe(0);
    band.dispose();
  });

  it('is lumpy, because a smooth band is an airbrush stroke', () => {
    const { band } = buildGalaxy();
    const baked = band.getAttribute('baked') as THREE.BufferAttribute;
    const axis: number[] = [];
    for (let i = 2; i < baked.count; i += 5) axis.push(baked.getY(i));
    // Neighbour-to-neighbour change along the axis: a pure function of
    // longitude would be almost perfectly smooth here.
    let steps = 0;
    for (let i = 1; i < axis.length; i++) {
      if (Math.abs((axis[i] as number) - (axis[i - 1] as number)) > 0.1 * (axis[i] as number)) steps++;
    }
    expect(steps, 'lumps along the band').toBeGreaterThan(axis.length / 3);
    band.dispose();
  });

  it('keeps its grain below the faintest named star', () => {
    // The band is made of stars you cannot separate. If a grain point were as
    // bright as a catalogue star, the hierarchy the three tiers buy would go
    // straight back out.
    const { grain } = buildGalaxy();
    const baked = grain.getAttribute('baked') as THREE.BufferAttribute;
    let brightest = 0;
    for (let i = 0; i < baked.count; i++) {
      brightest = Math.max(
        brightest,
        0.2126 * baked.getX(i) + 0.7152 * baked.getY(i) + 0.0722 * baked.getZ(i),
      );
    }
    const faintestStar = Math.min(
      ...[...STAR_SLOTS.values()]
        .flat()
        .filter((slot) => slot.tier === 'faint')
        .map((slot) => luminance(slot.tint) * slot.nudge),
    );
    expect(brightest).toBeLessThan(faintestStar);
    expect(brightest, 'and is still visible').toBeGreaterThan(faintestStar * 0.2);
    grain.dispose();
  });

  it('fades into the horizon instead of stopping at it', () => {
    /*
     * The positions never move — the group's matrix moves them — so the only
     * per-frame work is one dot product per vertex against the matrix's up
     * row. With the identity that row is (0, 1, 0), so this is a direct test
     * of the fade: nothing below the horizon, everything above twelve degrees,
     * and a ramp in between rather than a straight edge across the bottom of
     * the galaxy.
     */
    const { band } = buildGalaxy();
    const identity = new THREE.Matrix4();
    fadeAtHorizon(band, identity, 1);
    const position = band.getAttribute('position') as THREE.BufferAttribute;
    const baked = band.getAttribute('baked') as THREE.BufferAttribute;
    const colour = band.getAttribute('color') as THREE.BufferAttribute;
    const fade = Math.sin((12 * Math.PI) / 180) * DOME;
    let ramped = 0;
    for (let i = 0; i < position.count; i++) {
      const height = position.getY(i);
      if (height <= 0) expect(colour.getY(i)).toBe(0);
      else if (height >= fade) expect(colour.getY(i)).toBeCloseTo(baked.getY(i), 6);
      else if (baked.getY(i) > 0) {
        expect(colour.getY(i)).toBeLessThan(baked.getY(i));
        ramped++;
      }
    }
    expect(ramped, 'there is a ramp, not a cut').toBeGreaterThan(4);

    // And the whole thing goes out when the night is not worth looking at.
    fadeAtHorizon(band, identity, 0);
    for (let i = 0; i < colour.count; i++) expect(colour.getY(i)).toBe(0);
    band.dispose();
  });

  it('crosses high overhead on the curated August night, because it does', () => {
    /*
     * The fallback sky §5.5 promises is "as good as the real thing":
     * mid-August, mid-Perseids. At the default latitude the summer Milky Way
     * through Cygnus passes within a few degrees of the zenith on that night —
     * so if this band is placed correctly it is overhead, not lying along the
     * horizon where the trees are. Measured at 83 degrees.
     */
    const { band } = buildGalaxy();
    const position = band.getAttribute('position') as THREE.BufferAttribute;
    const basis = new THREE.Matrix4();
    skyBasis(new Date(Date.UTC(2024, 7, 12, 3, 0, 0)), 44, -73, basis);
    const point = new THREE.Vector3();
    let peak = -90;
    for (let i = 0; i < position.count; i++) {
      point.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(basis);
      peak = Math.max(peak, (Math.asin(point.y / point.length()) * 180) / Math.PI);
    }
    expect(peak).toBeGreaterThan(60);
    band.dispose();
  });

  it('builds the same galaxy every time', () => {
    // Presentation may use a clock and a random number; a sky may not. The
    // same night twice is the same night.
    const a = buildGalaxy();
    const b = buildGalaxy();
    for (const part of ['band', 'grain'] as const) {
      for (const name of ['position', 'baked'] as const) {
        expect(
          Array.from((a[part].getAttribute(name) as THREE.BufferAttribute).array),
          `${part}.${name}`,
        ).toEqual(Array.from((b[part].getAttribute(name) as THREE.BufferAttribute).array));
      }
      a[part].dispose();
      b[part].dispose();
    }
  });
});

describe('the moon has a halo rather than an edge', () => {
  it('draws two steps, not a gradient', () => {
    /*
     * "A moon with a two-step halo rather than a hard disc."
     *
     * The measurement that separates a step from a ramp: the drop *between*
     * the two steps has to be much larger than the change *across* either of
     * them. A first pass gave each step a smooth inner-to-outer falloff, and
     * the two met at almost the same value — three concentric rings of a
     * gradient, which is a glow with extra triangles.
     */
    const halo = buildHalo();
    const position = halo.getAttribute('position') as THREE.BufferAttribute;
    const colour = halo.getAttribute('color') as THREE.BufferAttribute;
    const levels = new Map<string, Set<number>>();
    for (let i = 0; i < position.count; i++) {
      const radius = Math.hypot(position.getX(i), position.getY(i)).toFixed(3);
      const set = levels.get(radius) ?? new Set<number>();
      set.add(Number(colour.getY(i).toFixed(4)));
      levels.set(radius, set);
    }
    const radii = [...levels.keys()].map(Number).sort((a, b) => a - b);
    expect(radii.length, 'the two steps share a rim').toBe(3);

    const at = (radius: number): number[] => [...(levels.get(radius.toFixed(3)) as Set<number>)].sort((a, b) => b - a);
    const inner = at(radii[0] as number)[0] as number;
    const seam = at(radii[1] as number);
    const rim = at(radii[2] as number)[0] as number;
    expect(seam.length, 'two values meet at the seam — that is the step').toBe(2);
    const [seamHigh, seamLow] = seam as [number, number];
    // Across the first step: nearly flat.
    expect(seamHigh / inner).toBeGreaterThan(0.8);
    // Between the steps: a cliff, several times the change across either.
    expect(seamLow).toBeLessThan(seamHigh * 0.5);
    expect(seamHigh - seamLow).toBeGreaterThan((inner - seamHigh) * 3);
    // And out to nothing, so the halo has no rim of its own.
    expect(rim).toBe(0);
    halo.dispose();
  });

  it('is a halo, not a second moon', () => {
    const halo = buildHalo();
    const position = halo.getAttribute('position') as THREE.BufferAttribute;
    let outer = 0;
    for (let i = 0; i < position.count; i++) {
      outer = Math.max(outer, Math.hypot(position.getX(i), position.getY(i)));
    }
    // The disc `Campsite.tsx` draws is 3.6 at 90 m. Anything under about twice
    // that is a rim on the moon rather than light around it; much over three
    // times and it is a weather effect.
    expect(outer / 3.6).toBeGreaterThan(2.4);
    expect(outer / 3.6).toBeLessThan(4);
    // In pixels: an 18-pixel moon inside a halo about 50 across.
    const degrees = (Math.atan(outer / 90) * 180) / Math.PI;
    expect(degrees * 2 * PX_PER_DEGREE).toBeGreaterThan(40);
    expect(degrees * 2 * PX_PER_DEGREE).toBeLessThan(70);
    halo.dispose();
  });
});
