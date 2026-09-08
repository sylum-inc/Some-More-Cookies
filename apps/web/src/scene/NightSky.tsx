/**
 * The night sky: the constellations, the galaxy, and the light around the moon.
 *
 * `Campsite.tsx` draws the field stars — the anonymous ones, scattered, which
 * is what they are. This draws the *named* ones, at the real altitude and
 * azimuth the astronomy model computes for the session's date and place, the
 * Milky Way at the real position of the galactic plane, the meteors, and the
 * halo the moon disc sits inside.
 *
 * Two rules from the spec are the whole design:
 *
 * - **Findable, not labelled.** A constellation is drawn as stars and nothing
 *   else. Once a player has held it in view long enough for it to resolve, its
 *   lines are drawn in faintly — which is what recognising a constellation
 *   actually feels like, and is as close to a label as this ever gets. There
 *   is no marker, no name floating in the sky and no list (§5.3).
 * - **Rare sky is a gift, never a gate.** Meteors are drawn when there are
 *   meteors. An ordinary night is a complete night.
 *
 * Six draw calls, up from two, on an arrival frame measured at about 107 of
 * the 120 the mid tier allows (ARCHITECTURE §10). That is the budget spent
 * deliberately: for a game whose premise is sitting outside at night, the sky
 * is the headline asset, and it was 80% of the frame with nothing in it.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CONSTELLATIONS, createRng, horizonPositionOf, skyTargets, type RitualState } from '@somemore/sim';

/** Radius of the celestial dome, metres. Beyond every fog distance. */
const DOME = 118;

/** How many line segments the streaks may use. */
const METEOR_SEGMENTS = 8;

export interface NightSkyProps {
  ritual: RitualState;
}

/* -------------------------------------------------------------------------- */
/* Star tiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Three tiers, chosen by the star's real magnitude.
 *
 * The direction asked for "1px #6a7080, 1px #c8cede, 2px #ffffff for a dozen"
 * after grading the old sky as "uniformly sized, uniformly bright 1px dots —
 * sensor noise, not a sky". The catalogue already carries a magnitude for
 * every named star, so which tier a star lands in is not a decorative roll:
 * Rigel and Betelgeuse are in the top tier because they are the two brightest
 * things in Orion.
 *
 * The cuts fall at 1.8 and 2.4, which over the catalogue's thirty-one named
 * stars gives eleven in the bright tier — the "dozen" — thirteen in the
 * middle and seven at the bottom.
 */
const TIER_BRIGHT_MAGNITUDE = 1.8;
const TIER_MID_MAGNITUDE = 2.4;

/** Point sizes are in *internal* pixels: the buffer is 320x240 (ADR-0003). */
const SIZE_SOFT = 1;
const SIZE_BRIGHT = 2;

const TINT_FAINT = new THREE.Color(0x6a7080);
const TINT_MID = new THREE.Color(0xc8cede);
const TINT_BRIGHT = new THREE.Color(0xffffff);

export type StarTier = 'faint' | 'mid' | 'bright';

/** Which tier a magnitude lands in. Lower magnitudes are brighter stars. */
export function starTier(magnitude: number): StarTier {
  if (magnitude <= TIER_BRIGHT_MAGNITUDE) return 'bright';
  return magnitude <= TIER_MID_MAGNITUDE ? 'mid' : 'faint';
}

const TIER_TINT: Record<StarTier, THREE.Color> = {
  faint: TINT_FAINT,
  mid: TINT_MID,
  bright: TINT_BRIGHT,
};

/** The magnitude a tier's own nudge range is measured against. */
const TIER_SPAN: Record<StarTier, number> = { bright: 1.8, mid: 2.4, faint: 3.6 };

export interface StarSlot {
  /** Which of the two point clouds this star lives in. */
  readonly bright: boolean;
  /** Its index within that cloud. */
  readonly index: number;
  readonly tier: StarTier;
  readonly tint: THREE.Color;
  /**
   * A small per-star nudge off the tier's own value, from the magnitude.
   *
   * The tiers are meant to be discrete — that discreteness is the fix — but
   * three literally identical values is the same failure at a coarser grain.
   * +/-12% off the tier keeps the three steps readable and stops the sky
   * being three colours.
   */
  readonly nudge: number;
}

