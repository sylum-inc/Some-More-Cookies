/**
 * The constellations, where they actually are.
 *
 * `Campsite.tsx` draws the field stars — the anonymous ones, scattered, which
 * is what they are. This draws the *named* ones, at the real altitude and
 * azimuth the astronomy model computes for the session's date and place, and
 * the meteors on top of them.
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
 * Two draw calls: one `Points` for every named star, one `LineSegments` for
 * the joins and the streaks together. The arrival frame is already at the
 * draw-call ceiling (ARCHITECTURE §10), so this is as cheap as a sky gets.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CONSTELLATIONS, skyTargets, type RitualState } from '@somemore/sim';

/** Radius of the celestial dome, metres. Beyond every fog distance. */
const DOME = 118;

/** How many line segments the streaks may use. */
const METEOR_SEGMENTS = 8;

export interface NightSkyProps {
  ritual: RitualState;
}

/** Total stars across every constellation in the catalogue. */
const STAR_COUNT = CONSTELLATIONS.reduce((total, c) => total + c.stars.length, 0);
/** Joins between consecutive stars within each constellation. */
const JOIN_COUNT = CONSTELLATIONS.reduce((total, c) => total + Math.max(0, c.stars.length - 1), 0);

export function NightSky({ ritual }: NightSkyProps): React.ReactElement {
  const starsRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);

  const starGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
    return geometry;
  }, []);
  useEffect(() => () => starGeometry.dispose(), [starGeometry]);

  const lineGeometry = useMemo(() => {
    const segments = JOIN_COUNT + METEOR_SEGMENTS;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    return geometry;
  }, []);
  useEffect(() => () => lineGeometry.dispose(), [lineGeometry]);

  const starMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 1.9,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => starMaterial.dispose(), [starMaterial]);

  const lineMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => lineMaterial.dispose(), [lineMaterial]);

  useFrame(() => {
    const stargazing = ritual.stargazing;
    const targets = skyTargets(stargazing, ritual.weather.cloudCover);

    const starPositions = starGeometry.getAttribute('position') as THREE.BufferAttribute;
    const starColours = starGeometry.getAttribute('color') as THREE.BufferAttribute;
    const linePositions = lineGeometry.getAttribute('position') as THREE.BufferAttribute;
    const lineColours = lineGeometry.getAttribute('color') as THREE.BufferAttribute;

    let star = 0;
    let segment = 0;
    let anythingVisible = false;

    for (const target of targets) {
      const constellation = CONSTELLATIONS.find((candidate) => candidate.id === target.id);
      if (!constellation) continue;
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
        // The catalogue's star offsets are a local frame in degrees-ish; they
        // are applied around the constellation's own alt/az so the shape stays
        // the shape while the whole thing rises and sets.
        const azimuth = target.azimuth + entry[0] * 0.14;
        const altitude = target.altitude + entry[1] * 0.14;
        const cosAlt = Math.cos(altitude);
        const x = Math.sin(azimuth) * cosAlt * DOME;
        const y = Math.sin(altitude) * DOME;
        const z = Math.cos(azimuth) * cosAlt * DOME;
        starPositions.setXYZ(star, x, visible ? y : -DOME, z);
        // Magnitude: lower numbers are brighter stars.
        const brightness = visible ? Math.max(0.25, 1.2 - entry[2] * 0.26) * clarity : 0;
        starColours.setXYZ(star, brightness, brightness, brightness * 1.04);
        star++;

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

    starPositions.needsUpdate = true;
    starColours.needsUpdate = true;
    linePositions.needsUpdate = true;
    lineColours.needsUpdate = true;

    if (starsRef.current) starsRef.current.visible = anythingVisible;
    if (linesRef.current) linesRef.current.visible = anythingVisible;
  });

  return (
    <group name="night-sky">
      <points ref={starsRef} geometry={starGeometry} material={starMaterial} frustumCulled={false} />
      <lineSegments ref={linesRef} geometry={lineGeometry} material={lineMaterial} frustumCulled={false} />
    </group>
  );
}

/** Alt/az to a point on the dome. Azimuth is measured from north (+Z). */
function domePoint(azimuth: number, altitude: number): [number, number, number] {
  const cosAlt = Math.cos(altitude);
  return [Math.sin(azimuth) * cosAlt * DOME, Math.sin(altitude) * DOME, Math.cos(azimuth) * cosAlt * DOME];
}
