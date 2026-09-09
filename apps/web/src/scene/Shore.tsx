/**
 * The water's edge.
 *
 * Everything to do with the water lives here, because at a campsite everything
 * to do with the water lives in one place: the surface, the rings a thing
 * makes when it touches it, the stones lying about to throw, the one in the
 * air, and the rod somebody left leaning on a log.
 *
 * Rendered only where the environment manifest actually has water — several
 * campsites are a salt flat, a mesa or a rail siding, and at those this
 * component returns nothing at all rather than an empty pond.
 *
 * Draw calls are the constraint here (ARCHITECTURE §10 budgets 120 and the
 * arrival frame is already at the ceiling), so the loose stones and the
 * ripples are each one `InstancedMesh` rather than one object apiece, and the
 * rod, the line and the float only exist while the rod is in somebody's hands.
 *
 * ## The slab
 *
 * An art review found "a hard-edged, flat, saturated blue-cyan horizontal band
 * (approx #2a4a63) in the mid-ground with knife edges and no reflection, no
 * ripple, no shoreline, no value gradient", and asked what it was meant to be.
 * The catalogue answers: at the default campsite it is *the creek behind the
 * site*, two metres forty across, ankle deep, and `basinFor` cuts a matching
 * channel into the terrain with a near bank and a far bank.
 *
 * The band was that creek drawn twenty-nine times too wide. The surface was a
 * flat 70x70 metre plane, unrotated, parked at `distanceM + 35`, so every
 * square metre of it past the far bank was water laid over the hillside behind
 * the creek. Two numbers made it luminous as well as enormous: `waterColour`
 * went into `emissive` at an intensity that reached 2.5, which takes the
 * catalogue's dark #22303a to exactly the #2a4a63 the review measured — a
 * value nobody chose, arrived at by multiplication.
 *
 * So the surface is now the size and the shape of the water the catalogue
 * declares, turned to lie along the bank, and dark. What used to be spent on
 * area is spent on three things instead:
 *
 *   - **the fire on the water.** Not a mirror image — a fire and an eye on the
 *     same bank can never see one — but the specular glitter off the wave
 *     facets that happen to be tilted right, which is what a campfire actually
 *     does to water and is the reason the effect is a broken streak rather
 *     than a picture of a flame. One additive pass over the same vertices.
 *   - **a value gradient**, cool and low, brightest where the surface meets
 *     each bank at a grazing angle and darkest down the middle.
 *   - **wet stones along both banks**, so the water ends in a shoreline
 *     instead of at a knife edge.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  clamp01,
  ripplePresence,
  terrainHeight,
  waveHeight,
  type RitualState,
  type WalkableWorld,
  type WaterState,
} from '@somemore/sim';
import { createPs1Material, type QualityTier, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';

/**
 * How far along the bank the surface is drawn, and at what resolution.
 *
 * Both were 70 metres and 28 segments, which is a two-and-a-half metre cell —
 * coarser than the wavelength the simulation's own `waveHeight` uses, so the
 * chop was being sampled below its own Nyquist and drawn as long smooth
 * ribbons. It also put fifty of those seventy metres past the fog, where they
 * cost vertices and returned nothing.
 *
 * Shorter and finer instead, at about the same vertex count: a channel gets
 * half-metre cells along its bank, open water gets one-and-a-half. The cell is
 * also the additive pass's dither cell, so this is the resolution of the fire
 * on the water as well as of the water.
 */
const CHANNEL_LENGTH_M = 48;
const CHANNEL_SEGMENTS = 84;
const SURFACE_M = 56;
const SURFACE_SEGMENTS = 32;
/**
 * Water narrower than this is a channel with two banks rather than open water.
 * Same threshold `basinFor` uses to decide whether to cut a far bank into the
 * terrain, and it has to stay the same threshold: a surface that thinks it is
 * a lake sitting in a bed that thinks it is a creek is the old defect again.
 */
const CHANNEL_WIDTH_M = 8;
/** Ripple rings drawn at once. Matches the model's own bound. */
const RIPPLE_POOL = 12;
/** Loose stones drawn on the shingle. */
const STONE_POOL = 5;
/**
 * How much of that grid each tier actually gets.
 *
 * The pass is per cell and runs every frame, so this is the one dial that
 * matters for cost: a phone draws a coarser creek and a coarser dither with
 * it, which is the right thing to lose first — the streak is still a streak at
 * half the resolution, and the alternative is losing the streak.
 */
const SURFACE_DETAIL: Record<QualityTier, number> = { low: 0.55, mid: 1, high: 1 };

/** Wet stones along the bank. One `InstancedMesh`, so one draw call. */
const BANK_POOL: Record<QualityTier, number> = { low: 0, mid: 16, high: 26 };

/**
 * Steps the fire's reflection is quantised to before it is dithered.
 *
 * The additive pass is a `MeshBasicMaterial`, so the ordered dither in
 * `ps1.ts` — which is per-material and lives in the standard material's
 * fragment stage — never reaches it. Quantising the per-vertex level to five
 * steps and offsetting alternate vertices by half a step is the same dither
 * done a stage earlier, on a grid whose cells are about twelve internal pixels
 * across at the distance the water actually sits. Without it the streak is a
 * smooth airbrushed smear, which is the one thing it must not be.
 */
