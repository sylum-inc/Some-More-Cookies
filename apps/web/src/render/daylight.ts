/**
 * What the sky looks like at a given sun altitude.
 *
 * The simulation has had a real sun since the astronomy module was written —
 * `sunState` returns its altitude, its azimuth and a 0..1 daylight term, and
 * `stargazing` advances the sky six hours over a session, so the sun genuinely
 * crosses the horizon around minute fifty-seven. None of it ever reached the
 * screen. `Campsite` called `curatedSky()` once, inside a `useMemo` with an
 * empty dependency array, and painted a fixed night: the dusk screenshot and
 * the dawn screenshot have the same stars in the same places, and the only
 * thing that changed across six simulated hours was the fire burning down.
 *
 * So this is the ramp that was missing. It takes the one number that actually
 * says what time it is — how high the sun is — and returns everything the
 * scene needs to look like that hour.
 *
 * **Derived rather than authored, on purpose.** Twelve environments each state
 * a night sky and a night fog in their manifest, and those are what make a
 * pine hollow look like a pine hollow rather than a mesa. Daylight is much
 * less local than that: the sky over a forest at noon and the sky over a salt
 * flat at noon are close to the same blue, and what distinguishes them in
 * daylight is the ground and the haze, not the dome. So the manifest's colours
 * anchor the night end of this ramp and the daylight end is shared. That also
 * means no environment has to be re-authored for the sun to come up in it.
 *
 * The stops below are in degrees of sun altitude because that is the unit the
 * thresholds are actually named in: civil twilight is −6°, nautical is −12°,
 * astronomical is −18°, and the low warm sun the spec calls "the campsite's
 * best-looking hour" is roughly 0° to +8°.
 */

export interface SkyLook {
  /** Scene background, as a hex int. The colour overhead. */
  readonly sky: number;
  /**
   * The colour at the horizon, which is a different colour from the zenith at
   * every hour that is worth looking at.
   *
   * A single flat background is why an art review found midday and dusk
   * indistinguishable: a sunset is not an orange *sky*, it is an orange band
   * under an indigo one, and with one colour for the whole dome there is
   * nowhere for that band to be. The dome mesh interpolates between this and
   * `sky`; the scene background stays `sky` so anything the dome does not
   * cover still agrees with it.
   */
  readonly horizon: number;
  /** Fog colour. Tracks the sky, or the horizon reads as a seam. */
  readonly fog: number;
  /** Ambient fill colour and how much of it. */
  readonly ambient: number;
  readonly ambientIntensity: number;
  /** The sun's own light. Zero while it is down. */
  readonly sunColor: number;
  readonly sunIntensity: number;
  /**
   * How much of the key light is the sun rather than the moon, 0..1.
   *
   * A crossfade rather than a switch: at civil twilight both are up and
   * neither is doing much, and cutting from one to the other at a threshold is
   * exactly the kind of pop that makes a sky look like a slideshow.
   */
  readonly sunShare: number;
  /** How bright the sun's disc is drawn, 0..1. */
  readonly sunDisc: number;
  /** And the moon's, which is washed out long before the sun is properly up. */
  readonly moonDisc: number;
  /**
   * How far to lift ground albedo toward white, 0..1.
   *
   * Every surface in this game was authored to be hit by a campfire from two
   * metres away. The forest floor is the extreme case: a dark dirt texture
   * over a dark brown, which reads as warm ground at night and as a hole in
   * the world at noon — measured at 38/255 under a full sun, against a sky at
   * 170. No amount of extra sunlight fixes that without blowing out everything
   * that already reads correctly, because the problem is the albedo and not
   * the lighting.
   *
   * So the palette moves with the hour, which is also how the machines this
   * game is pretending to be actually did day and night. Zero at night, so the
   * campsite people have already seen is untouched.
   */
  readonly surfaceLift: number;
}

interface Stop {
  /** Sun altitude in degrees. */
  readonly at: number;
  readonly sky: number;
  readonly horizon: number;
  readonly fog: number;
  readonly ambient: number;
  readonly ambientIntensity: number;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly sunShare: number;
  readonly sunDisc: number;
  readonly surfaceLift: number;
}

/**
 * Night, below astronomical twilight. `sky` and `fog` here are placeholders:
 * the caller's manifest colours are substituted for them, so each campsite
 * keeps its own dark.
 */
const NIGHT: Stop = {
  at: -18,
  sky: 0x070a0f,
  horizon: 0x0c1119,
  fog: 0x0b1016,
  ambient: 0x33445f,
  ambientIntensity: 1,
  sunColor: 0x000000,
  sunIntensity: 0,
  sunShare: 0,
  sunDisc: 0,
  surfaceLift: 0,
};

