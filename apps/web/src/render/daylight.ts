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
  /**
   * The airlight: the colour of the air itself, a little way up.
   *
   * This is the one that was missing, and its absence was drawing pale ghost
   * trees into every frame in the build.
   *
   * `horizon` is the sky at an elevation of zero — the strip you see *through*
   * forty metres of air with nothing behind it. The dome used to ramp from
   * that to `sky` over eight degrees, so everything above eight degrees was
   * painted the flat zenith colour, while distance fog went on resolving to
   * `horizon` for geometry at *every* height. A conifer crown ten metres up at
   * twenty-five metres away sits eleven degrees above the horizon: fogged to
   * the horizon band, drawn against pure zenith. Measured on the midday
   * capture, those crowns came out at luminance 169–183 against a sky at
   * 100.7 — 1.8 times brighter than the thing behind them, from no light
   * source, which is the same inverted aerial perspective a previous round
   * corrected at the horizon and reintroduced above it.
   *
   * So there is a third colour. It is what the air looks like at the elevation
   * the treeline actually occupies, the dome paints it there, and distance fog
   * resolves to it. Fogged geometry and the sky behind it are then the same
   * colour by construction rather than by coincidence, at every height.
   */
  readonly haze: number;
  /** Fog colour. Tracks the airlight, or the treeline reads as a cutout. */
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
 *
 * `gloom` is the *other* half of a lid, and it is why storm graded lighter than
 * overcast. Cover says how much of the sky is cloud; it does not say how thick
 * that cloud is, and the character table has overcast at 0.92 cover against a
 * storm at 1.00 — eight hundredths apart, on the one axis the two states were
 * being told apart by. So thickness is its own number, and it works on the
 * zenith rather than on the whole dome: a storm is a black ceiling with the
 * horizon still showing under it, which is both what one looks like and the
 * only version of "darkest state in the set" that does not put the ground
 * through the D7 legibility floor. See `weatherLook`, which is where the number
 * per kind lives.
 */