const GLITTER_STEPS = 5;

/**
 * The gamma the quantiser works in.
 *
 * Five steps applied to a linear level is not a dither, it is a cliff: the
 * first version rounded a firelight level of 0.03 straight to zero and the
 * whole pass rendered as nothing at all — a render feature discarded one line
 * after it was computed, which looks exactly like one that was never written.
 * Stepping in roughly perceptual space instead puts the five steps where an
 * eye can see them, which is what a dither is for.
 */
const GLITTER_GAMMA = 2.2;

/**
 * Where the additive pass starts and finishes fading, metres from the eye.
 *
 * It carries no scene fog (see the material), so it does its own. The far
 * number is inside the shortest `drawDistanceM` in the catalogue — the cedar
 * switchback's 42 — so the streak has always ended before the fog would have
 * ended it, whichever campsite this is.
 */
const FOG_NEAR_M = 7;
const FOG_FAR_M = 34;

/**
 * How far the fire's light carries onto the water, metres.
 *
 * The half-power distance of the pool: at this range the warm patch is at half
 * strength, and the falloff is inverse-square from there. Six metres puts the
 * bright part of the pool a good few metres wide on a shore that `shoreFor`
 * places between three and a half and nine and a half metres out, which is
 * what makes it a patch of light on the water rather than a wash over all of
 * it or a dot in the middle.
 */
const POOL_REACH_M = 6;

/**
 * How hard the pool is driven, once distance and clarity have had their say.
 *
 * This is the one frankly arbitrary number here: the additive pass has no
 * physical unit, so what it comes down to is how much orange there should be
 * on the water when a good fire is going nine metres away. Tuned against a
 * render rather than derived, and the render is what it is for.
 */
const POOL_GAIN = 2.6;

/** How far apart the two probes that measure the surface's lean are. */
const SLOPE_EPSILON_M = 0.2;

/**
 * The colour of firelight on water.
 *
 * Warmer and less saturated than the flame itself: what reaches the eye off a
 * wave facet has been through the water's own surface twice. The catalogue's
 * `fireGlow` values sit around #ff9b47, so this is that, pulled down.
 */
const FIRE_ON_WATER = new THREE.Color(0xff8a3c);
/** The cool light the surface returns where it meets a bank at a grazing angle. */
const BANK_SHEEN = new THREE.Color(0x93a9c0);

export interface ShoreProps {
  ritual: RitualState;
  settings: RenderSettings;
  walkable: WalkableWorld;
  /** Water tint from the environment's night palette, if it has one. */
  waterColour?: string | null;
  /** Scales the bank's stone count. Absent means the middle tier. */
  quality?: QualityTier;
  /** The stones or the rod, tapped. Gated by reach in the world, not here. */
  onTouch?: (id: 'stones' | 'rod') => void;
}

