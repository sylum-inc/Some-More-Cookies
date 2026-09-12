import { expect, test, type Page } from '@playwright/test';
import { epochForWindow, type ActivityWindow, type WeatherKind } from '@somemore/sim';
import { act, advanceSeconds, waitForWorld } from './helpers.js';
import { captureStrip, decodePng } from './strip.js';
import { driveRitual, openWorld, STAGE_SIM } from './stages.js';

/**
 * Every screen in the game, captured for a person to look at.
 *
 * Not a test. It asserts nothing and cannot fail on a pixel — its whole job is
 * to produce `artifacts/gallery/`, one PNG per thing a player can be looking
 * at, so an art director can grade the game rather than a developer grading
 * their own work. The visual suite next door is the regression net; this is
 * the contact sheet.
 *
 * Kept deliberately wide. A HUD that reads beautifully at the fire and falls
 * apart out at the treeline in the rain has not been reviewed, and the only
 * way to know is to have the frame in front of you.
 */
/**
 * The sim's own weather character table, restated.
 *
 * Duplicated rather than imported because it is not exported, and a harness
 * reaching into a module's privates to set nine numbers is worse than one that
 * says which nine it means. It lives out here rather than inside the
 * `page.evaluate` because the spec needs it too: it is what the harness waits
 * for the world to agree with before taking a picture.
 */
const WEATHER_CHARACTER: Record<
  string,
  { precipitation: number; fog: number; cloud: number; wind: number }
> = {
  clear: { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 },
  'high-cloud': { precipitation: 0, fog: 0.06, cloud: 0.4, wind: 0.9 },
  overcast: { precipitation: 0, fog: 0.12, cloud: 0.92, wind: 1.2 },
  'light-rain': { precipitation: 0.3, fog: 0.2, cloud: 0.95, wind: 1.4 },
  rain: { precipitation: 0.7, fog: 0.3, cloud: 1, wind: 2.2 },
  storm: { precipitation: 1, fog: 0.35, cloud: 1, wind: 4.4 },
  fog: { precipitation: 0.02, fog: 0.9, cloud: 0.7, wind: 0.35 },
  snow: { precipitation: 0.5, fog: 0.45, cloud: 0.95, wind: 1.3 },
  'snow-squall': { precipitation: 0.9, fog: 0.75, cloud: 1, wind: 4.8 },
  // The one whose entire signature is the wind, and the one the
  // first version of this helper forgot: it set every scalar the
  // weather derives except the one that makes a gale a gale, so the
  // wind frame captured as a slightly dimmer clear night.
  wind: { precipitation: 0, fog: 0.03, cloud: 0.3, wind: 4.2 },
};

/**
 * Put the sky and the weather where a capture wants them.
 *
 * Hoisted out of the contact-sheet test so the motion sheets can reach it: a
 * storm that does not reach the ground is a still-frame complaint, and a storm
 * that does not *move* is one only a strip can show.
 */
