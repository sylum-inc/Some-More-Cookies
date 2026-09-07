import { describe, expect, it } from 'vitest';
import {
  OFFERING_ID,
  SIM_DT,
  bite,
  createRitual,
  deriveSandwich,
  describeOffering,
  leaveSandwich,
  recordRun,
  setPresence,
  stepRitual,
  summariseAssembly,
  summariseRoast,
  vec3,
  type RitualState,
  type SandwichRecord,
  type WildlifeSpecies,
} from '../src/index.js';

/**
 * The other thing a s'more can be for.
 *
 * The ritual is the deepest system in this product and it terminated in
 * nothing: you made a thing whose only use was to vanish into you, and no
 * other system ever touched it. The wildlife model, meanwhile, has always
 * known exactly what animals do about unattended food — `WildlifeObject`
 * carries `portable` and `food`, and the steal chance is built from both.
 * Nothing new was needed for something to take it. These are about the two
 * ends being joined.
 */

/** Curious, not very shy, and interested in things left lying about. */
const MOUSE: WildlifeSpecies = {
  id: 'deer_mouse',
  label: 'a deer mouse',
  shyness: 0.6,
  curiosity: 0.9,
  window: ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'],
  attractedBy: ['crumbs', 'food-smell', 'warmth'],
  repelledBy: ['sudden-movement'],
  canPersist: false,
  investigatesObjects: true,
  traces: ['tiny prints in the duff'],
  note: 'Runs the same route along the log every time, as if it were a corridor.',
};

/** Bolder, and out at the same hours, so two animals share the clearing. */
const SQUIRREL: WildlifeSpecies = {
  ...MOUSE,
  id: 'douglas_squirrel',
  label: 'a pine squirrel',
  shyness: 0.35,
  curiosity: 0.8,
  traces: ['scattered cone scales'],
};

/**
 * A sandwich in hand without running the whole ritual for it.
 *
 * A real `SandwichRecord`, derived the way the machine derives one, because
 * eating reads its appearance and a stub cast to the type is a test that
 * passes until somebody bites it. These are about what happens after the
 * s'more exists; `ritual.test.ts` is where the making of one is proved.
 */
function madeOne(ritual: RitualState, index = 1): SandwichRecord {
  return deriveSandwich({
    roast: summariseRoast(ritual.marshmallow),
    assembly: summariseAssembly(ritual.assembly),
    machine: recordRun(ritual.machine),
    environmentId: ritual.options.environmentId,
    campsiteSeed: ritual.options.campsiteSeed,
    createdAt: ritual.options.now,
    index,
  });
}

function withSandwich(seed: string, roster: readonly WildlifeSpecies[] = [MOUSE]): RitualState {
  const ritual = createRitual({
    campsiteSeed: seed,
    environmentId: 'pine_hollow',
    now: 1_700_000_000_000,
    walkableRadiusM: 20,
    world: { wildlife: roster },
  });
  ritual.sandwich = madeOne(ritual);
  return ritual;
}

/** Runs the world forward the way the render loop does. */
function pass(ritual: RitualState, minutes: number): void {
  const steps = Math.round((minutes * 60) / SIM_DT);
  for (let step = 0; step < steps; step++) stepRitual(ritual, SIM_DT);
}

/** Sits by the fire while the evening goes on, or until something takes it. */
function waitUpTo(ritual: RitualState, minutes: number): number {
  const steps = Math.round((minutes * 60) / SIM_DT);
  const before = ritual.offeringsTaken;
  for (let step = 0; step < steps; step++) {
    stepRitual(ritual, SIM_DT);
    // The count, not the record: the record stays set once it is set.
    if (ritual.offeringsTaken > before) return ritual.elapsed;
  }
  return -1;
}

