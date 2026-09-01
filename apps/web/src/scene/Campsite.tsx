/**
 * The campsite: terrain, trees, sky, props.
 *
 * Compact but genuinely explorable (spec §5.1) — a walkable clearing with
 * real corners, not a corridor. Short draw distance and heavy fog do the
 * PS1 work while also being the reason the world is cheap to render.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  clamp01,
  curatedSky,
  terrainHeight,
  WOOD_TYPES,
  type FuelPatch,
  type PlacedLandmark,
  type WaterBasin,
  type WeatherState,
} from '@somemore/sim';

/** Ground below this is under water, so nothing is planted in it. */
const WATERLINE = -0.14;
/**
 * How far out from the fire the camp is trodden clear.
 *
 * Wide enough that the fire, the machine, the woodpile and the log are never
 * behind a fern, and narrow enough that the wood still feels close.
 */
const CLEARING_RADIUS = 3.4;
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import { createLandmarkGeometry, isPlaceable } from '../render/landmarks.js';
import {
  createLogGeometry,
  createRockGeometry,
  createTerrainGeometry,
  createTreeGeometry,
  createUnderstoreyGeometry,
  understoreyFamily,
} from '../render/geometry.js';

export interface CampsiteProps {
  seed: number;
  /** Taking a log from the pile — the diegetic route to feeding the fire. */
  onTakeWood?: (woodId: string) => void;
  /**
   * The places at this campsite where there is wood.
   *
   * Drawn rather than merely reachable: a patch you cannot see is a waypoint,
   * and the point of walking out for firewood is that you went somewhere and
   * found something. What is drawn thins as you work a place over.
   */
  fuelPatches?: readonly FuelPatch[];
  /** Reaching for a piece at one of them. */
  onGather?: (patchId: string) => void;
  /**
   * The named things that make this campsite this campsite.
   *
   * Placed by the simulation rather than here, because the same list decides
   * where they are drawn and where you can walk up to them, and a landmark you
   * can see across the clearing but cannot reach is worse than no landmark.
   */
  landmarks?: readonly PlacedLandmark[];
  /** Walking up to one. */
  onVisitLandmark?: (id: string) => void;
  /** Which fuels this campsite offers, in order of what the pile shows. */
  fuelIds?: readonly string[];
  weather: WeatherState;
  settings: RenderSettings;
  drawDistance: number;
  /** Night palette, hex strings from the environment manifest. */
  palette?: {
    ground: string;
    foliage: string;
    fog: string;
    sky: string;
  };
  /** How many trees to scatter, derived from the manifest's canopy kits. */
  treeCount?: number;
  /**
   * Everything growing under the canopy, straight from the manifest.
   *
   * Densities are the catalogue's own, in instances per hundred square metres.
   * `lowTierDrop` is the content author's call about what a weak device can
   * lose without losing the environment's identity — the cedar switchback
   * marks its ferns droppable and its Spanish moss not, because the moss *is*
   * the place.
   */
  understorey?: readonly {
    kitId: string;
    density: number;
    minHeight: number;
    maxHeight: number;
    lowTierDrop: boolean;
  }[];
  /**
   * The ground going down to the water, where this campsite has any.
   *
   * Passed straight through to `createTerrainGeometry`, which reads the same
   * `terrainHeight` the player walks on — so the shore the renderer draws and
   * the shore the player wades into are the same shore.
   */
  basin?: WaterBasin;
}

const DEFAULT_PALETTE = {
  ground: '#4a4438',
  foliage: '#1d3323',
  fog: '#0b1016',
  sky: '#070a0f',
};