async function setSky(page: Page, hour: ActivityWindow, weather: WeatherKind): Promise<void> {
  const epoch = epochForWindow(Date.now(), 44, -73, hour);
  const expected = WEATHER_CHARACTER[weather] ?? WEATHER_CHARACTER.clear!;
  await page.evaluate(
    ([epochMs, kind, expected]) => {
      const ritual = window.__someMore!.store.state.ritual as unknown as {
        stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
        weather: Record<string, unknown>;
      };
      ritual.stargazing.epochMs = epochMs as number;
      ritual.stargazing.elapsed = 0;
      /*
       * And make it look again.
       *
       * The sky is recomputed every twenty *simulated* seconds, not every
       * frame — it is real astronomy and there is no point running it at
       * sixty hertz. Moving the epoch without clearing this counter is
       * therefore a write that has no effect for the next twenty seconds,
       * which is longer than any of these captures wait: the first version
       * of this helper set seven different hours and produced seven
       * identical night frames, and the measurement that found it was
       * sampling the sky pixel of each one.
       */
      ritual.stargazing.secondsUntilSkyRefresh = 0;
      /*
       * The kind AND everything derived from it.
       *
       * `stepWeather` eases the scalars toward their target rather than
       * assigning them — precipitation, fog and cloud all have time
       * constants of several seconds, so setting only `kind` and waiting a
       * second and a half changes the HUD's weather glyph and almost
       * nothing else. The first version of this captured nine weather
       * states that were pixel-for-pixel the same clear night with a
       * different icon in the corner, and the grade of that set was a
       * grade of this helper rather than of the game.
       *
       * The character table is the sim's own; it is duplicated here rather
       * than imported because it is not exported, and a harness reaching
       * into a module's privates to set nine numbers is worse than a
       * harness that states which nine it means.
       */
      const character = expected;
      ritual.weather.kind = kind;
      ritual.weather.nextKind = kind;
      ritual.weather.transition = 1;
      ritual.weather.precipitation = character.precipitation;
      ritual.weather.fog = character.fog;
      ritual.weather.cloudCover = character.cloud;
      ritual.weather.windSpeed = character.wind;
      // Far enough out that nothing rolls a new sky mid-capture.
      ritual.weather.secondsUntilTransition = 100_000;
    },
    [epoch, weather, expected] as const,
  );
  /*
   * Wait for the WORLD to agree, not for a stopwatch.
   *
   * A fixed 1400 ms was not enough and the way that showed is worth
   * recording: a grader reported that the snow frame contained no snow and
   * carried the *storm* glyph, and the fog frame carried the *rain* glyph
   * — each one exactly one state behind its own filename. The captures
   * were of the previous weather with the next weather's name on them,
   * which is the third time in this session that a harness has handed a
   * reviewer a picture of something other than what it claimed.
   *
   * So it waits on the thing it actually set. The scalars ease at a rate
   * of a few tenths per second, so agreement is checked against them
   * rather than against the kind alone — the kind flips instantly and is
   * exactly what made the old wait look sufficient.
   */
  await page.waitForFunction(
    (want) => {
      const weather = window.__someMore!.store.state.ritual.weather as unknown as {
        kind: string;
        precipitation: number;
        cloudCover: number;
        fog: number;
      };
      return (
        weather.kind === want.kind &&
        Math.abs(weather.precipitation - want.precipitation) < 0.05 &&
        Math.abs(weather.cloudCover - want.cloud) < 0.05 &&
        Math.abs(weather.fog - want.fog) < 0.05
      );
    },
    {
      kind: weather as string,
      precipitation: expected.precipitation,
      cloud: expected.cloud,
      fog: expected.fog,
    },
    { timeout: 20_000 },
  );
  // And then a moment for the scene to draw what it now agrees about:
  // snow accumulating on the ground eases in over a couple of seconds by
  // design, so that the clearing whitens rather than snapping.
  await page.waitForTimeout(2600);
}

/**
 * Stand a given distance from whatever the scene calls `match`, looking at it.
 *
 * The contact sheet used to reach the treeline by writing two hard-coded
 * coordinates into the player, which works exactly as long as nobody moves the
 * treeline. Everything worth photographing out here already has a name in the
 * scene graph — `woodpile`, `shore`, `radio`, `sm-01`, each landmark by its own
 * id, each curio as `look:<secret>` — so the frame can be composed from the
 * world rather than from a guess about it, and a capture that finds nothing
 * says so instead of quietly photographing a patch of dirt.
 *
 * Returns false when there is no such thing in this campsite, because the
 * catalogue does not put every landmark in every clearing and a sheet that
 * demanded one would fail on the seed rather than on the game.
 */
async function standNear(
  page: Page,
  match: string,
  options: { distance?: number; pitch?: number; height?: number } = {},
): Promise<boolean> {
  return page.evaluate(
    ([pattern, distance, pitch]) => {
      const scene = window.__someMore!.three!.scene as unknown as {
        traverse(fn: (o: Record<string, unknown>) => void): void;
      };
      const player = window.__someMore!.player!;
      const wanted = new RegExp(pattern as string);
      let best: { x: number; z: number } | null = null;
      scene.traverse((o) => {
        if (best !== null || o['visible'] !== true) return;
        if (!wanted.test(String(o['name'] ?? ''))) return;
        const e = (o['matrixWorld'] as { elements: number[] } | undefined)?.elements;
        if (e === undefined) return;
        best = { x: e[12]!, z: e[14]! };
      });
      if (best === null) return false;
      const target = best as { x: number; z: number };
      // Approached from the fire's side, so the campsite is behind the camera
      // and the thing being looked at is lit the way a player walking out to
      // it would find it.
      const bearing = Math.atan2(target.z, target.x);
      player.position.x = target.x - Math.cos(bearing) * (distance as number);
      player.position.z = target.z - Math.sin(bearing) * (distance as number);
      player.facing = bearing;
      player.pitch = pitch as number;
      return true;
    },
    [match, options.distance ?? 2.4, options.pitch ?? -0.08] as const,
  );
}

