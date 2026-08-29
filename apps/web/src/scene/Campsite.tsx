/**
 * The campsite: terrain, trees, sky, props.
 *
 * Compact but genuinely explorable (spec §5.1) — a walkable clearing with
 * real corners, not a corridor. Short draw distance and heavy fog do the
 * PS1 work while also being the reason the world is cheap to render.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp01, curatedSky, CONSTELLATIONS, type WeatherState } from '@somemore/sim';
import { createPs1Material, type RenderSettings } from '../render/ps1.js';
import { getTexture } from '../render/textures.js';
import {
  createLogGeometry,
  createRockGeometry,
  createTerrainGeometry,
  createTreeGeometry,
} from '../render/geometry.js';

export interface CampsiteProps {
  seed: number;
  /** Taking a log from the pile — the diegetic route to feeding the fire. */
  onTakeWood?: (woodId: string) => void;
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
  onTakeWood,
  fuelIds = ['oak'],
}: CampsiteProps): React.ReactElement {
  const fogRef = useRef<THREE.Fog>(null);
  const starsRef = useRef<THREE.Points>(null);
  const rainRef = useRef<THREE.Points>(null);

  const terrain = useMemo(() => createTerrainGeometry(46, 26, seed, 0.7), [seed]);

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
      result.push({
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        scale: 0.7 + rng() * 0.8,
        rotation: rng() * Math.PI * 2,
        geometryIndex: Math.floor(rng() * 4),
      });
    }
    return result;
  }, [seed, treeCount]);

  const treeGeometries = useMemo(
    () => Array.from({ length: 4 }, (_, i) => createTreeGeometry(seed + i * 977, 4.2)),
    [seed],
  );

  const rocks = useMemo(() => {
    const rng = mulberry(seed ^ 0x2b0c);
    return Array.from({ length: 14 }, (_, i) => {
      const angle = rng() * Math.PI * 2;
      const distance = 2.5 + rng() * 8;
      return {
        geometry: createRockGeometry(seed + i * 31, 0.18 + rng() * 0.5),
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        rotation: rng() * Math.PI * 2,
      };
    });
  }, [seed]);

  const logGeometry = useMemo(() => createLogGeometry(1.9, 0.19), []);
  const woodpileGeometry = useMemo(() => createLogGeometry(0.55, 0.07), []);

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
      intensity: (0.7 + strength * 2.4) * clear,
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
    for (let i = 0; i < count - 30; i++) {
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

    // Recognisable constellations, placed around the dome.
    for (const constellation of CONSTELLATIONS) {
      const baseTheta = (constellation.raHours / 24) * Math.PI * 2;
      const basePhi = Math.acos(Math.max(-0.9, Math.min(0.9, constellation.decDeg / 90))) * 0.6;
      for (const star of constellation.stars) {
        if (index >= count) break;
        const theta = baseTheta + star[0] * 0.16;
        const phi = basePhi + star[1] * 0.16;
        const r = 120;
        positions[index * 3] = Math.sin(phi) * Math.cos(theta) * r;
        positions[index * 3 + 1] = Math.abs(Math.cos(phi)) * r + 25;
        positions[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
        // Brighter magnitudes are lower numbers.
        const brightness = Math.max(0.4, 1.15 - star[2] * 0.28);
        colors[index * 3] = brightness;
        colors[index * 3 + 1] = brightness;
        colors[index * 3 + 2] = brightness;
        index++;
      }
    }

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

      {/* Trees */}
      {trees.map((tree, i) => (
        <mesh
          key={i}
          geometry={treeGeometries[tree.geometryIndex] ?? treeGeometries[0]}
          material={treeMaterial}
          position={[tree.x, 0, tree.z]}
          rotation={[0, tree.rotation, 0]}
          scale={tree.scale}
          castShadow
        />
      ))}

      {/* Rocks */}
      {rocks.map((rock, i) => (
        <mesh
          key={i}
          geometry={rock.geometry}
          material={rockMaterial}
          position={[rock.x, 0.05, rock.z]}
          rotation={[0, rock.rotation, 0]}
          castShadow
          receiveShadow
        />
      ))}

      {/* Sitting log by the fire */}
      <mesh
        geometry={logGeometry}
        material={woodMaterial}
        position={[-1.5, 0.19, 0.9]}
        rotation={[0, 0.6, 0]}
        castShadow
        receiveShadow
      />

      {/* Woodpile — the fuel source the player draws from. Taking a log is a
          matter of reaching for one, not of pressing a labelled control. */}
      <group position={[1.7, 0, -0.9]} name="woodpile">
        {Array.from({ length: 8 }, (_, i) => (
          <mesh
            key={i}
            geometry={woodpileGeometry}
            material={woodMaterial}
            position={[(i % 3) * 0.14 - 0.14, 0.07 + Math.floor(i / 3) * 0.13, (i % 2) * 0.06]}
            rotation={[0, 0.1 * i, 0]}
            castShadow
            onClick={
              onTakeWood
                ? (event) => {
                    event.stopPropagation();
                    // Different logs in the pile are different wood, so which
                    // one you reach for genuinely matters to the fire.
                    onTakeWood(fuelIds[i % fuelIds.length] ?? 'oak');
                  }
                : undefined
            }
            onPointerOver={(event) => {
              if (!onTakeWood) return;
              event.stopPropagation();
              if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
            }}
            onPointerOut={() => {
              if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
            }}
          />
        ))}
      </group>

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
      <ambientLight intensity={0.85 + moonlight.ambient * 1.9} color={0x33445f} />
      <directionalLight
        position={moonlight.position}
        intensity={moonlight.intensity}
        color={0xa8bcd8}
      />
      {/* The sky's own light, from above, so canopies read as canopies. */}
      <hemisphereLight
        intensity={0.6 + moonlight.ambient * 1.5}
        color={0x4a5f80}
        groundColor={0x161a14}
      />
    </group>
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