/**
 * Which slot every catalogue star occupies, worked out once.
 *
 * The old loop walked the visible targets with a running counter, so a star's
 * buffer index depended on how many constellations happened to be up. That is
 * fine while every star is the same colour and fatal the moment they are not.
 */
export const STAR_SLOTS: ReadonlyMap<string, readonly StarSlot[]> = (() => {
  const slots = new Map<string, StarSlot[]>();
  let bright = 0;
  let soft = 0;
  for (const constellation of CONSTELLATIONS) {
    const row: StarSlot[] = [];
    for (const star of constellation.stars) {
      const magnitude = star[2];
      const tier = starTier(magnitude);
      const isBright = tier === 'bright';
      row.push({
        bright: isBright,
        index: isBright ? bright++ : soft++,
        tier,
        tint: TIER_TINT[tier],
        // Within a tier, brighter is nearer the top of the nudge range.
        nudge: 1.12 - 0.24 * Math.min(1, Math.max(0, magnitude / TIER_SPAN[tier])),
      });
    }
    slots.set(constellation.id, row);
  }
  return slots;
})();

const BRIGHT_COUNT = [...STAR_SLOTS.values()].reduce(
  (total, row) => total + row.filter((slot) => slot.bright).length,
  0,
);
const SOFT_COUNT = [...STAR_SLOTS.values()].reduce(
  (total, row) => total + row.filter((slot) => !slot.bright).length,
  0,
);

/** Joins between consecutive stars within each constellation. */
const JOIN_COUNT = CONSTELLATIONS.reduce((total, c) => total + Math.max(0, c.stars.length - 1), 0);

/* -------------------------------------------------------------------------- */
/* The galaxy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The galactic pole, J2000. This is where the Milky Way actually is.
 *
 * The band is a real object with a real position, so it is placed like one:
 * the galactic equator is converted to right ascension and declination here
 * and then handed to the same `horizonPositionOf` the constellations use. It
 * rises and sets, it lies across the sky at the angle it lies at, and in
 * summer the bright half through Sagittarius is up while in winter it is the
 * faint anticentre — none of which is decoration that had to be authored.
 */
const NGP_RA_DEG = 192.85948;
const NGP_DEC_DEG = 27.12825;
/** Galactic longitude of the north celestial pole. */
const NCP_GALACTIC_LON_DEG = 122.93192;

const DEG = Math.PI / 180;

/** Galactic (l, b) to equatorial, both in degrees in and hours/degrees out. */
export function galacticToEquatorial(lDeg: number, bDeg: number): { raHours: number; decDeg: number } {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const decNgp = NGP_DEC_DEG * DEG;
  const lNcp = NCP_GALACTIC_LON_DEG * DEG;
  const sinDec = Math.sin(decNgp) * Math.sin(b) + Math.cos(decNgp) * Math.cos(b) * Math.cos(lNcp - l);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const y = Math.cos(b) * Math.sin(lNcp - l);
  const x = Math.cos(decNgp) * Math.sin(b) - Math.sin(decNgp) * Math.cos(b) * Math.cos(lNcp - l);
  const ra = NGP_RA_DEG * DEG + Math.atan2(y, x);
  return { raHours: (((ra / (Math.PI * 2)) % 1) + 1) * 24 % 24, decDeg: dec / DEG };
}

/** A unit vector in the equatorial frame: +X at 0h on the equator, +Z at the pole. */
function equatorialVector(raHours: number, decDeg: number): [number, number, number] {
  const ra = (raHours / 24) * Math.PI * 2;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)];
}

/**
 * Half-width of the visible band, degrees, by galactic longitude.
 *
 * The direction asked for a 40px smear. At the world camera's 62 degree field
 * over a 240-line buffer that is 3.87 pixels per degree, so 40px is 10.3
 * degrees across — which is also about what the naked-eye band measures. It
 * is widest through the bulge and narrows towards the anticentre, so this is
 * not a constant.
 */
export function bandHalfWidth(lDeg: number): number {
  const towardCentre = Math.cos(lDeg * DEG) * 0.5 + 0.5;
  return 4.1 + towardCentre * 2.4;
}