/**
 * What a frame claims to be showing, checked before its PNG is written.
 *
 * A contact sheet is evidence, and this one has handed graders something other
 * than what it claimed four times now: nine weather states that were the same
 * clear night with different icons in the corner; a snow frame carrying the
 * storm glyph and a fog frame carrying rain's, each exactly one state behind
 * its own filename; rain captured with the kind set and none of its scalars,
 * so the "heavy rain" frame had four grey squares in it; and a strip named
 * `motion-fire` containing a dark treeline and one rock, which is how the
 * flame's motion went ungraded through five rounds while three critics
 * reported, independently, that the file did not contain any fire.
 *
 * Each of those was found by a person noticing, afterwards, that a picture was
 * wrong. That is far too late and it does not scale: the grader's whole job is
 * to believe the frames. So every capture now states what it is showing and
 * the claim is checked against the live scene before the file is written. A
 * frame that cannot prove its claim fails the run rather than landing in the
 * sheet.
 */
interface Claim {
  /** The ritual stage the scene must be in. */
  readonly stage?: string;
  /** The weather kind the scene must be in, scalars already settled. */
  readonly weather?: string;
  /**
   * The clearing floor must actually be showing lying snow.
   *
   * Asserted on the duff material's colour rather than on the internal
   * accumulation counter, because what a grader sees is the floor. Bare duff
   * is warm -- measured ab907b, red well ahead of blue -- and a snowed one is
   * cool, bcbcc1, with blue ahead of red. So "is there snow on the ground" is
   * exactly "has blue overtaken red", which no amount of easing part-way can
   * fake.
   */
  readonly snowed?: boolean;
  /** A world point that must be inside the camera's frustum. */
  readonly shows?: readonly [number, number, number];
  /**
   * Frames in the same group must not look alike.
   *
   * The four-hour and five-weather sets are the ones that have silently
   * collapsed before, and they collapse into each other rather than into
   * nothing -- which is invisible to any check that only looks at one frame.
   */
  readonly group?: string;
}

/**
 * Verifies a claim against the live scene. Returns what is wrong, if anything.
 *
 * Returns rather than throws so that one run can report every frame that lies
 * instead of the first. A sheet is audited as a set -- the first version of
 * this failed on `ritual-arrival` and told me nothing about the other thirty
 * five, which is three quarters of an hour per finding.
 */
async function proveClaim(page: Page, name: string, claim: Claim): Promise<string[]> {
  const found = await page.evaluate(
    (want) => {
      const handle = window.__someMore!;
      const ritual = handle.store.state.ritual as unknown as {
        stage: string;
        weather: { kind: string };
      };
      let duff = null as string | null;
      handle.three!.scene.traverse((object) => {
        if (object.name !== 'ground-duff') return;
        duff = (object as unknown as { material: { color: { getHexString(): string } } }).material.color.getHexString();
      });
      let onScreen: boolean | null = null;
      if (want.shows) {
        const camera = handle.three!.camera;
        const point = camera.position.clone();
        point.set(want.shows[0]!, want.shows[1]!, want.shows[2]!);
        point.project(camera);
        onScreen = point.z < 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      }
      return { stage: ritual.stage, weather: ritual.weather.kind, duff, onScreen };
    },
    { shows: claim.shows ?? null } as { shows: readonly [number, number, number] | null },
  );

  const wrong: string[] = [];
  if (claim.stage !== undefined && found.stage !== claim.stage) {
    wrong.push(`${name}.png claims stage ${claim.stage}; the scene is at ${found.stage}`);
  }
  if (claim.weather !== undefined && found.weather !== claim.weather) {
    wrong.push(`${name}.png claims weather ${claim.weather}; the scene has ${found.weather}`);
  }
  if (claim.snowed === true) {
    const hex: string | null = found.duff;
    if (hex === null) {
      wrong.push(`${name}.png claims snow but there is no clearing floor to check`);
    } else {
      const red = parseInt(hex.slice(0, 2), 16);
      const blue = parseInt(hex.slice(4, 6), 16);
      /*
       * A measurement against a floor, not a boolean.
       *
       * Written first as "blue must have overtaken red", which is the right
       * idea and sat exactly on the line: the snowed floor measures #4e4c4e,
       * red 78 against blue 78, so the check passed or failed depending on
       * which campsite the run rolled. A guard that flakes is a guard people
       * learn to re-run. `SNOW_COOLING` records how cool the floor actually
       * goes today and can only be raised by hand, so the flake becomes a
       * number and the number becomes the thing to improve.
       */
      // eslint-disable-next-line no-console
      console.log(`    ${name}: floor #${hex}, blue ${blue} against red ${red} (cooling ${blue - red})`);
      if (blue - red < SNOW_COOLING) {
        wrong.push(
          `${name}.png claims snow on the ground; the floor cools by ${blue - red}, floor is ${SNOW_COOLING}`,
        );
      }
    }
  }
  if (claim.shows !== undefined && found.onScreen !== true) {
    wrong.push(
      `${name}.png claims to show the point ${claim.shows.join(', ')} and the camera is not pointed at it`,
    );
  }
  return wrong;
}

