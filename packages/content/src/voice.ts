/**
 * Which half of an authored note a player is allowed to hear.
 *
 * `ActivityEntry.note` turned out to be written in two voices at once. Most of
 * it is prose about the place, meant for whoever is standing there:
 *
 *     "A cane pole, a cork float, and a lantern hung over the rail. You watch
 *      the float in black water. Sometimes it goes under."
 *
 * and then, in the same field, a sentence addressed to the team that built it:
 *
 *     "It is the most patient activity in the game and people love it."
 *
 * Twenty-two of a hundred and thirteen notes carry a sentence like that — "the
 * reference implementation", "the shot this environment exists to produce",
 * "this is the reason the audio engine has a canyon impulse response". They
 * are worth keeping: they are the clearest record anywhere of what each
 * campsite is *for*, and a manifest is exactly where that record belongs.
 *
 * What they cannot do is reach a player, and the first time the client started
 * reading activity notes out as notices, they did — somebody sitting at a fire
 * in the cicada bottoms was told that fishing is "the most patient activity in
 * the game and people love it", which is a sentence that removes the fire, the
 * night and the person from the room in one move.
 *
 * So: this splits the two voices at presentation time, and a test in
 * `catalogue.test.ts` pins the player-facing half of all hundred and thirteen
 * so that what a player is told is something a person has read.
 *
 * The rule is deliberately blunt — a sentence naming the game, the catalogue,
 * the product, an environment as an environment, or what people in general
 * will do, is a sentence about the artefact rather than about the place. Blunt
 * is the right shape here: a false positive costs one sentence of flavour, and
 * a false negative breaks the fiction in front of somebody.
 */

/**
 * Words that only appear when the author has stepped outside the fiction.
 *
 * `reference` catches both "the reference implementation" and "the reference
 * radio site". `experience` catches the one note that appraises itself as an
 * experience. Neither word occurs anywhere in the catalogue in an in-world
 * sense, and the pinned test above is what keeps that true.
 */
const OUT_OF_WORLD =
  /\b(the game|the catalogue|the product|this environment|the audio engine|reference|people will|people love|experience)\b/i;

/**
 * Splits on sentence ends, keeping the punctuation with its sentence.
 *
 * The lookbehind for an abbreviation is not decoration. A sticker in the
 * catalogue reads "DEPT. OF PARKS · CLEARED, with a second stamp beneath it in
 * a language the game never translates", and a naive split cut it after
 * "DEPT." — so the filter kept the abbreviation and threw the sticker away.
 * A full stop after a short run of capitals is an abbreviation, not the end of
 * a sentence.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<![A-Z]{1,5})(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The part of an authored note a player may be shown.
 *
 * Returns an empty string when the whole note is written to the team, which is
 * a real answer: four notes in the catalogue are, and showing nothing is
 * better than showing any of them.
 */
export function inWorld(note: string): string {
  return sentences(note)
    .filter((sentence) => !OUT_OF_WORLD.test(sentence))
    .join(' ');
}

/** True when a note carries a sentence that is addressed to the team. */
export function hasAuthorAside(note: string): boolean {
  return sentences(note).some((sentence) => OUT_OF_WORLD.test(sentence));
}