export function Shore({
  ritual,
  settings,
  walkable,
  waterColour,
  quality = 'mid',
  onTouch,
}: ShoreProps): React.ReactElement | null {
  const water = ritual.water;

  const surfaceRef = useRef<THREE.Mesh>(null);
  const glitterRef = useRef<THREE.Mesh>(null);
  const rippleRef = useRef<THREE.InstancedMesh>(null);
  const stoneRef = useRef<THREE.InstancedMesh>(null);
  const bankRef = useRef<THREE.InstancedMesh>(null);
  const flyingRef = useRef<THREE.Mesh>(null);
  const floatRef = useRef<THREE.Mesh>(null);
  const lineRef = useRef<THREE.LineSegments>(null);
  const rodRef = useRef<THREE.Group>(null);

  /**
   * The surface material.
   *
   * Self-lit, and that is not a shortcut. There is no light out at the shore —
   * the fire is eight metres away and falls off — so a purely lit surface
   * rendered as pure black, which at 5-bit quantisation means *nothing at
   * all*, not "very dark" (ARCHITECTURE §4.1). It was screenshotted looking
   * exactly like a missing mesh.
   *
   * A lake at night is also, in fact, the brightest thing in a landscape,
   * because it is a mirror pointed at the sky. So the emissive term is the sky
   * it is reflecting, driven per frame by the stargazing model's own moon and
   * starlight — which is why an overcast night dims the water and a full moon
   * lights it up.
   *
   * What it must not be is *bright*. The emissive intensity used to reach 2.5
   * on a clear night, and 2.5 x #22303a is #2a4a63 — the most saturated and
   * coolest thing on a screen whose whole palette is warm brown and orange, in
   * the mid-ground, drawing the eye off the fire. The scale below tops out
   * near 1.2 under a full moon and sits around 0.6 on an ordinary clear night,
   * which is a dark value rather than a black one (D7) and leaves every bright
   * thing on the water to the additive pass that follows.
   */
  const surfaceMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('water', { size: 64, seed: water ? water.seed : 1 }),
        color: waterColour ?? '#16242c',
        emissive: waterColour ?? '#243a4a',
        emissiveIntensity: 1,
        roughness: 0.24,
        metalness: 0.3,
        transparent: true,
        opacity: 0.96,
        flatShading: true,
      }),
    [settings, water, waterColour],
  );

  /**
   * The light *on* the water, as opposed to the water.
   *
   * Additive and unlit, the same choice the Milky Way's band makes and for the
   * same reason: this is light arriving at the eye off a surface, and additive
   * blending is the only kind that cannot darken what is behind it. It shares
   * the surface's geometry — so the streak rides the same wavelets the
   * simulation is displacing, for free — and carries its own `color`
   * attribute, which the surface material ignores.
   */
  const glitterMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        /*
         * `fog: false`, and the flag is load-bearing — the same one that was
         * eating the stars in `NightSky`. Three's fog stage *replaces* the
         * fragment colour with the fog colour rather than tinting it, so an
         * additive pass carrying fog adds the fog colour across its whole
         * footprint, including everywhere the glitter is zero. That would
         * paint a flat luminous band over the water: the exact defect this
         * pass exists to remove, reintroduced one stage later. The distance
         * fall-off is done per vertex in `paintGlitter` instead.
         */
        fog: false,
      }),
    [],
  );
  useEffect(() => () => glitterMaterial.dispose(), [glitterMaterial]);

  const shingleMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('stone', { size: 64 }), roughness: 1 }),
    [settings],
  );

  /**
   * Wet stone: the same rock, darker and shinier, because it is wet.
   *
   * A bank drawn in dry shingle is the knife edge again with lumps on it. The
   * step in value between this and `shingleMaterial` is what reads as a
   * waterline from eight metres away.
   */
  const wetMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('stone', { size: 64 }),
        color: '#6b6a63',
        roughness: 0.42,
        metalness: 0.18,
      }),
    [settings],
  );

  /**
   * How big the water is, and where.
   *
   * `basinFor` cuts the bed: open water is everything past `distanceM`, and a
   * channel runs from `distanceM` to `distanceM + widthM` with a far bank. The
   * surface has to be the same shape as the bed it sits in, which is the whole
   * of the fix — the old plane was 70 metres across whatever the catalogue
   * said, so at a two-metre creek sixty-eight of those metres were water drawn
   * over the hillside behind it.
   *
   * `across` runs from bank to bank, `along` runs down the bank and off into
   * the fog. Half a metre of tuck at each edge puts the waterline underneath
   * the bank rather than beside it.
   */
  const plan = useMemo(() => {
    if (!water) return null;
    const detail = SURFACE_DETAIL[quality];
    const width = water.spec.widthM;
    const channel = width < CHANNEL_WIDTH_M;
    const acrossM = channel ? Math.max(1.2, width) + 0.9 : SURFACE_M;
    // The middle of the water, measured out along the shore bearing.
    const centreM = channel ? water.shore.distanceM + width / 2 : water.shore.distanceM + SURFACE_M / 2 - 1.5;
    // Roughly a cell every 40cm across a creek, and the old resolution on open
    // water. The glitter is quantised per vertex, so this is also how coarse
    // the dither on the reflection is.
    const acrossSegments = Math.max(
      4,
      Math.round(
        (channel ? Math.min(SURFACE_SEGMENTS, Math.max(4, acrossM * 2.5)) : SURFACE_SEGMENTS) * detail,
      ),
    );
    return {
      acrossM,
      centreM,
      acrossSegments,
      alongM: channel ? CHANNEL_LENGTH_M : SURFACE_M,
      alongSegments: Math.round((channel ? CHANNEL_SEGMENTS : SURFACE_SEGMENTS) * detail),
    };
  }, [water, quality]);

  /**
   * The surface mesh.
   *
   * A plane lying along the bank, displaced per frame from the simulation's
   * own `waveHeight`. The displacement is what makes chop *visible*: a mirror
   * and a blown lake have to look different, because the whole of stone
   * skipping turns on the difference.
   *
   * `rotateX(-PI/2)` lays it flat with local +X along the bank and local +Z
   * away from it; the mesh's own `rotation.y` then turns local +Z onto the
   * shore bearing. The old plane had no Y rotation at all, so a creek running
   * north-east was drawn as a slab running due north.
   */
  const surfaceGeometry = useMemo(() => {
    if (!plan) return new THREE.BufferGeometry();
    const geometry = new THREE.PlaneGeometry(
      plan.alongM,
      plan.acrossM,
      plan.alongSegments,
      plan.acrossSegments,
    );
    geometry.rotateX(-Math.PI / 2);
    // Read by the additive pass only. The water's own material has
    // `vertexColors` off, so it never sees this.
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3), 3),
    );
    return geometry;
  }, [plan]);
  useEffect(() => () => surfaceGeometry.dispose(), [surfaceGeometry]);

  /**
   * The additive pass's own geometry: the same grid, unwelded.
   *
   * It cannot share the surface's buffer, and finding out why cost a render.
   * A colour written per vertex is *interpolated* across the triangle, so
   * quantising it into five steps and then handing it to a rasteriser that
   * ramps smoothly between them throws the quantisation away in the next
   * stage: the first version of this dithered the level carefully and drew a
   * perfectly smooth airbrushed gradient. Which is the house lesson again — a
   * render feature that is silently discarded looks exactly like one that was
   * never written, and only a picture catches it.
   *
   * So six vertices a cell, no sharing, one flat colour across both triangles.
   * The cell is then the dither's pixel, hard-edged, which is what the machine
   * this is imitating would have drawn anyway.
   */
  const glitterGeometry = useMemo(() => {
    if (!plan) return new THREE.BufferGeometry();
    const quads = plan.alongSegments * plan.acrossSegments;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads * 18), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(quads * 18), 3));
    return geometry;
  }, [plan]);
  useEffect(() => () => glitterGeometry.dispose(), [glitterGeometry]);

  const rippleGeometry = useMemo(() => new THREE.RingGeometry(0.85, 1, 14), []);
  useEffect(() => () => rippleGeometry.dispose(), [rippleGeometry]);
  const rippleMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  const stoneGeometry = useMemo(() => new THREE.DodecahedronGeometry(0.05, 0), []);
  useEffect(() => () => stoneGeometry.dispose(), [stoneGeometry]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const rippleColour = useMemo(() => new THREE.Color(), []);

  /** Where the shore is, in world space. */
  const shore = useMemo(() => {
    if (!water) return null;
    const cos = Math.cos(water.shore.bearing);
    const sin = Math.sin(water.shore.bearing);
    return {
      cos,
      sin,
      x: cos * water.shore.distanceM,
      z: sin * water.shore.distanceM,
      surfaceY: water.shore.surfaceY,
    };
  }, [water]);

  // The loose stones are laid out once: the same handful on every visit, in
  // the same places, because that is what a shore is.
  useEffect(() => {
    const mesh = stoneRef.current;
    if (!mesh || !water || !shore) return;
    for (let i = 0; i < STONE_POOL; i++) {
      const spread = (i - (STONE_POOL - 1) / 2) * 0.34;
      const x = shore.x - shore.sin * spread - shore.cos * 0.55;
      const z = shore.z + shore.cos * spread - shore.sin * 0.55;
      dummy.position.set(x, terrainHeight(x, z, walkable.seed, walkable.amplitude, walkable.basin) + 0.03, z);
      dummy.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      dummy.scale.setScalar(0.8 + (i % 3) * 0.22);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [water, shore, walkable, dummy]);

  /**
   * The bank.
   *
   * Wet stones scattered along the waterline — both waterlines where the
   * catalogue says a channel, the near one where it says open water. Sunk to
   * varying depths and jittered along and across the line, because the
   * complaint the bank answers is a *knife edge*: an irregular silhouette is
   * the entire brief, and a tidy row of stones would be a knife edge with
   * bumps in it.
   *
   * Laid out once, from a hash of the index and the campsite's own water seed,
   * so the bank is the same bank on every visit — the same discipline the
   * skipping stones already keep.
   */
  useEffect(() => {
    const mesh = bankRef.current;
    if (!mesh || !water || !shore || !plan) return;
    const count = BANK_POOL[quality];
    const channel = water.spec.widthM < CHANNEL_WIDTH_M;
    const farOffset = channel ? water.spec.widthM : 0;
    for (let i = 0; i < count; i++) {
      // Alternate banks where there are two, so neither is ever bare.
      const far = channel && i % 2 === 1;
      const t = hash01(water.seed, i * 3 + 1);
      const jitterAcross = (hash01(water.seed, i * 3 + 2) - 0.5) * 0.5;
      const jitterUp = hash01(water.seed, i * 3 + 3);
      // Spread down the bank, denser near the point the player comes to.
      const spread = (t - 0.5) * (channel ? 7.5 : 9.5);
      const out = water.shore.distanceM + (far ? farOffset : 0) + jitterAcross;
      const x = shore.cos * out - shore.sin * spread;
      const z = shore.sin * out + shore.cos * spread;
      const ground = terrainHeight(x, z, walkable.seed, walkable.amplitude, walkable.basin);
      // A third of them break the surface; the rest are under it, which is
      // what makes the waterline read as a waterline rather than as a kerb.
      const scale = 1.7 + jitterUp * 3.1;
      dummy.position.set(x, ground + 0.05 * scale * (0.25 + jitterUp * 0.5), z);
      dummy.rotation.set(t * 5.1, jitterAcross * 9.3, jitterUp * 4.7);
      dummy.scale.set(scale, scale * (0.5 + jitterUp * 0.4), scale * (0.8 + t * 0.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    for (let i = count; i < BANK_POOL.high; i++) {
      dummy.position.set(0, -60, 0);
      dummy.scale.setScalar(0.0001);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }, [water, shore, plan, walkable, dummy, quality]);

  useFrame(({ camera }) => {
    if (!water || !shore || !plan) return;

    // --- How much sky is there to reflect ----------------------------------
    // Moonlight plus starlight, cut by cloud. A mirror shows what is above it.
    const sky = ritual.stargazing.sky;
    const clear = 1 - clamp01(ritual.weather.cloudCover) * 0.82;
    const moon = sky.moon.visible ? sky.moon.illumination * Math.max(0, Math.sin(sky.moon.altitude)) : 0;
    // The floor is the same dark-adaptation floor the moonlight rig uses: a
    // person who has been sitting by a fire can see the water, and a surface
    // that renders as literal black is a defect rather than a dark night.
    // The gains are a third of what they were — see the material's own note.
    const skyLevel = moon * 0.62 + sky.starVisibility * 0.24;
    const reflected = 0.34 + skyLevel * clear;
    // Chop breaks the reflection up, so a blown lake is duller than a mirror.
    surfaceMaterial.emissiveIntensity = reflected * (1 - water.chop * 0.45);

    // --- Surface ----------------------------------------------------------
    const surface = surfaceRef.current;
    const glitter = glitterRef.current;
    if (surface) {
      surface.position.set(shore.cos * plan.centreM, shore.surfaceY, shore.sin * plan.centreM);
      // Local +Z onto the shore bearing, so the water lies along its own bank.
      surface.rotation.y = Math.PI / 2 - water.shore.bearing;
      const position = surfaceGeometry.getAttribute('position') as THREE.BufferAttribute;
      const worldX = surface.position.x;
      const worldZ = surface.position.z;
      const cos = Math.cos(surface.rotation.y);
      const sin = Math.sin(surface.rotation.y);
      for (let i = 0; i < position.count; i++) {
        // Local to world, by hand: the wave is a function of where the vertex
        // actually is, and the mesh's own rotation is now not the identity.
        const lx = position.getX(i);
        const lz = position.getZ(i);
        position.setY(i, waveAt(water, worldX + lx * cos + lz * sin, worldZ + lz * cos - lx * sin));
      }
      position.needsUpdate = true;
      surfaceGeometry.computeVertexNormals();

      if (glitter) {
        glitter.position.set(surface.position.x, shore.surfaceY + 0.012, surface.position.z);
        glitter.rotation.y = surface.rotation.y;
        paintGlitter({
          surface: surfaceGeometry,
          geometry: glitterGeometry,
          water,
          plan,
          surfaceY: shore.surfaceY,
          originX: worldX,
          originZ: worldZ,
          cos,
          sin,
          eyeX: camera.position.x,
          eyeY: camera.position.y,
          eyeZ: camera.position.z,
          // The flame's own middle, above the pit at the origin.
          fireY: 0.28 + ritual.fire.flameHeight * 0.4,
          fire: clamp01(ritual.fire.flame) * settings.fireBrightness,
          skyLevel: skyLevel * clear,
          still: settings.reducedMotion,
        });
        glitter.visible = true;
      }
    }

    // --- Rings ------------------------------------------------------------
    const ripples = rippleRef.current;
    if (ripples) {
      let used = 0;
      for (const ripple of water.ripples) {
        if (used >= RIPPLE_POOL) break;
        const presence = ripplePresence(ripple);
        if (presence <= 0.01) continue;
        // A ring spreads and fades. Both follow the age, so one number does.
        const radius = 0.25 + ripple.age * 1.35;
        // Riding the surface, not sunk into it: at any real chop the wavelets
        // are taller than a fixed offset and cut the rings into arcs.
        dummy.position.set(
          ripple.x,
          shore.surfaceY + waveAt(water, ripple.x, ripple.z) + 0.035,
          ripple.z,
        );
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        ripples.setMatrixAt(used, dummy.matrix);
        // Instanced meshes cannot vary opacity per instance, so the fade is
        // done in colour: the ring dims toward the water it is sitting on.
        rippleColour.setRGB(presence * 0.75, presence * 0.84, presence * 0.9);
        ripples.setColorAt(used, rippleColour);
        used++;
      }
      // Anything unused is scaled to nothing rather than left where it was.
      for (let i = used; i < RIPPLE_POOL; i++) {
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        ripples.setMatrixAt(i, dummy.matrix);
      }
      ripples.instanceMatrix.needsUpdate = true;
      if (ripples.instanceColor) ripples.instanceColor.needsUpdate = true;
      ripples.count = RIPPLE_POOL;
      ripples.visible = used > 0;
    }

    // --- The stone in the air --------------------------------------------
    const flying = flyingRef.current;
    if (flying) {
      const skipping = ritual.skipping;
      flying.visible = skipping.phase === 'flying';
      if (flying.visible) {
        flying.position.set(skipping.position.x, skipping.position.y, skipping.position.z);
        // Spin is visible, and it is the thing a player is trying to produce.
        flying.rotation.y += skipping.spin * 0.016;
        flying.rotation.z = skipping.tilt;
      }
    }

    // --- The rod, the line and the float ----------------------------------
    const fishing = ritual.fishing;
    const out = fishing.phase !== 'stowed' && fishing.phase !== 'ready';
    const rod = rodRef.current;
    if (rod) {
      // Always there, whether or not anybody has picked it up: a rod leaning
      // on the bank is how you know there is fishing here at all.
      rod.visible = water.spec.fishable;
      if (rod.visible) {
        const x = shore.x - shore.cos * 0.35;
        const z = shore.z - shore.sin * 0.35;
        rod.position.set(x, terrainHeight(x, z, walkable.seed, walkable.amplitude, walkable.basin), z);
        rod.rotation.y = -water.shore.bearing;
      }
    }
    const bobber = floatRef.current;
    if (bobber) {
      bobber.visible = out;
      if (bobber.visible) {
        // The float rides the surface, and dips when something is interested.
        const dip = fishing.bob * 0.09;
        bobber.position.set(
          fishing.floatX,
          shore.surfaceY + waveAt(water, fishing.floatX, fishing.floatZ) + 0.05 - dip,
          fishing.floatZ,
        );
      }
    }
    const line = lineRef.current;
    if (line && bobber) {
      line.visible = out;
      if (line.visible && rod) {
        const geometry = line.geometry as THREE.BufferGeometry;
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;
        position.setXYZ(0, rod.position.x, rod.position.y + 1.35, rod.position.z);
        position.setXYZ(1, bobber.position.x, bobber.position.y, bobber.position.z);
        position.needsUpdate = true;
        geometry.computeBoundingSphere();
      }
    }
  });

  if (!water || !shore || !plan) return null;

  return (
    <group name="shore">
      <mesh ref={surfaceRef} geometry={surfaceGeometry} material={surfaceMaterial} receiveShadow />

      {/* The fire on the water, and the sky at the banks. Same vertices as the
          surface, one hair above it, added rather than blended so it can only
          ever lighten the dark water underneath. */}
      <mesh
        ref={glitterRef}
        geometry={glitterGeometry}
        material={glitterMaterial}
        renderOrder={1}
        frustumCulled={false}
        visible={false}
      />

      {/* The bank. Wet stones along the waterline, so the water ends
          somewhere. */}
      <instancedMesh
        ref={bankRef}
        args={[stoneGeometry, wetMaterial, BANK_POOL.high]}
        castShadow
        receiveShadow
        frustumCulled={false}
      />

      <instancedMesh
        ref={rippleRef}
        args={[rippleGeometry, rippleMaterial, RIPPLE_POOL]}
        frustumCulled={false}
      />

      {/* The stones on the shingle. Picking one up is a matter of reaching
          down at the water's edge, not of choosing from a list. */}
      <instancedMesh
        onClick={(event) => {
          event.stopPropagation();
          onTouch?.('stones');
        }}
        
        ref={stoneRef}
        args={[stoneGeometry, shingleMaterial, STONE_POOL]}
        castShadow
      />

      {/* The one in the air */}
      <mesh ref={flyingRef} geometry={stoneGeometry} material={shingleMaterial} visible={false} />

      {/* The rod, leaning where somebody left it */}
      <group ref={rodRef}>
        <mesh
          position={[0, 0.78, 0]}
          rotation={[0.36, 0, 0]}
          material={shingleMaterial}
          onClick={(event) => {
            event.stopPropagation();
            onTouch?.('rod');
          }}
        >
          <cylinderGeometry args={[0.006, 0.013, 1.7, 5]} />
        </mesh>
      </group>

      <mesh ref={floatRef} visible={false}>
        <sphereGeometry args={[0.045, 6, 5]} />
        <meshBasicMaterial color={0xd8452c} toneMapped={false} />
      </mesh>

      {/* The line. One segment, rod tip to float, rewritten each frame. */}
      <lineSegments ref={lineRef} visible={false} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(6), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={0xdfe6ea} transparent opacity={0.5} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/**
 * Surface height at a world point.
 *
 * The simulation's own function, not a decorative one, so the wavelet a stone
 * bounces off is the wavelet the player can see — the same discipline that
 * makes the terrain analytic.
 */
function waveAt(water: WaterState, x: number, z: number): number {
  return waveHeight(water, x, z);
}

/**
 * A stable 0..1 from a seed and an index. No `Math.random`, no allocation.
 *
 * The same trick `skipping.ts` uses to lay out the stones on the shingle: a
 * shore that is a different shore on every visit is not a place.
 */
function hash01(seed: number, index: number): number {
  let h = (seed ^ (index * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export interface GlitterPass {
  /** The water's own grid, already displaced. Read, never written. */
  surface: THREE.BufferGeometry;
  /** The additive pass's unwelded grid. Written. */
  geometry: THREE.BufferGeometry;
  water: WaterState;
  plan: { acrossM: number; acrossSegments: number; alongSegments: number };
  surfaceY: number;
  /** World position of the surface mesh's own origin. */
  originX: number;
  originZ: number;
  /** The mesh's Y rotation, pre-resolved. */
  cos: number;
  sin: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Height of the flame's middle above the world datum. */
  fireY: number;
  /** 0..1 how much fire there is, already scaled by the brightness setting. */
  fire: number;
  /** 0..1 how much sky there is to return at the banks. */
  skyLevel: number;
  /** Reduced motion: the streak is still broken, but it stops moving. */
  still: boolean;
}

/**
 * The fire on the water, written into the shared geometry's colour attribute.
 *
 * There are two terms, because there are two things going on, and the first
 * version of this had only the second and rendered nothing at all.
 *
 * **The pool.** Firelight falling on the water, and on the bed a metre under
 * it, seen back through a moving surface. This is what a creek nine metres
 * from a campfire actually looks like: a warm patch on the water directly out
 * from the pit, dying away up- and downstream as the inverse square bites,
 * with the surface chopping it into pieces as it goes over. It needs no
 * special geometry, it is there from the moment the fire is lit, and it is the
 * broken orange streak on dark water the direction asked for.
 *
 * **The glitter.** Specular return off the individual wave facets tilted so
 * that they bounce the fire into the eye — the half-vector between the
 * direction to the fire and the direction to the eye is the normal a facet
 * would need, and how far that is off vertical, measured against how crumpled
 * this water is, is the strength.
 *
 * The glitter is worth explaining because it is worth *not* over-promising. A
 * fire and an eye standing on the same bank cannot see a mirror image of that
 * fire in the water: the mirror point of a light below the surface is seen
 * along a line that crosses the surface *between* the light and the eye, so
 * the water has to be between them. Standing at the fire looking across a
 * creek, that condition is nowhere satisfied and the honest answer is that
 * there is no reflected flame — which is why the pool carries the image. Walk
 * round to the far bank, though, and the geometry comes good: the fire lays a
 * real broken streak down the water towards you, pointing at your feet and
 * swinging as you move. That is a thing to find rather than a thing to be
 * given, which is the better version of it anyway.
 *
 * Both terms are then broken twice over — by the wavelet the cell is riding,
 * and by a seeded stipple that survives dead-flat water — and quantised to
 * five steps with a checkerboard offset, which is the dither.
 *
 * Everything is computed once per *cell* and written flat across both of its
 * triangles. Per vertex would be smoothed straight back out by the rasteriser
 * — see the note on `glitterGeometry` — and it is also half the arithmetic.
 */
export function paintGlitter(pass: GlitterPass): void {
  const { surface, geometry, water, plan } = pass;
  const source = surface.getAttribute('position') as THREE.BufferAttribute;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colours = geometry.getAttribute('color') as THREE.BufferAttribute;

  /*
   * How crumpled the surface is, as an angle.
   *
   * This is the width of the glitter path and nothing else. Glass gives a
   * tight bright line, chop gives a broad dull field — which is the same
   * trade-off `waveSlope` makes for the skipping stone, kept consistent so
   * that a night the player can *see* is rough is also a night that skips
   * badly. A creek's own current adds to it: standing waves over stones stand
   * far steeper than anything the wind makes.
   */
  const sigma = 0.06 + water.chop * 0.42 + Math.min(0.28, Math.abs(water.currentMs) * 0.2);
  /*
   * How much of the fire's light the bed sends back.
   *
   * Clear water over pale gravel returns a lot; the blackwater at Cicada
   * Bottoms returns almost nothing, and should not, because the whole
   * character of that place is that you cannot see into it. A floor of 0.2
   * keeps a dark pool from being a hole.
   */
  const bedGain = 0.2 + water.spec.clarity * 1.35;
  const time = pass.still ? 0 : water.elapsed;
  const columns = plan.alongSegments + 1;
  const amplitude = Math.max(1e-4, water.chop * 0.09);

  let slot = 0;
  for (let row = 0; row < plan.acrossSegments; row++) {
    for (let column = 0; column < plan.alongSegments; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;

      // The cell's four corners, and the middle of it, in world space.
      let lx = 0;
      let ly = 0;
      let lz = 0;
      for (const corner of [a, b, c, d]) {
        lx += source.getX(corner);
        ly += source.getY(corner);
        lz += source.getZ(corner);
      }
      lx /= 4;
      ly /= 4;
      lz /= 4;
      const px = pass.originX + lx * pass.cos + lz * pass.sin;
      const py = pass.surfaceY + ly;
      const pz = pass.originZ + lz * pass.cos - lx * pass.sin;

      // Toward the fire, which is at the origin by construction, and the eye.
      let fx = -px;
      let fy = pass.fireY - py;
      let fz = -pz;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      let ex = pass.eyeX - px;
      let ey = pass.eyeY - py;
      let ez = pass.eyeZ - pz;
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el;
      ey /= el;
      ez /= el;

      /*
       * The fall-off the scene fog would have done, done here.
       *
       * The mesh runs seventy metres down the bank and carries no fog, so
       * without this the bank sheen is a line of constant brightness receding
       * to the horizon — a knife edge again, lying down. Gone by the shortest
       * draw distance in the catalogue.
       */
      const range = 1 - clamp01((el - FOG_NEAR_M) / (FOG_FAR_M - FOG_NEAR_M));
      const reach = range * range;

      let red = 0;
      let green = 0;
      let blue = 0;
      if (reach > 0.001) {
        // The normal a facet would need to send the fire into the eye.
        const hx = fx + ex;
        const hy = fy + ey;
        const hz = fz + ez;
        const hl = Math.hypot(hx, hy, hz) || 1;
        const tilt = Math.acos(Math.min(1, Math.max(-1, hy / hl)));
        const ratio = tilt / sigma;

        /*
         * Fresnel, and it is doing two jobs at once because it is one fact.
         *
         * Water seen along its own surface is a mirror and water seen from
         * above is a window: the same number that says how much light the
         * surface *reflects* says how much it lets through to the lit bed
         * underneath. So the specular term and the pool are weighted by F and
         * 1-F rather than tuned apart, and the pair cannot double-count. It is
         * also what stops a player who walks up and looks straight down into
         * the shallows from getting a screenful of orange: at that angle a
         * surface reflects almost nothing, which is exactly what the first
         * render of this did not know.
         */
        const fresnel = 0.04 + 0.96 * Math.pow(1 - Math.max(0, ey), 5);
        const fall = (POOL_REACH_M * POOL_REACH_M) / (POOL_REACH_M * POOL_REACH_M + fl * fl);
        /*
         * Which way this scrap of surface is leaning, relative to the fire.
         *
         * The single thing that makes firelight on water read as water. The
         * fire sits a few degrees above a surface nine metres away, so the
         * light arrives almost flat, and almost-flat light picks out only the
         * faces turned towards it: the upstream side of every wavelet lights
         * and the downstream side does not. That is the whole of why the real
         * thing is a field of separate bright ripple-lines rather than a patch
         * of orange. Two `waveHeight` calls a cell, off the same function the
         * simulation bounces stones off.
         */
        const ahead = waveHeight(water, px + fx * SLOPE_EPSILON_M, pz + fz * SLOPE_EPSILON_M);
        const behind = waveHeight(water, px - fx * SLOPE_EPSILON_M, pz - fz * SLOPE_EPSILON_M);
        const lean = (ahead - behind) / (2 * SLOPE_EPSILON_M);
        const facing = clamp01(0.5 + lean / (amplitude * 3.4 + 0.008));
        const pool = fall * (1 - fresnel) * bedGain * POOL_GAIN * (0.2 + 0.8 * facing * facing);
        // Crests catch a specular return and troughs do not, which is the
        // wavelet breaking the streak up. The pool has its own break-up in
        // `facing` and does not want this one as well.
        const crest = 0.42 + 0.58 * clamp01(0.5 + ly / (amplitude * 2));
        let level = Math.exp(-ratio * ratio) * crest * fresnel + pool;

        if (level > 0.002) {
          // A stipple that outlives dead-flat water, because running water has
          // a surface texture long before it has waves.
          const drift = px * 3.1 + pz * 2.3 + time * 0.85;
          const cell = Math.floor(drift);
          const frac = drift - cell;
          const low = hash01(water.seed, cell);
          const high = hash01(water.seed, cell + 1);
          const smooth = frac * frac * (3 - 2 * frac);
          level *= 0.3 + 0.7 * (low + (high - low) * smooth);
        }
        level *= pass.fire * reach;

        /*
         * The dither: five steps, and alternate cells offset by half a step.
         *
         * A cell is forty centimetres across a creek, which subtends about a
         * dozen internal pixels from the far bank and about sixty from a
         * player standing over the shallows. At a dozen pixels five steps and
         * a checkerboard are a dither; at sixty they are contour bands and a
         * chessboard. So the whole quantiser fades in over the first few
         * metres, and the water under your feet is smooth — which is also
         * where a real surface stops looking stepped and starts looking wet.
         */
        const parity = (row + column) % 2;
        const grid = clamp01((el - 3) / 6);
        const capped = Math.min(1, level);
        const encoded = Math.pow(capped, 1 / GLITTER_GAMMA);
        const steps = Math.max(0, Math.round(encoded * GLITTER_STEPS - parity * 0.5 * grid));
        const quantised = Math.pow(steps / GLITTER_STEPS, GLITTER_GAMMA);
        const stepped = capped + (quantised - capped) * grid;

        /*
         * The value gradient: cool, low, and brightest at the banks.
         *
         * Grazing angles return more of the sky, so the strips of water tucked
         * under each bank are the light edge and the middle of the channel is
         * the dark one. The review asked for "a value gradient from dark
         * centre to bright edge" and this is it, drawn from the geometry
         * rather than painted on: `lz` runs bank to bank by construction.
         */
        const across = Math.min(1, Math.abs(lz) / (plan.acrossM / 2));
        const sheen = across * across * across * pass.skyLevel * reach * 0.34;

        red = FIRE_ON_WATER.r * stepped + BANK_SHEEN.r * sheen;
        green = FIRE_ON_WATER.g * stepped + BANK_SHEEN.g * sheen;
        blue = FIRE_ON_WATER.b * stepped + BANK_SHEEN.b * sheen;
      }

      // Two triangles, six vertices, one colour. Flat is the whole point.
      for (const corner of [a, c, b, b, c, d]) {
        position.setXYZ(slot, source.getX(corner), source.getY(corner), source.getZ(corner));
        colours.setXYZ(slot, red, green, blue);
        slot++;
      }
    }
  }
  position.needsUpdate = true;
  colours.needsUpdate = true;
  // No `computeBoundingSphere`: the mesh is never frustum-culled, and walking
  // eighteen thousand floats every frame to work out a bound nothing reads is
  // the kind of cost that hides in a profile as "geometry".
}