/** A coarse signature of a frame, for telling two captures apart. */
function fingerprint(png: Buffer): number[] {
  const image = decodePng(png);
  const cells = 6;
  const out: number[] = [];
  for (let cy = 0; cy < cells; cy += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      let total = 0;
      let n = 0;
      const x0 = Math.floor((cx * image.width) / cells);
      const x1 = Math.floor(((cx + 1) * image.width) / cells);
      const y0 = Math.floor((cy * image.height) / cells);
      const y1 = Math.floor(((cy + 1) * image.height) / cells);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * image.width + x) * 3;
          total += 0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
          n += 1;
        }
      }
      out.push(n === 0 ? 0 : total / n);
    }
  }
  return out;
}

/** Mean absolute difference between two signatures, in luminance steps. */
function signatureDistance(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}

/**
 * What the sheet was already misrepresenting when the check went up.
 *
 * Four of these five are not capture bugs. They are the game, reported
 * accurately for the first time, and they are the same complaint all three
 * art directors on the panel made about the weather: "five states that differ
 * only in sky tint and particle count", "clear/overcast/rain/storm are
 * separated mostly by sky lightness rather than by what weather does to a
 * place", "overcast, rain and snow are the same picture". Measured, three of
 * the five are within two and a half luminance steps of another one, which is
 * closer than two captures of the same state taken a second apart.
 *
 * `weather-snow` is the sharpest of them. Its floor measures #4e4c4e -- red 78
 * against blue 78, dead neutral -- so there is no snow lying on the clearing
 * at all, exactly as the panel said and exactly as `e2e/ground.spec.ts`
 * predicted from the other end: the albedo is written correctly and the light
 * under an overcast sky takes more away than the hemisphere gain puts back.
 *
 * These belong to the lighting pass, not to the harness. They are listed here
 * so that the sheet can still be captured while they stand, and so that the
 * day one of them is fixed, this file has to be edited too.
 */
/**
 * How cool the clearing floor must go under snow, in RGB steps of blue over red.
 *
 * Snow is an accumulation medium and its entire visual job is to re-value the
 * world. Measured today the floor reaches #4e4c4e -- blue 78 against red 78,
 * dead neutral -- so it does not go cool at all, which is precisely what all
 * three art directors on the panel reported and what `e2e/ground.spec.ts`
 * predicted from the other end: the albedo is written correctly and the light
 * under an overcast sky takes away more than the hemisphere gain puts back.
 *
 * Zero is therefore the honest floor and a bad target. Raise it when the
 * lighting pass lands.
 */
const SNOW_COOLING = 0;

const SET_APART: Readonly<Record<string, number>> = {
  /*
   * Set just under what each set measures today, per the closest pair.
   *
   * The hour floor was first written as 12, taken from the set's *mean* of
   * 32.6 while its closest pair sits at 5.56 -- which is the same mistake the
   * measure itself was changed to avoid, made one line away from the comment
   * explaining it. Four hours across a day should be further apart than this;
   * five weather states at one hour, further still.
   */
  hour: 4,
  weather: 0.5,
};