/**
 * The ramp, darkest first.
 *
 * The sun's intensities are in a different league from the moon's on purpose.
 * The first version of this table peaked at 2.9 against a moon that peaks near
 * 3, which is not a sun — the scene is tone-mapped, so the response to light is
 * compressed, and a noon that is numerically the same as a full moon renders
 * as a slightly brighter night. Measured on the forest floor: 66/255 at the
 * old peak, 107 at four times the light.
 *
 * Twilight is deliberately dark. The first version of this table put the sun
 * on the horizon against a sky at #6a6076, which measured as an overcast
 * afternoon rather than as dusk: the campsite's arrival shot stopped being
 * firelight against dark and became a fire competing with the sky, which is
 * the one thing this product's look cannot afford. A forest floor at civil
 * twilight is much darker than the open sky above it.
 *
 * The top is deliberately not a saturated postcard blue either. Ordered dithering at
 * 320×240 turns a flat, saturated field into visible banding, and the whole
 * render pipeline is built to flatter darkness — so daylight is desaturated
 * and slightly grey, which is both kinder to the dither and closer to what a
 * sky actually looks like through a canopy.
 */
const STOPS: readonly Stop[] = [
  NIGHT,
  {
    // Nautical twilight: the first hint that the east is not as black as the west.
    at: -12,
    sky: 0x0d1420,
    // The east is not as black as the west, and this is where that shows.
    horizon: 0x18202e,
    fog: 0x111a26,
    ambient: 0x3a4a66,
    ambientIntensity: 1.05,
    sunColor: 0x2a2438,
    sunIntensity: 0,
    sunShare: 0,
    sunDisc: 0,
    surfaceLift: 0,
  },
  {
    // Civil twilight. Blue hour proper — the sky is bright and the ground is not.
    at: -6,
    sky: 0x18243c,
    // Blue hour: the band above the trees is the brightest thing in the sky.
    horizon: 0x36405e,
    fog: 0x1f2a42,
    ambient: 0x4a5c80,
    ambientIntensity: 1.25,
    sunColor: 0x6b4a52,
    sunIntensity: 0.35,
    sunShare: 0.2,
    sunDisc: 0,
    surfaceLift: 0.06,
  },
  {
    // The sun is on the horizon. Warmest light of the whole cycle.
    at: 0,
    sky: 0x3a3850,
    /*
     * Sunrise and sunset, and the one saturated colour in the whole ramp.
     *
     * Everything else here is deliberately desaturated, because ordered
     * dithering at 320x240 bands a flat saturated field. A horizon is the
     * exception and has to be: it is a narrow strip with a hard gradient
     * across it, which is the one shape dithering flatters rather than
     * ruins, and without it there is no dusk in the build at all.
     */
    horizon: 0xd4703a,
    fog: 0x453f4a,
    ambient: 0x525068,
    ambientIntensity: 1.32,
    sunColor: 0xff8a42,
    sunIntensity: 2.2,
    sunShare: 0.75,
    sunDisc: 0.55,
    surfaceLift: 0.07,
  },
  {
    // Golden. Long shadows, orange on the trunks.
    at: 6,
    sky: 0x6b7590,
    // Golden hour: still warm at the bottom, cooling fast overhead.
    horizon: 0xc99a6e,
    fog: 0x7d7a78,
    ambient: 0x74809c,
    ambientIntensity: 1.6,
    sunColor: 0xffb066,
    sunIntensity: 5,
    sunShare: 1,
    sunDisc: 0.85,
    surfaceLift: 0.3,
  },
  {
    // Morning. The colour has come out of the light and gone into the sky.
    at: 18,
    sky: 0x8ba2c0,
    horizon: 0xbcc6cf,
    fog: 0xb2bfcc,
    ambient: 0x9fb2cc,
    ambientIntensity: 2.1,
    sunColor: 0xffeccc,
    sunIntensity: 8,
    sunShare: 1,
    sunDisc: 1,
    surfaceLift: 0.58,
  },
  {
    // Full day.
    at: 45,
    sky: 0x92a9cd,
    // Noon: pale and hazy at the bottom, which is what distance does.
    horizon: 0xcdd6de,
    fog: 0xc2ceda,
    ambient: 0xa8bcd6,
    ambientIntensity: 2.4,
    sunColor: 0xfff6ea,
    sunIntensity: 9.5,
    sunShare: 1,
    sunDisc: 1,
    surfaceLift: 0.64,
  },
];

/**
 * The scene's whole look for one sun altitude.
 *
 * `night` carries the campsite's own manifest colours, which stand in for the
 * bottom of the ramp so a mesa's night and a pine hollow's night stay
 * different from each other while their noons agree.
 *
 * `cloudCover` greys the lot: it pulls the sky and the fog toward each other
 * and takes the edge off the sun, which is what overcast does. It is applied
 * here rather than by the caller so that "what does it look like right now" has
 * exactly one answer.
 */
