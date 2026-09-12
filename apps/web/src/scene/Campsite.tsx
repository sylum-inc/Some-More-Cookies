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
  type PlacedCurio,
  type SkyState,
  type WaterBasin,
  type WeatherState,
} from '@somemore/sim';
import {
  DOME_ALOFT,
  DOME_BAND,
  lightningStrike,
  luminance,
  skyLook,
  weatherLook,
  type SkyLook,
} from '../render/daylight.js';
import { TIER_TINT, starTier } from './NightSky.js';

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
import { createCurioGeometry, curioMaterial } from '../render/curios.js';
import {
  createGroundCoverGeometry,
  createLitterGeometry,
  createLogGeometry,
  createRockGeometry,
  createTerrainGeometry,
  createTreeGeometrySet,
  createUnderstoreyGeometry,
  drawnTerrainHeight,
  understoreyFamily,
  type TerrainGrid,
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
  /**
   * The campsite's small findable things.
   *
   * Placed by the simulation for the same reason the landmarks are: the list
   * that decides where they are drawn is the list that decides where you can
   * crouch over them.
   */
  curios?: readonly PlacedCurio[];
  /** Crouching over one, or straightening up. */
  onLookCloser?: (secretId: string) => void;
  /** Walking up to one. */
  onVisitLandmark?: (id: string) => void;
  /** Which fuels this campsite offers, in order of what the pile shows. */
  fuelIds?: readonly string[];
  weather: WeatherState;
  settings: RenderSettings;
  drawDistance: number;
  /**
   * How far the player may walk from the fire, in metres.
   *
   * Drawn from the same number the fence uses, so the world is drawn at least
   * as far as it can be walked. See `campsiteRadiusM`.
   */
  walkableRadius: number;
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
  /**
   * The sky the simulation is actually under, right now.
   *
   * Optional, and the fallback is the curated night the scene used to pin
   * itself to for ever — so a caller that has no ritual (a storybook, a
   * fixture) still gets a campsite, and the one that does gets the hour.
   */
  sky?: SkyState;
}

/**
 * How far above the horizon the moon is pinned when it is down.
 *
 * Dark adaptation, which the renderer has no model of, plus the fact that a
 * light at grazing elevation puts almost nothing on flat ground. See
 * `bodyPosition`, and `e2e/night.spec.ts` for the line this holds.
 */
const MOON_FLOOR = 12;

/**
 * Where the undergrowth goes: clumps, three sizes, thicker under the trees.
 *
 * Two art reviews in a row have called the undergrowth "one Y-shaped sprite
 * repeated at near-identical scale and spacing", and all three halves of that
 * were true. Every instance was placed independently at a uniform angle and a
 * square-rooted radius, which is the definition of an even scatter; every scale
 * was a single roll over a 1.6x range, which at a metre from the knee is no
 * range at all; and nothing anywhere consulted where the trees were.
 *
 * Plants do not grow like that. They grow from where a parent dropped its
 * spores, in patches with bare ground between them, at whatever size the light
 * where they landed allowed — and bracken in particular is thickest exactly
 * where the canopy breaks. So:
 *
 *   - a handful of **clump centres** are drawn first and every instance belongs
 *     to one, scattered around it with a triangular falloff. The gaps between
 *     clumps are as much of the read as the clumps are;
 *   - **three scale classes** rather than one continuous roll, because a ratio
 *     of two between neighbours is what the eye picks up as different ages of
 *     the same plant, while a smooth spread of scales averages back to one size;
 *   - **canopy proximity** decides how many take, so the fringe under the trees
 *     is dense and the middle of the clearing is thin.
 *
 * All of it is placement, which is free: the same two geometries, the same two
 * draw calls, the same instance count.
 *
 * Lifted out of the component so it can be *measured* rather than looked at.
 * "Clumpier than a uniform scatter" and "three distinct sizes" are properties
 * with numbers attached, and a change like this one has now twice been made,
 * shipped, and reported as not having happened — see `campsite-scatter.test.ts`.
 */
export function plantUnderstorey(options: {
  rng: () => number;
  /** How many to plant. The loop stops when it has them. */
  count: number;
  /** The disc to fill, from `CLEARING_RADIUS` out. */
  radius: number;
  /** Two of them, because instancing wants one mesh per geometry variant. */
  buckets: ScatterItem[][];
  /** 0..1, how likely a plant is to take here. See `understoreyDensity`. */
  density: (x: number, z: number) => number;
  height: (x: number, z: number) => number;
  underwater: (y: number) => boolean;
}): number {
  const { rng, count, radius, buckets, density, height, underwater } = options;
  // The trail keeps the same corridor the trees already respect.
  const trailAngle = Math.atan2(6.2, 7.5);

  const clumps = Math.max(4, Math.round(count / 14));
  const centres: { angle: number; distance: number }[] = [];
  for (let c = 0; c < clumps; c++) {
    centres.push({
      angle: rng() * Math.PI * 2,
      distance: CLEARING_RADIUS + Math.sqrt(rng()) * Math.max(0, radius - CLEARING_RADIUS),
    });
  }

  /*
   * Attempts, not instances.
   *
   * Two of the filters below — the clearing's soft edge and the canopy term —
   * reject, and rejecting inside a fixed-length loop would have quietly halved
   * the undergrowth as a side effect of making it clumpy. So the loop runs
   * until it has planted what the catalogue asked for, with a hard attempt
   * ceiling so a kit whose whole disc is inside the clearing cannot spin. Same
   * instance count as before, and therefore the same triangles and draw calls.
   */
  let planted = 0;
  for (let i = 0; i < count * 4 && planted < count; i++) {
    /*
     * Most of it belongs to a patch and a fifth of it does not.
     *
     * Rendered from above, clump-only placement came out as polka dots: thirty
     * tight blobs with bare ground between every one of them, which is a
     * different wrong answer from an even sprinkle rather than a right one. A
     * real stand has patches *and* the odd plant out on its own, and the
     * strays are what stop the gaps reading as mown.
     */
    let distance: number;
    let angle: number;
    if (rng() < 0.2) {
      angle = rng() * Math.PI * 2;
      distance = CLEARING_RADIUS + Math.sqrt(rng()) * Math.max(0, radius - CLEARING_RADIUS);
    } else {
      const centre = centres[Math.floor(rng() * centres.length)] as {
        angle: number;
        distance: number;
      };
      // Two rolls added is a triangular distribution: most of a clump sits near
      // its centre and a few stragglers reach out, which is what a patch is.
      const spread = 0.9 + rng() * 3.2;
      const off = (rng() + rng() - 1) * spread;
      const offAngle = ((rng() + rng() - 1) * spread) / Math.max(1.5, centre.distance);
      distance = Math.max(CLEARING_RADIUS, centre.distance + off);
      angle = centre.angle + offAngle;
    }
    // A soft edge to the clearing: right at its lip almost nothing takes, and a
    // couple of metres out everything does. A hard ring reads as a mown lawn,
    // which is the opposite of a wood.
    const establish = clamp01((distance - CLEARING_RADIUS) / 2.4);
    if (rng() > establish * 0.85 + 0.15) continue;
    let delta = Math.abs(angle - trailAngle) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta < 0.3 && distance < 12) continue;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    if (rng() > density(x, z)) continue;
    const y = height(x, z);
    // Nothing grows in the fire or underwater.
    if (underwater(y)) continue;
    // Three ages of the same plant: seedling, established, and the one that got
    // the light. Roughly 3 : 5 : 2, so the big ones read as landmarks.
    const roll = rng();
    const scale = roll < 0.3 ? 0.52 : roll < 0.82 ? 0.9 : 1.55;
    const bucket = buckets[rng() < 0.5 ? 0 : 1] as ScatterItem[];
    bucket.push({
      x,
      y,
      z,
      // A little jitter inside each class, so a class is a size and not a stamp.
      scale: scale * (0.88 + rng() * 0.24),
      rotationY: rng() * Math.PI * 2,
    });
    planted++;
  }
  return planted;
}

/**
 * How thick the field stars are in a given direction, 0..1.
 *
 * The critic's item 13, the half of it that was left. The magnitudes and the
 * tiers were fixed a round ago and the *placement* was not: four hundred and
 * twenty points at a uniform angle over a uniform solid angle is a Poisson
 * field, and a Poisson field on a dome is exactly what a scanner's noise floor
 * looks like — which is what "uniformly sized, uniformly bright 1px dots,
 * sensor noise, not a sky" was about in the first place.
 *
 * A real sky is nothing like even. The galactic plane runs across it, there are
 * dark lanes where the dust is, and the count thins toward the pole; the eye
 * reads that structure long before it reads any individual star. A tilted band
 * plus two long-wavelength sines gives it for nothing: the placement loop rolls
 * a direction, samples this, and keeps the star in proportion. Same count, same
 * two clouds, same draw calls — a redistribution, not an addition.
 *
 * Never returns zero. The voids are thin, not empty; a sky with holes punched
 * clean through it reads as torn rather than as deep.
 */
export function starDrift(x: number, y: number, z: number): number {
  // `y * 2.1` tilts the plane so it crosses the sky at an angle rather than
  // lying along the horizon, which is where a treeline already is.
  const plane = Math.abs(x * 0.55 + y * 2.1 - z * 0.42) / 120;
  const band = 1 - Math.min(1, plane * 1.35);
  const lumps = Math.sin(x * 0.061 + z * 0.037) * 0.5 + Math.sin(z * 0.094 - y * 0.052) * 0.5;
  // The constant is the floor and it is chosen rather than left over: the
  // thinnest part of the sky still keeps about one star in seven.
  return clamp01(0.32 + band * 0.55 + lumps * 0.18);
}

/** Scratch, so easing the sky every frame allocates nothing. */
const TMP_COLOR = new THREE.Color();
/** A second one: the hour now moves four albedos, not one. */
const TMP_COLOR_B = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);
/**
 * Where the palette goes as the weather closes in.
 *
 * A blue-grey rather than a neutral one, because taking the chroma out of a
 * forest floor toward grey reads as a black-and-white photograph and taking it
 * toward this reads as cold light — and cold light is the thing every wet or
 * frozen state in the set has in common.
 */
const GROUND_CHILL = new THREE.Color(0x6a7686);
/**
 * Lying snow. Not white: snow under a canopy at dusk is a pale blue-grey, and
 * a floor at `#ffffff` in a game with a five-bit colour depth is a hole in the
 * frame rather than a surface.
 */
