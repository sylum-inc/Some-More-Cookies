/**
 * The campsite handed to the simulation, in the words a player may hear.
 *
 * Two things live here, and the second is the reason the first exists.
 *
 * **One builder.** The client assembled this object in two places — once for a
 * solo session and once for a shared one — and they had to agree, because a
 * shared world is rebuilt from the same manifest on every client and a field
 * present in one copy and missing from the other is a desync nobody would
 * find. They agreed by being copied, which is a promise rather than a
 * guarantee. Now there is one of them.
 *
 * **One filter.** Every string that leaves here can end up in front of a
 * person at a fire: the ground note, the wind note, what the place does to a
 * fire, what a landmark is, how a wood was found, what an animal sounds like,
 * what this campsite is for. Nineteen of the catalogue's 386 player-facing
 * prose fields carry a sentence addressed to the team rather than to the
 * player — "the eeriest sound in the game", "the flattest surface in the
 * product", "the funniest thing in the catalogue the first time it happens" —
 * and the first time the survey read a campsite's own notes out loud, two of
 * them arrived in the middle of a night on a plank over a swamp.
 *
 * Those sentences stay in the manifests, where they are the clearest record
 * anywhere of what each campsite is for. They stop here. See
 * `packages/content/src/voice.ts` for the split and `catalogue.test.ts` for
 * the test that holds all 386 of them to it.
 */

import type { EnvironmentManifest } from '@somemore/content';
import { inWorld } from '@somemore/content';
import type { RitualWorldContent } from '@somemore/sim';
import { LAYOUT, campFurniture } from '../scene/layout.js';

/**
 * How far this campsite goes, in metres — for the simulation and for the
 * fence, which must be the same number.
 *
 * They were not. `main.tsx` and `App.tsx`'s session builder handed the
 * simulation the manifest's authored value, while the client's own walkable
 * world clamped it to 16 m. Nothing checked that they agreed, and they did
 * not: `placeLandmarks` and `createGathering` both scale their distances by
 * the radius they are given, so across the twelve manifests 38 of 58
 * landmarks and 43 of 90 fuel patches were being placed outside the fence,
 * and 46 of those outside the 46 m square of ground the renderer draws at
 * all. Every landmark at Copperline Halt, Lantern Mesa and Mirror Flats was
 * somewhere you could not go. The suite did not catch it because
 * `place.spec.ts` asserts landmarks are inside `ritual.options.walkableRadiusM`
 * — the unclamped number — under the name "every landmark the catalogue names
 * is somewhere you can walk to".
 *
 * So there is one function now, and both sides call it.
 *
 * The cap is not the manifests' own ceiling. They author 26 to 70 m, and the
 * drawn world does not go that far: the ground is a plane sized from this
 * number, the trees and understorey are rings inside it, and the far edge of
 * a 70 m campsite would be fog over nothing. 34 m is Pine Hollow's authored
 * value — the campsite every visual baseline and every performance
 * measurement runs on — so the reference environment is exactly what its
 * manifest asks for, and the number is one a person chose for a real place
 * rather than one invented for a clamp.
 */
export const RADIUS_CAP_M = 34;

export function campsiteRadiusM(environment: EnvironmentManifest | undefined): number {
  return Math.max(8, Math.min(RADIUS_CAP_M, environment?.scene.walkableRadiusM ?? 13));
}

/** Passes a note through the voice filter, dropping it if nothing survives. */
function said(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const shown = inWorld(note);
  return shown.length > 0 ? shown : undefined;
}

/** Same, for a field the simulation requires rather than accepts as absent. */
function alwaysSaid(note: string): string {
  return inWorld(note);
}

export function worldContentFor(environment: EnvironmentManifest): RitualWorldContent {
  return {
    // The manifest's own types satisfy the simulation's, so most of the
    // catalogue is handed to the world systems with no adapter in between.
    wildlife: environment.wildlife.map((species) => ({
      ...species,
      note: alwaysSaid(species.note),
    })),
    radio: environment.radio,
    secrets: environment.secrets,
    // Several campsites have no water at all, and `scene.water` is omitted for
    // those — which every activity that needs water checks.
    ...(environment.scene.water ? { water: environment.scene.water } : {}),
    skyOpenness: environment.scene.skyOpenness,
    // Where the firewood at this campsite is, in the catalogue's own words.
    fuel: environment.fuel.sources.map((source) => ({
      ...source,
      foundAs: alwaysSaid(source.foundAs),
    })),
    // And the named things that make this campsite this one.
    landmarks: environment.scene.landmarks.map((landmark) => ({
      ...landmark,
      note: alwaysSaid(landmark.note),
    })),
    trailBearing: Math.atan2(LAYOUT.trailStart[2], LAYOUT.trailStart[0]),
    occupied: campFurniture(),
    // What this site's SM-01 tends to be like. Recognition, never difficulty
    // (§3.3).
    machine: {
      quirkWeights: environment.machine.quirkWeights,
      stickerHint: alwaysSaid(environment.machine.stickerHint),
      flavourNote: alwaysSaid(environment.machine.flavourNote),
      frostNote: alwaysSaid(environment.machine.frostNote),
    },
    // What this campsite is like, in its own words: the weather character, the
    // ambience notes and the ground and elevation the scene manifest describes.
    place: {
      ...pick('ground', said(environment.scene.groundNote)),
      ...pick('elevation', said(environment.scene.elevationNote)),
      ...pick('temperature', said(environment.weatherCharacter.temperatureNote)),
      ...pick('wind', said(environment.weatherCharacter.windNote)),
      ...pick('exposure', said(environment.weatherCharacter.exposureNote)),
      nightRangeC: environment.weatherCharacter.nightRangeC,
      ...pick('insects', said(environment.ambience.insectNote)),
      ...pick('reverb', said(environment.ambience.reverbNote)),
      distant: environment.ambience.distantEvents.map((event) => ({
        ...event,
        note: alwaysSaid(event.note),
      })),
      // How liminal this place is, 1..5. Decides how often and how
      // unpredictably it is heard from a long way off — never anything more
      // than that (schema §2.2: nothing stalks).
      eeriness: environment.character.eeriness,
    },
    // What is different about tonight (§5.4). Five per campsite, each with a
    // range and a note saying what it should drive, and until they were rolled
    // every visit to a campsite was the same visit.
    variations: environment.procedural.variations,
    // What there is to do here, and which of it this campsite is *for*.
    // `prominence` marks that one, and until the survey read it a player who
    // could not see the screen had no way to learn it.
    activities: environment.activities.map((activity) => ({
      id: activity.id,
      label: activity.label,
      prominence: activity.prominence,
      note: alwaysSaid(activity.note),
    })),
  };
}

/** Spreads a key only when there is something to put in it. */
function pick<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