export function skyLook(
  sunAltitudeDeg: number,
  night: { readonly sky: number; readonly fog: number },
  cloudCover = 0,
): SkyLook {
  /*
   * The manifest's night fog stands in as the night HORIZON as well.
   *
   * Because the two are the same thing. The band just above the treeline at
   * night is the haze, and now that distance fog resolves to the horizon (see
   * below), a campsite that authored its own fog would otherwise have it
   * quietly replaced by a shared constant at the one hour it matters most —
   * which is the whole reason twelve environments state a night fog at all.
   * With this substitution the far treeline at midnight resolves to exactly
   * the colour the pine hollow asked for, and the mesa's to the mesa's.
   */
  const stops = STOPS.map((stop) =>
    stop === NIGHT ? { ...stop, sky: night.sky, horizon: night.fog, fog: night.fog } : stop,
  );
  const altitude = Number.isFinite(sunAltitudeDeg) ? sunAltitudeDeg : -90;
  const blended = sample(stops, altitude);
  const cloud = clamp01(cloudCover);

  // Overcast: sky and fog converge, and the sun stops being a disc long before
  // it stops being a light.
  const flat = mix(blended.sky, blended.fog, cloud * 0.55);
  /*
   * Distance fog resolves to the HORIZON, not to a colour of its own.
   *
   * This is the one that was inverting aerial perspective at every hour. The
   * ramp carried a `fog` colour authored independently of the sky, so a tree
   * at forty metres was blended toward a warm grey that had nothing to do with
   * what was actually behind it — and measured on a clear night, the far
   * treeline came out at luminance 32 against a sky at 9. Three and a half
   * times *brighter* than the thing behind it, with a warm cast, at night,
   * from no light source.
   *
   * That is not a stylistic error, it is backwards physics. Distance-fogged
   * geometry converges toward the sky it is seen against; it cannot overshoot
   * past that value, because what fog is made of is the sky in front of the
   * object. So the fog colour is the horizon colour, mixed only slightly
   * toward the manifest's own authored fog so a canyon still gets a canyon's
   * haze. At dusk the far trees now resolve to the ember band and read as
   * near-black cutouts against the brighter sky above them; at noon they
   * resolve to the pale blue and sit behind it rather than in front.
   *
   * One line, six frames.
   */
  const horizon = mix(blended.horizon, flat, cloud * 0.82);
  return {
    sky: flat,
    // Cloud kills a sunset before it kills anything else: an overcast horizon
    // is the same grey as the zenith, which is exactly why overcast days have
    // no dusk to speak of.
    horizon,
    // The sky it is actually seen against, with a quarter of the campsite's
    // own authored haze still in it. See the note above. At night the two are
    // the same colour by construction, so a campsite keeps its own dark
    // exactly.
    fog: mix(horizon, blended.fog, 0.25),
    ambient: blended.ambient,
    // A grey lid is a huge diffuse source: less direct light, slightly more fill.
    ambientIntensity: blended.ambientIntensity * (1 + cloud * 0.18),
    sunColor: mix(blended.sunColor, 0xd8dee6, cloud * 0.7),
    sunIntensity: blended.sunIntensity * (1 - cloud * 0.72),
    sunShare: blended.sunShare,
    sunDisc: blended.sunDisc * (1 - cloud * 0.95),
    // The moon goes as the sky comes up, and behind cloud.
    moonDisc: clamp01(1 - blended.sunShare * 1.4) * (1 - cloud * 0.85),
    // Overcast lifts it further rather than less: a grey lid is a big soft
    // source and the ground under it is lighter than the ground under a low
    // sun, not darker.
    surfaceLift: clamp01(blended.surfaceLift * (1 + cloud * 0.15)),
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear interpolation between the two stops bracketing this altitude. */
function sample(stops: readonly Stop[], altitude: number): Stop {
  const first = stops[0]!;
  if (altitude <= first.at) return first;
  const last = stops[stops.length - 1]!;
  if (altitude >= last.at) return last;

  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]!;
    if (altitude > b.at) continue;
    const a = stops[i - 1]!;
    const t = (altitude - a.at) / (b.at - a.at);
    return {
      at: altitude,
      sky: mix(a.sky, b.sky, t),
      horizon: mix(a.horizon, b.horizon, t),
      fog: mix(a.fog, b.fog, t),
      ambient: mix(a.ambient, b.ambient, t),
      ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, t),
      sunColor: mix(a.sunColor, b.sunColor, t),
      sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
      sunShare: lerp(a.sunShare, b.sunShare, t),
      sunDisc: lerp(a.sunDisc, b.sunDisc, t),
      surfaceLift: lerp(a.surfaceLift, b.surfaceLift, t),
    };
  }
  return last;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Channel-wise blend of two packed hex colours. */
export function mix(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
  const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
  const bl = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Perceived brightness of a packed colour, 0..1. Used by tests and by tuning. */
export function luminance(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