export function Campsite({
  seed,
  weather,
  settings,
  drawDistance,
  palette = DEFAULT_PALETTE,
  treeCount = 54,
  understorey = [],
  onTakeWood,
  fuelPatches,
  onGather,
  landmarks,
  onVisitLandmark,
  fuelIds = ['oak'],
  basin,
}: CampsiteProps): React.ReactElement {
  const fogRef = useRef<THREE.Fog>(null);
  const starsRef = useRef<THREE.Points>(null);
  const rainRef = useRef<THREE.Points>(null);

  // A finer grid where there is water: a two-metre creek channel is invisible
  // at 1.8 m per segment, and the shore is the one edge that has to read.
  const terrain = useMemo(
    () => createTerrainGeometry(46, basin ? 44 : 26, seed, 0.7, basin),
    [seed, basin],
  );

  const groundMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('dirt', { size: 64, seed }),
        color: palette.ground,
        roughness: 1,
      }),
    [settings, seed, palette.ground],
  );

  const treeMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('foliage', { size: 64, seed }), color: palette.foliage, roughness: 1 }),
    [settings, seed, palette.foliage],
  );

  /**
   * The understorey's own material, double-sided and a touch lighter.
   *
   * Fronds, grass blades and hanging moss are built from planes, and a plane
   * is invisible from behind under `FrontSide`. Instanced at random rotations
   * that means roughly half of every plant is simply not drawn, which is why
   * the first render of the forest floor read as thin spiky silhouettes rather
   * than as mass.
   *
   * The colour is lifted off the canopy's, too. `palette.foliage` is chosen
   * for a treeline seen at distance through fog; the same value on something
   * a metre from your knee reads as a black cut-out, and the catalogue's own
   * note for the cedar switchback is that firelight through fern fronds is the
   * best-looking thing in the environment. It cannot be, if the fronds cannot
   * take a highlight.
   */
  const understoreyMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('foliage', { size: 64, seed }),
        color: new THREE.Color(palette.foliage).lerp(new THREE.Color(0x8fa86a), 0.34).getHex(),
        roughness: 0.92,
        side: THREE.DoubleSide,
      }),
    [settings, seed, palette.foliage],
  );

  const rockMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('stone', { size: 64, seed }), roughness: 1 }),
    [settings, seed],
  );

  const woodMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('bark', { size: 64, seed }), roughness: 1 }),
    [settings, seed],
  );

  // Trees are placed in a ring with a clearing in the middle. Deterministic
  // from the seed, so a campsite looks the same on every visit.
  const trees = useMemo(() => {
    const rng = mulberry(seed ^ 0x51ed);
    const result: { x: number; z: number; scale: number; rotation: number; geometryIndex: number }[] = [];
    // The trail the player walks in along. Trees are kept out of a corridor
    // either side of it, so the approach frames the fire instead of burying
    // the camera inside a trunk.
    const trailAngle = Math.atan2(6.2, 7.5);
    // A treeless salt flat and a closed-canopy forest are the same code path,
    // differing only in this number from the manifest.
    for (let i = 0; i < treeCount; i++) {
      const angle = rng() * Math.PI * 2;
      const distance = 6 + rng() * 15;
      let delta = Math.abs(angle - trailAngle) % (Math.PI * 2);
      if (delta > Math.PI) delta = Math.PI * 2 - delta;
      // Widen the gap nearer the camera's start so nothing clips the lens.
      if (delta < 0.34 && distance < 13) continue;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      // Nothing grows below the waterline. Without this a full pine stands in
      // the middle of the lake, which is the first thing anybody notices.
      if (basin && terrainHeight(x, z, seed, 0.7, basin) < WATERLINE) continue;
      result.push({
        x,
        z,
        scale: 0.7 + rng() * 0.8,
        rotation: rng() * Math.PI * 2,
        geometryIndex: Math.floor(rng() * 4),
      });
    }
    return result;
  }, [seed, treeCount, basin]);

  const treeGeometries = useMemo(
    () => Array.from({ length: 4 }, (_, i) => createTreeGeometry(seed + i * 977, 4.2)),
    [seed],
  );

  /**
   * The understorey, placed from the manifest's own densities.
   *
   * Two geometry variants per kit rather than one per plant: instancing needs
   * shared geometry, and at these counts the difference between two fern
   * shapes and two hundred is invisible in firelight and the difference in
   * draw calls is not.
   *
   * `drawDistance` stands in for the device budget here. It already arrives
   * capped by the quality tier, so a weak device gets a smaller disc to fill
   * and — through `lowTierDrop` — loses the kits the content author marked as
   * losable rather than the ones that carry the environment's identity.
   */
  const understoreyLayers = useMemo(() => {
    const radius = Math.max(6, Math.min(drawDistance, 22));
    const area = Math.PI * radius * radius;
    const keep = understorey.filter((kit) => !(kit.lowTierDrop && drawDistance < 18));

    return keep.map((kit, kitIndex) => {
      const rng = mulberry(seed ^ (0x9e37 + kitIndex * 7919));
      // Per hundred square metres, which is the unit the catalogue is written
      // in. Capped so a moss at density 70 cannot alone spend the frame.
      const wanted = Math.round((kit.density / 100) * area);
      const count = Math.min(460, wanted);
      const buckets: ScatterItem[][] = [[], []];

      /*
       * The clearing, and the trail through it.
       *
       * Planted from 1.7 m out, sword fern at its catalogue height of 0.6-1.4 m
       * stands chest-high exactly where the player stands, and the first render
       * buried the campfire — the opening image of the whole product — behind a
       * wall of fronds. Density was not the mistake; the catalogue says "wall to
       * wall on the slope" and it is right. The mistake was planting it in the
       * camp.
       *
       * People clear the ground they camp on, so the fire gets a real clearing
       * that thins rather than ends, and the trail keeps the same corridor the
       * trees already respect. Both are the environment being sensible about
       * itself rather than the renderer hiding its own content.
       */
      const trailAngle = Math.atan2(6.2, 7.5);

      for (let i = 0; i < count; i++) {
        const angle = rng() * Math.PI * 2;
        // Square-rooted so instances spread evenly over the disc rather than
        // crowding the middle, which is where the player spends the whole game.
        const distance = CLEARING_RADIUS + Math.sqrt(rng()) * (radius - CLEARING_RADIUS);
        // A soft edge to the clearing: right at its lip almost nothing takes,
        // and a couple of metres out everything does. A hard ring reads as a
        // mown lawn, which is the opposite of a wood.
        const establish = clamp01((distance - CLEARING_RADIUS) / 2.4);
        if (rng() > establish * 0.85 + 0.15) continue;
        let delta = Math.abs(angle - trailAngle) % (Math.PI * 2);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        if (delta < 0.3 && distance < 12) continue;
        const x = Math.cos(angle) * distance;
        const z = Math.sin(angle) * distance;
        const y = terrainHeight(x, z, seed, 0.7, basin);
        // Nothing grows in the fire or underwater.
        if (basin && y < WATERLINE) continue;
        const bucket = buckets[rng() < 0.5 ? 0 : 1] as ScatterItem[];
        bucket.push({ x, y, z, scale: 0.8 + rng() * 0.5, rotationY: rng() * Math.PI * 2 });
      }

      const height = (kit.minHeight + kit.maxHeight) / 2;
      const family = understoreyFamily(kit.kitId);
      return {
        kitId: kit.kitId,
        buckets,
        geometries: [
          createUnderstoreyGeometry(family, seed + kitIndex * 5171, height),
          createUnderstoreyGeometry(family, seed + kitIndex * 5171 + 31, height),
        ],
      };
    });
  }, [understorey, drawDistance, seed, basin]);

  /**
   * Four rock shapes rather than fourteen.
   *
   * Instancing needs shared geometry, and fourteen bespoke boulders cost
   * fourteen draw calls for variety nobody can see at night through fog. Four
   * shapes at varying scale and rotation are indistinguishable and cost one
   * call each. Rocks are left where they fall, including in the shallows: a
   * boulder half out of the water is a shoreline, where a tree in it is a
   * mistake.
   */
  const rockGeometries = useMemo(
    () => Array.from({ length: 4 }, (_, i) => createRockGeometry(seed + i * 331, 0.36)),
    [seed],
  );

  const rocks = useMemo(() => {
    const rng = mulberry(seed ^ 0x2b0c);
    const buckets: ScatterItem[][] = [[], [], [], []];
    for (let i = 0; i < 14; i++) {
      const angle = rng() * Math.PI * 2;
      const distance = 2.5 + rng() * 8;
      const shape = Math.floor(rng() * 4);
      (buckets[shape] as ScatterItem[]).push({
        x: Math.cos(angle) * distance,
        y: 0.05,
        z: Math.sin(angle) * distance,
        rotationY: rng() * Math.PI * 2,
        scale: 0.5 + rng() * 1.4,
      });
    }
    return buckets;
  }, [seed]);

  /** The trees, grouped by which of the four shapes they use. */
  const treeBuckets = useMemo(() => {
    const buckets: ScatterItem[][] = [[], [], [], []];
    for (const tree of trees) {
      (buckets[tree.geometryIndex] ?? (buckets[0] as ScatterItem[])).push({
        x: tree.x,
        y: 0,
        z: tree.z,
        rotationY: tree.rotation,
        scale: tree.scale,
      });
    }
    return buckets;
  }, [trees]);

  /** The woodpile, as one instanced stack. */
  const woodpileItems = useMemo<ScatterItem[]>(
    () =>
      Array.from({ length: 8 }, (_, i) => ({
        x: 1.7 + ((i % 3) * 0.14 - 0.14),
        y: 0.07 + Math.floor(i / 3) * 0.13,
        z: -0.9 + (i % 2) * 0.06,
        rotationY: 0.1 * i,
        scale: 1,
      })),
    [],
  );

  /**
   * The pile, split into one instanced group per species it holds.
   *
   * Interleaved rather than sorted into blocks: a real pile is mixed, and a
   * neat row of each kind would read as a shop shelf. The species a log
   * belongs to is decided by its position in the stack, exactly as `onPick`
   * always assumed.
   */
  const woodpileBySpecies = useMemo(() => {
    const groups = new Map<string, ScatterItem[]>();
    woodpileItems.forEach((item, i) => {
      const woodId = fuelIds[i % fuelIds.length] ?? 'oak';
      const bucket = groups.get(woodId);
      if (bucket) bucket.push(item);
      else groups.set(woodId, [item]);
    });
    return [...groups].map(([woodId, items]) => ({
      woodId,
      items,
      material: createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed }),
        color: WOOD_TYPES[woodId]?.bark ?? 0x5a4632,
        roughness: 1,
      }),
    }));
  }, [woodpileItems, fuelIds, settings, seed]);

  /*
   * The landmarks, one draw call each.
   *
   * A shape per kind rather than a mesh per landmark: this world is built out
   * of procedural kits by rule (ADR-0003), and forty-eight bespoke props is
   * not that. What makes it the bear box rather than a box is that you can
   * walk up to it and it tells you, in the words the catalogue wrote.
   */
  const landmarkProps = useMemo(() => {
    if (!landmarks || landmarks.length === 0) return [];
    return landmarks
      .filter((landmark) => isPlaceable(landmark.kind))
      .map((landmark) => ({
        landmark,
        geometry: createLandmarkGeometry(landmark.kind, landmark.seed),
        y: terrainHeight(landmark.x, landmark.z, seed, 0.7, basin),
      }));
  }, [landmarks, seed, basin]);

  /** Weathered wood and dulled metal. Nothing here is new. */
  const landmarkMaterials = useMemo(
    () => ({
      wood: createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed: 'landmark' }),
        color: 0x6f6152,
        roughness: 1,
      }),
      metal: createPs1Material({
        settings,
        map: getTexture('aluminium', { size: 64, seed: 'landmark' }),
        color: 0x59635a,
        roughness: 0.85,
      }),
      stone: createPs1Material({
        settings,
        map: getTexture('stone', { size: 64, seed: 'landmark' }),
        color: 0x6b6862,
        roughness: 1,
      }),
    }),
    [settings],
  );

  /** One bark material per wood, shared by every place that wood is found. */
  const deadfallMaterials = useMemo(() => {
    const byWood: Record<string, THREE.Material> = {
      __fallback: createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed }),
        color: 0x5a4632,
        roughness: 1,
      }),
    };
    for (const patch of fuelPatches ?? []) {
      if (byWood[patch.woodId]) continue;
      byWood[patch.woodId] = createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed }),
        color: WOOD_TYPES[patch.woodId]?.bark ?? 0x5a4632,
        roughness: 1,
      });
    }
    return byWood;
  }, [fuelPatches, settings, seed]);

  const logGeometry = useMemo(() => createLogGeometry(1.9, 0.19), []);
  const woodpileGeometry = useMemo(() => createLogGeometry(0.55, 0.07), []);

  /*
   * Deadfall, kindling and twigs, where the campsite says they are.
   *
   * Three sizes because they are three different things to find: a fallen limb
   * you have to break up, a scatter of finger-thick sticks, and the litter
   * underneath that a fire actually gets started with. What is drawn thins as
   * a place is worked over, so somewhere you have been three times looks it.
   */
  const deadfallGeometries = useMemo(
    () => ({
      log: createLogGeometry(0.72, 0.085),
      kindling: createLogGeometry(0.46, 0.022),
      tinder: createLogGeometry(0.2, 0.012),
    }),
    [],
  );

  const deadfallGroups = useMemo(() => {
    if (!fuelPatches || fuelPatches.length === 0) return [];
    return fuelPatches.map((patch) => {
      const rng = mulberry(seed ^ hashPatchId(patch.id));
      const drawn = patch.grade === 'log' ? 4 : patch.grade === 'kindling' ? 9 : 13;
      const left = patch.stock > 0 ? patch.remaining / patch.stock : 0;
      const count = Math.max(patch.remaining > 0 ? 1 : 0, Math.round(drawn * left));
      const spread = patch.grade === 'log' ? 0.75 : patch.grade === 'kindling' ? 0.55 : 0.4;
      const items: ScatterItem[] = [];
      for (let i = 0; i < count; i++) {
        const angle = rng() * Math.PI * 2;
        const distance = Math.sqrt(rng()) * spread;
        const x = patch.x + Math.cos(angle) * distance;
        const z = patch.z + Math.sin(angle) * distance;
        items.push({
          x,
          y: terrainHeight(x, z, seed, 0.7, basin) + (patch.grade === 'log' ? 0.085 : 0.016),
          rotationY: rng() * Math.PI * 2,
          scale: 0.75 + rng() * 0.5,
          z,
        });
      }
      return { patch, items };
    });
  }, [fuelPatches, seed, basin]);

  // --- Sky ---------------------------------------------------------------
  const sky = useMemo(() => curatedSky(), []);

  /**
   * Where the moon is and how much it is giving.
   *
   * `curatedSky()` is the documented fallback when the player has not granted
   * location: a real sky for a plausible place at a plausible hour, rather
   * than a made-up one (spec §5.5).
   */
  const moonlight = useMemo(() => {
    const moon = sky.moon;
    const clear = 1 - weather.cloudCover * 0.85;
    // Below the horizon there is no moon, and the night is starlight only.
    const above = Math.max(0, Math.sin(moon.altitude));
    const strength = moon.visible ? moon.illumination * above : 0;
    const distance = 90;
    // Azimuth is measured from north; +Z is north in this scene.
    const horizontal = Math.cos(moon.altitude) * distance;
    return {
      position: [
        Math.sin(moon.azimuth) * horizontal,
        Math.max(12, Math.sin(moon.altitude) * distance),
        Math.cos(moon.azimuth) * horizontal,
      ] as [number, number, number],
      // The floor stands for dark adaptation, which the renderer has no
      // model of: a person who has been sitting by a fire for ten minutes can
      // genuinely see the treeline. Without it a moonless night is a black
      // rectangle rather than a dark wood.
      // Raised to take over the work the flat ambient used to do badly. The
      // total light in the scene is about what it was; far more of it now
      // arrives from a direction, which is the whole point.
      intensity: (1.4 + strength * 3.2) * clear,
      ambient: clamp01(sky.ambientLight * clear),
    };
  }, [sky, weather.cloudCover]);

  const starGeometry = useMemo(() => {
    const count = 420;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const rng = mulberry(0x57a5);
    let index = 0;

    // Field stars.
    for (let i = 0; i < count; i++) {
      // Upper hemisphere only.
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(rng() * 0.95);
      const r = 120;
      positions[index * 3] = Math.sin(phi) * Math.cos(theta) * r;
      positions[index * 3 + 1] = Math.cos(phi) * r + 20;
      positions[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      const brightness = 0.45 + rng() * 0.55;
      // Slight colour variation: not every star is white.
      colors[index * 3] = brightness;
      colors[index * 3 + 1] = brightness * (0.9 + rng() * 0.1);
      colors[index * 3 + 2] = brightness * (0.92 + rng() * 0.12);
      index++;
    }

    // The named constellations are *not* here. They used to be scattered
    // around the dome by a decorative formula that had nothing to do with
    // where they are, which meant they could not be found and so could not be
    // looked for. `NightSky.tsx` draws them at the real altitude and azimuth
    // the astronomy model computes; these are the anonymous ones.

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, []);

  const starMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.85,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  // --- Precipitation ------------------------------------------------------
  const rainCount = 260;
  const rainGeometry = useMemo(() => {
    const positions = new Float32Array(rainCount * 3);
    const rng = mulberry(0x7a1f);
    for (let i = 0; i < rainCount; i++) {
      positions[i * 3] = (rng() - 0.5) * 26;
      positions[i * 3 + 1] = rng() * 12;
      positions[i * 3 + 2] = (rng() - 0.5) * 26;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const rainMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xaebccb,
        size: 0.045,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [],
  );

  useFrame((state, delta) => {
    // Fog tightens with weather, which is both atmosphere and a draw-distance
    // saving exactly when the scene gets busiest.
    if (fogRef.current) {
      const reduction = Math.min(1, weather.fog * 0.8 + weather.precipitation * 0.3);
      fogRef.current.near = 2.5;
      fogRef.current.far = Math.max(6, drawDistance * (1 - reduction * 0.78));
    }

    if (starsRef.current) {
      const visibility = sky.starVisibility * (1 - weather.cloudCover * 0.95);
      starMaterial.opacity = Math.max(0, visibility * 0.95);
      starsRef.current.visible = visibility > 0.02;
      // Very slow rotation — the sky turns over the course of a long session.
      starsRef.current.rotation.y += delta * 0.0016;
    }

    if (rainRef.current) {
      const strength = weather.precipitation;
      rainMaterial.opacity = strength * 0.55;
      rainRef.current.visible = strength > 0.02;
      if (strength > 0.02) {
        const positions = rainGeometry.getAttribute('position') as THREE.BufferAttribute;
        const isSnow = weather.kind === 'snow' || weather.kind === 'snow-squall';
        const fallSpeed = isSnow ? 1.1 : 11;
        rainMaterial.size = isSnow ? 0.075 : 0.04;
        for (let i = 0; i < rainCount; i++) {
          let y = positions.getY(i) - fallSpeed * delta;
          let x = positions.getX(i) + weather.windSpeed * delta * (isSnow ? 0.5 : 0.2);
          if (y < 0) {
            y = 12;
            x = (Math.random() - 0.5) * 26;
          }
          if (x > 13) x -= 26;
          positions.setXYZ(i, x, y, positions.getZ(i));
        }
        positions.needsUpdate = true;
      }
    }
    void state;
  });

  return (
    <group>
      <fog ref={fogRef} attach="fog" args={[palette.fog, 2.5, drawDistance]} />
      <color attach="background" args={[palette.sky]} />

      {/* Night sky */}
      <points ref={starsRef} geometry={starGeometry} material={starMaterial} frustumCulled={false} />

      {/* Moon — a flat disc, which is exactly what a PS1 moon was */}
      <mesh position={[38, 46, -70]}>
        <circleGeometry args={[3.6, 12]} />
        <meshBasicMaterial color={0xd8dfe8} toneMapped={false} transparent opacity={0.65 * (1 - weather.cloudCover * 0.8)} />
      </mesh>

      {/* Ground */}
      <mesh geometry={terrain} material={groundMaterial} receiveShadow />

      {/* Trees — four draw calls for the whole wood, not one per trunk. */}
      {treeBuckets.map((items, i) => (
        <Scatter
          key={`tree-${i}`}
          geometry={treeGeometries[i] ?? (treeGeometries[0] as THREE.BufferGeometry)}
          material={treeMaterial}
          items={items}
        />
      ))}

      {/* The understorey the manifest asked for, two draw calls per kit. */}
      {understoreyLayers.map((layer) =>
        layer.buckets.map((items, i) =>
          items.length === 0 ? null : (
            <Scatter
              key={`${layer.kitId}-${i}`}
              geometry={layer.geometries[i] ?? (layer.geometries[0] as THREE.BufferGeometry)}
              material={understoreyMaterial}
              items={items}
            />
          ),
        ),
      )}

      {/* Rocks */}
      {rocks.map((items, i) => (
        <Scatter
          key={`rock-${i}`}
          geometry={rockGeometries[i] ?? (rockGeometries[0] as THREE.BufferGeometry)}
          material={rockMaterial}
          items={items}
          receiveShadow
        />
      ))}

      {/*
        Sitting log by the fire.

        Laid across the radius rather than along it, which is both how anybody
        would put down something they meant to sit on facing a fire, and the
        fix for the two-metre log that used to run straight out of the pit and
        a foot into the side of the SM-01. Keep this rotation in step with
        `LAYOUT.logSeat`, `LAYOUT.radio` and `LAYOUT.torch` in `World.tsx`,
        which is where everything that sits on it is placed.
      */}
      <mesh
        geometry={logGeometry}
        material={woodMaterial}
        position={[-1.5, 0.19, 0.9]}
        rotation={[0, 2.114, 0]}
        castShadow
        receiveShadow
      />

      {/* Woodpile — the fuel source the player draws from. Taking a log is a
          matter of reaching for one, not of pressing a labelled control, and
          which log you reach for still decides which wood you get: the
          instance the ray hit is the log in your hand. */}
      {/*
        One instanced stack per species, so the pile is visibly mixed.
        
        `onPick` has always handed back the species of the individual log the
        ray hit, which makes the woodpile the most consequential choice at the
        campsite: pine catches from almost nothing and leaves you nothing,
        mesquite will not light on a cold fire and leaves a bed worth roasting
        over. Drawn in one material, that choice was real and completely
        unknowable -- indistinguishable from picking at random.
        
        Splitting the stack by species costs one draw call per wood the
        environment actually offers, which is two or three, and turns the pile
        into something you can read: pale logs are the light fast ones, dark
        logs are the dense slow ones. That is true of real wood, and it is the
        entire lesson this system exists to teach.
      */}
      {/*
        The named things.

        Drawn where the simulation put them, standing on the ground the player
        walks on, and each one reachable — which is the whole difference
        between a campsite that was described and a campsite that is there.
      */}
      {landmarkProps.map(({ landmark, geometry, y }) => (
        <mesh
          key={landmark.id}
          name={landmark.id}
          geometry={geometry}
          material={
            landmark.kind === 'built' || landmark.kind === 'signage'
              ? landmarkMaterials.metal
              : landmark.kind === 'water'
                ? landmarkMaterials.stone
                : landmarkMaterials.wood
          }
          position={[landmark.x, y, landmark.z]}
          rotation={[0, landmark.rotation, 0]}
          castShadow
          receiveShadow
          {...(onVisitLandmark
            ? {
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation();
                  onVisitLandmark(landmark.id);
                },
                onPointerOver: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation();
                  if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
                },
                onPointerOut: () => {
                  if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
                },
              }
            : {})}
        />
      ))}

      {/*
        The firewood that is not at camp.

        One instanced call per place. `onPick` carries which place was touched,
        so reaching for a stick out on the slope means that slope's wood, at
        that slope's moisture, exactly as reaching into the pile means the pile.
      */}
      {deadfallGroups.map(({ patch, items }) => (
        <Scatter
          key={patch.id}
          name={patch.id}
          geometry={deadfallGeometries[patch.grade]}
          material={
            deadfallMaterials[patch.woodId] ?? (deadfallMaterials['__fallback'] as THREE.Material)
          }
          items={items}
          receiveShadow
          {...(onGather ? { onPick: () => onGather(patch.id) } : {})}
        />
      ))}

      {woodpileBySpecies.map((group) => (
        <Scatter
          key={group.woodId}
          name="woodpile"
          geometry={woodpileGeometry}
          material={group.material}
          items={group.items}
          {...(onTakeWood ? { onPick: () => onTakeWood(group.woodId) } : {})}
        />
      ))}

      {/* Precipitation */}
      <points ref={rainRef} geometry={rainGeometry} material={rainMaterial} frustumCulled={false} />

      {/*
        Night light.

        Measuring the running product found the campsite unnavigable once the
        fire burned to coals: mean frame luminance around 3/255, with a tenth
        of a percent of pixels above the visible floor. That was survivable
        when every stage was an anchored close-up on a lit object, and stopped
        being survivable the moment the world became something you walk around
        in with animals in it.

        The fix is not a flat lift. The moon is placed by the real astronomy
        the simulation already computes — altitude and azimuth for the date —
        and its strength is its illuminated fraction, attenuated by the
        weather's own cloud cover. So a clear night under a full moon is
        genuinely navigable, an overcast new moon is genuinely dark and the
        fire is genuinely the only thing you have, and the difference between
        two campsites on two nights is a real difference rather than a dial.
      */}
      {/*
        Most of the light now comes from a direction.

        It used to come from `ambientLight`, at up to 2.75 against a moon of at
        most 3.1 — and ambient light adds the same value to every surface no
        matter which way it faces, so it cannot describe a shape. That is why
        the first person to play this found the campsite flat and cheap: the
        pines read as flat cones, the rocks as flat blobs, and the SM-01 — 23
        separate boxes wearing enamel, aluminium, rubber and smoked plastic —
        rendered as one beige silhouette. The materials were never the problem.
        Nothing was lighting them.

        So the same rough quantity of light is redistributed toward the moon,
        which has a position and therefore gives every surface a lit side and a
        shadowed one. The floor stays: it stands for dark adaptation, and a
        moonless overcast night still has to be a dark wood rather than a black
        rectangle. `e2e/night.spec.ts` is what holds that line.

        And the floor was too low. Redistributing toward the moon works only
        where there is a moon: on a clouded night with the moon down, both
        moon-driven terms collapse and what is left is the floor alone — which
        measured four to seven out of 255 out at the treeline, under the eight
        that five-bit quantisation can even represent. So a player who walked
        out for firewood was walking in a black rectangle, which is precisely
        the failure the floor exists to prevent (spec deviation D7). The floor
        is now roughly what it needs to be to read as a dark wood on the worst
        night the weather model can produce, and the night suite measures the
        far treeline rather than only the ground at your feet.
      */}
      <ambientLight intensity={1 + moonlight.ambient * 0.5} color={0x33445f} />
      <directionalLight
        position={moonlight.position}
        intensity={moonlight.intensity}
        color={0xa8bcd8}
      />
      {/* The sky's own light, from above, so canopies read as canopies. */}
      <hemisphereLight
        intensity={1.05 + moonlight.ambient * 1.2}
        color={0x4a5f80}
        groundColor={0x161a14}
      />
    </group>
  );
}

/** A stable small hash of a patch id, so each place scatters differently. */
function hashPatchId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** One placed instance: where it stands, which way it faces, how big it is. */
export interface ScatterItem {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
}

/**
 * A field of one shape, drawn in a single call.
 *
 * The campsite used to draw every tree, rock and log in the woodpile as its
 * own mesh, which put the arrival frame — the first thing anybody ever sees —
 * over the 120-call budget in ARCHITECTURE §10, and was recorded as a known
 * deviation whose stated fix was exactly this. Fifty-odd trunks become four
 * calls; nothing about the picture changes.
 *
 * `onPick` still gets which instance was touched, so reaching for a particular
 * log in the pile keeps meaning a particular wood.
 */
function Scatter({
  geometry,
  material,
  items,
  name,
  receiveShadow = false,
  onPick,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: readonly ScatterItem[];
  name?: string;
  receiveShadow?: boolean;
  onPick?: (index: number) => void;
}): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as ScatterItem;
      dummy.position.set(item.x, item.y, item.z);
      dummy.rotation.set(0, item.rotationY, 0);
      dummy.scale.setScalar(item.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items, dummy, geometry]);

  if (items.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, items.length]}
      castShadow
      receiveShadow={receiveShadow}
      {...(name ? { name } : {})}
      {...(onPick
        ? {
            onClick: (event: { stopPropagation: () => void; instanceId?: number }) => {
              event.stopPropagation();
              onPick(event.instanceId ?? 0);
            },
            onPointerOver: (event: { stopPropagation: () => void }) => {
              event.stopPropagation();
              if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
            },
            onPointerOut: () => {
              if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
            },
          }
        : {})}
    />
  );
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