const SNOW_LYING = new THREE.Color(0xd2dae4);
/** The stones lying in the dirt, and the sticks. See their materials. */
const PEBBLE_TONE = 0x4a453e;
const SPRIG_TONE = 0x6b5a44;

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
  walkableRadius,
  sky: liveSky,
  palette = DEFAULT_PALETTE,
  treeCount = 54,
  understorey = [],
  onTakeWood,
  fuelPatches,
  onGather,
  landmarks,
  curios,
  onLookCloser,
  onVisitLandmark,
  fuelIds = ['oak'],
  basin,
}: CampsiteProps): React.ReactElement {
  /*
   * The sky is eased in the frame loop rather than set from a render.
   *
   * React re-renders when the store says something changed, which is not every
   * frame and is not on any schedule the sun cares about. Driving the colours
   * from the prop directly would step the sky forward in visible jumps at
   * whatever cadence the game happened to be re-rendering at. So the render
   * decides where the sky is *going* and the frame loop walks it there.
   */
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemisphereRef = useRef<THREE.HemisphereLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const sunDiscRef = useRef<THREE.Mesh>(null);
  const moonDiscRef = useRef<THREE.Mesh>(null);
  /** Standing water in the low ground. One instanced mesh; see `puddles`. */
  const puddleRef = useRef<THREE.InstancedMesh>(null);
  /** Where the colours actually are, as opposed to where they are headed. */
  const eased = useRef({
    haze: new THREE.Color(),
    sky: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    started: false,
  });
  /*
   * The scene's own fog and background, owned here rather than declared.
   *
   * They used to be `<fog attach="fog">` and `<color attach="background">`
   * inside this component's `<group>` — and `attach` binds to the parent
   * object, so both were being set on the group. `scene.fog` and
   * `scene.background` were null the whole time: the campsite had no fog at
   * all, and the "short draw distance and heavy fog" this file's own header
   * claims were doing the work were doing none of it. The `fogRef` reads and
   * writes all worked; they were simply landing on an object nothing renders
   * from.
   */
  /*
   * The sky, as a gradient rather than as one colour.
   *
   * `scene.background` is a single flat colour and always was, which is why an
   * art review found midday and dusk indistinguishable: a sunset is an orange
   * band under an indigo one, and a flat field has nowhere to put the band. So
   * a dome goes over the background, mixing horizon into zenith by the view
   * direction's own Y.
   *
   * Three colours and a dozen lines of GLSL rather than a texture, because
   * ADR-0002 says everything is procedural and because a gradient texture at
   * this resolution would band worse than the shader does. `smoothstep` and a
   * pinch toward the horizon keep the interesting part — the two or three
   * degrees above the treeline — from being squeezed into nothing.
   *
   * **The whole sky was being drawn in the wrong colour space, and this is the
   * ninth thing this session to have been written, computed and then thrown
   * away one stage later.**
   *
   * A `ShaderMaterial` that writes `gl_FragColor` itself gets no
   * `<colorspace_fragment>` unless it asks for one, and its `Color` uniforms
   * are uploaded in the renderer's *working* space, which is linear. So every
   * colour this dome has ever painted went into an sRGB framebuffer as a linear
   * number — and linear-as-sRGB is roughly half the value. The ramp's noon
   * zenith is `#92a9cd`; measured on the midday capture it arrives as
   * `#4a679c`, which is exactly `sRGBToLinear(#92a9cd)` rounded, to the byte,
   * on all three channels.
   *
   * That one missing include is most of the "pale ghost trees" an art director
   * found in the mid-distance. Distance fog is applied *after*
   * `<colorspace_fragment>` in Three's own fragment order and its colour
   * uniform is converted to the output space on the way in, so fogged geometry
   * resolves to exactly the value `daylight.ts` asks for — while the sky behind
   * it was arriving at half of it. A tree at the treeline was not too bright;
   * the sky was too dark, by a factor of two, at every hour since the dome was
   * written. Measured: crowns at 169–183 against a sky at 100.7.
   *
   * It is worth recording how well it hid. Every screenshot looked like a
   * plausible dusk, because halving a sky in linear light is very close to what
   * a darker sky looks like — and the ramp had been re-tuned twice *against*
   * these frames, so two rounds of art direction were spent compensating for a
   * missing five words.
   */
  const domeMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uHorizon: { value: new THREE.Color(0x0c1119) },
          uZenith: { value: new THREE.Color(0x070a0f) },
          /** The airlight: what the sky is at the treeline. See `daylight.ts`. */
          uHaze: { value: new THREE.Color(0x0b1016) },
          uCloud: { value: new THREE.Color(0x4a4f58) },
          /** 0..1 cover, and a slow drift so the deck is not a painting. */
          uCover: { value: 0 },
          uTime: { value: 0 },
          /** Full-frame lightning, 0..1. Zero whenever motion is reduced. */
          uFlash: { value: 0 },
        },
        vertexShader: `
          varying vec3 vDirection;
          void main() {
            vDirection = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uHorizon;
          uniform vec3 uZenith;
          uniform vec3 uHaze;
          uniform vec3 uCloud;
          uniform float uCover;
          uniform float uTime;
          uniform float uFlash;
          varying vec3 vDirection;

          /*
           * A cloud deck, because the sky had none.
           *
           * \`cloudCover\` moved the sky's colour and its fog and the sun's
           * intensity, and never drew a cloud — so overcast, rain, storm and
           * snow all rendered as the same empty gradient with a different
           * icon in the HUD corner. Three octaves of value noise on a plane
           * the view direction is projected onto, which is a flat deck seen
           * in perspective: cells crowd together toward the horizon exactly
           * the way real cloud does, and that convergence is most of what
           * says "sky" rather than "texture".
           */
          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }

          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
              mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }

          float clouds(vec3 dir) {
            // Below the horizon there is no deck to see.
            if (dir.y < 0.02) return 0.0;
            // Project onto a plane a little above the eye. The divide is what
            // crowds the cells toward the horizon.
            vec2 p = dir.xz / dir.y;
            p += vec2(uTime * 0.004, uTime * 0.0015);
            float f = noise(p * 0.55) * 0.55;
            f += noise(p * 1.3) * 0.28;
            f += noise(p * 2.9) * 0.17;
            // Cover opens and closes the gaps rather than fading the whole
            // deck: at 0.3 you get scattered cloud with sky between, at 0.95
            // an unbroken lid, which is the difference between high-cloud and
            // overcast and cannot be done with opacity alone.
            float edge = mix(0.86, 0.12, uCover);
            return smoothstep(edge, edge + 0.34, f) * smoothstep(0.02, 0.30, dir.y);
          }

          void main() {
            /*
             * Two ramps, because a sky has two things going on in it.
             *
             * \`band\` is the sunset strip. Narrow on purpose: the first version
             * ramped over the first 25 degrees, and because the camera sits
             * pitched down at a fire the whole visible sky is inside that — so
             * a sunset came out as a uniformly red dome rather than as a red
             * strip under a violet one, which is a different and much worse
             * thing.
             *
             * \`aloft\` is the aerial gradient above it, and it is the one that
             * was missing. With the band as the *only* ramp, everything above
             * eight degrees was painted the flat zenith colour and there was no
             * haze in the sky at all — while distance fog went on resolving to
             * the horizon for geometry at every height. A conifer crown eleven
             * degrees up was therefore fogged toward a strip it was nowhere
             * near, and drawn against a zenith with nothing between them. Both
             * edges come from \`daylight.ts\` (\`DOME_BAND\`, \`DOME_ALOFT\`),
             * which is also where \`uHaze\` and the fog colour are derived from
             * them, so the two cannot drift apart.
             */
            float h = clamp(vDirection.y, 0.0, 1.0);
            float band = smoothstep(${DOME_BAND.from.toFixed(3)}, ${DOME_BAND.to.toFixed(3)}, h);
            float aloft = smoothstep(${DOME_ALOFT.from.toFixed(3)}, ${DOME_ALOFT.to.toFixed(3)}, h);
            vec3 sky = mix(uHorizon, mix(uHaze, uZenith, aloft), band);
            // The deck's whole colour arrives ready-made now, rather than
            // being mixed toward the horizon here: a storm lid has to be able
            // to go dark *including* its warm belly, and mixing a fixed 28 %
            // of the horizon back in at this end put a floor under how dark
            // any cloud could be. See where the uniform is set.
            vec3 colour = mix(sky, uCloud, clouds(vDirection));
            /*
             * Lightning, as the sky rather than as a filter.
             *
             * The critic asked for "periodic full-frame value inversion", and
             * that is what a bolt does: for two frames the sky is the brightest
             * thing in the world instead of the darkest, and every tree in front
             * of it becomes a black cut-out. Done here, it costs one uniform and
             * no post-process — and because it is only ever the *sky* that goes
             * white, the ground stays exactly as legible as it was, which is what
             * D7 needs and what a screen-wide white flash would not give.
             *
             * \`uFlash\` is held at zero whenever reduced motion is on; see the
             * frame loop, where the storm keeps its other four signatures.
             */
            colour = mix(colour, vec3(0.86, 0.90, 1.0), uFlash);
            gl_FragColor = vec4(colour, 1.0);
            /*
             * And out into the space the framebuffer is actually in.
             *
             * See the note where this material is built: without this the dome
             * writes linear light into an sRGB buffer and the entire sky is
             * drawn at about half the value the ramp asks for, which is most of
             * what "pale ghost trees in the mid-distance" turned out to be.
             */
            #include <colorspace_fragment>
          }
        `,
        side: THREE.BackSide,
        /*
         * Neither writes depth nor tests it.
         *
         * Not writing keeps the dome from occluding anything. Not *testing* is
         * what lets it sit inside the far plane without the geometry beyond it
         * punching through — it is drawn first (`renderOrder` below) and
         * everything else paints over it, which is how a sky has always been
         * done and is why its radius can be a number that fits the frustum.
         *
         * The first version of this was a 420-metre sphere against a camera
         * whose far plane is 200, so it was clipped in its entirety and the
         * sky stayed exactly as flat as it had been. The screenshots looked
         * plausible — the flat background is the dome's own zenith colour —
         * and it took measuring the horizon strip against the zenith strip to
         * see that the two were the same number.
         */
        depthWrite: false,
        depthTest: false,
        fog: false,
        toneMapped: false,
      }),
    [],
  );
  const sceneFog = useMemo(() => new THREE.Fog(0x0b1016, 2.5, 30), []);
  const sceneBackground = useMemo(() => new THREE.Color(0x070a0f), []);
  const starsRef = useRef<THREE.Points>(null);
  const brightStarsRef = useRef<THREE.Points>(null);
  const rainRef = useRef<THREE.LineSegments>(null);
  /** How much snow is lying, eased so a squall whitens the ground over seconds. */
  const snowCover = useRef(0);
  const snowRef = useRef<THREE.Points>(null);

  /*
   * How far the drawn world has to go.
   *
   * The ground was a fixed 46 m square, which is 23 m from the fire in any
   * direction — fine while the fence was 16 m, and not fine now that it is
   * the campsite's authored radius. Past the edge `terrainHeight` keeps
   * answering, so the player does not fall; the ground simply stops being
   * drawn under them. It is sized from whichever is further, the fog or the
   * fence, plus a margin so the edge itself is never the thing you are
   * looking at.
   */
  const extent = Math.max(drawDistance, walkableRadius);

  /*
   * A finer grid where there is water: a two-metre creek channel is invisible
   * at 1.8 m per segment, and the shore is the one edge that has to read.
   *
   * Segments follow the size so that metres-per-vertex stays where it was
   * rather than the grid coarsening as the world grows — the drawn ground and
   * the walked ground are the same analytic function, and they stop agreeing
   * when the mesh gets too loose to follow it. Capped, because the cost is
   * quadratic and a 70 m basin at the fine spacing is 26,000 triangles on its
   * own.
   */
  const terrainGrid = useMemo((): TerrainGrid => {
    const size = Math.max(46, extent * 2 + 12);
    const metresPerSegment = basin ? 46 / 44 : 46 / 26;
    const segments = Math.min(basin ? 72 : 48, Math.round(size / metresPerSegment));
    return { size, segments, seed, amplitude: 0.7, ...(basin ? { basin } : {}) };
  }, [seed, basin, extent]);

  const terrain = useMemo(
    () =>
      createTerrainGeometry(
        terrainGrid.size,
        terrainGrid.segments,
        terrainGrid.seed,
        terrainGrid.amplitude,
        terrainGrid.basin,
      ),
    [terrainGrid],
  );

  /**
   * The surface anything laid on the ground has to sit on.
   *
   * Not `terrainHeight`. The mesh is flat triangles through samples of that
   * function and departs from it by up to six centimetres between vertices —
   * enough to swallow a mat lifted a centimetre and a half, in patches, which
   * reads as holes in the clearing floor. See `drawnTerrainHeight`.
   */
  const groundAt = useMemo(
    () => (x: number, z: number) => drawnTerrainHeight(x, z, terrainGrid),
    [terrainGrid],
  );

  /*
   * The forest floor's texture, at a size where it is a texture.
   *
   * Three rounds of art review said the ground has no material — "a smooth
   * radial gradient of brown", measured at 3.6 of 255 in high-frequency detail
   * across the largest surface in the game. The dirt texture was there the
   * whole time and had been since the render layer was built. What was missing
   * was one line: `PlaneGeometry` lays its UVs 0..1 across the entire mesh, and
   * this mesh is forty-six metres wide, so a sixty-four pixel texture was being
   * magnified to about seventy centimetres a texel. At that scale a speckle is
   * not a speckle, it is a gradient — which is exactly what three reviews
   * described.
   *
   * Cloned rather than repeated in place because `getTexture` caches by key and
   * everything else that draws dirt wants it at its own scale.
   *
   * Two metres a tile. Small enough that the near ground has grain a player can
   * see from standing height, large enough that the tiling does not read as
   * wallpaper at the treeline — and it is 3 cm a texel, which after the 320x240
   * downsample is around the size of the ordered dither cell, so the two
   * cooperate rather than fight.
   */
  const groundTexture = useMemo(() => {
    const base = getTexture('dirt', { size: 64, seed });
    if (!base) return null;
    const tiled = base.clone();
    tiled.wrapS = THREE.RepeatWrapping;
    tiled.wrapT = THREE.RepeatWrapping;
    const size = Math.max(46, extent * 2 + 12);
    tiled.repeat.set(size / 2, size / 2);
    tiled.needsUpdate = true;
    return tiled;
  }, [seed, extent]);
  useEffect(() => () => groundTexture?.dispose(), [groundTexture]);

  const groundMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: groundTexture,
        color: palette.ground,
        roughness: 1,
        // The per-vertex tint `createTerrainGeometry` bakes in. It multiplies
        // against `color`, so the hour still moves the whole floor together
        // and this only varies it.
        vertexColors: true,
      }),
    [settings, groundTexture, palette.ground],
  );

  /**
   * The ground's two colours: the one the manifest asked for, and a daylight
   * one.
   *
   * The forest floor is a dark dirt texture over a dark brown, which is
   * exactly right lit by a fire from two metres and reads as a hole in the
   * world at noon — measured at 38/255 under a full sun against a sky at 170.
   * Adding sunlight until the ground looks right blows out everything that
   * already looked right, because what is wrong is the albedo. So the palette
   * moves with the hour instead, which is how the hardware this is pretending
   * to be did day and night anyway.
   *
   * **Lifted toward daylight, not toward white.** The first version of this
   * lerped the manifest's ground colour 85 % of the way to `0xffffff`, which
   * raises the value and destroys the chroma at the same rate: the pine
   * hollow's `#2b2119` came out at `#9e9a96`, a neutral grey with two units of
   * colour left in it, and a fourth art review called the whole world
   * achromatic. It was right, and this was half of why.
   *
   * A surface in sunlight does not desaturate. It gets brighter and, if
   * anything, a little *more* saturated, because more of the light reaching
   * the eye has bounced off it. So the day tone is the same hue at a much
   * higher lightness, taken in HSL where those two are separable numbers.
   *
   * **But not more saturated than it started, which is where the last version
   * overshot.** `chroma: 1.15` on top of `lightness: 0.55` took the pine
   * hollow's `#2b2119` — a manifest that describes itself as "deep rust-brown
   * needle litter over compacted dirt" — out to a `#af8869` that the midday
   * capture then rendered as a near-uniform orange. Graded, the note was that
   * the forest floor read "closer to Mars than to a pine hollow", and it was
   * right: rust-brown at 13 % lightness has about the same chroma-to-value
   * ratio as orange at 55 %, and holding the ratio while quadrupling the value
   * is what turns duff into desert. Real needle litter loses a little chroma as
   * it dries out in the sun and it loses a lot as it silvers with age, so the
   * day tone now sits slightly *under* the night's saturation rather than over
   * it, and a little darker with it.
   */
  const groundTones = useMemo(() => {
    const night = new THREE.Color(palette.ground);
    return { night, day: sunlit(night, 0.46, 0.82) };
  }, [palette.ground]);

  /**
   * How much darker the ground gets on the way out to the trees — moved.
   *
   * This was 0.88, multiplied into the terrain material's colour, under an
   * argument for a three-step ladder from the fire ring to the treeline. The
   * argument was right and the mechanism could not carry it: a material colour
   * is one colour across everything it paints, so what the frame actually got
   * was a step at the cover mat's rim and then six metres of clearing floor at
   * a single value. Measured at a metre's spacing under a midday sun: 75.6,
   * 72.7, 75.9, 73.3, 75.2, 75.2, 75.3 out of 255. That flat stretch is most
   * of the bottom half of most frames, and it is what a panel of three art
   * directors each described, independently, as one brown wash.
   *
   * The shade is now a function of world radius applied per vertex, shared by
   * the terrain and the duff mat so the two cannot drift apart — see
   * `clearingShade` in `render/geometry.ts`. It is left at 1 here rather than
   * deleted because `paint` still takes the parameter for the worn ring's 1.06
   * lift, and because a reader arriving at this call site needs to be told the
   * shade exists somewhere else rather than left to conclude it was dropped.
   */
  const CANOPY_SHADE = 1;

  /**
   * The near ground, in two grains.
   *
   * See `createGroundCoverGeometry`. The spoke count is the quality dial:
   * `drawDistance` arrives already capped by the tier, so a weak device gets a
   * coarser mat rather than a smaller one — the near ground is the last thing
   * in this scene that should shrink, since it is what the player is standing
   * on.
   */
  const groundCover = useMemo(
    () =>
      createGroundCoverGeometry({
        seed,
        spokes: drawDistance < 26 ? 14 : drawDistance < 36 ? 20 : 26,
        outerRadius: 9.4,
        height: groundAt,
      }),
    [seed, groundAt, drawDistance],
  );
  useEffect(
    () => () => {
      groundCover.worn.dispose();
      groundCover.duff.dispose();
    },
    [groundCover],
  );

  /**
   * The two near-ground tiles, at their own scales.
   *
   * Eighty-five centimetres for the trodden ring against two metres for the
   * duff — and the duff's two metres is exactly the terrain's, so the mat has
   * no outer edge at all. The whole frequency step lives at the worn ring's
   * boundary, which is the "variation in grain between the trodden ring and
   * the untrodden ground" that four reviews have asked for, and it cannot come
   * from a tint.
   */
  const coverTextures = useMemo(() => {
    const make = (key: 'duff' | 'trodden', metres: number): THREE.Texture | null => {
      const base = getTexture(key, { size: 64, seed });
      if (!base) return null;
      const tiled = base.clone();
      tiled.wrapS = THREE.RepeatWrapping;
      tiled.wrapT = THREE.RepeatWrapping;
      // The mat's UVs are already in metres, so the repeat is the tile size.
      tiled.repeat.set(1 / metres, 1 / metres);
      tiled.needsUpdate = true;
      return tiled;
    };
    return { duff: make('duff', 2), trodden: make('trodden', 0.85) };
  }, [seed]);
  useEffect(
    () => () => {
      coverTextures.duff?.dispose();
      coverTextures.trodden?.dispose();
    },
    [coverTextures],
  );

  /**
   * The tile every contact pool shares. See `ContactPools`.
   *
   * Not tiled and not repeated — one disc, stretched to each prop's footprint.
   */
  const contactTexture = useMemo(() => getTexture('contact', { size: 64, seed: seed ^ 0x4d1e }), [seed]);
  useEffect(() => () => contactTexture?.dispose(), [contactTexture]);

  const duffMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: coverTextures.duff,
        color: palette.ground,
        roughness: 1,
        vertexColors: true,
      }),
    [settings, coverTextures.duff, palette.ground],
  );

  /*
   * The worn ring wears the campsite's own ground colour, exactly like the
   * ground around it.
   *
   * The lift lives in the tile — `trodden` is normalised to `TRODDEN_LIFT`
   * times the reference ground mean — rather than in a paler material colour.
   * The first version did it the other way and put the ring five times the
   * albedo of the floor it sits in, which under a campfire is not a worn ring,
   * it is a spotlight; `e2e/night.spec.ts` asserts a band and would have
   * failed on it. Keeping the colour shared also means a mesa's worn ring is
   * a mesa's, with no second palette to keep in step.
   */
  const wornMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: coverTextures.trodden,
        color: palette.ground,
        roughness: 1,
        vertexColors: true,
      }),
    [settings, coverTextures.trodden, palette.ground],
  );

  /**
   * What is lying on it.
   *
   * Two shapes and two draw calls for the whole clearing floor. The counts
   * follow `drawDistance` for the same reason the mat's spokes do; nothing
   * here is ever dropped entirely, because a bare plane is the defect and a
   * sparse one is only a thinner wood.
   */
  const litterGeometries = useMemo(
    () => ({
      pebble: createLitterGeometry('pebble', seed ^ 0x3f21, 0.085),
      sprig: createLitterGeometry('sprig', seed ^ 0x7d0b, 0.075),
    }),
    [seed],
  );
  useEffect(
    () => () => {
      litterGeometries.pebble.dispose();
      litterGeometries.sprig.dispose();
    },
    [litterGeometries],
  );

  const litterFields = useMemo(() => {
    const rng = mulberry(seed ^ 0x1c4d);
    const tier = drawDistance < 26 ? 0.55 : drawDistance < 36 ? 1 : 1.4;
    const pebbles: ScatterItem[] = [];
    const sprigs: ScatterItem[] = [];
    const wanted = Math.round(190 * tier);
    for (let i = 0; i < wanted; i++) {
      const angle = rng() * Math.PI * 2;
      /*
       * A little steeper than the square root an even spread over a disc would
       * want. Even is right for a wood you walk through and wrong here: what
       * has to read is the two or three metres between the fire and the log,
       * which is where the camera spends the whole game.
       */
      const distance = 0.95 + Math.pow(rng(), 0.62) * 7.4;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const y = groundAt(x, z);
      if (basin && y < WATERLINE) continue;
      const item: ScatterItem = {
        x,
        // On the mat, which is itself a centimetre and a half over the ground.
        y: y + 0.022,
        z,
        rotationY: rng() * Math.PI * 2,
        scale: 0.6 + rng() * 1.1,
      };
      /*
       * Sticks and needles are what a *swept* ring has least of, and stones
       * are what it has most: sweeping a fire ring moves the litter out and
       * leaves the grit behind. So the mix flips across the boundary, which is
       * the second thing after the tile change that says the ring is worn.
       */
      const stony = distance < 3.2 ? 0.68 : 0.26;
      if (rng() < stony) pebbles.push(item);
      else sprigs.push(item);
    }
    return { pebbles, sprigs };
  }, [seed, basin, groundAt, drawDistance]);

  /**
   * Puddles, in the low ground, for one draw call and about eighty triangles.
   *
   * Chosen rather than scattered: a puddle in a random place is a shiny disc,
   * and a puddle in a hollow is *drainage*. So a few dozen candidates are
   * sampled around the clearing and only the lowest survive, which means the
   * water lies where the terrain says water would lie and the same campsite
   * puddles in the same places every time it rains.
   *
   * Kept out of the trodden ring by a wide margin: the one place a campsite
   * does not hold water is the packed ground people have been walking on, and
   * the fire's pool of light reaches far enough out that the puddles still
   * catch it from the edge of the duff.
   */
  const puddleItems = useMemo<ScatterItem[]>(() => {
    const rng = mulberry(seed ^ 0x60d1);
    const candidates: { x: number; z: number; y: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const angle = rng() * Math.PI * 2;
      const distance = 3.6 + Math.sqrt(rng()) * 5.2;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const y = groundAt(x, z);
      if (basin && y < WATERLINE) continue;
      candidates.push({ x, y, z });
    }
    candidates.sort((a, b) => a.y - b.y);
    // Eight on a mid device, five on a weak one. The count is what makes them
    // read as weather rather than as a feature of the campsite.
    const wanted = drawDistance < 26 ? 5 : drawDistance < 36 ? 8 : 10;
    return candidates.slice(0, wanted).map((spot) => ({
      x: spot.x,
      // Over the duff mat's own centimetre and a half, or the water is under
      // the ground it is supposed to be lying on.
      y: spot.y + 0.019,
      z: spot.z,
      rotationY: rng() * Math.PI * 2,
      scale: 0.34 + rng() * 0.46,
    }));
  }, [seed, basin, groundAt, drawDistance]);

  /** A seven-sided disc. Seven triangles; a circle would be a rounding error. */
  const puddleGeometry = useMemo(() => {
    const disc = new THREE.CircleGeometry(1, 7);
    disc.rotateX(-Math.PI / 2);
    return disc;
  }, []);
  useEffect(() => () => puddleGeometry.dispose(), [puddleGeometry]);

  /**
   * Water lying on dirt: dark, smooth and a little metallic.
   *
   * The albedo is almost nothing, which is right — a puddle is mostly a mirror
   * — and the whole of what you see in it is the specular return. That is why
   * it is worth a draw call: everything else rain does to this clearing makes
   * it darker, and this is the one thing that makes part of it brighter.
   */
  const puddleMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        color: 0x2c3742,
        roughness: 0.12,
        metalness: 0.62,
        transparent: true,
        opacity: 0,
      }),
    [settings],
  );

  const treeMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('foliage', { size: 64, seed }),
        color: palette.foliage,
        roughness: 1,
        // The conifer's three tone bands, which `createTreeGeometry` bakes in
        // as multipliers rather than as colours — so the manifest's own
        // foliage colour still decides what a pine hollow's canopy IS, and
        // this only says which parts of it catch the light. Without the flag
        // the bands are computed and thrown away.
        vertexColors: true,
      }),
    [settings, seed, palette.foliage],
  );

  /**
   * The wood's three colours: night, day, and the hour in between.
   *
   * The ground has moved with the sun since the daylight ramp was written and
   * the canopy never has. So at noon the trees kept an albedo authored to be
   * lit by a campfire — `#1e2a20` at the pine hollow, a green with sixteen
   * units of chroma in it — under nine and a half units of sun and two and a
   * half of blue-grey ambient. The result is what a fourth art review called
   * it: grey cones. Nothing was broken; the trees were simply the only large
   * surface in the scene still painted for midnight at noon.
   *
   * Two axes move, not one:
   *
   *   - **Value**, so a conifer in full sun is not a hole. Less than the
   *     ground gets, because a canopy really is darker than the floor it
   *     shades and because the treeline has to stay darker than the sky behind
   *     it — that is the aerial-perspective law, and lifting the trees past
   *     the horizon would invert it again.
   *   - **Hue**, which is what "the forest is achromatic" is actually about.
   *     Conifers go blue-green under a high sun and olive under a low one,
   *     because the light itself does. So the day tone is nudged cool and the
   *     golden-hour tone warm, and the frame loop crossfades between them on
   *     the sun's own colour temperature rather than on the clock.
   */
  const foliageTones = useMemo(() => {
    const night = new THREE.Color(palette.foliage);
    const day = sunlit(night, 0.31, 1.3);
    return {
      night,
      // High sun: the sky is the fill and the sky is blue.
      day: day.clone().lerp(new THREE.Color(0x4e7a68), 0.4),
      // Low sun: the same canopy under a warm key goes olive.
      golden: sunlit(night, 0.29, 1.4).lerp(new THREE.Color(0x7a7440), 0.3),
    };
  }, [palette.foliage]);

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
  const understoreyTones = useMemo(
    () => ({
      night: new THREE.Color(palette.foliage).lerp(new THREE.Color(0x8fa86a), 0.34),
    }),
    [palette.foliage],
  );

  const understoreyMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('foliage', { size: 64, seed }),
        color: understoreyTones.night.getHex(),
        roughness: 0.92,
        side: THREE.DoubleSide,
      }),
    [settings, seed, understoreyTones],
  );

  /*
   * Deadfall wood: greyer and cooler than a fresh log, because it has been
   * lying there long enough to lose its bark and go silver. That also keeps it
   * from competing with the warm log you sit on, which is the thing in the
   * middle of the frame the eye is supposed to land on.
   */
  const deadfallMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('bark', { size: 64 }),
        color: 0x8c8479,
        roughness: 1,
      }),
    [settings],
  );

  /*
   * `vertexColors` because `createRockGeometry` has always written a tint and
   * nothing has ever read it. A boulder shaded only by its own flat normals is
   * two or three values; with the tint it is two or three values plus the
   * mottle of a rock, which is what stops fourteen instances of four shapes
   * reading as fourteen instances of four shapes.
   */
  const rockMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('stone', { size: 64, seed }),
        roughness: 1,
        vertexColors: true,
      }),
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
    /*
     * The ring reaches as far as the world does. It used to stop at 21 m
     * whatever the campsite was, so raising the fence would have walked the
     * player out through the last of the trees and into open fog.
     *
     * `sqrt` because a uniform roll on the radius crowds the middle: the area
     * of a ring grows with its distance, so the same count spread evenly by
     * radius reads as a thicket around the fire and parkland beyond it.
     */
    const CLEARING = 6;
    const treeline = Math.max(CLEARING + 15, extent);
    /*
     * The count follows the ring's area, or the same trees spread over a
     * bigger world would read as a thinning forest rather than a larger one —
     * `treeCount` is the manifest's canopy density, not a fixed population.
     * Capped so a 34 m closed canopy cannot alone spend the triangle budget.
     */
    const area = (treeline * treeline - CLEARING * CLEARING) / (21 * 21 - CLEARING * CLEARING);
    const wanted = Math.min(240, Math.round(treeCount * Math.max(1, area)));
    for (let i = 0; i < wanted; i++) {
      const angle = rng() * Math.PI * 2;
      const distance = CLEARING + Math.sqrt(rng()) * (treeline - CLEARING);
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
        geometryIndex: Math.floor(rng() * 6),
      });
    }
    return result;
  }, [seed, treeCount, basin, extent]);

  /*
   * Six shapes, dealt from a deck rather than rolled six times.
   *
   * Four was a quarter of the wood per shape, and with a dead snag in the set
   * that reads as a burn scar rather than as a forest — so the snag only
   * enters the deck at six. `createTreeGeometrySet` takes the same
   * `seed + i * 977` step the four independent calls used, so a campsite that
   * already existed keeps the same trees standing in the same places.
   *
   * Two more draw calls out of about 120, and about 23k triangles across 240
   * instances against the 60k budget in ARCHITECTURE §10 — up from 13k, which
   * is what a silhouette that is not a triangle costs.
   */
  const treeGeometries = useMemo(() => createTreeGeometrySet(seed, 4.2, 6), [seed]);

  /*
   * Deadfall, out where there is nothing else.
   *
   * An art review's note on every campfire frame was that the eye goes fire,
   * then nothing, then trees: between the log you sit on and the treeline
   * there is flat ground and a few rocks, so the middle distance has no scale
   * and no depth cue. A wood this old has trees down in it, and a fallen trunk
   * is the ideal thing to put there — it lies across the view rather than
   * along it, which breaks the horizontal, and it is the one object in a
   * forest whose length tells you how far away it is.
   *
   * Placed in a band between the walkable middle and the treeline, angled
   * roughly tangentially so they cross the sight line rather than point at the
   * camera, and seeded so a campsite has the same wood down in it every visit.
   * Sunk slightly: a trunk resting exactly on an undulating heightfield floats
   * at one end, and one that has lain there for years is into the duff anyway.
   */
  const deadfall = useMemo<ScatterItem[]>(() => {
    const rng = mulberry(seed ^ 0x51d3);
    const inner = Math.max(5.5, extent * 0.55);
    const outer = Math.max(inner + 3, extent * 0.95);
    return Array.from({ length: 7 }, () => {
      const angle = rng() * Math.PI * 2;
      const radius = inner + rng() * (outer - inner);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      return {
        x,
        // Sampled where it lies rather than at the origin, or a trunk on the
        // far slope hangs in the air.
        y: terrainHeight(x, z, seed, 0.7, basin) - 0.06,
        z,
        // Tangential, plus a wide wobble: exactly tangential seven times reads
        // as a fence.
        rotationY: angle + Math.PI / 2 + (rng() - 0.5) * 1.5,
        scale: 0.8 + rng() * 1.5,
      };
    });
  }, [seed, extent, basin]);

  /** One trunk, reused for all seven at different lengths and angles. */
  const deadfallGeometry = useMemo(() => createLogGeometry(2.6, 0.19), []);

  /**
   * How likely a plant is to have taken at a point, 0..1, from the wood above it.
   *
   * The undergrowth and the canopy were placed by two functions that had never
   * heard of each other, so the fern density in the open middle of the clearing
   * was the same as the fern density under a closed stand — which is the
   * "near-identical spacing" note from two different reviews, seen from the
   * other end. In a real wood the two are tightly coupled: bracken is thickest
   * at the canopy edge, sparse in full shade, and sparse again in the open.
   *
   * A coarse grid rather than a distance query per plant. Four hundred and
   * sixty instances against two hundred and forty trees is a hundred thousand
   * distance tests every time the campsite is built; a 24×24 lattice with a
   * splat per tree is two hundred and forty writes and a bilinear read, and at
   * two metres a cell it is finer than anything the eye can resolve on a
   * scatter this dense.
   */
  const understoreyDensity = useMemo(() => {
    const cells = 24;
    const half = Math.max(12, extent);
    const step = (half * 2) / cells;
    const field = new Float32Array(cells * cells);
    for (const tree of trees) {
      // The crown, not the trunk: a tree shades a disc about as wide as it is
      // tall, and `scale` is the only thing here that knows how big it is.
      const reach = 2.4 * tree.scale;
      const minI = Math.max(0, Math.floor((tree.x - reach + half) / step));
      const maxI = Math.min(cells - 1, Math.floor((tree.x + reach + half) / step));
      const minJ = Math.max(0, Math.floor((tree.z - reach + half) / step));
      const maxJ = Math.min(cells - 1, Math.floor((tree.z + reach + half) / step));
      for (let i = minI; i <= maxI; i++) {
        for (let j = minJ; j <= maxJ; j++) {
          const cx = (i + 0.5) * step - half;
          const cz = (j + 0.5) * step - half;
          const d = Math.hypot(cx - tree.x, cz - tree.z);
          if (d > reach) continue;
          field[j * cells + i] = (field[j * cells + i] as number) + (1 - d / reach);
        }
      }
    }
    return (x: number, z: number): number => {
      const i = Math.min(cells - 1, Math.max(0, Math.floor((x + half) / step)));
      const j = Math.min(cells - 1, Math.max(0, Math.floor((z + half) / step)));
      const shade = field[j * cells + i] as number;
      /*
       * A hump, not a ramp. Nothing much grows in the open and nothing much
       * grows under a closed stand; the fringe between them is where the wood
       * is impassable, and putting the peak there is the whole point of
       * consulting the trees at all.
       */
      const t = Math.min(1, shade / 2.2);
      return 0.22 + Math.sin(t * Math.PI) * 0.78;
    };
  }, [trees, extent]);

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
      plantUnderstorey({
        rng,
        count,
        radius,
        buckets,
        density: understoreyDensity,
        height: (x, z) => terrainHeight(x, z, seed, 0.7, basin),
        underwater: basin ? (y) => y < WATERLINE : () => false,
      });

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
  }, [understorey, drawDistance, seed, basin, understoreyDensity]);

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

  /**
   * Which props get a pool, and how wide.
   *
   * The radii are footprints rather than heights: what a contact pool is
   * *for* is the join, so a tall thin thing gets a small one. They are a
   * little wider than the object because the darkest part of real contact
   * occlusion sits just outside the silhouette, where the ground can still
   * see some sky but not much.
   *
   * Trees are deliberately left out. Two hundred and forty of them meet the
   * ground at the treeline, where the floor is already the darkest part of the
   * frame and a pool buys nothing — the same argument that keeps them out of
   * the sun's shadow pass. This is for the things standing on the open floor a
   * player walks across, which is where three critics said the failure reads.
   */
  const contactItems = useMemo(() => {
    const out: { x: number; z: number; radius: number }[] = [];
    const add = (items: readonly ScatterItem[], factor: number): void => {
      for (const item of items) {
        // Clamped, because `scale` is a multiplier on shapes of very different
        // base sizes and an unbounded one puts a two-metre pool under a stone
        // the size of a fist.
        const radius = Math.min(0.85, Math.max(0.14, item.scale * factor));
        out.push({ x: item.x, z: item.z, radius });
      }
    };
    for (const bucket of rocks) add(bucket, 0.62);
    add(deadfall, 0.46);
    /*
     * Pebbles are left out, having been in for exactly one render.
     *
     * They are eighty-five millimetres across and there are dozens of them, so
     * what the frame got was dozens of pools a metre wide tiling most of the
     * clearing — the floor went from having no contact cue to being paved with
     * them. A contact pool is worth drawing for something a player can walk
     * around; below that it is just a smudge under a speck.
     */
    return out;
  }, [rocks, deadfall]);

  /** The trees, grouped by which of the six shapes they use. */
  const treeBuckets = useMemo(() => {
    const buckets: ScatterItem[][] = [[], [], [], [], [], []];
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

  /*
   * And the small things you find by crouching over them.
   *
   * Built beside the landmarks and wearing the same three materials, so the
   * whole campsite is dressed from one palette and the draw-call budget pays
   * for three materials rather than six.
   */
  const curioProps = useMemo(() => {
    if (!curios || curios.length === 0) return [];
    return curios.map((curio) => ({
      curio,
      geometry: createCurioGeometry(curio.shape, curio.seed),
      y: terrainHeight(curio.x, curio.z, seed, 0.7, basin),
    }));
  }, [curios, seed, basin]);

  /**
   * Weathered wood and painted steel. Nothing here is new.
   *
   * The metal was `aluminium` — a brushed grain over a flat mid grey — laid
   * across box faces whose UVs ran 0..1 whatever their size. At twenty metres
   * that is a uniform rectangle with a marginally lighter top, and an art
   * review of the dusk frame picked it out of a whole campsite as the one
   * thing that reads as an untextured primitive. Both halves of that are now
   * fixed: `createBoxGeometry` lays UVs in metres and bakes a weathering
   * gradient, and the tile is paint rather than mill finish, so the marks on
   * it — chips, rust runs, panel shading — are large enough to survive being
   * two pixels wide.
   *
   * `vertexColors` is what makes the gradient reach the screen, and it is also
   * why every geometry these materials touch has to carry a colour attribute:
   * `MeshStandardMaterial` has no default for a missing one. The landmark and
   * curio boxes and rocks all do; the merge fills anything else with white.
   */
  const landmarkMaterials = useMemo(
    () => ({
      wood: createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed: 'landmark' }),
        color: 0x6f6152,
        roughness: 1,
        vertexColors: true,
      }),
      metal: createPs1Material({
        settings,
        map: getTexture('paintedMetal', { size: 64, seed: 'landmark' }),
        /*
          * Near-neutral, because the olive is in the paint now.
          *
          * `0x59635a` over `aluminium` was a green tint over a pale grey mill
          * finish, which lands on a flat sage slab brighter than the treeline
          * behind it at every hour — the exact thing an art review picked out
          * of the dusk frame. Multiplying a warm grey into a tile that is
          * already olive-drab paint gives the catalogue's own "olive-drab bear
          * box" and leaves the value a little under where it was.
          */
        color: 0xb0aca0,
        roughness: 0.85,
        vertexColors: true,
      }),
      stone: createPs1Material({
        settings,
        map: getTexture('stone', { size: 64, seed: 'landmark' }),
        color: 0x6b6862,
        roughness: 1,
        vertexColors: true,
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
      // Paler than the standing tree: dead wood is, and it has to clear the
      // 5-bit floor by torchlight or it is not there.
      const pale = new THREE.Color(WOOD_TYPES[patch.woodId]?.bark ?? 0x5a4632).lerp(new THREE.Color(0xcfc3a6), 0.45);
      byWood[patch.woodId] = createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed }),
        color: pale.getHex(),
        roughness: 1,
      });
    }
    return byWood;
  }, [fuelPatches, settings, seed]);

  const litterMaterial = useMemo(
    () => createPs1Material({ settings, map: getTexture('bark', { size: 64, seed }), color: 0xb9a98a, roughness: 1 }),
    [settings, seed],
  );

  /**
   * The stones lying in the dirt.
   *
   * Not the boulders' material. `rockMaterial` is white over the `stone` tile,
   * which is around two hundred times the albedo of the ground it sits on —
   * right for a granite boulder a metre across catching the moon, and wrong
   * for a pebble the size of a thumbnail: a hundred and ninety of those at
   * that albedo is not grit on a forest floor, it is popcorn. Five times the
   * ground reads as a stone half out of the soil, which is what these are.
   */
  const pebbleMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('stone', { size: 64, seed }),
        color: PEBBLE_TONE,
        roughness: 1,
        vertexColors: true,
      }),
    [settings, seed],
  );

  /**
   * The sticks and needles lying on the clearing floor.
   *
   * Its own material rather than the fuel patches' litter heap, because that
   * one is also worn by a bare `coneGeometry` and this one asks for vertex
   * colours — a geometry without the attribute under a material that wants it
   * reads the generic vertex attribute, which is the black-ground trap this
   * whole pass exists to close.
   */
  const sprigMaterial = useMemo(
    () =>
      createPs1Material({
        settings,
        map: getTexture('bark', { size: 64, seed }),
        color: SPRIG_TONE,
        roughness: 1,
        vertexColors: true,
      }),
    [settings, seed],
  );
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
      // Thicker than life, on purpose: at internal resolution a
      // finger-thick stick twenty metres from the fire is under one pixel,
      // and the frame that exists to show "here is the wood" was black.
      kindling: createLogGeometry(0.5, 0.035),
      tinder: createLogGeometry(0.32, 0.024),
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
          y: terrainHeight(x, z, seed, 0.7, basin) + (patch.grade === 'log' ? 0.085 : patch.grade === 'kindling' ? 0.035 : 0.024),
          rotationY: rng() * Math.PI * 2,
          scale: 0.75 + rng() * 0.5,
          z,
        });
      }
      return { patch, items };
    });
  }, [fuelPatches, seed, basin]);

  // --- Sky ---------------------------------------------------------------
  /*
   * The hour, from the simulation, or the curated night if there is no
   * simulation to ask.
   *
   * This used to be `useMemo(() => curatedSky(), [])` — computed once and
   * never again. The sim has advanced a real sky the whole time, six hours of
   * it over a session, and none of it arrived: the dusk screenshot and the
   * dawn screenshot had the same stars in the same places, and the only thing
   * that changed across a whole night was the fire burning down.
   */
  const fallbackSky = useMemo(() => curatedSky(), []);
  const sky = liveSky ?? fallbackSky;

  /** The manifest's own night, as the bottom of the daylight ramp. */
  const nightColors = useMemo(
    () => ({ sky: hexOf(palette.sky), fog: hexOf(palette.fog) }),
    [palette.sky, palette.fog],
  );

  /**
   * What this weather does to the surfaces, as opposed to what it does to the
   * sky. See `weatherLook` — this is the half that was missing.
   *
   * Read every render rather than memoised on the weather object, because the
   * simulation mutates that object in place: memoising on its identity is
   * memoising on a reference that never changes, which is a slower way of
   * computing it once.
   */
  const surfaces = weatherLook(weather);

  const look = useMemo(
    () => skyLook((sky.sun.altitude * 180) / Math.PI, nightColors, weather.cloudCover, surfaces.gloom),
    [sky.sun.altitude, nightColors, weather.cloudCover, surfaces.gloom],
  );

  /** Where the sun is. Its light is `look.sunIntensity`, which is zero when it is down. */
  const sunPosition = useMemo(
    () => bodyPosition(sky.sun.altitude, sky.sun.azimuth),
    [sky.sun.altitude, sky.sun.azimuth],
  );

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
    return {
      position: bodyPosition(moon.altitude, moon.azimuth, MOON_FLOOR),
      // The floor stands for dark adaptation, which the renderer has no
      // model of: a person who has been sitting by a fire for ten minutes can
      // genuinely see the treeline. Without it a moonless night is a black
      // rectangle rather than a dark wood.
      // Raised to take over the work the flat ambient used to do badly. The
      // total light in the scene is about what it was; far more of it now
      // arrives from a direction, which is the whole point.
      /*
       * Raised, to pay back what correcting aerial perspective honestly took.
       *
       * Distance fog used to resolve to a warm grey brighter than the night
       * sky, so the far treeline was being lifted out of black by a pale wash
       * in front of it rather than by anything shining on it. Removing the
       * wash was right — it was the single biggest visual defect in the build
       * — but it also removed light the D7 legibility floor was relying on,
       * and the far side of the clearing measured 5.82 against a floor of 6.
       *
       * The moon is where that light belongs. It falls on the trees and the
       * ground the way a real moon does, it keeps the treeline darker than the
       * sky behind it (which is the property just bought), and unlike ambient
       * it does not flatten the shapes the floor exists to protect.
       */
      intensity: (1.75 + strength * 3.9) * clear,
      ambient: clamp01(sky.ambientLight * clear),
    };
  }, [sky, weather.cloudCover]);

  /*
   * The anonymous field stars, in three tiers like the named ones.
   *
   * These were 420 points at one size with a random brightness, which is what
   * an art review meant by "uniformly sized, uniformly bright 1px dots —
   * sensor noise, not a sky". Two things were wrong and only one of them was
   * the art: the material's `fog` flag (see below) was repainting every one of
   * them the same colour anyway, so the random brightness never reached the
   * screen either.
   *
   * A real sky is not a uniform sprinkle. It is a handful of stars you could
   * name, a few dozen you can see plainly, and a haze of ones you only catch
   * with the corner of your eye — and the count goes up steeply as they get
   * fainter. So each star gets a magnitude drawn from a distribution with that
   * shape, and lands in one of the three tiers `NightSky` already defines for
   * the named stars, drawn in the same three tints. One sky with one set of
   * steps, rather than a tiered constellation layer over an untiered wash.
   *
   * Two clouds, because point size is a property of the material and not of
   * the point: the bright tier is drawn at two internal pixels and the other
   * two at one. At 320x240 that is the entire difference between a star and a
   * bright star, and it is the whole reason the tiers are worth having.
   */
  const starLayers = useMemo(() => {
    const count = 420;
    const rng = mulberry(0x57a5);
    const soft: number[] = [];
    const softColors: number[] = [];
    const bright: number[] = [];
    const brightColors: number[] = [];

    /*
     * Drifts and voids, which is the half of "uniformly sized, uniformly
     * bright" that the tiering did not answer.
     *
     * The magnitudes were fixed a round ago and the *placement* was not: four
     * hundred and twenty points at a uniform angle over a uniform solid angle
     * is a Poisson field, and a Poisson field on a dome is exactly what a
     * scanner's noise floor looks like. A real sky is nothing like even. It has
     * the galactic plane running through it, dark lanes where the dust is, and
     * a general thinning toward the pole — so the eye reads structure long
     * before it reads any individual star.
     *
     * Two octaves of value noise over the sphere gives that for nothing: a
     * candidate direction is rolled, the field is sampled there, and the star
     * is kept in proportion. No extra points, no extra buffers, no extra draw
     * calls — the same two clouds, redistributed. Rejection sampling with an
     * attempt ceiling, so the count is unchanged and a pathological field
     * cannot spin.
     */
    let placed = 0;
    for (let attempt = 0; attempt < count * 6 && placed < count; attempt++) {
      // Upper hemisphere only.
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(rng() * 0.95);
      const r = 120;
      const x = Math.sin(phi) * Math.cos(theta) * r;
      const y = Math.cos(phi) * r + 20;
      const z = Math.sin(phi) * Math.sin(theta) * r;
      if (rng() > starDrift(x, y, z)) continue;
      placed++;

      /*
       * A magnitude, not a brightness. Raised to a power so the count climbs
       * steeply toward the faint end — a flat random gives as many bright
       * stars as dim ones, which is the sprinkle this is replacing. The range
       * puts roughly a dozen in the bright tier out of four hundred, which is
       * about what a dark sky gives you.
       */
      const magnitude = 1.4 + Math.pow(rng(), 0.35) * 3.4;
      const tier = starTier(magnitude);
      const tint = TIER_TINT[tier];
      // A small nudge off the tier's own value, so three tiers do not read as
      // three colours.
      const nudge = 0.88 + rng() * 0.24;

      const target = tier === 'bright' ? bright : soft;
      const colors = tier === 'bright' ? brightColors : softColors;
      target.push(x, y, z);
      colors.push(tint.r * nudge, tint.g * nudge, tint.b * nudge);
    }

    // The named constellations are *not* here. They used to be scattered
    // around the dome by a decorative formula that had nothing to do with
    // where they are, which meant they could not be found and so could not be
    // looked for. `NightSky.tsx` draws them at the real altitude and azimuth
    // the astronomy model computes; these are the anonymous ones.
    const build = (positions: number[], colors: number[]): THREE.BufferGeometry => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      return geometry;
    };
    return { soft: build(soft, softColors), bright: build(bright, brightColors) };
  }, []);

  /** The bright tier, at two internal pixels. See the note where they are built. */
  const brightStarMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 2,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    [],
  );

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
        /*
         * The single most consequential defaulted boolean in this codebase.
         *
         * `PointsMaterial.fog` defaults to TRUE, the scene's fog is linear
         * with a far plane well inside the star dome, and three.js's
         * `fog_fragment` chunk does not tint at a fog factor of 1 — it
         * replaces the fragment colour outright. So every one of these four
         * hundred and twenty stars was drawn at exactly the campsite's fog
         * colour, whatever its own brightness, and the per-star brightness two
         * lines above was computed and then thrown away one stage later.
         *
         * An art director's verdict on the night sky was "uniformly sized,
         * uniformly bright 1px dots — sensor noise, not a sky", and that is
         * what one default did to code that was otherwise working. It is worth
         * recording how invisible it was: a screenshot cannot tell a star
         * field that was drawn flat from one that was authored flat, and the
         * only reason it was found at all is that somebody went looking for
         * the mechanism rather than adjusting the art.
         */
        fog: false,
      }),
    [],
  );

  /* --- Precipitation ------------------------------------------------------
   *
   * Rain is drawn as line segments and snow as points, which is not a stylistic
   * preference — it is the only way either of them can look like itself.
   *
   * Both used to be the same 260 attenuated points. A `PointsMaterial` sprite
   * is an axis-aligned square, and with `sizeAttenuation` on, a drop a metre
   * from the camera is drawn several times larger than one at ten metres — so
   * a 4.5-centimetre drop close to the lens became a grey block roughly
   * fifteen screen pixels across. A capture of heavy rain showed four large
   * grey squares hanging in the air and nothing else, which is what finally
   * made this visible; the harness had been setting the weather's *kind*
   * without its scalars, so no rain had ever actually been captured.
   *
   * Rain is a streak. It has a direction, it leans with the wind, and it is
   * the lean that says a storm is a storm. Two vertices per drop, and the
   * whole thing is one draw call exactly as the points were.
   *
   * Snow keeps points, because a flake really is a small round thing — but
   * with attenuation OFF and a size in pixels rather than metres, so a flake
   * is the same two pixels at every depth. That is how the hardware being
   * imitated did snow, and it is why theirs never had the near-field blobs.
   */
  const rainCount = 420;
  const rainGeometry = useMemo(() => {
    // Two vertices a drop: head and tail. The tail is placed in the frame loop
    // because its offset depends on the wind, which changes.
    const positions = new Float32Array(rainCount * 6);
    const rng = mulberry(0x7a1f);
    for (let i = 0; i < rainCount; i++) {
      const x = (rng() - 0.5) * 26;
      const y = rng() * 12;
      const z = (rng() - 0.5) * 26;
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y - 0.3;
      positions[i * 6 + 5] = z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const rainMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: 0x8fa3b8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [],
  );

  const snowCount = 320;
  const snowGeometry = useMemo(() => {
    const positions = new Float32Array(snowCount * 3);
    const rng = mulberry(0x2c93);
    for (let i = 0; i < snowCount; i++) {
      positions[i * 3] = (rng() - 0.5) * 26;
      positions[i * 3 + 1] = rng() * 12;
      positions[i * 3 + 2] = (rng() - 0.5) * 26;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, []);

  const snowMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xd8dce4,
        // Pixels, not metres. See the note above about near-field blobs.
        size: 2,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [],
  );

  useFrame((state, delta) => {
    /*
     * The hour, walked toward rather than jumped to.
     *
     * One-second time constant: fast enough that a player fast-forwarding an
     * evening sees the sky keep up, slow enough that the sky refreshing on its
     * own cadence in the simulation never arrives as a step. The first frame
     * snaps, because easing up from black would look like a fade-in.
     */
    const ease = eased.current;
    const k = ease.started ? Math.min(1, delta * 1.6) : 1;
    ease.started = true;
    ease.sky.lerp(TMP_COLOR.setHex(look.sky), k);
    ease.horizon.lerp(TMP_COLOR.setHex(look.horizon), k);
    ease.haze.lerp(TMP_COLOR.setHex(look.haze), k);
    (domeMaterial.uniforms.uHorizon!.value as THREE.Color).copy(ease.horizon);
    (domeMaterial.uniforms.uZenith!.value as THREE.Color).copy(ease.sky);
    (domeMaterial.uniforms.uHaze!.value as THREE.Color).copy(ease.haze);
    domeMaterial.uniforms.uCover!.value = weather.cloudCover;
    domeMaterial.uniforms.uTime!.value = state.clock.elapsedTime;
    /*
     * The bolt, computed once and used by everything that reacts to it.
     *
     * Reduced motion takes it to zero and leaves it there (PRODUCT_SPEC §12) —
     * a full-frame value inversion is precisely what that setting exists to
     * suppress. The storm is still nameable without it: it is the only state
     * with a black ceiling, the hardest shear on the rain, the wettest ground
     * and standing water in the low spots, and all four of those are still.
     */
    const flash =
      surfaces.lightning && !settings.reducedMotion ? lightningStrike(state.clock.elapsedTime) : 0;
    domeMaterial.uniforms.uFlash!.value = flash;
    /*
     * The deck's own colour, which is the sky's plus a lift.
     *
     * Not a fixed grey: a cloud at noon is white-grey against blue and a cloud
     * at midnight is a slightly paler black against black, and a constant
     * would make the night sky look like it had a fog bank painted on it. So
     * it tracks the zenith and lifts by an amount that falls off as the sky
     * darkens.
     */
    const lift = 0.16 + luminance(ease.sky.getHex()) * 0.55;
    (domeMaterial.uniforms.uCloud!.value as THREE.Color)
      .copy(ease.sky)
      .lerp(TMP_COLOR.setHex(0xffffff), lift)
      // Cloud is lit from below at dusk and from above at noon; rather than
      // track that, the deck takes a little of whatever the sky under it is
      // doing, which lands close enough at either end and means a red sunset
      // gets red-bellied cloud for free.
      .lerp(ease.horizon, 0.28)
      /*
       * And how *thick* it is, which is the thing that was missing.
       *
       * The deck's colour tracked the sky and nothing else, so an overcast lid
       * and a storm lid were drawn at the same value — and since cover only
       * separates them by eight hundredths (0.92 against 1.00), the two states
       * came out of the grader as the same picture, with storm measuring
       * *lighter* than overcast, which is backwards.
       *
       * A storm cloud is dark because it is deep: not much light gets through
       * a kilometre of it. That is a different number from how much of the sky
       * it covers, and it belongs here rather than on the horizon — the strip
       * under the lid stays bright, which is what a squall line looks like and
       * is also what keeps the far side of the clearing above the D7 floor
       * while the storm is being the darkest state in the set.
       */
      .multiplyScalar(1 - surfaces.gloom * 0.72);
    ease.fog.lerp(TMP_COLOR.setHex(look.fog), k);

    if (state.scene.background !== sceneBackground) state.scene.background = sceneBackground;
    if (state.scene.fog !== sceneFog) state.scene.fog = sceneFog;
    sceneBackground.copy(ease.sky);

    // Fog tightens with weather, which is both atmosphere and a draw-distance
    // saving exactly when the scene gets busiest.
    const reduction = Math.min(1, weather.fog * 0.8 + weather.precipitation * 0.3);
    /*
     * Where the haze starts, which was two and a half metres.
     *
     * Everything past the fire was being washed toward the fog colour, so on a
     * clear evening the treeline arrived at roughly eighty per cent fog — and
     * once the fog colour was corrected to resolve to the horizon (see
     * `daylight.ts`), that meant the far trees became the horizon band almost
     * exactly and read as pale ghosts standing in front of a darker sky. Both
     * halves had to move: fog was the wrong *colour*, and there was far too
     * much of it.
     *
     * A clearing you can see across is twenty metres wide. Haze inside that is
     * not atmosphere, it is a filter. Starting at about a third of the draw
     * distance leaves the campsite itself unfogged, puts a tree at the treeline
     * around forty per cent fogged — enough for depth, not enough to erase it —
     * and keeps the far wall of the wood reading as a wall.
     *
     * Weather still tightens it, which is both atmosphere and a draw-distance
     * saving exactly when the scene gets busiest: a real fog pulls `near` in as
     * well as `far`, because that is the difference between distance haze and
     * standing inside a cloud.
     */
    sceneFog.near = Math.max(1.2, drawDistance * 0.32 * (1 - reduction * 0.85));
    sceneFog.far = Math.max(6, drawDistance * 1.35 * (1 - reduction * 0.72));
    sceneFog.color.copy(ease.fog);

    /*
     * The key light changes hands.
     *
     * Both lights are always mounted and their intensities cross over, because
     * swapping one for the other at a threshold pops — and at civil twilight
     * both bodies really are up and neither is doing much, which is precisely
     * the moment a cut would be visible.
     */
    if (sunRef.current) {
      const sun = sunRef.current;
      sun.intensity += (look.sunIntensity - sun.intensity) * k;
      sun.color.lerp(TMP_COLOR.setHex(look.sunColor), k);
      sun.visible = sun.intensity > 0.005;
    }
    if (moonRef.current) {
      const target = moonlight.intensity * (1 - look.sunShare);
      moonRef.current.intensity += (target - moonRef.current.intensity) * k;
      moonRef.current.visible = moonRef.current.intensity > 0.005;
    }
    if (ambientRef.current) {
      const ambient = ambientRef.current;
      /*
       * Fog lifts the black point, which is the thing fog actually does.
       *
       * A graded capture of fog was described as "a slightly bluer sky" with
       * the treeline reading at HIGHER contrast than on a clear night, which
       * is backwards: fog is suspended water lit by everything around it, so
       * the first thing it does is stop anything being properly dark. Without
       * this the fog setting moved the draw distance and nothing else, and a
       * player could not tell it from a clear night with a shorter view.
       *
       * Ambient rather than a post-process, because a lifted black point IS
       * ambient — light arriving from every direction at once is the physical
       * description of both.
       */
      const murk = weather.fog * weather.fog;
      const target =
        (look.ambientIntensity + moonlight.ambient * 0.5 * (1 - look.sunShare)) * (1 + murk * 1.35);
      ambient.intensity += (target - ambient.intensity) * k;
      // And it takes the sky's colour with it, because that is what is lighting it.
      TMP_COLOR.setHex(look.ambient).lerp(ease.horizon, murk * 0.6);
      ambient.color.lerp(TMP_COLOR, k);
    }

    /*
     * Lightning, on the scene as well as on the sky.
     *
     * A storm without a flash is heavy rain, and the difference between the two
     * is the whole reason the word exists. The dome does the value inversion —
     * see `uFlash` — and this is the half that makes it a *light* rather than a
     * filter: for two frames the clearing is lit from the sky by something
     * enormous and cold, so the props throw the wrong shadows and the ground
     * goes blue-white. The two together are what a strike is.
     *
     * Gated on reduced motion at the single point where `flash` is computed, so
     * there is one gate rather than three (PRODUCT_SPEC §12).
     */
    if (ambientRef.current && flash > 0) {
      ambientRef.current.intensity += flash * 5.5;
      ambientRef.current.color.lerp(TMP_COLOR.setHex(0xc8d4ff), flash * 0.8);
    }
    if (hemisphereRef.current) {
      const hemisphere = hemisphereRef.current;
      /*
       * The sky's own light, raised at night to keep the D7 floor.
       *
       * Correcting aerial perspective took the far treeline from 6.4 to 5.82
       * against a legibility floor of 6 — and it did so honestly: the old fog
       * resolved to a warm grey brighter than the night sky, and what looked
       * like a lit wood was a wood with a pale wash in front of it. Removing
       * the wash removed the light it was faking.
       *
       * So the light is put back as light. A hemisphere term is the right
       * place: it is the sky illuminating the canopy from above, which is
       * physically what lifts a far treeline out of black on a clear night,
       * and unlike fog it does not flatten the depth that was just bought.
       * Measured after: the far side reads 6.9 against the floor of 6, with
       * the trees still darker than the sky behind them.
       */
      const target =
        (1.28 + moonlight.ambient * 1.35 * (1 - look.sunShare) + look.sunShare * 1.1) *
        surfaces.topLight;
      hemisphere.intensity += (target - hemisphere.intensity) * k;
      /*
       * And the weather's own colour on the tops of things, which is where the
       * whole "snow on every upward-facing face" read comes from.
       *
       * A hemisphere light shades by the surface normal's Y and by nothing
       * else, which is exactly and only "upward-facing faces". So a squall
       * drives this white and hard and the log top, the stone tops, the
       * machine's roof and the crowns all take snow together, with their sides
       * left dry — and rain drives it a cold steel blue at half the strength,
       * which is a wet sheen on the same faces. Nine states, one uniform, no
       * cap geometry and no draw calls, which is what makes it affordable at
       * all: a snow cap per prop would be a mesh and a call for each.
       */
      TMP_COLOR.copy(ease.sky);
      if (surfaces.topColor !== 0) {
        TMP_COLOR.lerp(
          TMP_COLOR_B.setHex(surfaces.topColor),
          Math.max(surfaces.settling, surfaces.wet * 0.7, surfaces.chill * 0.4),
        );
      }
      hemisphere.color.lerp(TMP_COLOR, k);
      /*
       * And the *other* half of a hemisphere light, which was a constant.
       *
       * `groundColor` is the bounce coming back up off the floor, and a fixed
       * near-black green means the underside of every canopy in the catalogue
       * is lit by the same colour at every hour. In daylight a forest floor
       * throws a genuinely warm light up into the boughs above it, and that
       * upward warm against the sky's downward cool is most of what stops a
       * conifer being one flat tone — the effect the tone bands are for, done
       * by the lighting rather than by the mesh.
       */
      hemisphere.groundColor.lerp(
        TMP_COLOR_B.copy(groundMaterial.color).multiplyScalar(0.55 + look.surfaceLift * 0.5),
        k,
      );
    }

    /*
     * And the ground comes up with the sun — and now goes out into the weather.
     *
     * Lying snow is eased rather than assigned, so walking into a squall
     * whitens the clearing over a few seconds. Everything else follows the
     * weather's own transition, which is already a ramp over about a minute.
     */
    /*
     * Snow lies faster than it melts, which is both true and the fix for a
     * capture.
     *
     * One rate for both directions meant a clearing that whitened over about
     * eight seconds and then un-whitened just as fast the moment the squall
     * passed, which is not what happens to snow and — more immediately — is
     * longer than any harness waits, so the contact sheet's snow frame was of a
     * clearing a third of the way through settling. Rising over about a second
     * and a half and falling over eight is the right shape and it also means
     * the picture of snow is a picture of snow.
     */
    const settling = surfaces.settling > snowCover.current;
    snowCover.current +=
      (surfaces.settling - snowCover.current) * Math.min(1, delta * (settling ? 0.65 : 0.12));
    const lying = snowCover.current;
    /*
     * The three ground materials, all three of them.
     *
     * This is the fix for the single largest hole in the weather: snow settling
     * used to be written to `groundMaterial` alone. `groundMaterial` is the
     * *terrain* — the coarse grid that starts nine and a half metres out, where
     * the cover mats end. Everything nearer than that is `duffMaterial` and
     * `wornMaterial`, and that is the bottom half of every frame in the game.
     * So the accumulation landed on the one piece of ground the player never
     * sees clean: past the mats the terrain is forty to a hundred per cent
     * distance fog by the time it reaches the eye, and a sevenfold lift in its
     * albedo arrived as about one luminance step. Measured across the contact
     * sheet, the near ground under snow read 20.0 out of 255 against clear at
     * 29.8 — snow was *darker* than a clear night and within a step and a half
     * of rain and storm.
     *
     * `paint` is therefore applied to all three, in order: the hour, then what
     * the weather has done to it, then what is lying on top.
     */
    const paint = (
      material: THREE.MeshStandardMaterial,
      wornRing: boolean,
      shade = 1,
    ): void => {
      const colour = material.color;
      colour.copy(groundTones.night).lerp(groundTones.day, look.surfaceLift);
      // Under the canopy edge rather than under the sky. See `CANOPY_SHADE`.
      if (shade !== 1) colour.multiplyScalar(shade).lerp(GROUND_CHILL, (1 - shade) * 0.5);
      // Wet duff is darker and much less colourful — the needles go near-black
      // and the light that comes back is the sky's, not the ground's.
      if (surfaces.groundValue !== 1) colour.multiplyScalar(surfaces.groundValue);
      if (surfaces.chill > 0) colour.lerp(GROUND_CHILL, surfaces.chill * 0.42);
      /*
       * Broken white over dark duff, rather than a white floor.
       *
       * The worn ring takes less: it is the ground people have been walking on
       * and the fire has been burning a hole in, and a snowed campsite reads as
       * snowed *because* there is bare trodden earth at the middle of it.
       */
      if (lying > 0.004) colour.lerp(SNOW_LYING, lying * (wornRing ? 0.55 : 1));
    };
    // Fire ring, duff, wood — brightest, middle, darkest. The step the frame
    // has never had. Lying snow inverts it on its own, because the worn ring
    // takes less of it than the ground around it does.
    paint(wornMaterial, true, 1.06);
    paint(duffMaterial, false, 1);
    paint(groundMaterial, false, CANOPY_SHADE);
    /*
     * And what a wet surface does that a dark one does not: come back at you.
     *
     * Roughness is the difference between wet ground and merely dark ground.
     * Dropping it puts a specular kick on the duff exactly where the fire is,
     * which is what stops "darken and desaturate" reading as "turn the lights
     * down" — the clearing gets darker overall and *brighter* in the two metres
     * around the pit, which is what rain at a campfire actually looks like.
     */
    const wetRoughness = 1 - surfaces.wet * 0.55;
    groundMaterial.roughness = wetRoughness;
    wornMaterial.roughness = wetRoughness;
    duffMaterial.roughness = wetRoughness;
    // Stone and fallen wood soak too, and stone shows it most.
    rockMaterial.roughness = 1 - surfaces.wet * 0.62;
    deadfallMaterial.roughness = 1 - surfaces.wet * 0.5;
    woodMaterial.roughness = 1 - surfaces.wet * 0.5;

    /*
     * And so does the wood, which never has.
     *
     * `surfaceLift` peaks at 0.64 rather than at 1, so it is renormalised here
     * — the canopy has its own two day tones and wants the whole of the ramp
     * between them, not two thirds of it.
     *
     * `warmth` is read off the key light's own colour rather than off the
     * clock: the ramp already decides that the sun is `#ff8a42` on the horizon
     * and `#fff6ea` overhead, and taking red-minus-blue from that is one
     * number that cannot drift out of step with the light actually in the
     * scene. Warm key, olive canopy; cold key, blue-green canopy.
     */
    const canopyLift = clamp01(look.surfaceLift / 0.64);
    const warmth = clamp01(
      ((((look.sunColor >> 16) & 0xff) - (look.sunColor & 0xff)) / 120) * (0.35 + look.sunShare * 0.65),
    );
    TMP_COLOR.copy(foliageTones.golden).lerp(foliageTones.day, 1 - warmth);
    treeMaterial.color.copy(foliageTones.night).lerp(TMP_COLOR, canopyLift);
    // Weather reaches the wood too. A soaked canopy is darker and colder; a
    // snowed one is not white — the crowns catch it and the sides do not, which
    // the hemisphere term above is already doing — but it does go grey-blue.
    if (surfaces.chill > 0) treeMaterial.color.lerp(GROUND_CHILL, surfaces.chill * 0.3);
    if (surfaces.wet > 0) treeMaterial.color.multiplyScalar(1 - surfaces.wet * 0.16);
    // The understorey rides the same ramp from its own, lighter, night colour:
    // it is a metre from the player's knee and cannot go where the treeline
    // goes without turning into a black cut-out at the one distance it is
    // meant to catch firelight.
    understoreyMaterial.color
      .copy(understoreyTones.night)
      .lerp(TMP_COLOR_B.copy(TMP_COLOR).lerp(WHITE, 0.16), canopyLift);
    /*
     * Undergrowth goes *dark* under snow, not white, and that is the read.
     *
     * A field of white ground with black stalks sticking out of it is what a
     * snowed clearing looks like from standing height; white ground with white
     * grass on it is a fog bank. The same for the litter: pebbles and sprigs
     * poking through the cover are the whole reason it reads as lying snow at
     * a depth rather than as a repainted floor.
     */
    // Reset from the base tone first: these two are the only materials here
    // whose colour is otherwise a constant, and multiplying a constant in a
    // frame loop walks it to black over a few hundred frames.
    sprigMaterial.color.setHex(SPRIG_TONE);
    pebbleMaterial.color.setHex(PEBBLE_TONE);
    if (lying > 0.004) {
      understoreyMaterial.color.multiplyScalar(1 - lying * 0.45);
      sprigMaterial.color.multiplyScalar(1 - lying * 0.5);
      pebbleMaterial.color.lerp(SNOW_LYING, lying * 0.75);
    }
    if (surfaces.wet > 0) {
      understoreyMaterial.color.multiplyScalar(1 - surfaces.wet * 0.2);
      sprigMaterial.color.multiplyScalar(1 - surfaces.wet * 0.3);
      pebbleMaterial.color.multiplyScalar(1 - surfaces.wet * 0.25);
    }

    /*
     * Standing water, which is the one thing rain does that a tint cannot.
     *
     * Puddles are worth their single draw call because they are the only part
     * of wet weather that is *bright*: a dark, almost mirror-smooth disc lying
     * in the low ground picks the fire up and throws it back, so the clearing
     * gains three or four orange shapes it does not have when it is dry. That
     * is a change in the composition of the frame rather than in its palette,
     * which is what "the player cannot name the weather from the picture" was
     * really asking for.
     */
    if (puddleRef.current) {
      const shown = surfaces.puddles;
      puddleRef.current.visible = shown > 0.02;
      puddleMaterial.opacity = Math.min(0.92, 0.25 + shown * 0.67);
      puddleMaterial.color.copy(ease.haze).multiplyScalar(0.55);
    }

    // The two discs. Neither is a light; both are just something to look at.
    if (sunDiscRef.current) {
      const disc = sunDiscRef.current;
      disc.visible = look.sunDisc > 0.01;
      disc.position.set(sunPosition[0], sunPosition[1], sunPosition[2]);
      disc.lookAt(0, 1.6, 0);
      const material = disc.material as THREE.MeshBasicMaterial;
      material.opacity += (look.sunDisc - material.opacity) * k;
      material.color.lerp(TMP_COLOR.setHex(look.sunColor), k);
    }
    if (moonDiscRef.current) {
      const disc = moonDiscRef.current;
      const target = look.moonDisc * 0.65;
      disc.visible = target > 0.01;
      disc.position.set(moonlight.position[0], moonlight.position[1], moonlight.position[2]);
      disc.lookAt(0, 1.6, 0);
      const material = disc.material as THREE.MeshBasicMaterial;
      material.opacity += (target - material.opacity) * k;
    }

    if (starsRef.current) {
      /*
       * And out entirely once the sun is up.
       *
       * `starVisibility` is the astronomy module's answer to "how faint a star
       * could you see", which folds in moonlight and twilight but not the one
       * thing that settles it — a midday screenshot had a field of stars in a
       * blue sky. Civil twilight is where the last of them go, so the fade
       * runs from -6 degrees to zero and nothing survives a risen sun.
       */
      const sunDeg = (sky.sun.altitude * 180) / Math.PI;
      const daylightWash = Math.max(0, Math.min(1, (sunDeg + 6) / 6));
      const visibility = sky.starVisibility * (1 - weather.cloudCover * 0.95) * (1 - daylightWash);
      starMaterial.opacity = Math.max(0, visibility * 0.95);
      starsRef.current.visible = visibility > 0.02;
      brightStarMaterial.opacity = Math.max(0, visibility * 0.98);
      if (brightStarsRef.current) {
        brightStarsRef.current.visible = visibility > 0.02;
        // Turned with the other cloud, or the two skies drift apart.
        brightStarsRef.current.rotation.y = starsRef.current.rotation.y;
      }
      // Very slow rotation — the sky turns over the course of a long session.
      starsRef.current.rotation.y += delta * 0.0016;
    }

    const isSnow = weather.kind === 'snow' || weather.kind === 'snow-squall';
    const falling = weather.precipitation;

    /*
     * What is in the air when nothing is falling out of it.
     *
     * `wind` was the one state in the set with no signature at all. Its cloud
     * is 0.3, its fog is 0.03 and its precipitation is zero, so every channel
     * the renderer had was showing it as a slightly hazier clear night — and a
     * gale that looks like a calm one is the plainest possible case of "the
     * player cannot name the weather from the picture". Its own caption says
     * "you hear wind before you feel it", which is fine as a line and is not a
     * picture.
     *
     * A wood in a gale has things flying through it: needles off the crowns,
     * dust off the trodden ring, last year's leaves. Drawn on the emitter the
     * rain already owns — the same 420 segments, the same one draw call, warm
     * brown instead of blue-grey and nearly flat instead of nearly vertical —
     * so a state that had nothing now has motes streaking across the clearing
     * and costs the frame nothing it was not already paying.
     */
    /*
     * Keyed on `gale` and not on `shear`, and the difference is a bug.
     *
     * `shear` takes the greater of the kind's lean and the live wind, so that a
     * lull in a storm still lays the rain over. Asked "is this a gale", it
     * answers for the gust: the simulation's wind swings to roughly one and a
     * half of the base at all times, so a clear night whose authored shear is
     * 0.08 was crossing a 0.45 threshold several times a minute and drawing
     * windblown litter in still air. It showed up in the gallery as thin pale
     * diagonals across the stars and through the crowns and took a while to
     * recognise, because every other bug of the year has been a thing that was
     * computed and never reached the screen; this is the one that reached it
     * and should not have.
     *
     * `gale` is the kind's own lean with no gust in it. The threshold sits
     * above `rain`'s 0.52 as well, so a rain state captured without its
     * scalars — which is exactly what the harness does when it sets a kind and
     * no precipitation — stays empty rather than quietly filling with leaves.
     * Only `wind` (0.95) and `storm` (1) are above it, and the storm is raining.
     */
    const blowing = falling < 0.02 ? clamp01((surfaces.gale - 0.6) / 0.35) : 0;
    if (rainRef.current) {
      const strength = isSnow ? 0 : Math.max(falling, blowing * 0.55);
      rainMaterial.opacity = strength * 0.62;
      rainMaterial.color.setHex(blowing > 0 ? 0x8a7047 : 0x8fa3b8);
      rainRef.current.visible = strength > 0.02;
      if (strength > 0.02) {
        const positions = rainGeometry.getAttribute('position') as THREE.BufferAttribute;
        /*
         * The lean is the whole picture, and it is now the *state's* lean.
         *
         * It used to be the instantaneous wind speed, which sounds right and is
         * not: the simulation's gust term swings between roughly half and one
         * and a half of the base at all times, so a downpour on a lull sheared
         * less than a drizzle on a gust and the picture said nothing about
         * which weather it was. `shear` takes the greater of what the *kind*
         * asks for and what the wind is actually doing, so a storm is always
         * hard over and a gale still lays the drizzle down.
         */
        // Blowing litter is almost flat and much slower to lose height; rain is
        // steep. The one number that separates them is how much of the streak's
        // length is horizontal.
        const lean = blowing > 0 ? 2.6 + blowing * 3.4 : 0.06 + surfaces.shear * 0.62;
        const length = 0.26 + strength * 0.34 + surfaces.shear * 0.3;
        const fall = blowing > 0 ? 1.1 : 9 + strength * 7;
        /*
         * Litter blows through the clearing. It does not cross the sky.
         *
         * The emitter's column is twelve metres because rain falls from above
         * the treeline, and borrowing that column for litter put warm streaks
         * over the stars and through the crowns — which reads as a scratch on
         * the lens, not as weather. Needles and last year's leaves come off
         * the duff and out of the low branches, so the band is the height of
         * the trodden ring rather than the height of the wood. Anything
         * already above it is recycled on the next frame instead of taking
         * ten seconds to sink at the litter's 1.1 m/s.
         */
        const ceiling = blowing > 0 ? 2.6 : 12;
        for (let i = 0; i < rainCount; i++) {
          const head = i * 2;
          let y = positions.getY(head) - fall * delta;
          let x = positions.getX(head) + (0.4 + surfaces.shear * 5.2) * delta;
          if (y < 0 || y > ceiling) {
            // Rain re-enters at the top of its column; litter is not falling
            // from anywhere, so it re-enters anywhere in the band.
            y = blowing > 0 ? 0.2 + Math.random() * (ceiling - 0.2) : ceiling;
            // A drop that lands is a new drop somewhere else. Presentation
            // only, so `Math.random` is allowed here (ADR-0001 is about
            // `packages/sim`); making rain deterministic would make it
            // visibly repeat.
            x = (Math.random() - 0.5) * 26;
          }
          if (x > 13) x -= 26;
          const z = positions.getZ(head);
          positions.setXYZ(head, x, y, z);
          positions.setXYZ(head + 1, x - lean * length, y - length, z);
        }
        positions.needsUpdate = true;
      }
    }

    if (snowRef.current) {
      const strength = isSnow ? falling : 0;
      snowMaterial.opacity = strength * 0.9;
      snowRef.current.visible = strength > 0.02;
      if (strength > 0.02) {
        const positions = snowGeometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < snowCount; i++) {
          // A squall drives flakes almost flat; a still snowfall lets them sink.
          let y = positions.getY(i) - (1.05 + surfaces.shear * 1.1) * delta;
          // Flakes drift rather than fall: a sideways wander each one keeps to
          // itself, so the field does not move as a sheet.
          let x =
            positions.getX(i) +
            (surfaces.shear * 6.5 + Math.sin(state.clock.elapsedTime * 0.8 + i) * 0.22) * delta;
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
      {/*
        The dome. Rendered before everything, writes no depth, and is never
        culled — it is the inside of a sphere with the camera at its centre, so
        the frustum test has nothing useful to say about it.
      */}
      <mesh material={domeMaterial} renderOrder={-1} frustumCulled={false}>
        <sphereGeometry args={[160, 32, 16]} />
      </mesh>

      {/* Night sky */}
      {/* Two clouds, one per point size. See the note where they are built. */}
      <points ref={starsRef} geometry={starLayers.soft} material={starMaterial} frustumCulled={false} />
      <points
        ref={brightStarsRef}
        geometry={starLayers.bright}
        material={brightStarMaterial}
        frustumCulled={false}
      />

      {/*
        Moon and sun — flat discs, which is exactly what PS1 ones were.

        Both are placed from the real azimuth and altitude in the frame loop
        rather than pinned to a spot in the scene. The moon used to sit at a
        fixed `[38, 46, -70]` for ever, which was fine while the sky was also
        fixed for ever and is not fine now that the night turns.
      */}
      <mesh ref={moonDiscRef}>
        <circleGeometry args={[3.6, 12]} />
        <meshBasicMaterial color={0xd8dfe8} toneMapped={false} transparent opacity={0} />
      </mesh>
      <mesh ref={sunDiscRef} visible={false}>
        <circleGeometry args={[2.6, 14]} />
        <meshBasicMaterial color={0xffd9a8} toneMapped={false} transparent opacity={0} />
      </mesh>

      {/* Ground */}
      <mesh name="ground-terrain" geometry={terrain} material={groundMaterial} receiveShadow />

      {/*
        And the ground you are standing on, over the top of it.

        Two draw calls and about four hundred triangles for the eight metres
        that are half of every frame — see `createGroundCoverGeometry`. Laid a
        centimetre and a half proud of the terrain, which is under a pixel at
        the distance the mat ends and is what keeps it winning the depth test
        against a grid that only agrees with it at its own vertices.
      */}
      <mesh name="ground-duff" geometry={groundCover.duff} material={duffMaterial} receiveShadow />
      <mesh name="ground-worn" geometry={groundCover.worn} material={wornMaterial} receiveShadow />

      {/*
        And the dark where things touch it. Drawn after the floor and before
        anything standing on it, so it multiplies into the ground and not into
        the props. See `ContactPools`.
      */}
      <ContactPools items={contactItems} texture={contactTexture} height={groundAt} />

      {/*
        What is lying on it. Two more calls; nothing here is a mesh per pebble.

        These do not cast: a stone eight centimetres across contributes nothing
        to a 512-pixel shadow map over a forty-metre camera except a shadow
        pass over two hundred more instances, which is the same trade the wood
        already makes.
      */}
      <Scatter
        geometry={litterGeometries.pebble}
        material={pebbleMaterial}
        items={litterFields.pebbles}
        castShadow={false}
        receiveShadow
      />
      <Scatter
        geometry={litterGeometries.sprig}
        material={sprigMaterial}
        items={litterFields.sprigs}
        castShadow={false}
        receiveShadow
      />

      {/*
        And the water lying in it, when there is any.

        One instanced mesh whatever the weather; the frame loop hides it when
        the ground is dry, so a clear night pays a visibility test and nothing
        else. See `puddleItems` for why they are where they are.
      */}
      <Scatter
        innerRef={puddleRef}
        geometry={puddleGeometry}
        material={puddleMaterial}
        items={puddleItems}
        castShadow={false}
        receiveShadow={false}
      />

      {/* Trees — four draw calls for the whole wood, not one per trunk. */}
      {/* The wood receives shadow but does not cast it. See `Scatter`. */}
      {treeBuckets.map((items, i) => (
        <Scatter
          key={`tree-${i}`}
          geometry={treeGeometries[i] ?? (treeGeometries[0] as THREE.BufferGeometry)}
          material={treeMaterial}
          items={items}
          castShadow={false}
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
              castShadow={false}
            />
          ),
        ),
      )}

      {/* Deadfall in the middle distance. See the note where it is placed. */}
      <Scatter
        geometry={deadfallGeometry}
        material={deadfallMaterial}
        items={deadfall}
        receiveShadow
      />

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
                  // Not stopped: out of reach this is a tap on a thing across
                  // the clearing, which means walk me over there. The handler
                  // decides, and lets the movement layer have it if it is a
                  // walk. See `onGather` for the same rule about firewood.
                  onVisitLandmark(landmark.id);
                  void event;
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
        The small things. Drawn dull and low on purpose: a landmark is what you
        pick out of the dark from across a clearing, and one of these is what
        you only notice once you are standing over it. A tap walks you there,
        the same rule the landmarks and the firewood follow.
      */}
      {curioProps.map(({ curio, geometry, y }) => (
        <mesh
          key={curio.secretId}
          name={`look:${curio.secretId}`}
          geometry={geometry}
          material={landmarkMaterials[curioMaterial(curio.shape)]}
          position={[curio.x, y, curio.z]}
          rotation={[0, curio.rotation, 0]}
          castShadow
          receiveShadow
          {...(onLookCloser
            ? {
                onClick: (event: { stopPropagation: () => void }) => {
                  onLookCloser(curio.secretId);
                  void event;
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
        <group key={patch.id}>
          {/* A low heap of litter under the sticks, so the patch reads as a
              place from a distance and the sticks read as lying on something. */}
          {patch.grade !== 'log' && (
            <mesh
              position={[patch.x, terrainHeight(patch.x, patch.z, seed, 0.7, basin) + 0.01, patch.z]}
              material={litterMaterial}
              receiveShadow
            >
              <coneGeometry args={[(patch.grade === 'kindling' ? 0.55 : 0.4) * 0.8, 0.07, 7]} />
            </mesh>
          )}
          <Scatter
            name={patch.id}
            geometry={deadfallGeometries[patch.grade]}
            material={
              deadfallMaterials[patch.woodId] ?? (deadfallMaterials['__fallback'] as THREE.Material)
            }
            items={items}
            receiveShadow
            {...(onGather ? { onPick: () => onGather(patch.id) } : {})}
          />
        </group>
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
      <lineSegments
        name="precipitation-rain"
        ref={rainRef}
        geometry={rainGeometry}
        material={rainMaterial}
        frustumCulled={false}
      />
      <points
        name="precipitation-snow"
        ref={snowRef}
        geometry={snowGeometry}
        material={snowMaterial}
        frustumCulled={false}
      />

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
      <ambientLight ref={ambientRef} intensity={1 + moonlight.ambient * 0.5} color={0x33445f} />
      <directionalLight
        ref={moonRef}
        position={moonlight.position}
        intensity={moonlight.intensity}
        color={0xa8bcd8}
      />
      {/*
        And the sun, which is the same idea and the bigger light.

        Mounted always and lit by intensity, so there is never a frame where
        the scene has no key at all. `look.sunIntensity` is zero while the sun
        is below the horizon, so at night this costs one unlit light.
      */}
      {/*
        And it casts, which nothing in this scene has ever done.

        `gl.shadowMap.enabled` has been true since the render layer was built
        and every prop in the campsite sets `castShadow`, but no *light* did —
        so the shadow map had no caster and the whole thing was inert. It never
        showed at night, because a campfire's light comes from the point light
        in the pit and a moon at that intensity casts nothing you would notice.
        In daylight it is the difference between a picture with a sun in it and
        a picture that is merely bright: an art review's exact words for the
        noon frame were "no shadows, no sun angle".

        Sized to the campsite rather than to the draw distance. A 40-metre
        shadow camera over a 512-pixel map is 8 cm a texel, which on
        `BasicShadowMap` is a hard crunchy edge — which is the correct look
        here — and stretching it to the treeline would make it mush.

        The near and far planes are around `bodyPosition`'s 90-metre distance,
        not around zero. A directional light's shadow camera sits AT the light
        and looks toward its target, so a far plane of 90 puts the campsite
        exactly on the clip plane and everything in it either side: the first
        version of this cast no shadow at all at noon, which looked identical
        to having no `castShadow`, and the way it was found was noticing that
        a log lying in full sun had nothing underneath it.
      */}
      <directionalLight
        ref={sunRef}
        position={sunPosition}
        intensity={0}
        color={0xfff0d8}
        visible={false}
        castShadow
        shadow-mapSize-width={512}
        shadow-mapSize-height={512}
        shadow-camera-near={55}
        shadow-camera-far={135}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
        // Acne on a low-resolution map over a displaced terrain, otherwise.
        shadow-bias={-0.0016}
        shadow-normalBias={0.03}
      />
      {/* The sky's own light, from above, so canopies read as canopies. */}
      <hemisphereLight
        ref={hemisphereRef}
        intensity={1.05 + moonlight.ambient * 1.2}
        color={0x4a5f80}
        groundColor={0x161a14}
      />
    </group>
  );
}

/**
 * The same colour, in sunlight.
 *
 * Lightness raised to `lightness`, saturation scaled by `chroma` — done in
 * HSL, where those are two numbers, rather than by lerping toward white, where
 * they are one. Every night palette in the catalogue is a dark, low-key colour
 * chosen to be lit by a fire from two metres; at noon those albedos read as
 * holes, and the previous fix for that took them to grey. A surface in
 * daylight is brighter and no less coloured than the same surface at dusk, and
 * hue is the whole of what distinguishes a pine hollow from a mesa.
 */
function sunlit(color: THREE.Color, lightness: number, chroma: number): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * chroma), lightness);
}

/** `'#0b1016'` from a manifest, as the integer the renderer wants. */
function hexOf(color: string): number {
  const parsed = Number.parseInt(color.replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Where a body in the sky sits in the scene, from its altitude and azimuth.
 *
 * Azimuth is measured from north and +Z is north here.
 *
 * `floor` is the one cheat and it matters more than it looks. A light below
 * the horizon would rake the scene from underneath, which reads as a bug
 * rather than as night — but how far above the horizon it is pinned decides
 * how much of its light lands on flat ground, because a horizontal surface
 * takes light by the sine of the elevation. Dropping the moon's floor from
 * twelve to six halved the light on the forest floor and took the far side of
 * the clearing from a dark wood to a black rectangle: 10.7 to 5.4 against the
 * D7 legibility floor of 6. The moon keeps twelve. The sun does not need one,
 * because when the sun is down its intensity is zero.
 */
function bodyPosition(
  altitude: number,
  azimuth: number,
  floor = 6,
  distance = 90,
): [number, number, number] {
  const horizontal = Math.cos(altitude) * distance;
  return [
    Math.sin(azimuth) * horizontal,
    Math.max(floor, Math.sin(altitude) * distance),
    Math.cos(azimuth) * horizontal,
  ];
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
/**
 * One dark pool per prop, and one draw call for all of them.
 *
 * Every critic on the panel reported the same thing in different words: the
 * rocks sit *on* the clearing floor rather than *in* it, "read as decals
 * pasted on a plane", have no occlusion where they meet the ground. It is
 * worst at midday, when the sun is overhead and cast shadows collapse, and
 * there is then no cue whatever that an object and a floor are touching.
 *
 * Deliberately NOT a shadow map. The sun's pass is already declined for the
 * two hundred and forty trees because it took the worst-case sweep past its
 * draw-call budget for four texels of mush, and the thing a rock needs here —
 * a tight dark core exactly at the contact line — is below a 512 map's
 * resolution over a forty-metre camera anyway. Contact occlusion is not the
 * shadow of a light, it is the sky being blocked, so it has no direction and a
 * blob is not an approximation of it: a blob is what it is.
 *
 * Every prop's pool is one instance of one quad in one mesh, so the whole
 * campsite costs a single draw call and two triangles a prop.
 */
function ContactPools({
  items,
  texture,
  height,
}: {
  items: readonly { x: number; z: number; radius: number }[];
  texture: THREE.Texture | null;
  height: (x: number, z: number) => number;
}): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const geometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    // Laid flat, face up, once — rather than rotating every instance.
    plane.rotateX(-Math.PI / 2);
    return plane;
  }, []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        /*
         * Multiplied into the ground rather than drawn over it, so the floor
         * keeps its own grain, its own hue and its own weather and simply gets
         * darker. A black quad with an alpha mask would paint a grey sticker
         * and would have to be re-tinted every time the hour moved.
         */
        /*
         * Spelled out as factors rather than named as `MultiplyBlending`.
         *
         * The named constant was set, and `material.blending` read back as 4
         * at runtime, and the pools still painted as opaque white squares with
         * a dark dot in the middle of each — which is what NormalBlending does
         * to this tile. Rather than keep arguing with it, the factors are
         * written out: destination times source, add nothing. dst = dst * src,
         * so white is the identity and the dark core is the only thing that
         * does anything.
         */
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        blendEquation: THREE.AddEquation,
        transparent: true,
        depthWrite: false,
        /*
         * Fog OFF, and this is load-bearing rather than an optimisation.
         *
         * `three`'s `fog_fragment` mixes the fragment toward the fog colour,
         * which is a bright sky value in daylight — under a multiply blend
         * that turns a distant shadow into something that *lightens* the
         * ground it lands on. It is the same defect as the stars and the rain
         * painting the fog colour, which is rule one of `e2e/invariants.spec.ts`
         * and which would have caught this had it been left on.
         */
        fog: false,
      }),
    [texture],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      dummy.position.set(item.x, height(item.x, item.z) + 0.022, item.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(item.radius * 2, 1, item.radius * 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items, dummy, height]);

  if (items.length === 0 || texture === null) return null;
  return (
    <instancedMesh
      name="contact-pools"
      ref={meshRef}
      args={[geometry, material, items.length]}
      renderOrder={1}
      frustumCulled={false}
    />
  );
}

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
  innerRef,
  receiveShadow = false,
  castShadow = true,
  onPick,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: readonly ScatterItem[];
  name?: string;
  /** For the one scatter the frame loop has to show and hide. See `puddles`. */
  innerRef?: React.RefObject<THREE.InstancedMesh | null>;
  receiveShadow?: boolean;
  /**
   * Whether this scatter casts into the shadow map.
   *
   * Off for the wood and the understorey. A shadow pass re-renders everything
   * that casts, so the two hundred and forty trees that are most of the
   * campsite's triangles were also most of the shadow map's — measured, the
   * sun's single pass took the worst-case sweep from 80 draw calls to well
   * over two hundred against a budget of 133. And it bought nothing: at 512
   * over a forty-metre camera a tree's shadow is four texels of mush, and the
   * shadows worth having are the ones near the fire, on the props a player is
   * standing among.
   */
  castShadow?: boolean;
  onPick?: (index: number) => void;
}): React.ReactElement | null {
  const ownRef = useRef<THREE.InstancedMesh>(null);
  const meshRef = innerRef ?? ownRef;
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
      castShadow={castShadow}
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