describe('setting it down', () => {
  it('takes it out of your hands and puts it on the ground', () => {
    const ritual = withSandwich('set-down');
    expect(leaveSandwich(ritual, 1.2, 0.4)).toBe(true);
    expect(ritual.sandwich, 'it was still in hand after being put down').toBeNull();
    expect(ritual.offering).not.toBeNull();
    expect(ritual.offering!.id).toBe(OFFERING_ID);
  });

  it('refuses a sandwich you have already started', () => {
    /*
     * Half a s'more left on a stump is litter, not an offering. The difference
     * matters because the whole act reads as generosity and giving away your
     * leftovers does not.
     */
    const ritual = withSandwich('bitten');
    bite(ritual, 0);
    expect(ritual.bite.bites).toBeGreaterThan(0);
    expect(leaveSandwich(ritual, 1, 0), 'a bitten s’more was left out as an offering').toBe(
      false,
    );
    expect(ritual.offering).toBeNull();
  });

  it('refuses when there is nothing in your hands, and refuses a second one', () => {
    const empty = withSandwich('empty');
    empty.sandwich = null;
    expect(leaveSandwich(empty, 1, 0)).toBe(false);

    const twice = withSandwich('twice');
    expect(leaveSandwich(twice, 1, 0)).toBe(true);
    twice.sandwich = madeOne(twice, 2);
    expect(leaveSandwich(twice, 2, 0), 'two offerings were out at once').toBe(false);
  });

  it('never lands on the coals, wherever it is aimed', () => {
    /*
     * "On the fire" is not a placement anybody means, and it is refused here
     * rather than in the interface because at a shared fire the position
     * arrives over the wire from somebody else's client — §9's rule is that no
     * message exists which can destroy another player's work.
     */
    for (const [x, z] of [
      [0, 0],
      [0.1, -0.05],
      [-0.3, 0.2],
    ]) {
      const ritual = withSandwich(`pit-${x}-${z}`);
      expect(leaveSandwich(ritual, x!, z!)).toBe(true);
      expect(
        Math.hypot(ritual.offering!.x, ritual.offering!.z),
        `a s’more aimed at ${x},${z} landed in the fire`,
      ).toBeGreaterThan(0.9);
    }

    // And a placement that was already clear is left exactly where it was put.
    const ritual = withSandwich('clear');
    leaveSandwich(ritual, 2.5, -1.5);
    expect(ritual.offering!.x).toBeCloseTo(2.5, 6);
    expect(ritual.offering!.z).toBeCloseTo(-1.5, 6);
  });

  it('makes the camp smell of food while it sits there', () => {
    /*
     * The mechanism, and the reason this is not just a delete button. Half the
     * roster at a pine campsite is `attractedBy: ['food-smell']`, and a whole
     * s'more on the ground outsmells anything else in the clearing.
     */
    const ritual = withSandwich('smell');
    stepRitual(ritual, SIM_DT);
    const before = ritual.wildlife.cues['food-smell'] ?? 0;
    leaveSandwich(ritual, 1.2, 0.4);
    stepRitual(ritual, SIM_DT);
    expect(ritual.wildlife.cues['food-smell'] ?? 0).toBeGreaterThan(before);
    expect(ritual.wildlife.cues['food-smell'] ?? 0).toBeGreaterThan(0.5);
  });
});

