/**
 * The campfire.
 *
 * Crunchy and PS1 on the surface, driven entirely by the simulation
 * underneath. Fire is one of the places the spec explicitly allows modern
 * rendering, so the flames are additive and unlit — but they are still
 * quantised and dithered by the post pass, which is what keeps them of this
 * world.
 *
 * Two things about this file are load-bearing and easy to undo by accident.
 *
 * The flame's colour ramp lives in the *geometry*, as vertex colours, not in
 * the per-instance colour. That is the only way the ramp can be identical at
 * four metres and at forty centimetres: a per-instance colour paints a whole
 * tongue one flat value, which is invisible when the tongue is six pixels tall
 * and is the entire read when it is a quarter of the screen. Anything written
 * to `setColorAt` here must therefore stay close to neutral — it scales the
 * ramp, it does not replace it.
 *
 * And the fire ring is one merged mesh rather than nine. Nine stones were nine
 * draw calls in the colour pass and nine more in the shadow pass, at the exact
 * spot in the scene where the draw budget peaks. They never move, so they are
 * welded once.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { fireLightIntensity, fuelGrade, PIT, type FireState } from '@somemore/sim';
import { getTexture } from '../render/textures.js';
import { createPs1Material } from '../render/ps1.js';
import { createLogGeometry } from '../render/geometry.js';
import type { RenderSettings } from '../render/ps1.js';

const FLAME_COUNT = 24;
const EMBER_COUNT = 22;
const SPARK_COUNT = 30;
/**
 * How many pieces of fuel can be drawn at once.
 *
 * Higher than the fire wants, because the pit is now somewhere a player parks
 * wet wood to dry as well as somewhere they burn it, and an armful of kindling
 * is five pieces on its own.
 */
const LOG_SLOTS = 12;
const STEAM_COUNT = 14;

/** Half the length of the drawn log, for working out where its raised end is. */
const LOG_HALF_LENGTH = 0.2;

/** The height a dragged piece is carried at — a hand's width above the ash. */
const PIT_PLANE_Y = 0.07;

/** How thick the drawn log is. The unit every close-range size is judged in. */
const LOG_DIAMETER = 0.096;

/**
 * How tall one tongue may be drawn when the player's face is in the fire.
 *
 * At roasting range a flame the height of the whole column is a flat sheet
 * across a quarter of the screen. Nobody kneeling at a fire sees that; they
 * see a fistful of short overlapping tongues. About one and a half times the
 * thickness of the log is what that measures.
 */
const NEAR_TONGUE_HEIGHT = LOG_DIAMETER * 1.5;

/** Where the near read is fully in force, and where it has fully let go. */
const NEAR_RANGE = 0.55;
const FAR_RANGE = 1.7;

/** The pit is the origin of the world; the flame column stands over it. */
const FIRE_CENTRE = new THREE.Vector3(0, 0.18, 0);

/** Stands in for a particle the phase table is too short to describe. */
const FALLBACK_PHASE = {
  offset: 0,
  radius: 0.1,
  speed: 1,
  angle: 0,
  slenderness: 0.3,
  yaw: 0,
} as const;

/**
 * The flame's value ramp, from the base of a tongue to its tip, in sRGB.
 *
 * White-hot where it leaves the fuel, saturated orange through the body, thin
 * dark amber at the tip. Written as sRGB hexes and converted by `THREE.Color`,
 * because the renderer works in linear space and hand-written linear triples
 * are how the old ramp ended up pale: `(1, 0.8, 0.12)` reads as `#ffd726` on
 * screen — a lemon — and two of those overlapping additively clamp red *and*
 * green, leaving only blue free to climb. That is how the hottest thing in the
 * frame became the coolest hue in it.
 *
 * Green never appears because it is never authored: every stop below has green
 * strictly under red and blue strictly under green.
 */
const FLAME_RAMP: readonly (readonly [number, number])[] = [
  [0.0, 0xfff4e0],
  [0.05, 0xffd069],
  [0.18, 0xffa22c],
  [0.4, 0xf76512],
  [0.68, 0xa63708],
  [1.0, 0x360e00],
];

/** Columns and rows in one tongue ribbon. Small: there are a lot of them. */
const TONGUE_COLUMNS = 5;
const TONGUE_ROWS = 8;

function flameRampAt(v: number, out: THREE.Color): THREE.Color {
  const clamped = Math.min(1, Math.max(0, v));
  for (let i = 1; i < FLAME_RAMP.length; i++) {
    const [hi, hiColor] = FLAME_RAMP[i] as readonly [number, number];
    if (clamped > hi && i < FLAME_RAMP.length - 1) continue;
    const [lo, loColor] = FLAME_RAMP[i - 1] as readonly [number, number];
    const t = hi === lo ? 0 : (clamped - lo) / (hi - lo);
    return out.setHex(loColor).lerp(new THREE.Color(hiColor), Math.min(1, Math.max(0, t)));
  }
  return out.setHex(FLAME_RAMP[0]?.[1] ?? 0xffffff);
}

/**
 * One tongue of flame: two ribbons crossed at right angles, carrying the ramp
 * in their vertex colours.
 *
 * Crossed rather than billboarded on purpose. Billboards are all parallel to
 * the image plane, so at roasting range with a wide field of view they shear
 * into a fan of identical cardboard flaps radiating from the vanishing point —
 * which is exactly what the close-range fire looked like. Crossed ribbons have
 * a silhouette from any angle, never go edge-on, and give the fire parallax as
 * the player moves their head around it.
 *
 * There is no texture. The taper and the soft edge are the vertex colours
 * going to black at the rim, and under additive blending black adds nothing —
 * so the edge fades instead of ending at a hard alpha cut, which is what put a
 * visible seam through the middle of the old fire wherever two quads crossed.
 *
 * Unit-sized: one metre tall, one metre across, scaled per instance.
 */