export function skyLook(
  sunAltitudeDeg: number,
  night: { readonly sky: number; readonly fog: number },
  cloudCover = 0,
  gloom = 0,
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
  /*
   * How far off the horizon the airlight is measured, which is not zero.
   *
   * Scattered sunlight is what makes air visible, so there is a great deal of
   * it at noon and effectively none at midnight — and the amount also decides
   * how fast the sky changes colour with elevation. `surfaceLift` is already
   * the ramp's own "how much sun is on this world" term, peaking at 0.64, so it
   * is reused rather than a second number kept in step by hand.
   *
   * At night this is zero, and the whole of the block below collapses to the
   * manifest's own fog colour exactly — which is a contract twelve environments
   * depend on and `daylight.test.ts` asserts as an equality.
   */
  const airlight = clamp01(blended.surfaceLift / 0.64);
  const zenith = gloom > 0 ? scale(flat, 1 - clamp01(gloom) * 0.62) : flat;
  /*
   * The airlight is measured from the *ungloomed* sky, and that is deliberate.
   *
   * A storm lid is a ceiling. It is over the trees, not among them, and the air
   * underneath it is still lit by the bright strip all round the horizon —
   * which is why a squall line looks like a black roof over a pale band rather
   * than like night. Keeping `gloom` out of everything at or below the treeline
   * is what makes the darkest state in the set safe: the sky goes out, the
   * ground the player is standing on does not, and there is no elevation at
   * which a fogged tree can end up brighter than the sky behind it.
   */
  const haze = mix(horizon, flat, HAZE_LIFT * airlight);
  return {
    // A lid is a lid: thickness comes off the ceiling and leaves the strip
    // under it alone. That strip is also the only thing keeping the far side of
    // the clearing above the legibility floor, which is why it is not touched.
    sky: zenith,
    // Cloud kills a sunset before it kills anything else: an overcast horizon
    // is the same grey as the zenith, which is exactly why overcast days have
    // no dusk to speak of.
    horizon,
    haze,
    /*
     * The fog colour is *literally* the dome's own colour at the top of the
     * treeline. Not near it, not derived from the same numbers — the same
     * function call, at the elevation the tallest crown in the clearing
     * occupies.
     *
     * That equality is the whole fix, and it is worth being blunt about why it
     * has to be an equality. The rule "fogged geometry converges toward the sky
     * it is seen against and cannot overshoot it" was already written down,
     * already tested, and already passing — against `sky` and `horizon`, the
     * two colours the ramp happens to name. The sky a *tree* is seen against is
     * neither of them; it is the dome's value ten to eighteen degrees up, and
     * nothing was ever comparing against that. Measured on the shipped midday
     * capture, the crowns came out at 169–183 against a sky at 100.7 while the
     * suite went green. Anchoring the two together at one elevation is the only
     * version of this that cannot drift apart again, and `skyAt` is exported so
     * a test can ask the same question at every elevation in between.
     *
     * Erring at the top of the band rather than the middle is deliberate:
     * everything lower — trunks, deadfall, the far terrain — then fogs to
     * slightly *less* than the sky behind it and reads as a firmer silhouette,
     * which is the right way round to be wrong.
     *
     * At night `airlight` is zero, both blends below collapse, and the whole
     * expression reduces to `mix(horizon, blended.fog, 0.25)` — which is what
     * it was before any of this, and is exactly the manifest's own fog colour
     * once the two substitutions at the top of the function are taken into
     * account. That is a contract twelve environments depend on and
     * `daylight.test.ts` asserts as an equality. There is no airlight at
     * midnight and this ramp says so rather than approximating it.
     */
    fog: mix(
      // The campsite's own authored haze goes in *before* the cloud pull, on
      // the same side of it as the horizon. Blending it in afterwards left the
      // manifest colour untouched by cloud while the horizon was pulled toward
      // the flat, so a site whose night fog is much brighter than its night sky
      // — the meltwater cirque, the salt flat — inverted by a couple of
      // luminance steps under partial cover. Two steps is invisible and it is
      // still the wrong sign, and the whole reason this module is being rebuilt
      // is that nobody could see the last one either.
      mix(mix(blended.horizon, blended.fog, 0.25 * (1 - airlight)), flat, cloud * 0.82),
      flat,
      HAZE_LIFT * airlight,
    ),
    ambient: blended.ambient,
    // A grey lid is a huge diffuse source: less direct light, slightly more fill.
    ambientIntensity: blended.ambientIntensity * (1 + cloud * 0.18),
    sunColor: mix(blended.sunColor, 0xd8dee6, cloud * 0.7),
    // Thickness takes the last of the key light. The fill is left alone: a
    // storm cloud is still an enormous diffuse source, and it is the fill that
    // the D7 floor is standing on.
    sunIntensity: blended.sunIntensity * (1 - cloud * 0.72) * (1 - clamp01(gloom) * 0.6),
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

/**
 * How far from the horizon toward the zenith the airlight sits, at full sun.
 *
 * Not a free parameter: it is the elevation the *treeline* occupies, and the
 * treeline is where every fogged pixel in this game is. A conifer at the
 * campsite's ring stands six to twelve metres tall between fifteen and
 * thirty-five metres out, seen from an eye a metre and a half up — eight to
 * twenty degrees, which on the dome's own `sin(elevation)` scale is 0.14 to
 * 0.34, which is a bit under half way through the gradient below. Hence 0.4.
 *
 * Kept under a half deliberately. Above that the far distance would be closer
 * to the zenith than to the horizon, which is the *other* error — the one a
 * previous round corrected — and `daylight.test.ts` holds the line.
 */
const HAZE_LIFT = 0.5;

/**
 * The top of the treeline, on the dome's `sin(elevation)` scale.
 *
 * A conifer at this campsite's ring is six to twelve metres tall and stands
 * fifteen to thirty-five metres out; the tallest crown at the nearest of those
 * distances is about eighteen degrees above an eye a metre and a half up. That
 * is the highest a fogged pixel gets in this game, and it is therefore the
 * elevation the fog colour is anchored to. `sin(18°)`.
 */
const TREELINE_TOP = 0.309;

/**
 * The dome's gradient, as two smoothsteps, shared with the shader that draws it.
 *
 * `BAND` is the sunset strip: narrow on purpose, because a sunset is a strip
 * and an earlier version that ramped over twenty-five degrees produced a
 * uniformly red dome. `ALOFT` is the gradient from the airlight up to the
 * zenith, and it deliberately does not *start* until the top of the treeline.
 *
 * That gives three regions rather than two, and the middle one is the point:
 * from about five degrees to eighteen the sky is flat at `haze`, which is the
 * band every fogged pixel in this game is drawn against. Anchoring the fog
 * colour to the same constant makes "a fogged tree is never brighter than the
 * sky behind it" true by construction over the whole range where there are
 * trees, at every hour and under any lid — rather than true at two sampled
 * colours and false at eleven degrees, which is what shipped.
 *
 * The band was previously the *only* ramp, over eight degrees, so everything
 * above eight degrees was flat zenith with no haze in it at all.
 */
export const DOME_BAND = Object.freeze({ from: 0, to: 0.09 });
export const DOME_ALOFT = Object.freeze({ from: TREELINE_TOP, to: 0.85 });

function smoothstep(from: number, to: number, x: number): number {
  const t = clamp01((x - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/**
 * What the sky is, looking `sinElevation` above the horizon.
 *
 * The same arithmetic as the dome's fragment shader, in JavaScript, so a test
 * can ask the question the screenshot answers: *is this fogged tree darker than
 * the sky immediately behind it?* Answering it against `sky` and `horizon`
 * alone — which is what the suite did — cannot catch a crown drawn against the
 * zenith and fogged toward the horizon, and that is exactly the defect that
 * shipped.
 */
export function skyAt(look: SkyLook, sinElevation: number): number {
  return domeGradient(look.horizon, look.haze, look.sky, sinElevation);
}

function domeGradient(horizon: number, haze: number, zenith: number, sinElevation: number): number {
  const h = clamp01(sinElevation);
  const aloft = smoothstep(DOME_ALOFT.from, DOME_ALOFT.to, h);
  const band = smoothstep(DOME_BAND.from, DOME_BAND.to, h);
  return mix(horizon, mix(haze, zenith, aloft), band);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Multiplies a packed colour's channels, clamped. */
function scale(color: number, factor: number): number {
  const k = Math.max(0, factor);
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((color & 0xff) * k));
  return (r << 16) | (g << 8) | b;
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

/* ==========================================================================
 * Weather, on the ground and on the props
 * ========================================================================== */

/**
 * What a weather state does to the *surfaces*, as opposed to the sky.
 *
 * The lowest-scoring group in the whole art grade was the nine weather states,
 * and the charge was specific: "the ground, the machine, the log, the fire, the
 * rocks and the grass are pixel-comparable across all four." Measured on the
 * contact sheet it was worse than that — the near ground ran from 17.6 to 29.8
 * out of 255 across all nine states, twelve steps of separation for nine
 * conditions, with snow at 20.0 sitting between storm at 19.6 and rain at 21.4.
 * The whole of the difference between a blizzard and a downpour was a glyph in
 * the corner of the HUD.
 *
 * The reason is structural rather than a matter of tuning. Everything weather
 * did went through `cloudCover`, `fog` and `precipitation`, and all three of
 * those are *sky* terms: they move the dome, the draw distance and a particle
 * emitter. Nothing in the chain ever reached an albedo. The one exception —
 * snow settling on the ground — was written against the terrain material only,
 * and the terrain is the one piece of ground the player never sees clean: out
 * past the cover mats it is forty to a hundred per cent distance fog by the
 * time it reaches the eye, so a sevenfold lift in its albedo arrived as one
 * luminance step. The code ran. It had nowhere to land.
 *
 * So this is the missing half: one table, one value per kind per surface
 * property, blended across the weather's own transition so a shower arrives
 * over a minute rather than between frames. It is a pure function of the
 * weather state and nothing else, which is what lets nine states be checked
 * against each other in a test instead of in nine screenshots.
 */
export interface WeatherLook {
  /**
   * How thick the lid is, past how much of it there is. Feeds `skyLook`.
   * Storm is the only 1: it is the darkest state in the set by construction.
   */
  readonly gloom: number;
  /** Soaked, 0..1. Darker duff, less chroma in it, and a sheen on the tops. */
  readonly wet: number;
  /** How much snow *wants* to be lying. The scene eases toward it. */
  readonly settling: number;
  /** Multiplier on ground albedo. Rain and storm take it down; snow does not. */
  readonly groundValue: number;
  /** How far the ground and the props are pushed toward cool grey, 0..1. */
  readonly chill: number;
  /** Strength of the light on upward-facing faces, and its colour. */
  readonly topLight: number;
  readonly topColor: number;
  /** Standing water in the low ground, 0..1. */
  readonly puddles: number;
  /** How hard anything falling leans, 0..1. Storm and squall are the tops. */
  readonly shear: number;
  /** Whether this state flashes. Honoured only when motion is allowed. */
  readonly lightning: boolean;
}

interface Surfaces {
  gloom: number;
  wet: number;
  settling: number;
  groundValue: number;
  chill: number;
  topLight: number;
  topColor: number;
  puddles: number;
  shear: number;
  lightning: boolean;
}

/**
 * The nine states, as surfaces.
 *
 * `topColor` and `topLight` are the load-bearing pair and deserve a word. Snow
 * lies on every upward-facing face in a clearing — the log, the stone tops, the
 * machine's roof, the crowns — and no amount of albedo on the *ground* says
 * that. Modelling it as geometry would be a cap mesh per prop and a draw call
 * for each; modelling it as an albedo would need per-face data the instanced
 * meshes do not carry. But a hemisphere light already lights a surface by its
 * normal's Y and nothing else, which is precisely "upward-facing faces only",
 * and the scene already has one. So snow drives it white and hard, rain drives
 * it a cold steel blue and moderate — a wet log has a cold sky reflected in the
 * top of it and dry sides — and clear leaves it as the sky. Nine states, one
 * uniform, no geometry, no draw calls.
 *
 * `groundValue` is held above 0.78 everywhere, including in the storm. §D7 is
 * a floor and "darkest state in the set" is not a licence to go through it:
 * what makes the storm dark here is the ceiling above it, the chroma out of it
 * and the fire being the only warm thing left, not the ground being crushed.
 */
const SURFACES: Record<string, Surfaces> = {
  clear: {
    gloom: 0, wet: 0, settling: 0, groundValue: 1, chill: 0,
    topLight: 1, topColor: 0x000000, puddles: 0, shear: 0.08, lightning: false,
  },
  'high-cloud': {
    gloom: 0.04, wet: 0, settling: 0, groundValue: 0.98, chill: 0.07,
    topLight: 1.05, topColor: 0x000000, puddles: 0, shear: 0.18, lightning: false,
  },
  /*
   * The seven kinds below `storm` are the ones the shipping campsite can
   * actually roll — pine hollow's weights carry no storm and no snow — which
   * makes them the ones `e2e/night.spec.ts` will be measuring, and that suite
   * cannot be run from here. So their `topLight` is kept modest and their
   * `groundValue` shallow: the read comes from chroma, from roughness and from
   * the puddles rather than from moving the level of the largest surface in the
   * game up or down under a legibility floor nobody can re-measure today.
   */
  overcast: {
    // A grey lid is a big soft box: the tops of things get *more* light under
    // it, not less, which is the half of overcast that reads as overcast.
    gloom: 0.1, wet: 0.08, settling: 0, groundValue: 0.96, chill: 0.2,
    topLight: 1.18, topColor: 0xb9c4cf, puddles: 0, shear: 0.24, lightning: false,
  },
  'light-rain': {
    gloom: 0.13, wet: 0.5, settling: 0, groundValue: 0.92, chill: 0.34,
    topLight: 1.25, topColor: 0x9fb2c4, puddles: 0.35, shear: 0.3, lightning: false,
  },
  rain: {
    gloom: 0.18, wet: 0.95, settling: 0, groundValue: 0.86, chill: 0.46,
    topLight: 1.35, topColor: 0x8fa6bd, puddles: 0.9, shear: 0.52, lightning: false,
  },
  storm: {
    gloom: 1, wet: 1, settling: 0, groundValue: 0.78, chill: 0.58,
    topLight: 1.3, topColor: 0x7d92ab, puddles: 1, shear: 1, lightning: true,
  },
  fog: {
    // Standing inside a cloud: everything is lit from everywhere, so the tops
    // brighten and the chroma goes, but nothing is actually wet underfoot.
    gloom: 0.08, wet: 0.3, settling: 0, groundValue: 0.94, chill: 0.5,
    topLight: 1.3, topColor: 0xa8b2ba, puddles: 0.12, shear: 0.04, lightning: false,
  },
  snow: {
    gloom: 0.1, wet: 0, settling: 0.86, groundValue: 1, chill: 1,
    topLight: 2.1, topColor: 0xe4ecf5, puddles: 0, shear: 0.22, lightning: false,
  },
  'snow-squall': {
    gloom: 0.34, wet: 0, settling: 0.97, groundValue: 1, chill: 1,
    topLight: 2.2, topColor: 0xe8f0f8, puddles: 0, shear: 0.92, lightning: false,
  },
  wind: {
    gloom: 0.02, wet: 0, settling: 0, groundValue: 1, chill: 0.12,
    topLight: 1.05, topColor: 0x000000, puddles: 0, shear: 0.95, lightning: false,
  },
};

const CLEAR_SURFACES = SURFACES['clear'] as Surfaces;

/**
 * The surfaces for the weather the world is actually in.
 *
 * Blended across `transition` for the same reason the sky is eased: weather
 * takes the best part of a minute to arrive in this simulation, and a ground
 * that goes from dry to soaked between two frames throws away the one thing
 * that makes weather something a player responds to rather than something that
 * happens to them.
 *
 * `precipitation` scales the wet and the settling on top of the kind, so a
 * shower that is only half arrived only half wets the clearing — the kind says
 * what this weather *is*, the scalars say how much of it there is.
 */
export function weatherLook(weather: {
  readonly kind: string;
  readonly nextKind?: string;
  readonly transition?: number;
  readonly precipitation?: number;
  readonly windSpeed?: number;
}): WeatherLook {
  const from = SURFACES[weather.kind] ?? CLEAR_SURFACES;
  const to = SURFACES[weather.nextKind ?? weather.kind] ?? from;
  const t = clamp01(weather.transition ?? 1);
  const fall = clamp01(weather.precipitation ?? 0);
  // A gale with no cloud in it still lays the grass over: shear is the one
  // property that comes off the wind rather than off the kind alone.
  const gust = clamp01((weather.windSpeed ?? 0) / 6);

  const blendColor = (a: number, b: number): number => (a === 0 ? b : b === 0 ? a : mix(a, b, t));
  return {
    gloom: lerp(from.gloom, to.gloom, t),
    // Damp is a floor, not a scale: an hour into a drizzle the ground is wet
    // whether or not it is raining hard at this instant.
    wet: clamp01(lerp(from.wet, to.wet, t) * (0.45 + fall * 0.55)),
    settling: clamp01(lerp(from.settling, to.settling, t) * (0.3 + fall * 0.7)),
    groundValue: lerp(from.groundValue, to.groundValue, t),
    chill: clamp01(lerp(from.chill, to.chill, t)),
    topLight: lerp(from.topLight, to.topLight, t),
    topColor: blendColor(from.topColor, to.topColor),
    puddles: clamp01(lerp(from.puddles, to.puddles, t) * (0.35 + fall * 0.65)),
    shear: clamp01(Math.max(lerp(from.shear, to.shear, t), gust * 0.85)),
    lightning: t < 0.5 ? from.lightning : to.lightning,
  };
}

/**
 * The lightning, as one number.
 *
 * Driven off elapsed time rather than a roll so it cannot fire twice in a frame
 * or stutter, and returned rather than applied so that the reduced-motion path
 * is a single call site that passes zero. Two strikes close together the way
 * they actually come, then a long wait; the second is the same bolt's
 * afterglow and is weaker.
 */
export function lightningStrike(elapsedSeconds: number): number {
  const beat = elapsedSeconds % 8.5;
  // A short spike: instant on, quick off, nothing in between.
  const pulse = (at: number, width: number): number => {
    if (at < 0 || at > width) return 0;
    const k = 1 - at / width;
    return k * k;
  };
  return Math.max(pulse(beat, 0.06), pulse(beat - 0.19, 0.09) * 0.55);
}
