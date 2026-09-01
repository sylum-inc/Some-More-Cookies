import type { EnvironmentManifest } from '../schema.js';

/**
 * Mirror Flats — the most liminal environment in the catalogue, and the test
 * case for the calibration rule (§2.2).
 *
 * A salt pan under two centimetres of water reflecting the entire sky, one
 * picnic table, one fire, and nothing else in any direction. It is strange the
 * way an empty motel car park at 3am is strange: nothing is wrong, there is
 * simply an enormous amount of nothing, and it is beautiful. Nothing here
 * approaches, follows, or threatens.
 */
export const MIRROR_FLATS: EnvironmentManifest = {
  id: 'mirror_flats',
  name: 'Mirror Flats',
  tagline: 'Two centimetres of water over a hundred square kilometres of salt, holding the whole sky upside down.',
  inspiration:
    'A seasonally flooded salt pan in a continental desert basin — a boat ramp that has not touched water in decades, a picnic table on a gravel island, and a horizon with a visible curve to it.',
  biomeTags: ['salt-pan', 'endorheic-basin', 'desert', 'ephemeral-water'],
  character: {
    temperature: 'warm',
    moisture: 'arid',
    altitude: 'lowland',
    treeCover: 'none',
    water: 'ephemeral-sheet',
    eeriness: 5,
  },
  arrival: {
    approach:
      'A causeway of white gravel, one lane wide, running straight out into the flats with water on both sides that is nowhere deeper than your ankle. It goes on much further than you expect.',
    firstHeard:
      'Your own footsteps, and their reflection off the water, which arrives a fraction late and makes it sound like someone is walking slightly out of step with you. That is all this is, and once you work it out it becomes companionable.',
    firstSeen:
      'Stars. Below you. The water is holding the entire sky and the causeway appears to be floating in space.',
    underfoot:
      'Salt-crusted gravel that crunches like frozen snow, then a centimetre of water that is exactly blood-warm.',
    arrivalBeat:
      'The causeway ends at a gravel island about the size of a tennis court. A picnic table, a fire ring, the SM-01 — and their reflections, going down as far as they go up.',
    walkSeconds: { min: 40, max: 60 },
  },
  scene: {
    ground: 'salt-crust',
    groundNote:
      'Polygonal salt crust, white going grey-violet at night, cracked into plates a metre across. Where it is flooded it is a perfect mirror; where it is dry it crunches.',
    vegetation: [
      { kitId: 'kit_pickleweed', label: 'Pickleweed', density: 4, heightRange: { min: 0.1, max: 0.4 }, lowTierDrop: true, note: 'The only living plant. Low red-green succulent clumps at the island margin, and nothing at all past twenty metres.' },
      { kitId: 'kit_salt_grass', label: 'Salt grass tuft', density: 6, heightRange: { min: 0.1, max: 0.3 }, lowTierDrop: true, note: 'Bleached, sparse, growing out of the gravel where the causeway was built up.' },
    ],
    landmarks: [
      { id: 'picnic_table', label: 'The picnic table', kind: 'camp', handcrafted: true, note: 'Steel frame, wooden top, bolted to a concrete pad on a gravel island in the middle of a salt lake. Somebody decided this should exist and did the work.' },
      { id: 'boat_ramp', label: 'The boat ramp', kind: 'abandoned', handcrafted: true, note: 'A concrete ramp running down into two centimetres of water, with a sign that says NO WAKE. It has not been usable in decades and it is maintained.' },
      { id: 'the_causeway', label: 'The causeway', kind: 'built', handcrafted: true, note: 'Nine hundred metres of white gravel going back the way you came, visible end to end, with your own footprints on it.' },
      { id: 'far_range', label: 'The range on the horizon', kind: 'natural', handcrafted: true, note: 'A low blue line, forty kilometres off, doubled by the water so it reads as a lens rather than a mountain.' },
      { id: 'the_pole', label: 'The measuring pole', kind: 'signage', handcrafted: true, note: 'A striped pole driven into the pan a hundred metres out, marked in centimetres. The water has never reached the second mark.' },
    ],
    elevation: 'flat',
    elevationNote:
      'The flattest surface in the product. Any elevation change here is measured in centimetres and is visible for kilometres.',
    water: {
      kind: 'ephemeral-sheet',
      label: 'The sheet',
      widthM: 2000,
      flow: 'still',
      clarity: 0.5,
      fishable: false,
      skippable: false,
      note: 'Ankle-deep at most, saline, blood-warm, and absolutely still. It is not a lake. It is a mirror with a floor.',
    },
    drawDistanceM: 400,
    fog: { colour: '#141420', density: 0.0018, note: 'Effectively none. The longest sightline in the product; the fog exists only to soften the far range.' },
    nightPalette: {
      zenith: '#04050c',
      horizon: '#191a26',
      ground: '#4a4a52',
      foliage: '#2c3128',
      rock: '#55545a',
      water: '#0a0b14',
      fireGlow: '#ffa757',
      moonlight: '#cfd4e4',
      shadow: '#08080c',
    },
    skyOpenness: 1,
    walkableRadiusM: 70,
  },
  weather: {
    id: 'mirror-flats',
    weights: { clear: 10, 'high-cloud': 3, wind: 2, overcast: 1 },
    baseTempC: 20,
    baseWind: 1.1,
    exposure: 0.6,
    skyEventChance: 0.34,
    skyEvents: ['meteor-shower', 'heat-lightning', 'moonbow'],
    transitionSeconds: 380,
  },
  weatherCharacter: {
    temperatureNote:
      'Warm, even, and unmoving. The water holds the day’s heat and gives it back all night, so the temperature barely changes between arriving and leaving.',
    windNote:
      'Almost none, and when it does come it arrives as a visible line crossing the mirror from kilometres away — you watch the reflection break, travel toward you, and reach you.',
    exposureNote: 'Open on every side, but so still that exposure rarely matters. The rare windy night here is genuinely dramatic.',
    nightRangeC: { min: 14, max: 25 },
  },
  fuel: {
    sources: [
      { woodId: 'mesquite', weight: 5, foundAs: 'A bundle in the bed of the maintenance truck that is parked at the trailhead and never moves.', moistureBias: -0.1 },
      { woodId: 'driftwood', weight: 4, foundAs: 'Wood from an old shoreline, deposited when the lake was a lake, salt-cured and unnaturally light.', moistureBias: -0.14 },
      { woodId: 'oak', weight: 2, foundAs: 'Broken pallet slats stacked behind the boat ramp sign.', moistureBias: -0.08 },
    ],
    note:
      'Ancient shoreline driftwood is so dry and so salt-loaded that it lights instantly and burns with a pale, almost white flame with green at the edges. It is the strangest-looking fire in the catalogue and the fire reflected in the water beneath it doubles the effect exactly.',
  },
  wildlife: [
    {
      id: 'brine_fly',
      label: 'Brine flies',
      shyness: 0.1,
      curiosity: 0.1,
      window: ['dusk'],
      attractedBy: ['warmth', 'water-edge'],
      repelledBy: ['cold-air', 'wind'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['a dark band along the waterline that moves apart as you walk through it'],
      note: 'A carpet of them at the water edge at dusk that opens around your feet and closes behind you. Gone entirely by full dark.',
    },
    {
      id: 'avocet',
      label: 'Avocets',
      shyness: 0.65,
      curiosity: 0.2,
      window: ['dusk', 'pre-dawn'],
      attractedBy: ['quiet', 'water-edge', 'moonlight'],
      repelledBy: ['footsteps', 'flashlight'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['long-toed prints in the salt going out and not coming back'],
      note: 'Wading in the shallow sheet a long way out, upside down in their own reflections, sweeping their bills side to side. Silent unless startled, and then absurdly loud.',
    },
    {
      id: 'kit_fox',
      label: 'Kit fox',
      shyness: 0.68,
      curiosity: 0.85,
      window: ['deep-night'],
      attractedBy: ['food-smell', 'marshmallow-smell', 'stillness', 'firelight'],
      repelledBy: ['sudden-movement', 'camera-flash', 'radio-music'],
      canPersist: true,
      investigatesObjects: true,
      traces: ['tiny prints on the causeway, going out, with a matching set on the reflection', 'a marshmallow taken from an open bag with impressive delicacy'],
      note: 'Ears far too big for it. Trots the causeway on its own errand and detours to the fire out of pure curiosity. Sits down at eight metres and waits to see what you do.',
    },
    {
      id: 'night_heron',
      label: 'Black-crowned night heron',
      shyness: 0.8,
      curiosity: 0.15,
      window: ['deep-night'],
      attractedBy: ['quiet', 'water-edge'],
      repelledBy: ['voices', 'splashing'],
      canPersist: true,
      investigatesObjects: false,
      traces: ['a single large print at the boat ramp waterline'],
      note: 'Announces itself with one flat croak from somewhere overhead and is never seen at all, on most visits. Stands motionless on the boat ramp on a few.',
    },
  ],
  ambience: {
    wind: { character: 'still', baseLevel: 0.1, gustiness: 0.5, material: 'nothing — there is nothing for wind to move' },
    insectDensity: 0.15,
    insectNote: 'A thin high shimmer from the brine flies at dusk and then, after dark, genuinely nothing. Long stretches of true silence are the intended experience.',
    waterPresence: 0.12,
    reverb: 'snowfield',
    reverbNote:
      'Water over flat salt: sound gets one clean specular reflection off the surface and then nothing at all. Voices sound slightly doubled and slightly too close, which is exactly the intended feeling.',
    distantEvents: [
      { id: 'distant_truck', label: 'A truck on the far highway', weight: 4, minGapSeconds: 380, note: 'Ten kilometres off, audible for four minutes, gone. You can see its lights the whole time.' },
      { id: 'salt_tick', label: 'The crust ticking as it cools', weight: 5, minGapSeconds: 100, note: 'Very small, very sharp, from a hundred metres in every direction simultaneously.' },
      { id: 'heron_croak', label: 'A croak, overhead', weight: 3, minGapSeconds: 300, note: 'One note, close, from a bird you never see, and then nothing for an hour.' },
      { id: 'wind_line_arrives', label: 'A wind line crossing the mirror', weight: 3, minGapSeconds: 420, note: 'Visible for thirty seconds before it is audible, and audible for five seconds before you feel it.' },
    ],
    nightFloorDb: -68,
  },
  activities: [
    { id: 'fire-tending', label: 'Tend the fire', prominence: 'available', note: 'Still air, dry fuel, no pressure at all. The most forgiving fire in the catalogue and a good place to just experiment.' },
    { id: 'stargazing', label: 'Stargaze', prominence: 'signature', note: 'You can lie on your back and see the sky, or lie on your front and see the sky. Both work. Zenith to horizon to reflected zenith with no interruption.' },
    { id: 'sky-mirror-walking', label: 'Walk out onto the mirror', prominence: 'signature', note: 'Ankle deep, no destination, in the middle of the reflected sky. The game does not mark a distance limit; it simply gets very quiet and eventually you turn round. The best thing here.' },
    { id: 'telescope', label: 'Telescope', prominence: 'notable', note: 'The table is a perfect mount and the seeing is absurd. Also: point it down.' },
    { id: 'photography', label: 'Photograph', prominence: 'signature', note: 'Perfect symmetry, no clutter, a black sky and one light source. The hero product shot of the entire product is taken here and everyone finds that out on their own.' },
    { id: 'wading', label: 'Wade', prominence: 'notable', note: 'Blood-warm water over hard salt. Every step sends a ring out across the reflected stars for twenty metres.' },
    { id: 'radio', label: 'Radio', prominence: 'available', note: 'The band is wide open and almost empty. Somehow that is the most fitting possible radio experience.' },
    { id: 'flashlight', label: 'Flashlight', prominence: 'available', note: 'The beam goes out across the water and does not come back. There is nothing for it to hit.' },
    { id: 'wildlife-watching', label: 'Watch for wildlife', prominence: 'available', note: 'The kit fox uses the causeway like a road, because it is one.' },
  ],
  radio: {
    stations: [
      { id: 'ksal_1078', dial: 107.8, band: 'fm', name: 'KSAL — Automated', character: 'ambient', reception: 0.68, note: 'An unattended transmitter playing a four-hour playlist that has been on shuffle since before you were born. Station ident every twenty minutes, in a voice recorded once.' },
      { id: 'border_blaster', dial: 1570, band: 'am', name: 'A very large transmitter, somewhere south', character: 'community', reception: 0.8, note: 'Enormous signal, in another language, playing brass band music and then a man talking for a very long time, warmly.' },
      { id: 'the_beacon_310', dial: 310, band: 'am', name: 'NDB — three letters', character: 'environmental', reception: 0.85, note: 'A non-directional beacon repeating three letters in Morse forever. It is the loudest, clearest and least informative signal in the entire product.' },
      { id: 'empty_band', dial: 98.1, band: 'fm', name: 'A carrier with nothing on it', character: 'strange', reception: 0.4, note: 'A dead-flat carrier that suppresses the static entirely. You tune to it and the radio goes silent in a way that is different from being off.' },
    ],
    baseReception: 0.72,
    receptionNote: 'A conductive salt plain is a genuinely excellent ground plane. AM is spectacular. There is simply nothing on it.',
    betweenStations: 'Clean, wide, low static with occasional distant lightning crackles that arrive from storms hundreds of kilometres away.',
  },
  secrets: [
    {
      id: 'mf_the_pole_mark',
      title: 'The second mark on the pole',
      discovery: 'Wade the hundred metres out to the striped measuring pole.',
      telling:
        'The lower marks are stained and worn. The second mark, forty centimetres up, is clean and unstained and has a date scratched beside it in the paint — a date the water has never come close to.',
      channels: ['strange-objects', 'notes'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.4,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'mf_the_table_carving',
      title: 'Under the table',
      discovery: 'The underside of the picnic table top, with a flashlight.',
      telling:
        'A single line burned into the wood with a hot wire: a list of eleven dates in one hand, decades apart, the last one recent. No names. Someone comes back here.',
      channels: ['notes', 'recurring-figures'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.35,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'mf_your_own_light',
      title: 'The other fire',
      discovery: 'Far out on the flats, in the direction of nothing, there is a small orange light.',
      telling:
        'It is the right colour and the right size to be a campfire. Through binoculars it is still just a light. It is gone by dawn, it leaves nothing, and it is almost certainly a reflection of yours in a patch of water at exactly the wrong angle. Almost certainly.',
      channels: ['recurring-figures', 'campsite-changes'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.12,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'mf_the_ramp_sign',
      title: 'Behind the NO WAKE sign',
      discovery: 'The sign is bolted through into a steel post, and something is wedged behind the plate.',
      telling:
        'A laminated photograph of this ramp with a boat on it and water to the top of the concrete, and on the back, in ballpoint: "it was like this. I know."',
      channels: ['strange-objects', 'notes'],
      oneTime: true,
      leavesEvidence: 'The photograph stays wedged into the sign frame face-out afterwards, going slowly yellow across subsequent visits.',
      rarity: 0.22,
      optional: true,
      gatesNothing: true,
    },
  ],
  machine: {
    quirkWeights: { 'long-hold': 3.5, 'flicker-segment': 2.5, 'slow-amber': 2, 'proud-badge': 1.5 },
    flavourNote:
      'Salt has crept up the machine’s feet and left a white tide line thirty centimetres up all four sides. The completion tone here has no reflections to interfere with it, so it is the purest the tone ever sounds — and it carries out over the water for what feels like a kilometre.',
    stickerHint: 'RETURN TO DEPOT IF FOUND, which raises a question nobody answers.',
    frostNote: 'In warm still air the frost forms slowly and evenly and then sweats, and the run-off leaves clean vertical tracks through the salt bloom.',
  },
  procedural: {
    seedStreams: ['scatter', 'weather', 'wildlife', 'radio', 'water', 'sky', 'machine'],
    variations: [
      { id: 'sheet_depth', label: 'Water depth on the pan', range: { min: 0, max: 0.04 }, unit: 'metres', note: 'At zero the mirror is gone and the site becomes a dry white plain — a completely different-looking environment from the same manifest. This is the biggest single seeded variation in the catalogue.' },
      { id: 'crust_polygon_scale', label: 'Salt polygon size', range: { min: 0.6, max: 1.8 }, unit: 'metres', note: 'The texture of the ground where it is dry.' },
      { id: 'far_range_haze', label: 'Haze on the far range', range: { min: 0.1, max: 0.9 }, unit: 'normalised', note: 'Whether the horizon is a hard line or a suggestion.' },
      { id: 'fox_visit', label: 'Kit fox arrival', range: { min: 0, max: 1 }, unit: 'probability', note: 'It has its own night and you are not necessarily part of it.' },
      { id: 'mirage_strength', label: 'Residual mirage', range: { min: 0, max: 0.5 }, unit: 'normalised', note: 'Late-evening thermal shimmer on the far range, fading as the ground cools.' },
    ],
    invariants: [
      'The picnic table bolted to its pad.',
      'The boat ramp and the NO WAKE sign.',
      'The nine-hundred-metre causeway.',
      'The striped pole a hundred metres out.',
    ],
  },
  discovery: {
    weight: 6,
    affinities: { 'arid-interior': 2.5, 'continental-interior': 1.4, mediterranean: 1.1, highland: 0.9, unknown: 1, 'humid-subtropical': 0.6, boreal: 0.5, 'maritime-west': 0.6, 'maritime-east': 0.5 },
    note: 'The rarest of the core set — it should feel like a place you were sent to rather than one you found. Still fully reachable from every region, including on a first draw.',
  },
  performance: {
    cost: 'light',
    midTierDrawCalls: 34,
    midTierTriangles: 12000,
    dynamicLights: 3,
    lowTierCuts: [
      'The mirror becomes a single reflected skybox plus a reflected fire sprite rather than a live planar pass — this is nearly free and looks almost identical at this camera height.',
      'Star field 1400 → 500 points.',
      'Ripple rings from wading cap at 6 concurrent instead of 24.',
      'Draw distance 400m → 200m; the far range becomes a painted band on the skybox.',
    ],
    note: 'The least geometry in the product by a wide margin: a table, a ramp, a sign, a pole and a plane. It runs on anything, and it is arguably the best-looking environment in the catalogue, which is a useful thing to be able to point at.',
  },
};