function createTongueGeometry(): THREE.BufferGeometry {
  // Pinched where it leaves the wood, widest just above it, drawn to a point.
  const widthAt = (v: number) => Math.pow(Math.max(0, 1 - v), 0.62) * Math.min(1, 0.42 + v * 6.5);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const ramp = new THREE.Color();

  for (let ribbon = 0; ribbon < 2; ribbon++) {
    const base = positions.length / 3;
    for (let row = 0; row < TONGUE_ROWS; row++) {
      const v = row / (TONGUE_ROWS - 1);
      const halfWidth = widthAt(v) * 0.5;
      flameRampAt(v, ramp);
      /*
       * Both ends of the tongue fade out rather than stopping.
       *
       * Additive geometry with a bright edge row is a cut, and a cut is what
       * makes a flame look like a piece of card: the old sprite's hard alpha
       * boundary is the "hard translucent edge" in the note. The foot fades
       * into the fuel it is leaving and the tip dissolves instead of coming to
       * a lit point.
       */
      const foot = Math.pow(Math.min(1, v / 0.18), 0.7);
      const tip = 1 - Math.pow(Math.min(1, Math.max(0, (v - 0.78) / 0.22)), 1.4);
      // Bright up the middle, black at the rim: the soft edge, and the reason
      // the interior of a cluster reads hotter than its outside. The core
      // tightens toward the base so the white-hot part is a filament rather
      // than a pale slab across the widest part of the tongue.
      const sharpness = 1.6 + (1 - v) * 1.8;
      for (let column = 0; column < TONGUE_COLUMNS; column++) {
        const u = (column / (TONGUE_COLUMNS - 1)) * 2 - 1;
        const across = u * halfWidth;
        positions.push(ribbon === 0 ? across : 0, v, ribbon === 0 ? 0 : across);
        const density = Math.pow(Math.max(0, 1 - u * u), sharpness) * foot * tip;
        colors.push(ramp.r * density, ramp.g * density, ramp.b * density);
      }
    }
    for (let row = 0; row < TONGUE_ROWS - 1; row++) {
      for (let column = 0; column < TONGUE_COLUMNS - 1; column++) {
        const a = base + row * TONGUE_COLUMNS + column;
        const b = a + 1;
        const c = a + TONGUE_COLUMNS;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * One river cobble: squat, blunt, closed.
 *
 * The displacement is a function of the vertex's *direction*, never of its
 * index. `IcosahedronGeometry` is non-indexed — twenty faces, sixty separate
 * vertices — so a per-vertex random pushes the three corners of every face
 * apart and the solid comes apart into twenty loose triangles with nothing
 * joining them. That is what put a ring of black paper darts round the fire:
 * half of those loose triangles face away from the flames and flat-shade to
 * nothing. Direction in, displacement out, and shared corners stay shared.
 */
function createCobbleGeometry(seed: number, radius: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 1);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const direction = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    direction.fromBufferAttribute(position, i).normalize();
    const lumps =
      Math.sin(direction.x * 4.1 + seed) * 0.42 +
      Math.sin(direction.y * 3.3 + seed * 1.7) * 0.26 +
      Math.sin(direction.z * 4.7 + seed * 2.3) * 0.42;
    const bulge = radius * (1 + lumps * 0.13);
    // Wider than tall, and no points: a cobble that has been in a river.
    position.setXYZ(i, direction.x * bulge * 1.26, direction.y * bulge * 0.5, direction.z * bulge * 1.26);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** How many stones stand in the ring. */
const RING_STONES = 9;

/**
 * The whole fire ring, welded into one geometry.
 *
 * Nine cobbles, each sunk into the duff so it has a contact line instead of
 * sitting on the ground like a prop, and each graded in its vertex colours:
 * soot on the top inside edge where a fire actually blackens a stone, cooling
 * outward to a grey-brown. The grading never reaches black — the darkest a
 * stone is allowed to be is a warm brown, which is the whole of spec deviation
 * D7 applied to the one place in the frame it kept being broken.
 */
function createStoneRingGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const clean = new THREE.Color(1.42, 1.3, 1.12);
  const soot = new THREE.Color(0.62, 0.5, 0.4);
  const graded = new THREE.Color();
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();

  for (let i = 0; i < RING_STONES; i++) {
    const angle = (i / RING_STONES) * Math.PI * 2;
    /*
     * Deterministic, and no two stones alike: size, lean and how deep each one
     * is bedded all come off the index.
     *
     * The size range is bounded by the spacing. Nine stones on a 0.42 m ring
     * stand 0.29 m apart, so a cobble wider than half of that grows through
     * its neighbour, and stones growing through each other is half of what
     * "looks like broken geometry" meant.
     */
    const size = 0.074 + ((i * 29) % 7) / 7 * 0.026;
    const sink = 0.026 + ((i * 17) % 5) / 5 * 0.016;
    const lean = (((i * 41) % 9) / 9 - 0.5) * 0.22;
    const geometry = createCobbleGeometry(1000 + i, size);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const sourceNormal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const sourceUv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const index = geometry.getIndex();

    matrix.compose(
      new THREE.Vector3(Math.cos(angle) * PIT.ringRadius, size * 0.5 - sink, Math.sin(angle) * PIT.ringRadius),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, angle * 1.7, lean * 0.6, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    normalMatrix.getNormalMatrix(matrix);

    const base = positions.length / 3;
    for (let v = 0; v < position.count; v++) {
      vertex.fromBufferAttribute(position, v).applyMatrix4(matrix);
      normal.fromBufferAttribute(sourceNormal, v).applyMatrix3(normalMatrix).normalize();
      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(sourceUv ? sourceUv.getX(v) : 0, sourceUv ? sourceUv.getY(v) : 0);

      /*
       * How far up this stone the vertex sits, and how far round toward the
       * fire. Soot collects where those two meet and nowhere else.
       *
       * Both exponents are steep on purpose. Firelight arrives from above and
       * in front, so a soot term spread over the whole upper half cancels
       * exactly the light that is supposed to be picking each stone out and
       * the ring goes back to being a row of dark lumps. It belongs on the top
       * inside edge and nowhere else; the rest of the stone is grey-brown, and
       * every face turned toward the fire is lit.
       */
      const top = Math.min(1, Math.max(0, (vertex.y + sink) / Math.max(1e-4, size * 0.9)));
      const radial = Math.hypot(vertex.x, vertex.z) - PIT.ringRadius;
      const inside = Math.min(1, Math.max(0, -radial / (size * 1.0)));
      const amount = Math.pow(top, 1.6) * Math.pow(inside, 2.2);
      graded.copy(clean).lerp(soot, Math.min(1, Math.max(0, amount)));
      colors.push(graded.r, graded.g, graded.b);
    }
    // `IcosahedronGeometry` is not indexed — it hands back sixty loose corners
    // for twenty faces — so the merge has to draw its own index rather than
    // assume one is there. Trusting `getIndex()` here silently produced a ring
    // with no triangles in it at all.
    if (index) for (let t = 0; t < index.count; t++) indices.push(base + index.getX(t));
    else for (let v = 0; v < position.count; v++) indices.push(base + v);
    geometry.dispose();
  }

  const ring = new THREE.BufferGeometry();
  ring.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  ring.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  ring.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  ring.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  ring.setIndex(indices);
  ring.computeBoundingSphere();
  return ring;
}

export interface FireProps {
  fire: FireState;
  settings: RenderSettings;
  maxParticles: number;
  /**
   * Working the bed with your hands, at the point you touched it.
   *
   * `inward` is how far the touch travelled toward the middle of the pit, in
   * metres: positive for a sweep that pulls ash over the coals, negative for
   * one that rakes it back off them, and about zero for a tap. Those are the
   * same two motions with the same tool, told apart the way they are told
   * apart in life — by which way you moved your hand.
   *
   * What each of them means is the caller's business, because it also depends
   * on what is in the player's other hand. The pit reports the gesture and
   * takes no view.
   */
  onWorkBed?: (work: { x: number; z: number; inward: number }) => void;
  /**
   * Whether the fire is allowed to cast. Off on the low tier: a point light's
   * shadow is six cube faces re-rendered every frame, which is the one thing
   * a phone that already dropped to 180 lines cannot afford.
   */
  shadows?: boolean;
  /**
   * Arranging: dragging one piece of fuel across the pit.
   *
   * Position only. What the wood does when it gets there — lie flat, or ride
   * up on what is already in the pit — is the simulation's business, not the
   * renderer's, and certainly not a control the player has to find.
   */
  onMoveLog?: (logId: string, x: number, z: number) => void;
  /**
   * The colour this campsite's fire throws, from its night palette.
   *
   * Every environment states one and none of them had ever been used: the
   * dynamic light was the same orange at a pine hollow, a salt flat and a
   * snowfield. Firelight is the only light most of these places have, so it is
   * most of what makes them look different from each other.
   */
  glow?: string | number;
  /** Shared with the input layer so a drag on a log is not also a look. */
  grabbedRef?: React.MutableRefObject<string | null>;
  /**
   * Whether the player is close enough to put a hand in the pit.
   *
   * A function rather than a prop because it is read on a pointer event and
   * changes as the player walks: making it state would re-render the scene on
   * every step across the clearing. It has to gate the *grab* and not just the
   * effect — a press on a log two metres away that took hold of nothing still
   * swallowed the tap that was trying to walk the player over to it.
   */
  canTouch?: () => boolean;
}

export function Fire({
  fire,
  settings,
  maxParticles,
  shadows = false,
  onWorkBed,
  onMoveLog,
  glow,
  grabbedRef,
  canTouch,
}: FireProps): React.ReactElement {
  const flamesRef = useRef<THREE.InstancedMesh>(null);
  const embersRef = useRef<THREE.InstancedMesh>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const emberLightRef = useRef<THREE.PointLight>(null);
  const logsRef = useRef<THREE.Group>(null);
  const steamRef = useRef<THREE.InstancedMesh>(null);
  const ashRef = useRef<THREE.Mesh>(null);
  /** The piece currently under a finger, if any. */
  const dragging = useRef<string | null>(null);
  /** Where a log was touched and whether the finger then moved: a tap on wood is a poke at the bed. */
  const logTap = useRef<{ x: number; z: number; moved: boolean } | null>(null);
  /** Where a hand went into the ash, so a sweep can be told from a tap. */
  const sweep = useRef<{ radius: number; x: number; z: number } | null>(null);

  // A denser cluster, and not one draw call more: the tongues are instances of
  // one geometry, so density is bought in vertices and vertices are the thing
  // this scene has room for.
  const flameCount = Math.min(FLAME_COUNT, Math.max(5, Math.floor(maxParticles / 10)));
  const emberCount = Math.min(EMBER_COUNT, Math.max(6, Math.floor(maxParticles / 8)));
  const sparkCount = Math.min(SPARK_COUNT, Math.max(8, Math.floor(maxParticles / 6)));
  const steamCount = Math.min(STEAM_COUNT, Math.max(4, Math.floor(maxParticles / 14)));

  const flameGeometry = useMemo(() => createTongueGeometry(), []);
  useEffect(() => () => flameGeometry.dispose(), [flameGeometry]);
  // Flattened: coals are a bed, not a pile of marbles.
  const emberGeometry = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(0.021, 0);
    geometry.scale(1, 0.45, 1);
    return geometry;
  }, []);
  const logGeometry = useMemo(() => createLogGeometry(0.4, 0.048), []);

  const flameMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // No map. The ramp and the soft edge are both in the vertex colours,
        // which is what makes them hold at every camera distance instead of
        // dissolving into one flat texel value the closer you get.
        vertexColors: true,
        transparent: true,
        opacity: 0.86,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        /*
         * Fog off, and this is not cosmetic.
         *
         * `fog_fragment` *replaces* the fragment colour with the fog colour as
         * the factor goes to one rather than tinting it, so a fogged additive
         * sprite stops being fire and starts being a lump of night-blue haze
         * added to the frame. Materials default to `fog: true`, so leaving
         * this out is how a flame quietly turns the colour of the weather.
         */
        fog: false,
      }),
    [],
  );

  const emberMaterial = useMemo(
    () => createPs1Material({ map: getTexture('ember', { size: 32 }), settings, emissive: 0xff5a12, emissiveIntensity: 1.6 }),
    [settings],
  );

  /**
   * One material per slot, not one shared between them.
   *
   * Charring and the glow of a piece catching are written onto the material
   * every frame, so a single shared material meant the whole pit took whatever
   * the last log in the list happened to be — six logs, one appearance, and no
   * way to see that the piece you just laid on is not yet alight.
   */
  const logMaterials = useMemo(
    () =>
      Array.from({ length: LOG_SLOTS }, (_, i) =>
        createPs1Material({
          map: getTexture('bark', { size: 64 }),
          settings,
          roughness: 1,
          /*
           * The seams it burns through, per slot.
           *
           * Seeded by slot index so two logs side by side do not split in the
           * same places — which is the whole reason there is one material per
           * slot rather than one shared, and the reason this is worth a
           * texture rather than a constant.
           */
          emissiveMap: getTexture('charCracks', { size: 64, seed: 0x9e37 + i * 131 }),
          emissive: 0xffffff,
          emissiveIntensity: 0,
        }),
      ),
    [settings],
  );

  const stoneMaterial = useMemo(
    () =>
      createPs1Material({
        map: getTexture('stone', { size: 64 }),
        settings,
        // Darkened: raw stone albedo next to a fire blows out to paper white.
        // The soot and the grey-brown come off the vertex colours instead, so
        // the ring is graded rather than uniformly crushed.
        color: 0x46433d,
        vertexColors: true,
        /*
         * A warm floor under the ring, driven by the fire below.
         *
         * A stone that has been in a fire ring all evening is radiantly warm,
         * and it is the only thing standing between the away-facing side of a
         * cobble and pure black — ambient at night is a fifth of a per cent of
         * an albedo this dark. Held down by `fireBrightness` with everything
         * else the fire lights (D7: a dark surface, never a black rectangle).
         */
        emissive: 0x321708,
        emissiveIntensity: 0.5,
        roughness: 1,
      }),
    [settings],
  );

  /*
   * A wisp, not a bedsheet.
   *
   * At 0.2 x 0.28 metres, scaled up to 1.7 as it rose, one wisp was half a
   * metre of pale quad — and the `steam` tile is a wedge that widens as it
   * goes up with a hard flat cut across its bottom, so at roasting range a
   * plume off damp wood became a fan of enormous cardboard blades converging
   * on the fuel, sitting over the fire and washing the orange out of it. That
   * fan is what the near-range fire has been getting blamed for. Steam off a
   * stick is about a hand across; this is a hand across.
   */
  const steamGeometry = useMemo(() => new THREE.PlaneGeometry(0.085, 0.13), []);
  const steamMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: getTexture('steam', { size: 32, seed: 'steam' }),
        transparent: true,
        opacity: 0.55,
        /*
         * Additive, because instanced meshes can vary colour and not opacity.
         *
         * A wisp is faded here by darkening its instance colour, and under
         * normal blending that paints a *dark* smudge over the fire instead of
         * a fainter pale one. Steam off wet wood at the edge of a fire is lit
         * by the fire and is brighter than the night behind it, so adding it
         * is both the honest look and the one the instancing can express.
         */
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        // Same reason as the flame: fog replaces an additive fragment rather
        // than tinting it.
        fog: false,
      }),
    [],
  );

  const sparkGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3));
    return geometry;
  }, [sparkCount]);

  const sparkMaterial = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: 0xffb257,
        size: 0.022,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        /*
         * `PointsMaterial.fog` defaults to true, and a fogged point is not a
         * dimmer point — `fog_fragment` swaps its colour for the fog's. Sparks
         * carry a long way on a still night, which is exactly the distance at
         * which the fog factor is high, so without this the embers drifting
         * off the fire were night-blue specks.
         */
        fog: false,
      }),
    [],
  );

  /*
   * Per-particle phase offsets, stable across frames.
   *
   * `slenderness` and `yaw` are what stop the cluster reading as one sprite
   * stamped out twenty times. Every number here is derived from the index, so
   * a given seed gives a given fire.
   */
  const phases = useMemo(
    () =>
      Array.from({ length: Math.max(flameCount, emberCount, sparkCount, steamCount) }, (_, i) => ({
        offset: (i * 2.399963229728653) % (Math.PI * 2),
        radius: 0.04 + ((i * 37) % 100) / 100 * 0.14,
        speed: 0.6 + ((i * 53) % 100) / 100 * 0.9,
        angle: ((i * 71) % 100) / 100 * Math.PI * 2,
        slenderness: 0.24 + ((i * 43) % 100) / 100 * 0.2,
        yaw: ((i * 61) % 100) / 100 * Math.PI,
      })),
    [flameCount, emberCount, sparkCount, steamCount],
  );

  /** The fire ring: nine cobbles, one geometry, one draw call. */
  const ringGeometry = useMemo(() => createStoneRingGeometry(), []);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  /** The campsite's own firelight, or the catalogue's default warm orange. */
  const glowColor = useMemo(() => new THREE.Color(glow ?? 0xff9b47), [glow]);
  /**
   * The same firelight, pulled most of the way back to white.
   *
   * The flame's colour is the ramp baked into the tongue geometry. This is the
   * multiplier over it, so it has to be close to neutral or a salt flat's cool
   * glow would drag the tongues off orange and a pine hollow's would clip them
   * red. A third of the way toward a glow normalised to full value is enough
   * for two campsites to look like different places and not enough to move the
   * ramp off fire.
   */
  const glowTint = useMemo(() => {
    const peak = Math.max(glowColor.r, glowColor.g, glowColor.b, 1e-4);
    return new THREE.Color(1, 1, 1).lerp(
      new THREE.Color(glowColor.r / peak, glowColor.g / peak, glowColor.b / peak),
      0.32,
    );
  }, [glowColor]);
  const color = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const flicker = settings.flicker;
    const brightness = settings.fireBrightness;
    const intensity = fire.flame;
    /** Reduced motion damps every drift and wobble in here, not just the camera. */
    const motion = settings.reducedMotion ? 0.22 : 1;
    /*
     * How close the player's face is, 0 at arm's length and 1 in the fire.
     *
     * The pit is the origin of the world, so this is just the camera's
     * distance to it. Everything the near read needs hangs off this one
     * number, and it moves continuously, so nothing pops as the player walks
     * in. It is the term the old fire did not have: sprites sized once in
     * world units are correct at four metres and a wall of cardboard at forty
     * centimetres.
     */
    const near =
      1 - Math.min(1, Math.max(0, (state.camera.position.distanceTo(FIRE_CENTRE) - NEAR_RANGE) / (FAR_RANGE - NEAR_RANGE)));
    // Ash over the coals is a blanket, and it is opaque. A banked bed shows a
    // faint red in the cracks and nothing else, which is exactly why a player
    // arriving at one needs telling that there is anything alive in it.
    const buried = 1 - fire.ashCover * 0.92;
    const emberGlow = Math.min(1, fire.emberMass) * buried;
    /*
     * The coals' own light, not just their colour.
     *
     * Their per-instance colour already followed the glow, but the emissive
     * term on the shared material did not, so a banked bed — "grey ash, and
     * heat still under it" — still showed ten bright orange coals sitting on
     * top of the ash. One write, one material.
     */
    emberMaterial.emissiveIntensity = 1.6 * emberGlow;
    /*
     * The ring's own warmth, so no stone in it is ever a black shape.
     *
     * The stones face every direction, and the side of one facing away from
     * the fire receives almost nothing: the albedo is a fifth of a per cent
     * and night ambient is night ambient. Stones that have spent an evening
     * round a fire are radiantly warm, so the floor is honest as well as
     * legible, and it rides `fireBrightness` with everything else the fire
     * lights. This is the D7 floor for the fire ring: dark, never black.
     */
    stoneMaterial.emissiveIntensity = (0.24 + Math.min(1, intensity + emberGlow * 0.6) * 0.62) * brightness;

    // --- Flames -----------------------------------------------------------
    const flames = flamesRef.current;
    if (flames) {
      /*
       * Up close the fire gets smaller and denser, not bigger and flatter.
       *
       * The tongues do not grow as you approach — they are the same tongues —
       * but the column packs down: each one is capped at about one and a half
       * times the thickness of the log, the rise is compressed, and the ring
       * they stand on tightens. What the player's face ends up in front of is
       * a fistful of short overlapping flames rather than four sheets. At
       * walking distance the caps let go entirely and the column stands its
       * full height, which is the read that already worked and must not move.
       */
      const tallest = THREE.MathUtils.lerp(0.46, NEAR_TONGUE_HEIGHT, near);
      const rise = THREE.MathUtils.lerp(1, 0.62, near);
      const huddle = THREE.MathUtils.lerp(1, 0.66, near);
      // More tongues overlapping means each has to add less, or the middle of
      // the cluster clamps to white and takes the colour with it.
      const density = THREE.MathUtils.lerp(1, 0.72, near);

      for (let i = 0; i < flameCount; i++) {
        const p = phases[i] ?? FALLBACK_PHASE;
        // Each flame tongue rises, shrinks and recycles.
        const life = (t * p.speed * (0.5 + intensity) + p.offset) % 1;
        /*
         * Tongues linger near the fuel and go out quickly once they leave it.
         *
         * A linear rise spread fourteen sprites evenly up a flame column more
         * than a metre tall, which from a kneeling position read as a handful
         * of separate little fires hanging in the air above the pit rather
         * than as one fire. Weighting the rise keeps most of them down in the
         * wood where a flame actually is, and the faster taper stops the last
         * one being a bright speck at head height.
         */
        const height = Math.pow(life, 1.5) * fire.flameHeight * 0.92 * rise;
        const shrink = Math.pow(Math.max(0, 1 - life), 0.85);
        const sway =
          Math.sin(t * 3 * flicker * motion + p.offset) *
          0.05 *
          (0.3 + fire.windSpeed * 0.2) *
          motion;
        /*
         * The lean, which the prose has always claimed and the picture never
         * showed.
         *
         * `height` rather than `height * height` was the whole problem: a
         * linear lean tips the entire column like a hinged plank, and at the
         * old coefficient a full gale bent a forty-centimetre flame by four
         * centimetres — about six degrees, which at 320x240 is nothing. A
         * flame is anchored at the fuel and free at the tip, so it bends more
         * the further up it goes, and squaring the height is what turns a tilt
         * into a bend. An art review's note was blunt: "you already write 'the
         * flames lean with it'; the flames do not lean."
         */
        const lean = fire.windSpeed * 0.115 * height * height * 2.4;
        // How far out from the axis this tongue sits. `huddle` is the near
        // term: walk up to the fire and the column packs in rather than
        // spreading, which is what stops it fanning across the whole frame.
        const radius = p.radius * (1 - life * 0.5) * huddle;

        dummy.position.set(
          Math.cos(p.angle) * radius + sway + Math.cos(fire.windDirection) * lean,
          height + 0.012,
          Math.sin(p.angle) * radius + Math.sin(fire.windDirection) * lean,
        );
        // The tongue is a unit shape, so its height and its width are set
        // separately: a flame is narrow, and a uniform scale is what made the
        // old sprites read as squares of cardboard the closer you got.
        const wobble = 0.85 + Math.sin(t * 9 * motion + p.offset) * 0.15 * flicker * motion;
        const tongueHeight = Math.min(tallest, shrink * (0.2 + intensity * 0.34) * wobble);
        const tongueWidth = tongueHeight * p.slenderness * (2 - wobble);
        dummy.scale.set(Math.max(0.001, tongueWidth), Math.max(0.001, tongueHeight), Math.max(0.001, tongueWidth));
        /*
         * Crossed ribbons, not a billboard: they carry their own silhouette,
         * so all they need is a yaw and a lean that keep neighbours from
         * looking stamped from the same die. A row of identical upright cones
         * is a picket fence, which is what the close-range fire read as even
         * on the frames where nothing else was wrong with it.
         */
        const tilt = (p.slenderness - 0.34) * 1.6 + fire.windSpeed * 0.05 * motion;
        dummy.rotation.set(
          Math.sin(p.yaw) * tilt,
          p.yaw + sway * 2,
          Math.cos(p.yaw) * tilt,
          'YXZ',
        );
        dummy.updateMatrix();
        flames.setMatrixAt(i, dummy.matrix);

        /*
         * Near enough to neutral to leave the ramp alone.
         *
         * The white-hot-to-amber ramp is in the geometry; this only says how
         * hot this particular tongue is and lets the campsite's own firelight
         * tint it a little. Tongues standing in the middle of the ring burn
         * hotter than tongues at its edge, which is what makes the inside of
         * the cluster brighter than its outline instead of the fire being one
         * even slab of light.
         */
        const core = 1 - Math.min(1, p.radius / 0.15);
        const heat =
          Math.pow(1 - life, 1.15) * intensity * brightness * density * (0.78 + core * 0.42);
        color.copy(glowTint).multiplyScalar(heat);
        flames.setColorAt(i, color);
      }
      flames.instanceMatrix.needsUpdate = true;
      if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
      flames.visible = intensity > 0.02;
    }

    // --- Ember bed --------------------------------------------------------
    const embers = embersRef.current;
    if (embers) {
      for (let i = 0; i < emberCount; i++) {
        const p = phases[i] ?? FALLBACK_PHASE;
        const r = p.radius * 1.9;
        dummy.position.set(Math.cos(p.angle) * r * 0.85, 0.012, Math.sin(p.angle) * r * 0.85);
        dummy.rotation.set(0, p.angle, 0);
        dummy.scale.setScalar(0.75 + emberGlow * 0.5);
        dummy.updateMatrix();
        embers.setMatrixAt(i, dummy.matrix);

        // Coals pulse slowly and independently — the bed is never uniform.
        const pulse = 0.55 + Math.sin(t * 1.4 * flicker + p.offset * 3) * 0.25;
        const glow = emberGlow * pulse * brightness;
        color.setRGB(glow * 1.1, glow * 0.32, glow * 0.06);
        embers.setColorAt(i, color);
      }
      embers.instanceMatrix.needsUpdate = true;
      if (embers.instanceColor) embers.instanceColor.needsUpdate = true;
      embers.visible = emberGlow > 0.01;
    }

    // --- Sparks -----------------------------------------------------------
    const sparks = sparksRef.current;
    if (sparks) {
      const positions = sparkGeometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < sparkCount; i++) {
        const p = phases[i] ?? FALLBACK_PHASE;
        const life = (t * p.speed * 0.35 + p.offset) % 1;
        const rise = life * (1.4 + fire.flame * 1.2);
        const drift = life * fire.windSpeed * 0.35;
        positions.setXYZ(
          i,
          Math.cos(p.angle) * p.radius * (1 + life) + Math.cos(fire.windDirection) * drift,
          0.1 + rise,
          Math.sin(p.angle) * p.radius * (1 + life) + Math.sin(fire.windDirection) * drift,
        );
      }
      positions.needsUpdate = true;
      sparkMaterial.opacity = 0.75 * intensity * brightness;
      sparks.visible = intensity > 0.08;
    }

    // --- Ash ---------------------------------------------------------------
    const ash = ashRef.current;
    if (ash) {
      const material = ash.material as THREE.MeshStandardMaterial;
      // Grey and dead-looking when the fire is put away; scorched and dark
      // when it has been raked back off the coals.
      const grey = 0.29 + fire.ashCover * 0.34;
      material.color.setRGB(grey, grey * 0.96, grey * 0.88);
      ash.scale.setScalar(1 + fire.ashCover * 0.06);
    }

    // --- Light ------------------------------------------------------------
    // One dynamic light for flame plus one low warm light for the coals: the
    // budget allows few dynamic lights, and these two carry the whole scene.
    const light = lightRef.current;
    if (light) {
      const base = fireLightIntensity(fire) * 11 * brightness;
      // Reduced motion damps the light's pulse as well as the flames' sway: a
      // room lit by something that will not hold still is a motion problem
      // whether or not the thing itself is on screen.
      const jitter =
        1 + Math.sin(t * 11) * 0.06 * flicker * motion + Math.sin(t * 23.3) * 0.035 * flicker * motion;
      light.intensity = base * jitter;
      light.position.y = 0.28 + fire.flameHeight * 0.35;
      /*
       * The campsite's own firelight at full flame, reddening as it dies.
       *
       * The curve is the one that was here — hot and yellow at the top, deep
       * and red at the bottom — with the top of it now being the colour this
       * environment says its fire throws rather than one orange for all of
       * them.
       */
      light.color.setRGB(
        glowColor.r,
        glowColor.g * (0.76 + intensity * 0.24),
        glowColor.b * (0.62 + intensity * 0.38),
      );
    }
    const emberLight = emberLightRef.current;
    if (emberLight) {
      emberLight.intensity = emberGlow * 3.2 * brightness;
      // Coals are the same fire, much further down the same curve.
      emberLight.color.setRGB(glowColor.r, glowColor.g * 0.49, glowColor.b * 0.29);
    }

    // --- Fuel --------------------------------------------------------------
    // Drawn where the simulation says it is. Until this existed, every log in
    // the pit was drawn at a fixed slot on a ring of six and the only thing a
    // player could learn about arranging a fire was that it made no difference.
    const logs = logsRef.current;
    let steamIndex = 0;
    if (logs) {
      logs.children.forEach((child, i) => {
        const log = fire.logs[i];
        child.visible = Boolean(log);
        if (!log) return;
        const mesh = child as THREE.Mesh;
        const grade = fuelGrade(log.grade);
        const spot = log.spot;

        // A leaned piece has its inner end up on the pile. The geometry runs
        // along local +X, and `spot.angle` already points that end inward as
        // the lean rises, so tilting about Z lifts the right end of it.
        const tilt = spot.lean * 0.62;
        mesh.position.set(
          spot.x,
          0.048 + Math.sin(tilt) * LOG_HALF_LENGTH * 0.9,
          spot.z,
        );
        mesh.rotation.set(0, spot.angle, tilt, 'YZX');

        // Thin fuel is thin. A handful of tinder should not read as a log.
        const girth = log.grade === 'log' ? 1 : log.grade === 'kindling' ? 0.42 : 0.26;
        const length = log.grade === 'log' ? 0.4 + log.mass * 0.6 : log.grade === 'kindling' ? 0.62 : 0.4;
        mesh.scale.set(length, girth, girth);

        const material = mesh.material as THREE.MeshStandardMaterial;
        // Fuel chars visibly as it burns, and thin fuel gets there far sooner.
        const charAmount = Math.min(1, log.burnedFor / (260 / grade.burns));
        material.color.setRGB(1 - charAmount * 0.78, 1 - charAmount * 0.84, 1 - charAmount * 0.88);
        /*
         * How hard it is glowing through its own cracks.
         *
         * The emissive colour is white and the map carries the orange, so this
         * is one number rather than three — and because the map is black
         * across most of the log, turning it up lights the seams rather than
         * washing the whole piece red, which is what the old
         * `setRGB(ignition * 0.25, ...)` did. Charring feeds into it as well
         * as ignition: a piece that has been burning a while glows in its
         * splits even between flames, which is the difference between a log on
         * a fire and a log with a light shone on it.
         */
        material.emissiveIntensity = log.ignition * 1.35 + charAmount * log.ignition * 0.9;

        // Steam off whatever is drying, so moisture is something you can see
        // rather than a number nobody is shown.
        if (log.steam > 0.06) {
          // Two wisps per piece, out of phase, so it reads as a plume coming
          // off the wood rather than as a single sprite blinking on and off.
          for (let w = 0; w < 2 && steamIndex < steamCount; w++) {
            const p = phases[steamIndex] ?? FALLBACK_PHASE;
            const life = (t * 0.42 * p.speed + p.offset) % 1;
            dummy.position.set(
              spot.x + Math.sin(t * 0.9 * motion + p.offset) * 0.035 * (0.4 + life) * motion,
              0.09 + life * 0.22,
              spot.z + Math.cos(t * 0.7 * motion + p.offset) * 0.035 * (0.4 + life) * motion,
            );
            dummy.quaternion.copy(state.camera.quaternion);
            dummy.scale.setScalar((0.6 + life * 0.9) * (0.45 + log.steam * 0.55));
            dummy.updateMatrix();
            steamRef.current?.setMatrixAt(steamIndex, dummy.matrix);
            /*
             * A floor under the wisp, warmth in it, and a lid on it up close.
             *
             * At `steam * 0.8` the whole plume sat under the 5-bit quantiser
             * against the dark ground and the frame that exists to show a
             * soaked log drying showed nothing above it. It starts pale and
             * catches a touch of firelight, which is what steam next to a fire
             * looks like.
             *
             * The warmth is not decoration. A neutral grey added over ground
             * this orange lands on a desaturated khaki, and at roasting range
             * a plume of it sat across the whole fire and took the fire's own
             * colour with it — the pale flat blades the near view kept being
             * judged on were this, not the flames. Tinted toward the firelight
             * it stays part of the fire, and `nearFade` keeps it from being
             * the biggest thing in the frame when the player's face is in it.
             */
            const nearFade = 1 - near * 0.55;
            const fade =
              Math.min(1, 0.3 + log.steam * 0.7) * Math.pow(1 - life, 0.75) * nearFade * brightness;
            color.setRGB(fade, fade * 0.82, fade * 0.63);
            steamRef.current?.setColorAt(steamIndex, color);
            steamIndex++;
          }
        }
      });
    }

    const steam = steamRef.current;
    if (steam) {
      // Park the unused wisps out of sight rather than leaving last frame's.
      for (let i = steamIndex; i < steamCount; i++) {
        dummy.position.set(0, -10, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        steam.setMatrixAt(i, dummy.matrix);
      }
      steam.instanceMatrix.needsUpdate = true;
      if (steam.instanceColor) steam.instanceColor.needsUpdate = true;
      steam.visible = steamIndex > 0;
    }
  });

  return (
    <group>
      {/*
        The stone ring: nine cobbles in one mesh.

        Welded rather than looped because nine separate meshes were eighteen
        draw calls once shadows are counted, spent at the spot in the scene
        where the budget already peaks — and the stones have never moved and
        never will.
      */}
      <mesh geometry={ringGeometry} material={stoneMaterial} castShadow receiveShadow />

      {/*
        The ash bed, and the two things a person does to one with their hands.

        You poke the coals by reaching into them, not by pressing a control
        labelled "rake" — and you bank the fire by sweeping the ash back over
        them, not by pressing one labelled "bank". Same hand, same tool, told
        apart by which way it moved: out to open the bed, in to bury it.
      */}
      <mesh
        ref={ashRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.005, 0]}
        receiveShadow
        onPointerDown={
          onWorkBed
            ? (event) => {
                // Out of reach this is a tap on a fire across the clearing,
                // which means "walk me over there" — so it has to be left
                // alone to bubble out to the movement layer.
                if (canTouch && !canTouch()) return;
                event.stopPropagation();
                sweep.current = {
                  radius: Math.hypot(event.point.x, event.point.z),
                  x: event.point.x,
                  z: event.point.z,
                };
                // Say the pit has the gesture, or a sweep across the coals
                // would turn the player's head at the same time.
                if (grabbedRef) grabbedRef.current = '__bed';
                try {
                  (event.target as Element | null)?.setPointerCapture(event.pointerId);
                } catch {
                  /* Older Safari. The sweep still works while over the bed. */
                }
              }
            : undefined
        }
        onPointerUp={
          onWorkBed
            ? (event) => {
                const started = sweep.current;
                sweep.current = null;
                if (grabbedRef) grabbedRef.current = null;
                try {
                  (event.target as Element | null)?.releasePointerCapture(event.pointerId);
                } catch {
                  /* Nothing to release. */
                }
                if (!started || (canTouch && !canTouch())) return;
                event.stopPropagation();
                const ended = Math.hypot(event.point.x, event.point.z);
                onWorkBed({ x: started.x, z: started.z, inward: started.radius - ended });
              }
            : undefined
        }
        onPointerOver={(event) => {
          if (!onWorkBed || (canTouch && !canTouch())) return;
          event.stopPropagation();
          if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
        }}
      >
        <circleGeometry args={[0.42, 12]} />
        {/* Tinted well down: raw ash albedo this close to the fire light
            blows out to white paper and swallows the coals. */}
        <meshStandardMaterial map={getTexture('ash', { size: 64 })} color={0x4a453e} roughness={1} />
      </mesh>

      {/*
        Fuel.

        Twelve slots, each parked on the spot the simulation gives it, and each
        one draggable. Dragging is the arranging verb in full: there is no lean
        control, no stack menu and no button — you pick a piece of wood up and
        you put it somewhere else, and where you put it decides whether it
        breathes, whether it lights, and whether it dries.
      */}
      <group ref={logsRef}>
        {Array.from({ length: LOG_SLOTS }, (_, i) => (
          <mesh
            key={i}
            geometry={logGeometry}
            material={logMaterials[i]}
            castShadow
            onPointerDown={
              onMoveLog
                ? (event) => {
                    const log = fire.logs[i];
                    if (!log || (canTouch && !canTouch())) return;
                    event.stopPropagation();
                    dragging.current = log.id;
                    if (grabbedRef) grabbedRef.current = log.id;
                    logTap.current = { x: event.point.x, z: event.point.z, moved: false };
                    // Without capture the drag dies the instant the pointer
                    // leaves a piece of wood five centimetres across, which on
                    // a phone is immediately.
                    try {
                      (event.target as Element | null)?.setPointerCapture(event.pointerId);
                    } catch {
                      /* Older Safari. The drag still works while over the log. */
                    }
                  }
                : undefined
            }
            onPointerMove={
              onMoveLog
                ? (event) => {
                    const log = fire.logs[i];
                    if (!log || dragging.current !== log.id) return;
                    // A pointer-up that landed somewhere this mesh never heard
                    // about would otherwise leave the wood stuck to the finger.
                    if (event.buttons === 0 && event.pointerType === 'mouse') {
                      dragging.current = null;
                      if (grabbedRef) grabbedRef.current = null;
                      return;
                    }
                    event.stopPropagation();
                    // The pit is the origin of the world and its floor is flat,
                    // so the drag target is wherever the ray crosses it.
                    const ray = event.ray;
                    if (Math.abs(ray.direction.y) < 1e-4) return;
                    const distance = (PIT_PLANE_Y - ray.origin.y) / ray.direction.y;
                    if (distance <= 0) return;
                    const x = ray.origin.x + ray.direction.x * distance;
                    const z = ray.origin.z + ray.direction.z * distance;
                    const r = Math.hypot(x, z);
                    const tap = logTap.current;
                    if (tap && Math.hypot(x - tap.x, z - tap.z) > 0.04) tap.moved = true;
                    // Let go of it outside the ring and it stays on the stones:
                    // the pit has no opinion about wood beyond them.
                    const scale = r > PIT.ringRadius ? PIT.ringRadius / r : 1;
                    onMoveLog(log.id, x * scale, z * scale);
                  }
                : undefined
            }
            onPointerUp={(event) => {
              if (dragging.current === null) return;
              dragging.current = null;
              if (grabbedRef) grabbedRef.current = null;
              /*
               * Touched and let go without moving: that is a poke, not a
               * move. Reaching into the pit and finding a log under your
               * finger opens the bed the same as reaching into the ash —
               * the wood is what is standing on the coals, after all.
               */
              const tap = logTap.current;
              logTap.current = null;
              if (tap && !tap.moved && onWorkBed && !(canTouch && !canTouch())) {
                onWorkBed({ x: tap.x, z: tap.z, inward: 0 });
              }
              try {
                (event.target as Element | null)?.releasePointerCapture(event.pointerId);
              } catch {
                /* Nothing to release. */
              }
            }}
            onPointerOver={(event) => {
              if (!onMoveLog || !fire.logs[i] || (canTouch && !canTouch())) return;
              event.stopPropagation();
              if (typeof document !== 'undefined') document.body.style.cursor = 'grab';
            }}
            onPointerOut={() => {
              if (typeof document !== 'undefined') document.body.style.cursor = 'auto';
            }}
          />
        ))}
      </group>

      <instancedMesh ref={steamRef} args={[steamGeometry, steamMaterial, steamCount]} />

      <instancedMesh ref={embersRef} args={[emberGeometry, emberMaterial, emberCount]} />
      <instancedMesh ref={flamesRef} args={[flameGeometry, flameMaterial, flameCount]} />
      <points ref={sparksRef} geometry={sparkGeometry} material={sparkMaterial} />

      {/*
        The fire's two lights, and why neither has a tight `distance` any more.
        
        Three.js's `distance` is not a soft horizon: it multiplies the falloff
        by a window that reaches exactly zero at that radius, and the window's
        slope is discontinuous there. On flat ground that draws a hard-edged
        ellipse you can trace with a finger — an art review called the ember
        frame "the single most damning image here" and described precisely
        that: a clean-edged orange ellipse sitting *on* the dirt rather than
        light falling *across* it. The radius of the ellipse was 5 metres,
        which is the number that used to be on the line below.
        
        So the cut-off is pushed out past anything the player can see standing
        at the pit, and `decay` — a real inverse-square for the embers — does
        the falloff instead. The intensities in the frame loop are unchanged:
        at the distances that matter the window was already near 1, so what
        this removes is the edge and not the light.
        
        The key light casts, which is the other half of the same note. A fire
        is the only light in this scene at night, and the reason the clearing
        read as flat is that nothing in it had a shadow — the log a metre from
        the pit should throw one straight away from the flame, across the dirt,
        moving as the fire breathes. That is the cheapest atmosphere available
        here and the scene was not spending it.
      */}
      <pointLight
        ref={lightRef}
        position={[0, 0.35, 0]}
        distance={70}
        decay={1.35}
        castShadow={shadows}
        shadow-mapSize-width={512}
        shadow-mapSize-height={512}
        shadow-camera-near={0.12}
        // Short, because a point light's shadow camera is six faces and the
        // precision is spent on whatever this range covers. Everything worth
        // shadowing here is inside the fire ring's own few metres.
        shadow-camera-far={9}
        shadow-bias={-0.004}
        shadow-normalBias={0.02}
      />
      <pointLight ref={emberLightRef} position={[0, 0.06, 0]} distance={26} decay={2} />
    </group>
  );
}