describe('something takes it', () => {
  it('comes for it, and it takes a while', () => {
    /*
     * Not a button that summons an animal. The offering goes into the object
     * list the wildlife model has always investigated, so what happens next is
     * the ordinary business of something being drawn in, settling, deciding it
     * is brave enough, and only then picking the thing up.
     */
    const ritual = withSandwich('taken');
    leaveSandwich(ritual, 1.2, 0.4);
    const at = waitUpTo(ritual, 30);
    expect(at, 'nothing came for it in half an hour').toBeGreaterThan(0);
    expect(at, 'something snatched it the moment it touched the ground').toBeGreaterThan(20);
    expect(ritual.offering, 'it was taken and is still lying there').toBeNull();
    expect(ritual.offeringTaken!.label).toBe('a deer mouse');
  });

  it('is not how you get good with foxes', () => {
    /*
     * §7, twice over: not collectible pets, and no feeding quest. The animal
     * that carried it off knows this fire differently now. Foxes in general do
     * not, and neither does the next deer mouse — a mechanic where food bought
     * general tameness would be a feeding quest with the word filed off.
     */
    const ritual = withSandwich('bond');
    leaveSandwich(ritual, 1.2, 0.4);
    expect(waitUpTo(ritual, 30)).toBeGreaterThan(0);

    const taken = ritual.offeringTaken!;
    const familiarity = ritual.wildlife.familiarity;
    expect(familiarity.individuals[taken.individualId] ?? 0).toBeGreaterThan(0.2);
    expect(
      familiarity.species[taken.speciesId] ?? 0,
      'feeding one animal made the whole species tamer',
    ).toBe(0);
  });

  it('credits the one that took the s’more, not one that took something else', () => {
    /*
     * Everything a player drops is stealable, so "an animal with `tookObject`"
     * is not the same question as "the animal that took this one". Two animals
     * in the clearing and a dropped bag between them is all it takes to tell
     * them apart, and the obvious reading gets it wrong: on the third seed
     * below a squirrel makes off with the bag and is still retreating with it
     * when a mouse takes the s'more, and picking the first thief in the list
     * credits the squirrel for a s'more it never touched. That seed is here
     * because it does that — the other three are the ordinary case.
     *
     * Checked against the model's own account of what happened — the
     * `took-object` event carrying this object's id — rather than against
     * anything this file worked out for itself.
     */
    for (const seed of [
      'two-thieves-1',
      'two-thieves-2',
      'two-thieves-3',
      'two-thieves-4',
    ]) {
      const ritual = withSandwich(seed, [MOUSE, SQUIRREL]);
      setPresence(ritual, {
        objects: [{ id: 'bag', position: vec3(0.9, 0.2, -0.3), portable: true, food: true }],
      });
      leaveSandwich(ritual, 1.2, 0.4);
      expect(waitUpTo(ritual, 40), `nothing came for it at ${seed}`).toBeGreaterThan(0);

      const took = ritual.wildlifeEvents.find(
        (event) => event.kind === 'took-object' && event.objectId === OFFERING_ID,
      );
      expect(took, `the s’more went without the model saying so at ${seed}`).toBeDefined();
      expect(
        ritual.offeringTaken!.individualId,
        `the wrong animal was credited at ${seed}`,
      ).toBe(took!.individualId);
    }
  });

  it('is still saying so a minute later', () => {
    /*
     * Why this is not a one-step flag.
     *
     * The client reads the world once a frame over a simulation stepping
     * thirty times a second, and its own fast-forward runs a whole evening
     * inside one call. Anything true for exactly one step is a line the player
     * is not guaranteed to be shown, and it is the rare things that get
     * missed. The count is what says "this is new"; the record stays.
     */
    const ritual = withSandwich('lingers');
    leaveSandwich(ritual, 1.2, 0.4);
    expect(waitUpTo(ritual, 30)).toBeGreaterThan(0);
    const atTheTime = ritual.offeringTaken;

    pass(ritual, 1);
    expect(ritual.offeringTaken, 'the world forgot what took it').toEqual(atTheTime);
    expect(ritual.offeringsTaken, 'it counted the same s’more twice').toBe(1);
    // And the campsite wrote it down once, not once per step.
    expect(ritual.traces.filter((trace) => trace.id.startsWith('offering:'))).toHaveLength(1);
  });

  it('leaves the campsite something to remember it by', () => {
    const ritual = withSandwich('trace');
    leaveSandwich(ritual, 1.2, 0.4);
    expect(waitUpTo(ritual, 30)).toBeGreaterThan(0);
    // Traces harvest on the step after the take, so give it one.
    stepRitual(ritual, SIM_DT);
    const kept = ritual.traces.filter((trace) => trace.id.startsWith('offering:'));
    expect(kept, 'the place forgot it immediately').toHaveLength(1);
    expect(kept[0]!.kind).toBe('sandwich');
    expect(kept[0]!.payload.telling).toContain('deer mouse');
  });

  it('says what happened and nothing about what it meant', () => {
    /*
     * §5.3. No thank you, no acknowledgement, no counter going up — an animal
     * that took food off a stump is not grateful and does not know it has been
     * given anything, and a line implying otherwise would turn the one place
     * the ritual touches the wildlife model into a transaction.
     */
    const said = describeOffering({ label: 'a deer mouse' });
    expect(said).toContain('deer mouse');
    expect(said, 'the offering reported a number').not.toMatch(/\d/);
    expect(said.toLowerCase()).not.toMatch(/thank|reward|earn|bond|friend|score|\+/);
  });
});