/**
 * How bright the band is at a galactic longitude.
 *
 * Overwhelmingly a function of looking towards the centre or away from it —
 * the Sagittarius half is the one people mean when they say they have seen
 * the Milky Way — with the Great Rift cut into it, the dust lane that splits
 * the band in two from Cygnus down to Centaurus. Without the rift a band this
 * wide reads as an airbrush stroke.
 */
export function bandBrightness(lDeg: number): number {
  const l = ((lDeg % 360) + 360) % 360;
  const towardCentre = Math.cos(l * DEG) * 0.5 + 0.5;
  const core = 0.28 + 0.72 * Math.pow(towardCentre, 1.7);
  /*
   * The rift runs roughly l = 25 to l = 75, deepest near the middle of that.
   *
   * It takes 55% out at its deepest, which sounds enormous and is roughly
   * what it does: the Great Rift genuinely halves the band. A first pass took
   * 42% over a wider Gaussian and measured as no dark lane at all — the
   * brightest point of the rift was still brighter than the band at Cygnus,
   * so the dust read as a slight unevenness rather than as the thing that
   * splits the Milky Way in two.
   */
  const rift = Math.exp(-(((l - 50) / 22) ** 2)) * 0.55;
  return Math.max(0.06, core * (1 - rift));
}

/** The band's own colour, from the direction: #2a3040. */
const BAND_COLOUR = new THREE.Color(0x2a3040);

/** Samples along the galactic equator, and rows across it. */
const BAND_SAMPLES = 72;
const BAND_ROWS = [-1, -0.5, 0, 0.5, 1] as const;
/** Unresolved stars in the band: the grain that makes it read as a smear. */
const GRAIN_COUNT = 640;

/**
 * How far above the horizon the band has faded fully in.
 *
 * A hard cut at zero puts a straight edge across the bottom of the galaxy,
 * which no sky has. Fading over the last twelve degrees is also what actually
 * happens: there is a lot more air in the way down there.
 */
const HORIZON_FADE = Math.sin(12 * DEG) * DOME;

/* -------------------------------------------------------------------------- */
/* The moon's halo                                                            */
/* -------------------------------------------------------------------------- */

/*
 * These four numbers have to agree with the moon disc in `Campsite.tsx`,
 * which owns the disc itself: same distance, same horizon floor, and a radius
 * this is a multiple of. If that file moves its moon, this halo has to move
 * with it.
 */
const MOON_DISTANCE = 90;
const MOON_FLOOR = 12;
const MOON_RADIUS = 3.6;

/**
 * Two steps, not a gradient.
 *
 * "A moon with a two-step halo rather than a hard disc." Two flat annuli is
 * the literal reading and also the right one for the idiom: the hardware this
 * is pretending to be could not have drawn a smooth glow, and a dithered
 * two-step ring is what its games did instead. The inner step is roughly the
 * disc again and the outer roughly twice that, which at 3.87 pixels per
 * degree puts the whole halo at about 50 pixels across against an 18-pixel
 * moon.
 */
const HALO_STEPS = [
  // Nearly flat across the step, then a hard drop to the next one. Flat is
  // the point: a halo that ramps smoothly from the disc to nothing is a glow,
  // and a glow is what the direction said this was not.
  { inner: 1.0, outer: 1.85, innerLevel: 0.3, outerLevel: 0.26 },
  // The outer step fades to nothing at its rim rather than ending. A hard
  // outer edge at this brightness draws a 50-pixel circle in the sky, which
  // is a weather effect — a lunar corona — and not what a clear night does.
  { inner: 1.85, outer: 3.1, innerLevel: 0.105, outerLevel: 0 },
] as const;
const HALO_SEGMENTS = 18;

/* -------------------------------------------------------------------------- */

export interface SkyMaterials {
  bright: THREE.PointsMaterial;
  soft: THREE.PointsMaterial;
  grain: THREE.PointsMaterial;
  line: THREE.LineBasicMaterial;
  band: THREE.MeshBasicMaterial;
  halo: THREE.MeshBasicMaterial;
}