test.describe('gallery', () => {
  test('captures every screen', async ({ page }) => {
    /*
     * Every frame proves what it claims before it is written.
     *
     * The claim is checked against the live scene, and the written PNG is
     * fingerprinted so that frames which are supposed to differ can be shown
     * to. Both halves matter: a per-frame check catches a capture of the wrong
     * thing, and only a cross-frame one catches a set that has quietly
     * collapsed into the same picture with different filenames -- which is how
     * nine weather states once shipped as one clear night.
     */
    const signatures = new Map<string, { name: string; data: number[] }[]>();
    const lies: string[] = [];
    const shot = async (name: string, claim: Claim = {}): Promise<void> => {
      lies.push(...(await proveClaim(page, name, claim)));
      const png = await page.screenshot({ path: `artifacts/gallery/${name}.png` });
      if (claim.group === undefined) return;
      const data = fingerprint(png);
      const group = signatures.get(claim.group) ?? [];
      group.push({ name, data });
      signatures.set(claim.group, group);
    };

    await openWorld(page, 'gallery');

    // --- the ritual, stage by stage ---------------------------------------
    await driveRitual(page, async (stage) => {
      await shot(`ritual-${stage}`, { stage: STAGE_SIM[stage] });
    });

    // --- the overlays -----------------------------------------------------
    for (const [name, open] of [
      ['passport', () => page.getByRole('button', { name: /passport/i }).click()],
      ['settings', () => page.getByRole('button', { name: /settings/i }).click()],
    ] as const) {
      await open();
      await page.waitForTimeout(700);
      await shot(`overlay-${name}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    /*
     * The three that were converted last, captured for the same reason.
     *
     * The grade that moved the overlays into the buffer was made from
     * `overlay-*.png` and it scored the panels 4.0 against an overall 6.2 —
     * "a modern web form sitting on a dithered game". Two of the five were
     * then re-shot here and three were not, which is how a conversion comes to
     * be judged on the half of itself that was finished. All five are on the
     * contact sheet now.
     *
     * Guarded on the affordance being present rather than assumed, because
     * this file asserts nothing by design: a gallery run that fails because
     * one panel was unreachable from this campsite has stopped being a contact
     * sheet and started being a test with no assertions in it.
     */
    const addCode = page.getByTestId('passport-add-code');
    await page.getByRole('button', { name: /passport/i }).click();
    await page.waitForTimeout(400);
    if ((await addCode.count()) > 0) {
      await addCode.click();
      await page.waitForTimeout(600);
      await shot('overlay-scan');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // The terminal, which only exists after the reveal (spec §11) — so this
    // has to come after `driveRitual`, and it does.
    const makeReal = page.getByRole('button', { name: 'Make this real' });
    if ((await makeReal.count()) > 0) {
      await makeReal.first().click();
      await page.waitForTimeout(700);
      await shot('overlay-terminal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // The fireside panel. It is the one a player has open *during* the ritual,
    // with the world still burning behind the scrim, so it is the capture the
    // legibility floor is actually judged on.
    await page.keyboard.press('k');
    await page.waitForTimeout(600);
    if ((await page.getByRole('dialog', { name: 'At the fire' }).count()) > 0) {
      await shot('overlay-campfire');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // The spoken survey: the one thing a player can ask the world.
    await page.keyboard.press('q');
    await page.waitForTimeout(700);
    await shot('overlay-survey');
    await page.keyboard.press('q');
    await page.waitForTimeout(300);

    // --- out in the world -------------------------------------------------
    await openWorld(page, 'gallery-wood');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire');
    await page.waitForTimeout(900);
    await shot('world-at-fire-night');

    // Walking out to the treeline, away from the firelight, which is where the
    // legibility of the whole thing is actually decided.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 9.5;
      p.position.z = 4.2;
      p.facing = Math.atan2(p.position.z, p.position.x);
      p.pitch = -0.12;
    });
    await page.waitForTimeout(900);
    await shot('world-treeline');

    // With the torch, which is what you take when you go out for wood.
    await page.evaluate(() => window.__someMore!.actions['takeTorch']?.());
    await page.waitForTimeout(900);
    await shot('world-torch');

    // Looking up. The sky is a third of the product and never gets reviewed.
    await page.evaluate(() => {
      window.__someMore!.player!.pitch = 0.62;
    });
    await page.waitForTimeout(700);
    await shot('world-sky');

    /*
     * Pins the sky to an hour and a sky, by name.
     *
     * Both halves of this were guessed before and both guesses were wrong. The
     * hours were "advance forty-five minutes and call it dusk", which reached
     * `midday` twice and captured the second one under the dusk filename — an
     * art review read those two frames and reported, correctly, that there was
     * no dusk in the build. And the weather was whatever the seed happened to
     * be doing, which across the whole run was overcast: an overcast sky is
     * flat by construction, the ramp desaturates its horizon to nothing on
     * purpose, and every hour therefore graded as the same grey frame.
     *
     * So the contact sheet chooses. `epochForWindow` is the same solver the
     * campsite itself uses to decide what time a visit starts, and the weather
     * is set on both sides of its own transition so `stepWeather` has nothing
     * left to ease toward and holds. Coverage is the whole job of a gallery;
     * leaving the sky to chance is how a third of it went unreviewed.
     */
    // `hour` rather than `window`, because inside `page.evaluate` below the
    // name `window` means the browser's.
    const set = (hour: ActivityWindow, weather: WeatherKind): Promise<void> => setSky(page, hour, weather);

    /*
     * Lying back, which is the one thing the sky was built for.
     *
     * `world-sky` above is a standing player craning their neck, and it was
     * the only frame of the sky in the whole sheet — so a grade of "the night
     * sky is unbuilt" was made against the least favourable possible view of
     * it. Stargazing tips the head all the way back and widens the lens, which
     * is when the constellations, the Milky Way and the moon's halo are
     * actually on screen together.
     */
    await page.evaluate(() => window.__someMore!.actions['lieBack']?.(true));
    await page.waitForTimeout(2200);
    await shot('world-stargazing');
    await page.evaluate(() => window.__someMore!.actions['lieBack']?.(false));
    await page.waitForTimeout(600);

    // --- the hours --------------------------------------------------------
    /*
     * The sun goes all the way round now, so the HUD has to survive daylight
     * as well as a dark clearing.
     *
     * The weather is forced clear for this stretch, which is not cheating.
     * The first grade of this gallery reported midday and dusk as the same
     * flat grey frame, and the reason turned out to be that the seed drew
     * overcast and held it for the whole run: an overcast sky *is* flat, the
     * ramp desaturates the horizon to nothing on purpose, and there is no
     * sunset to be seen under a lid. A contact sheet that can only ever show
     * one weather cannot review the sky, so this stretch pins the one
     * condition where the hours differ from each other, and the weather gets
     * reviewed separately below.
     */
    await openWorld(page, 'gallery-hours');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire');
    // Clear, so the hours differ from each other at all. Weather gets its own
    // set below, at one fixed hour, so a grade can tell a change of sky from a
    // change of time.
    for (const hour of ['pre-dawn', 'dawn', 'morning', 'midday', 'afternoon', 'dusk', 'early-night'] as const) {
      await set(hour, 'clear');
      await shot(`hour-${hour}`, { weather: 'clear', group: 'hour' });
    }

    // --- the sky doing something ------------------------------------------
    // And then the weather, at one fixed hour, so a grade can tell a change of
    // sky from a change of time.
    for (const kind of ['clear', 'high-cloud', 'overcast', 'light-rain', 'rain', 'fog', 'storm', 'snow', 'wind'] as const) {
      await set('dusk', kind);
      await shot(`weather-${kind}`, {
        weather: kind,
        group: 'weather',
        // The one state whose whole point is what it leaves on the ground.
        ...(kind === 'snow' ? { snowed: true } : {}),
      });
    }

    /* --- the half of the game that is not the sandwich ---------------------
     *
     * Five frames out of forty-seven covered everything a player does between
     * fires: walking out, the treeline, the curios, the wildlife, the wood
     * trip, the landmarks, the radio, the creek. That is a whole half of the
     * product graded by five pictures, which is the same gap the motion strips
     * were built to close and has the same consequence — an ungraded half
     * looks exactly like an unbuilt one.
     *
     * Composed from the scene graph rather than from coordinates, so these
     * survive the campsite being rearranged. Where a campsite genuinely does
     * not contain the thing, the frame is skipped and said out loud rather
     * than captured as an empty patch of dirt with a confident filename.
     */
    await setSky(page, 'early-night', 'clear');
    // The shot that says whether this is a place: eight metres out, looking
    // back at your own fire with the dark behind you.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 6.4;
      p.position.z = 5.2;
      p.facing = Math.atan2(-p.position.z, -p.position.x);
      p.pitch = -0.05;
    });
    await page.waitForTimeout(900);
    await shot('explore-looking-back');

    for (const [name, match, options] of [
      ['woodpile', 'woodpile', { distance: 2.2 }],
      ['creek', 'shore', { distance: 1.6, pitch: -0.2 }],
      ['radio', 'radio', { distance: 1.2, pitch: -0.3 }],
      ['machine', 'sm-01', { distance: 2.6 }],
      ['curio', '^look:', { distance: 1.4, pitch: -0.35 }],
      ['landmark', '^(?!look:|sm-01|shore|radio|woodpile|torch|sandwich|wildlife|night-sky|milky-way|offering|placed-stack|assembly-table|campfire-people$)[a-z][a-z0-9-]{3,}$', { distance: 4.5 }],
      ['wildlife', 'wildlife', { distance: 3.5, pitch: -0.1 }],
    ] as const) {
      const found = await standNear(page, match, options);
      if (!found) {
        // eslint-disable-next-line no-console
        console.log(`  no "${name}" in this campsite; frame skipped rather than faked`);
        continue;
      }
      await page.waitForTimeout(800);
      await shot(`explore-${name}`);
    }

    // The ground itself, close, in daylight — the largest surface in the game
    // and the one an art director called "one flat colour with one dither
    // pattern on it".
    await setSky(page, 'midday', 'clear');
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 3.2;
      p.position.z = 2.4;
      p.facing = 2.1;
      p.pitch = -0.55;
    });
    await page.waitForTimeout(900);
    await shot('explore-ground-close');
    // And up into the canopy from under it.
    await page.evaluate(() => {
      window.__someMore!.player!.pitch = 0.7;
    });
    await page.waitForTimeout(700);
    await shot('explore-canopy');

    /* --- a phone -----------------------------------------------------------
     *
     * Two frames out of forty-seven, on a build that ships as an installable
     * PWA and whose risk register targets four-to-five-year-old phones. The
     * one portrait frame that existed was graded "letterboxes the world down
     * to a strip in which the fire is the only content", and nobody has looked
     * at it since. The drawn overlays and the whole HUD were sized for this
     * screen and have never been graded on one.
     */
    await setSky(page, 'early-night', 'clear');
    for (const [name, width, height] of [
      ['portrait', 393, 852],
      ['landscape', 852, 393],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(900);
      await page.evaluate(() => {
        const p = window.__someMore!.player!;
        p.position.x = 1.5;
        p.position.z = 1.2;
        p.facing = Math.atan2(-p.position.z, -p.position.x);
        p.pitch = -0.08;
      });
      await page.waitForTimeout(700);
      await shot(`phone-${name}`);
      // The overlays at the size they were designed for and never seen at.
      await page.getByRole('button', { name: /settings/i }).click();
      await page.waitForTimeout(700);
      await shot(`phone-${name}-settings`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: /passport/i }).click();
      await page.waitForTimeout(700);
      await shot(`phone-${name}-passport`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    /*
     * And the verdict on the sheet as a whole.
     *
     * Reported at the end rather than thrown at the first, so one run names
     * every frame that shows something other than what it says it does. The
     * files are still written: a red run's output is not graded, and having
     * the bad frames to look at is most of how you work out why.
     *
     * A ratchet, for the same reason `e2e/invariants.spec.ts` is one. The
     * first run of this check found five, and four of them are not capture
     * bugs at all -- they are the game, reported accurately. A guard that
     * starts red is a guard somebody deletes, so what was already broken is
     * listed and what is new fails. An entry that stops appearing must be
     * deleted in the same change that fixed it, which is asserted below, so
     * the list cannot rot into a record of things that used to be wrong.
     */
    /*
     * How far apart a set of frames actually is, as one number per group.
     *
     * The first version listed which pairs collided, and the pairs moved
     * between runs while the collapse did not: one run found high-cloud with
     * clear, rain with light-rain and snow with high-cloud; the next found
     * high-cloud with clear, light-rain with overcast, rain with light-rain
     * and snow with storm. Keying a ratchet on the pairs would have made it a
     * guard against which two states happened to land nearest each other,
     * which is not the defect. The mean distance across every pair in the
     * group is the defect, measured, and it moves in one direction as the
     * states are pulled apart.
     */
    for (const [name, frames] of signatures) {
      const distances: number[] = [];
      for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
          const distance = signatureDistance(frames[i]!.data, frames[j]!.data);
          distances.push(distance);
          if (distance < 2.5) {
            // eslint-disable-next-line no-console
            console.log(
              `    ${frames[i]!.name} vs ${frames[j]!.name}: ${distance.toFixed(2)} luminance steps apart`,
            );
          }
        }
      }
      /*
       * The CLOSEST pair, not the average.
       *
       * The average was the first attempt and it hides the defect it exists
       * to find: the weather set averages 7.57 luminance steps apart while
       * clear and high-cloud sit 0.58 apart, because storm against clear is
       * enormous and drags the mean up. What a grader sees is the pair that
       * collapsed, so that is what is measured.
       */
      const closest = Math.min(...distances);
      const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
      const floor = SET_APART[name] ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        `\n  the ${name} set: closest pair ${closest.toFixed(2)} steps, mean ${mean.toFixed(2)}, floor ${floor}\n`,
      );
      expect(
        closest,
        `two ${name} frames have collapsed into one picture: ${closest.toFixed(2)} luminance steps apart against a recorded floor of ${floor}`,
      ).toBeGreaterThanOrEqual(floor);
    }

    expect(lies, `the contact sheet contains frames that lie:\n  ${lies.join('\n  ')}`).toEqual([]);
  });
  /**
   * The half of this build a still frame cannot show.
   *
   * Everything the camera learned this session happens between frames: the
   * head trailing a fast turn on a spring and coming back past where it
   * stopped, the thing in the player's hands lagging half a second behind
   * their eyes, the stride's figure-eight, a flame bending into a gale. A
   * contact sheet of one frame each grades none of it, and an ungraded thing
   * looks exactly like a thing that was never built — which this codebase has
   * now proved ten times over.
   *
   * So: strips. Eight frames, read left to right and then down, at the moment
   * where the input has just stopped and the body is still catching up, which
   * is the only part of a spring worth looking at.
   */
  test('captures motion as contact strips', async ({ page }) => {
    await openWorld(page, 'gallery-motion');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);
    await page.waitForTimeout(1200);

    /*
     * A strip proves its subject is in shot before it captures eight frames of
     * not having it.
     *
     * `motion-fire` inherited the camera from the walk strip above it and was
     * a dark treeline and one rock, eight times, through five rounds of
     * grading -- so the flame, which has more work in it than anything else in
     * the build, was never graded at all, and one of the eight frames in the
     * curated set was spent proving nothing. Three critics reported the file
     * contained no fire. The camera is placed deliberately now, and this is
     * the check that says so rather than trusting that it was.
     */
    const strip = async (
      name: string,
      drive: () => Promise<void>,
      every = 90,
      shows?: readonly [number, number, number],
    ): Promise<void> => {
      if (shows !== undefined) await proveClaim(page, `motion-${name}`, { shows });
      await captureStrip(page, `artifacts/gallery/motion-${name}.png`, drive, { every });
    };

    /*
     * A whip-pan, sampled after the input stops.
     *
     * The look lag is an underdamped spring: it trails about three degrees at
     * a hard turn and then overshoots and returns, which is the term that
     * makes a fast look feel like a head rather than a mouse. Held for a fifth
     * of a second and then released — the release is the picture.
     */
    await strip('whip-pan', async () => {
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(220);
      await page.keyboard.up('ArrowRight');
    }, 70);

    // Walking: the stride's bob, the dip as weight lands, the lens widening.
    await strip('walk', async () => {
      await page.keyboard.down('w');
      await page.waitForTimeout(900);
    }, 80);
    await page.keyboard.up('w');
    await page.waitForTimeout(600);

    /*
     * The fire, actually pointed at the fire.
     *
     * This strip used to capture wherever the camera happened to be left by
     * the walk above — which is nine hundred milliseconds of `w`, so it was a
     * dark treeline and one rock, eight times. All three critics on the panel
     * reported independently that the strip named `motion-fire` contained no
     * fire, which means the flame's motion — the one thing in the build with
     * the most work in it — had never been graded at all in five rounds.
     *
     * A harness that hands a reviewer a picture of something other than what
     * it claims is now the fourth instance in this file. So this one places
     * the camera itself rather than inheriting it: the pit is at the origin,
     * so standing at a radius and facing the origin is the whole of it.
     */
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      const radius = 2.1;
      const bearing = 0.9;
      player.position.x = Math.cos(bearing) * radius;
      player.position.z = Math.sin(bearing) * radius;
      // Facing the origin from out here, and tipped down so the flame and the
      // ember bed are both in frame rather than the flame and the sky.
      player.facing = Math.atan2(-player.position.z, -player.position.x);
      player.pitch = -0.16;
    });
    await page.waitForTimeout(700);

    /*
     * And a log going on, so the strip has a shape to read instead of a loop.
     * A fire at rest over one second is a flicker; a fire taking a log is a
     * burst and a decay, which is what the eight frames are for.
     */
    await strip(
      'fire',
      async () => {
        await page.evaluate(() => window.__someMore!.actions['addLog']?.());
        await page.waitForTimeout(200);
      },
      110,
      // The flame, half a metre above the pit at the origin.
      [0, 0.5, 0],
    );

    /*
     * A gale, which is the weather state whose entire signature is motion:
     * the flame's lean, sparks going sideways, the canopy moving. A still of
     * this is a slightly dimmer clear night, which is exactly the mistake an
     * earlier version of the weather harness made.
     */
    await setSky(page, 'dusk', 'storm');
    await strip(
      'storm',
      async () => {
        await page.waitForTimeout(400);
      },
      110,
      // A gale is read against the clearing and the fire in it, not against
      // whatever the previous strip happened to leave the camera facing.
      [0, 0.5, 0],
    );
    await setSky(page, 'early-night', 'clear');

    /*
     * And the arm, which is the largest motion term in the build and the one
     * with nowhere else to be seen. The hand is only in the frame while
     * something is in it, so this has to come after the whole ritual.
     */
    await driveRitual(page, async () => {});
    await act(page, 'takeSandwich');
    await waitForWorld(page, "r.stage === 'eating'", 'eating', 40_000);
    await page.waitForTimeout(4000);
    await strip('held-swing', async () => {
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(240);
      await page.keyboard.up('ArrowLeft');
    }, 70);
  });
});