/**
 * Every material the sky draws with.
 *
 * Built out here rather than inside the component so a test can assert on it,
 * which is not an abstract nicety — see `fog` below.
 */
export function createSkyMaterials(): SkyMaterials {
  /*
   * `fog: false` on every one of these, and that flag is the bug that made
   * the sky look the way it was graded.
   *
   * The scene carries a linear `THREE.Fog` whose far plane is at most the
   * campsite's draw distance — under fifty metres. Everything here is on a
   * dome at 118 m, so the fog factor is a hard 1, and Three's fog stage
   * replaces the fragment colour *entirely* with the fog colour at factor 1.
   * Every star was therefore drawn at exactly `look.fog`, whatever magnitude
   * it had. "Uniformly sized, uniformly bright 1px dots — sensor noise, not a
   * sky" is not what this code asked for; it is what one defaulted boolean
   * did to it one stage after the magnitudes were computed. A screenshot
   * cannot tell that apart from a deliberately flat sky, which is why
   * `nightsky.test.ts` now asserts the flag rather than trusting the look.
   */
  const point = (size: number): THREE.PointsMaterial =>
    new THREE.PointsMaterial({
      size,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
  // Additive: the galaxy and the halo are light *added* to the sky, and
  // additive blending is the only kind that cannot darken what is behind it —
  // which matters when what is behind it is already nearly black and D7 says
  // a dark wood, never a black rectangle.
  const wash = (): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
  return {
    bright: point(SIZE_BRIGHT),
    soft: point(SIZE_SOFT),
    grain: point(SIZE_SOFT),
    line: new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
    band: wash(),
    // Its own instance, not the band's: the halo drives its own opacity from
    // the moon's phase, and sharing one material had the Milky Way brightening
    // and fading with the moon.
    halo: wash(),
  };
}

export function NightSky({ ritual }: NightSkyProps): React.ReactElement {
  const brightRef = useRef<THREE.Points>(null);
  const softRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const galaxyRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  const brightGeometry = useMemo(() => pointCloud(BRIGHT_COUNT), []);
  useEffect(() => () => brightGeometry.dispose(), [brightGeometry]);
  const softGeometry = useMemo(() => pointCloud(SOFT_COUNT), []);
  useEffect(() => () => softGeometry.dispose(), [softGeometry]);

  const lineGeometry = useMemo(() => pointCloud((JOIN_COUNT + METEOR_SEGMENTS) * 2), []);
  useEffect(() => () => lineGeometry.dispose(), [lineGeometry]);

  const galaxy = useMemo(() => buildGalaxy(), []);
  useEffect(
    () => () => {
      galaxy.band.dispose();
      galaxy.grain.dispose();
    },
    [galaxy],
  );

  const halo = useMemo(() => buildHalo(), []);
  useEffect(() => () => halo.dispose(), [halo]);

  const materials = useMemo(() => createSkyMaterials(), []);
  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose();
    },
    [materials],
  );

  useFrame(({ camera }) => {
    const stargazing = ritual.stargazing;
    const cloud = ritual.weather.cloudCover;
    const targets = skyTargets(stargazing, cloud);

    const brightPositions = brightGeometry.getAttribute('position') as THREE.BufferAttribute;
    const brightColours = brightGeometry.getAttribute('color') as THREE.BufferAttribute;
    const softPositions = softGeometry.getAttribute('position') as THREE.BufferAttribute;
    const softColours = softGeometry.getAttribute('color') as THREE.BufferAttribute;
    const linePositions = lineGeometry.getAttribute('position') as THREE.BufferAttribute;
    const lineColours = lineGeometry.getAttribute('color') as THREE.BufferAttribute;

    let segment = 0;
    let anythingVisible = false;

    for (const target of targets) {
      const constellation = CONSTELLATIONS.find((candidate) => candidate.id === target.id);
      const slots = STAR_SLOTS.get(target.id);
      if (!constellation || !slots) continue;
      // Binoculars gather more light, so faint stars come up through them.
      const gain = stargazing.binoculars ? 1.5 : 1;
      const clarity = Math.min(1, target.clarity * gain);
      const visible = target.up && clarity > 0.015;
      if (visible) anythingVisible = true;

      let previousX = 0;
      let previousY = 0;
      let previousZ = 0;
      for (let i = 0; i < constellation.stars.length; i++) {
        const entry = constellation.stars[i]!;
        const slot = slots[i]!;
        // The catalogue's star offsets are a local frame in degrees-ish; they
        // are applied around the constellation's own alt/az so the shape stays
        // the shape while the whole thing rises and sets.
        const azimuth = target.azimuth + entry[0] * 0.14;
        const altitude = target.altitude + entry[1] * 0.14;
        const cosAlt = Math.cos(altitude);
        const x = Math.sin(azimuth) * cosAlt * DOME;
        const y = Math.sin(altitude) * DOME;
        const z = Math.cos(azimuth) * cosAlt * DOME;

        const positions = slot.bright ? brightPositions : softPositions;
        const colours = slot.bright ? brightColours : softColours;
        positions.setXYZ(slot.index, x, visible ? y : -DOME, z);
        // The tier owns the colour; clarity owns whether it is there at all.
        const level = visible ? slot.nudge * clarity : 0;
        colours.setXYZ(
          slot.index,
          slot.tint.r * level,
          slot.tint.g * level,
          slot.tint.b * level,
        );

        if (i > 0 && segment < JOIN_COUNT) {
          // The joins only exist once a player has picked this one out. That
          // is as close to a label as a constellation ever gets here.
          const known = target.known && visible;
          const faint = known ? 0.16 * clarity : 0;
          linePositions.setXYZ(segment * 2, previousX, known ? previousY : -DOME, previousZ);
          linePositions.setXYZ(segment * 2 + 1, x, known ? y : -DOME, z);
          lineColours.setXYZ(segment * 2, faint, faint * 1.05, faint * 1.2);
          lineColours.setXYZ(segment * 2 + 1, faint, faint * 1.05, faint * 1.2);
          segment++;
        }
        previousX = x;
        previousY = y;
        previousZ = z;
      }
    }

    // Any unused join is parked below the horizon.
    for (let i = segment; i < JOIN_COUNT; i++) {
      linePositions.setXYZ(i * 2, 0, -DOME, 0);
      linePositions.setXYZ(i * 2 + 1, 0, -DOME, 0);
      lineColours.setXYZ(i * 2, 0, 0, 0);
      lineColours.setXYZ(i * 2 + 1, 0, 0, 0);
    }

    // --- Meteors ------------------------------------------------------------
    for (let i = 0; i < METEOR_SEGMENTS; i++) {
      const index = JOIN_COUNT + i;
      const meteor = stargazing.meteors[i];
      if (!meteor) {
        linePositions.setXYZ(index * 2, 0, -DOME, 0);
        linePositions.setXYZ(index * 2 + 1, 0, -DOME, 0);
        lineColours.setXYZ(index * 2, 0, 0, 0);
        lineColours.setXYZ(index * 2 + 1, 0, 0, 0);
        continue;
      }
      anythingVisible = true;
      // The streak is where it has been, not where it is: a meteor is a line.
      const tail = 0.12;
      const headAz = meteor.azimuth;
      const headAlt = meteor.altitude;
      const tailAz = headAz - Math.cos(meteor.heading) * meteor.speed * tail;
      const tailAlt = headAlt - Math.sin(meteor.heading) * meteor.speed * tail;
      const life = Math.max(0, 1 - meteor.age / meteor.lifeSeconds);
      const bright = meteor.brightness * life;
      linePositions.setXYZ(index * 2, ...domePoint(headAz, headAlt));
      linePositions.setXYZ(index * 2 + 1, ...domePoint(tailAz, tailAlt));
      lineColours.setXYZ(index * 2, bright, bright * 0.97, bright * 0.9);
      // The tail fades to nothing, which is what makes it read as motion.
      lineColours.setXYZ(index * 2 + 1, 0, 0, 0);
    }

    brightPositions.needsUpdate = true;
    brightColours.needsUpdate = true;
    softPositions.needsUpdate = true;
    softColours.needsUpdate = true;
    linePositions.needsUpdate = true;
    lineColours.needsUpdate = true;

    if (brightRef.current) brightRef.current.visible = anythingVisible;
    if (softRef.current) softRef.current.visible = anythingVisible;
    if (linesRef.current) linesRef.current.visible = anythingVisible;

    // --- The galaxy ---------------------------------------------------------
    /*
     * The sky is rigid, so the band does not have to be recomputed: the whole
     * equatorial frame rotates into the horizon frame as one, and the mesh
     * carries that rotation on its own transform.
     *
     * The basis is *measured* rather than derived — the images of two points
     * on the celestial equator, through the same `horizonPositionOf` the
     * stars go through, and the third axis from their cross product. Deriving
     * the matrix by hand would have meant re-deriving the sim's azimuth
     * convention (which is measured from the south, not the north, whatever
     * the old comment in this file said) and getting it wrong silently. Two
     * calls a frame buys a guarantee that the galaxy cannot drift away from
     * the constellations.
     */
    if (galaxyRef.current) {
      const date = new Date(stargazing.epochMs + stargazing.elapsed * 1000 * stargazing.timeScale);
      skyBasis(date, stargazing.latitudeDeg, stargazing.longitudeDeg, BASIS);
      galaxyRef.current.matrix.copy(BASIS);
      galaxyRef.current.matrixWorldNeedsUpdate = true;

      /*
       * How much galaxy there is tonight.
       *
       * `starVisibility` already folds in twilight and the moon's own wash;
       * cloud is applied here, once, exactly as `skyTargets` does it. Squared,
       * because the band is a low-contrast object and is the first thing a
       * hazy sky takes away — long before it takes the stars.
       */
      const visibility = Math.max(
        0,
        Math.min(1, stargazing.sky.starVisibility * (1 - cloud * 0.95) * stargazing.skyOpenness),
      ) ** 2;
      fadeAtHorizon(galaxy.band, BASIS, visibility);
      fadeAtHorizon(galaxy.grain, BASIS, visibility);
      galaxyRef.current.visible = visibility > 0.01;
    }

    // --- The moon's halo ----------------------------------------------------
    if (haloRef.current) {
      const moon = stargazing.sky.moon;
      const above = Math.max(0, Math.sin(moon.altitude));
      /*
       * A thin moon has a small halo and a full one has a large one, because
       * the halo is the moon's own light scattered in the air. The horizon
       * floor matches the disc's: `Campsite.tsx` parks the moon above the
       * treeline rather than letting it set into the ground, and a halo that
       * did not do the same would slide off it.
       */
      const strength = moon.visible ? moon.illumination * (0.35 + above * 0.65) : 0;
      const level = strength * (1 - cloud * 0.6);
      haloRef.current.visible = level > 0.02;
      if (haloRef.current.visible) {
        const horizontal = Math.cos(moon.altitude) * MOON_DISTANCE;
        haloRef.current.position.set(
          Math.sin(moon.azimuth) * horizontal,
          Math.max(MOON_FLOOR, Math.sin(moon.altitude) * MOON_DISTANCE),
          Math.cos(moon.azimuth) * horizontal,
        );
        // Flat, and turned to face the eye — the disc it wraps does the same.
        haloRef.current.lookAt(camera.position);
        (haloRef.current.material as THREE.MeshBasicMaterial).opacity = level;
      }
    }
  });

  return (
    <group name="night-sky">
      <points ref={softRef} geometry={softGeometry} material={materials.soft} frustumCulled={false} />
      <points ref={brightRef} geometry={brightGeometry} material={materials.bright} frustumCulled={false} />
      <lineSegments ref={linesRef} geometry={lineGeometry} material={materials.line} frustumCulled={false} />
      {/*
        Drawn before the stars so the stars sit on top of it rather than in
        it, and never written to the depth buffer — the whole sky is one
        surface as far as depth is concerned.
      */}
      <group ref={galaxyRef} name="milky-way" renderOrder={-2} matrixAutoUpdate={false}>
        <mesh geometry={galaxy.band} material={materials.band} frustumCulled={false} />
        <points geometry={galaxy.grain} material={materials.grain} frustumCulled={false} />
      </group>
      <mesh ref={haloRef} geometry={halo} material={materials.halo} frustumCulled={false} renderOrder={-1} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

/** Scratch, so a frame allocates nothing. */
const BASIS = new THREE.Matrix4();
const AXIS_A = new THREE.Vector3();
const AXIS_B = new THREE.Vector3();
const AXIS_C = new THREE.Vector3();

function pointCloud(count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  return geometry;
}

/** Alt/az to a point on the dome. */
function domePoint(azimuth: number, altitude: number): [number, number, number] {
  const cosAlt = Math.cos(altitude);
  return [Math.sin(azimuth) * cosAlt * DOME, Math.sin(altitude) * DOME, Math.cos(azimuth) * cosAlt * DOME];
}

/**
 * The rotation that takes the equatorial frame to this place and moment.
 *
 * Measured, not derived: see the note at the call site. `horizonPositionOf`
 * is never asked for the pole itself, because the sim's azimuth formula has a
 * `tan(declination)` in it and the pole is exactly where that blows up.
 */
export function skyBasis(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  const first = horizonPositionOf(0, 0, date, latitudeDeg, longitudeDeg);
  const second = horizonPositionOf(6, 0, date, latitudeDeg, longitudeDeg);
  AXIS_A.set(...domePoint(first.azimuth, first.altitude)).normalize();
  AXIS_B.set(...domePoint(second.azimuth, second.altitude)).normalize();
  /*
   * B cross A, not A cross B.
   *
   * The sim measures azimuth from the south and increasing westward, so
   * equatorial-to-horizon is a *reflection* rather than a rotation: its
   * determinant is -1. Taking the cross product the other way round gives a
   * proper rotation that agrees with `horizonPositionOf` on the two axes it
   * was built from and disagrees with it on everything else — which is
   * exactly what the first version did, and the band came out mirrored
   * through the meridian while still looking entirely plausible. The
   * materials here are `DoubleSide`, so the flipped winding costs nothing.
   */
  AXIS_C.crossVectors(AXIS_B, AXIS_A).normalize();
  return out.makeBasis(AXIS_A, AXIS_B, AXIS_C);
}

/**
 * Dims a static sky object towards the horizon and by tonight's clarity.
 *
 * The positions never change — the group's matrix moves them — so the only
 * thing that has to be recomputed per frame is how much of each vertex is
 * left, which is one dot product against the matrix's up row. That is about
 * a thousand multiplies for the whole galaxy.
 */
export function fadeAtHorizon(
  geometry: THREE.BufferGeometry,
  basis: THREE.Matrix4,
  visibility: number,
): void {
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colours = geometry.getAttribute('color') as THREE.BufferAttribute;
  const baked = geometry.getAttribute('baked') as THREE.BufferAttribute;
  const e = basis.elements;
  for (let i = 0; i < positions.count; i++) {
    const height =
      (e[1] as number) * positions.getX(i) +
      (e[5] as number) * positions.getY(i) +
      (e[9] as number) * positions.getZ(i);
    const t = Math.max(0, Math.min(1, height / HORIZON_FADE));
    const level = t * t * (3 - 2 * t) * visibility;
    colours.setXYZ(i, baked.getX(i) * level, baked.getY(i) * level, baked.getZ(i) * level);
  }
  colours.needsUpdate = true;
}

/**
 * The band and its grain, in the equatorial frame.
 *
 * `baked` holds the colour the vertex would have at the zenith on a perfect
 * night; `color` is that, dimmed, and is rewritten each frame. Keeping the
 * two apart is what lets the fade be a multiply rather than a rebuild.
 */
export function buildGalaxy(): { band: THREE.BufferGeometry; grain: THREE.BufferGeometry } {
  const positions: number[] = [];
  const baked: number[] = [];
  const indices: number[] = [];
  const rng = createRng('milky-way');

  for (let s = 0; s < BAND_SAMPLES; s++) {
    const lon = (s / BAND_SAMPLES) * 360;
    const halfWidth = bandHalfWidth(lon);
    const brightness = bandBrightness(lon);
    /*
     * Mottle, per sample, seeded.
     *
     * A band whose only variation is a smooth function of longitude is an
     * airbrush stroke; the real thing is lumpy at every scale, and the lumps
     * are what stop a 40-pixel smear reading as a gradient the dither will
     * band. ADR-0001 does not reach this file, but "the same sky twice" does,
     * so it is seeded rather than random.
     */
    const mottle = 0.72 + rng.next() * 0.56;
    for (let r = 0; r < BAND_ROWS.length; r++) {
      const across = BAND_ROWS[r] as number;
      const { raHours, decDeg } = galacticToEquatorial(lon, across * halfWidth);
      const [x, y, z] = equatorialVector(raHours, decDeg);
      // Just outside the star dome, so a star is never inside the galaxy.
      positions.push(x * DOME * 1.01, y * DOME * 1.01, z * DOME * 1.01);
      // Across the band: brightest on the axis, gone at the edge. Squared
      // rather than linear because the edge of the Milky Way is not an edge.
      const profile = (1 - Math.abs(across)) ** 2;
      const level = brightness * mottle * profile;
      baked.push(BAND_COLOUR.r * level, BAND_COLOUR.g * level, BAND_COLOUR.b * level);
    }
  }
  for (let s = 0; s < BAND_SAMPLES; s++) {
    const next = (s + 1) % BAND_SAMPLES;
    for (let r = 0; r < BAND_ROWS.length - 1; r++) {
      const a = s * BAND_ROWS.length + r;
      const b = next * BAND_ROWS.length + r;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const band = new THREE.BufferGeometry();
  band.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  band.setAttribute('baked', new THREE.Float32BufferAttribute(baked, 3));
  band.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(baked.length), 3));
  band.setIndex(indices);

  /*
   * The grain: unresolved stars, which is what the Milky Way is made of.
   *
   * Also the dither. The direction asked for a "dithered smear" and the
   * ordered dither in `ps1.ts` is per-material and does not reach a mesh that
   * is not a PS1 material; a few hundred single-pixel points scattered
   * through the band is a stochastic dither instead, costs one draw call, and
   * is the honest thing to draw besides.
   *
   * Capped below the faintest star tier on purpose. The band is made of stars
   * you cannot separate — if a grain point were as bright as a catalogue star
   * the hierarchy the three tiers just bought would go straight back out.
   */
  const grainPositions: number[] = [];
  const grainBaked: number[] = [];
  const grainRng = createRng('milky-way-grain');
  for (let i = 0; i < GRAIN_COUNT; i++) {
    const lon = grainRng.next() * 360;
    // Concentrated towards the axis: two uniforms averaged is a triangle
    // distribution, which is close enough to the profile and free.
    const across = (grainRng.next() + grainRng.next() - 1) * bandHalfWidth(lon);
    const { raHours, decDeg } = galacticToEquatorial(lon, across);
    const [x, y, z] = equatorialVector(raHours, decDeg);
    grainPositions.push(x * DOME * 1.005, y * DOME * 1.005, z * DOME * 1.005);
    const level = bandBrightness(lon) * (0.3 + grainRng.next() * 0.7) * 0.55;
    grainBaked.push(TINT_FAINT.r * level, TINT_FAINT.g * level, TINT_FAINT.b * level);
  }
  const grain = new THREE.BufferGeometry();
  grain.setAttribute('position', new THREE.Float32BufferAttribute(grainPositions, 3));
  grain.setAttribute('baked', new THREE.Float32BufferAttribute(grainBaked, 3));
  grain.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(grainBaked.length), 3));

  return { band, grain };
}

/** Two flat annuli, brightest inside, sharing one draw call with the band. */
export function buildHalo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  for (const step of HALO_STEPS) {
    const base = positions.length / 3;
    for (let i = 0; i <= HALO_SEGMENTS; i++) {
      const angle = (i / HALO_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(cos * step.inner * MOON_RADIUS, sin * step.inner * MOON_RADIUS, 0);
      positions.push(cos * step.outer * MOON_RADIUS, sin * step.outer * MOON_RADIUS, 0);
      // Faintly cold, the way moonlight scattered through air actually is.
      colours.push(step.innerLevel, step.innerLevel, step.innerLevel * 1.06);
      colours.push(step.outerLevel, step.outerLevel, step.outerLevel * 1.06);
    }
    for (let i = 0; i < HALO_SEGMENTS; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  return geometry;
}
