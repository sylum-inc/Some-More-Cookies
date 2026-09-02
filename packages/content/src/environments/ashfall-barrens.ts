import type { EnvironmentManifest } from '../schema.js';

/**
 * Ashfall Barrens — black ground, steam, and a hot spring that makes this the
 * only environment where the cold air and the warm water disagree.
 *
 * The strangest-looking place in the catalogue and deliberately the friendliest
 * in its details: the ground is volcanic ash, the ambience is geothermal, and
 * the one built object is a wooden soaking box somebody maintains.
 */
export const ASHFALL_BARRENS: EnvironmentManifest = {
  id: 'ashfall_barrens',
  name: 'Ashfall Barrens',
  tagline: 'Black ground, white steam, and a wooden tub somebody keeps clean for no reason anyone can name.',
  inspiration:
    'A young volcanic plateau in a cold maritime north — pumice flats, twisted survivor pines, a geothermal seep, and a footpath marked with painted stakes because there are no other landmarks.',
  biomeTags: ['volcanic-plateau', 'geothermal', 'subarctic', 'pumice-barrens'],
  character: {
    temperature: 'cool',
    moisture: 'damp',
    altitude: 'montane',
    treeCover: 'sparse',
    water: 'hot-spring',
    eeriness: 4,
  },
  arrival: {
    approach:
      'A path of yellow-painted stakes across an entirely featureless black plain. You count them, because there is nothing else to do and because you want to know how many there are.',
    firstHeard:
      'A hiss. Continuous, directionless, coming from the ground rather than from any particular place — and under it, very faint, water moving somewhere underneath you.',
    firstSeen:
      'Steam, going straight up in three separate columns, lit from below by something orange that turns out to be the fire.',
    underfoot:
      'Coarse black ash that squeaks and slides. Every footprint is perfect and stays perfect.',
    arrivalBeat:
      'The last stake is right at the edge of the site and the ground changes to gravel and there is the fire, a wooden tub steaming beside it, and a single bent pine standing over both.',
    walkSeconds: { min: 36, max: 55 },
  },
  scene: {
    ground: 'volcanic-ash',
    groundNote:
      'Coarse black-grey pumice grit, with rust-orange and sulphur-yellow mineral staining radiating out from every vent. Firelight on black ash goes almost nowhere, so the lit area is small and very defined.',
    vegetation: [
      { kitId: 'kit_survivor_pine', label: 'Survivor pine', density: 1.4, heightRange: { min: 2, max: 7 }, lowTierDrop: false, note: 'Wind-twisted, half of every tree dead and silver, half stubbornly green. There are nine of them in the whole environment and each is individually placed.' },
      { kitId: 'kit_thermal_moss', label: 'Thermal moss', density: 40, heightRange: { min: 0.02, max: 0.1 }, lowTierDrop: true, note: 'Vivid green, growing only in the warm ground around the vents, in rings. The only saturated colour in the environment.' },
      { kitId: 'kit_lupine', label: 'Ash lupine', density: 7, heightRange: { min: 0.2, max: 0.7 }, lowTierDrop: true, note: 'The first plant back after an eruption. Grey-green leaves that hold single drops of condensed steam.' },
    ],
    landmarks: [
      { id: 'the_tub', label: 'The soaking box', kind: 'built', handcrafted: true, note: 'A cedar box fed by a pipe hammered into the seep, with a plug on a chain, a wooden bench, and a broom leaning against it. Someone maintains this. Nobody is ever here.' },
      { id: 'bent_pine', label: 'The bent pine', kind: 'natural', handcrafted: true, note: 'Bowed almost to horizontal and still alive, with the site sheltered in its lee. It is the only thing here taller than a person.' },
      { id: 'stake_line', label: 'The line of stakes', kind: 'signage', handcrafted: true, note: 'Thirty-one yellow-painted stakes going back the way you came. The count is always thirty-one.' },
      { id: 'steam_vents', label: 'The three vents', kind: 'natural', handcrafted: true, note: 'Fumaroles in a rough triangle around the site, hissing continuously, warm enough to stand over on a cold night.' },
      { id: 'ash_dunes', label: 'The ash dunes', kind: 'natural', handcrafted: false, note: 'Low wind-shaped ridges to the north, redrawn between visits, holding every footprint until they are.' },
    ],
    elevation: 'gentle',
    elevationNote:
      'Nearly flat with long low swells. The lack of relief is the point — this is a place where a single tree is a landmark.',
    water: {
      kind: 'hot-spring',
      label: 'The seep and the box',
      widthM: 2.2,
      flow: 'seeping',
      clarity: 0.8,
      fishable: false,
      skippable: false,
      note: 'Forty-one degrees at the pipe, mineral, faintly sulphurous, with a permanent skin of steam. The only warm water in the catalogue.',
    },
    drawDistanceM: 120,
    fog: { colour: '#2a2b2c', density: 0.021, note: 'Steam haze rather than fog, moving in slow sheets, thicker downwind of the vents and effectively absent upwind.' },
    nightPalette: {
      zenith: '#060810',
      horizon: '#1e2126',
      ground: '#22211f',
      foliage: '#1d2a1e',
      rock: '#33322f',
      water: '#2c3a3c',
      fireGlow: '#ff9542',
      moonlight: '#a9b6c6',
      shadow: '#050506',
    },
    skyOpenness: 0.88,
    walkableRadiusM: 44,
  },
  weather: {
    id: 'ashfall-barrens',
    weights: { overcast: 4, fog: 4, wind: 4, 'high-cloud': 3, clear: 3, 'light-rain': 3, rain: 2, snow: 2, 'snow-squall': 1 },
    baseTempC: 6,
    baseWind: 2.9,
    exposure: 0.7,
    skyEventChance: 0.26,
    skyEvents: ['aurora', 'meteor-shower'],
    transitionSeconds: 150,
  },
  weatherCharacter: {
    temperatureNote:
      'Cold air over warm ground. Standing in the right place you are warm from below and cold from above at the same time, and finding those places is half the pleasure of the site.',
    windNote: 'Comes across the flats with nothing to slow it and bends the steam columns flat, which is how you see the wind before you feel it.',
    exposureNote: 'Exposed, but the bent pine and the tub make a real pocket, and the warm ground around the vents means the fire is never the only heat.',
    nightRangeC: { min: -2, max: 9 },
  },
  fuel: {
    sources: [
      { woodId: 'pine', weight: 5, foundAs: 'Dead limbs off the survivor pines, silvered and resin-hard.', moistureBias: -0.02 },
      { woodId: 'birch', weight: 4, foundAs: 'A stack under a tarp by the tub, replenished by whoever looks after this place.', moistureBias: -0.06 },
      { woodId: 'driftwood', weight: 2, foundAs: 'Pieces washed down the melt channel and dried on the warm ground beside a vent.', moistureBias: -0.12 },
    ],
    note:
      'Anything left on the warm ground by a vent for an hour comes out drier than it went in, which is a genuinely useful trick and one the environment never explains. Birch bark from the tarp stack lights in a breath, even in rain.',
  },
  wildlife: [
    {
      id: 'arctic_hare',
      label: 'Mountain hare',
      shyness: 0.7,
      curiosity: 0.4,
      window: ['dusk', 'deep-night', 'pre-dawn'],
      attractedBy: ['warmth', 'stillness', 'quiet'],
      repelledBy: ['flashlight', 'footsteps', 'sudden-movement'],
      canPersist: true,
      investigatesObjects: false,
      traces: ['big splayed prints crossing the ash in a dead straight line', 'droppings on the warm ground by the second vent'],
      note: 'Sits on the warm ground near a vent for long periods, absolutely motionless, and is only visible because the steam moves around it.',
    },
    {
      id: 'raven',
      label: 'Raven',
      shyness: 0.45,
      curiosity: 1,
      window: ['dusk', 'dawn'],
      attractedBy: ['food-smell', 'crumbs', 'machine-hum', 'voices'],
      repelledBy: ['sudden-movement'],
      canPersist: true,
      investigatesObjects: true,
      traces: ['a shiny object placed on the tub bench', 'the broom moved', 'a foil corner wedged in the bent pine'],
      note: 'One bird, the same bird, with a gap in its primaries. Watches every stage of the ritual from the top of the pine and makes a sound like a dripping tap when the machine finishes.',
    },
    {
      id: 'ptarmigan',
      label: 'Ptarmigan',
      shyness: 0.5,
      curiosity: 0.3,
      window: ['dawn', 'dusk'],
      attractedBy: ['quiet', 'stillness'],
      repelledBy: ['footsteps', 'wind'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['a roost hollow scraped in the ash'],
      note: 'Nearly invisible until it moves, and then it moves like a wind-up toy. Makes a sound like someone laughing quietly at the far end of a corridor.',
    },
    {
      id: 'thermal_midge',
      label: 'Steam midges',
      shyness: 0,
      curiosity: 0.1,
      window: ['dusk', 'early-night', 'deep-night', 'pre-dawn'],
      attractedBy: ['warmth', 'firelight'],
      repelledBy: ['wind', 'cold-air'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['none'],
      note: 'A column of them dancing over each vent, all night, in the cold, because the ground is warm. Harmless, silent, and the only insects for kilometres.',
    },
  ],
  ambience: {
    wind: { character: 'buffeting', baseLevel: 0.44, gustiness: 0.7, material: 'ash grit against ash grit, and one bent pine' },
    insectDensity: 0.12,
    insectNote: 'Only the midge columns over the vents, and they are visual rather than audible — the insect layer in the mix is almost nothing.',
    waterPresence: 0.35,
    reverb: 'snowfield',
    reverbNote:
      'Dead. Coarse ash absorbs like fresh snow and there is nothing to reflect off, so sound simply stops existing about ten metres out. The steam hiss fills the space that reverb would normally occupy.',
    distantEvents: [
      { id: 'vent_surge', label: 'A vent changes note', weight: 6, minGapSeconds: 80, note: 'The hiss drops a fifth for thirty seconds and comes back. The ground does this on its own schedule.' },
      { id: 'ground_thump', label: 'A single thump underground', weight: 3, minGapSeconds: 500, note: 'Felt through the boots more than heard. One, never two.' },
      { id: 'raven_far', label: 'The raven, elsewhere', weight: 4, minGapSeconds: 200, note: 'Three knocks from somewhere across the flats, and then it is back on the pine and you did not see it move.' },
      { id: 'wind_line', label: 'A wind line crosses the flats', weight: 5, minGapSeconds: 120, note: 'You watch the steam columns bend one after another as it comes, and then it hits.' },
    ],
    nightFloorDb: -56,
  },
  activities: [
    { id: 'fire-tending', label: 'Tend the fire', prominence: 'notable', note: 'Windy and open, but the vents let you pre-dry fuel — the one place where preparation beats technique.' },
    { id: 'hot-spring-soak', label: 'Soak in the box', prominence: 'signature', note: 'Pull the plug, let it drain and refill, wait. Sit in it in the cold with steam coming off the water and the fire ten feet away. The single most relaxing thing in the product.' },
    { id: 'stargazing', label: 'Stargaze', prominence: 'notable', note: 'From the tub, ideally. Aurora is genuinely likely here and it is the best place in the catalogue to see one.' },
    { id: 'photography', label: 'Photograph', prominence: 'notable', note: 'Steam backlit by firelight against black ground. The sandwich frosted, on black ash, with a vent hissing behind it.' },
    { id: 'radio', label: 'Radio', prominence: 'notable', note: 'Odd. Geomagnetic activity does audible things to the band here, and when the aurora is up, so is the static.' },
    { id: 'flashlight', label: 'Flashlight', prominence: 'available', note: 'The beam is visible as a solid bar in the steam and completely invisible outside it.' },
    { id: 'wildlife-watching', label: 'Watch for wildlife', prominence: 'available', note: 'The raven watches back, which is not the same thing.' },
    { id: 'foraging', label: 'Dry fuel on the warm ground', prominence: 'notable', note: 'Not really foraging. More like discovering that the ground is an appliance.' },
    { id: 'snow-tracking', label: 'Read the ash', prominence: 'available', note: 'Every print from the whole night is still there, including the ones that were there when you arrived.' },
  ],
  radio: {
    stations: [
      { id: 'kfla_1029', dial: 102.9, band: 'fm', name: 'Coastal FM, relayed', character: 'ambient', reception: 0.5, note: 'A relay of a station on the coast, two hundred kilometres away, playing whatever a small station plays at two in the morning.' },
      { id: 'geo_obs', dial: 4625, band: 'shortwave', name: 'Geophysical observatory', character: 'environmental', reception: 0.55, note: 'K-index, magnetometer readings, a station name, and a long pause. Read by someone who is also awake at this hour.' },
      { id: 'aurora_static', dial: 27.185, band: 'shortwave', name: 'The band when the aurora is up', character: 'strange', reception: 0.25, note: 'Not a station. A whistling descending tone — a real atmospheric phenomenon — that arrives at random and cannot be tuned to, only caught.' },
      { id: 'harbour_relay', dial: 1503, band: 'am', name: 'Harbour and road report', character: 'weather-service', reception: 0.62, note: 'The pass is closed. The pass has been closed for a while. Nobody sounds worried about it.' },
      { id: 'kbex_913', dial: 91.3, band: 'fm', name: 'KBEX — Night Kitchen', character: 'lofi', reception: 0.38, note: 'A three-hour block of warm tape loops that fades out entirely when the wind rises and comes back when it drops.' },
    ],
    baseReception: 0.48,
    receptionNote: 'Flat ground and no obstruction, but the geomagnetic latitude is high and the band goes strange without warning. When the aurora shows, the radio hears it first.',
    betweenStations: 'Hissy, with slow rising and falling swells that track the aurora exactly, which players will notice and be delighted by.',
  },
  secrets: [
    {
      id: 'ab_who_keeps_the_tub',
      title: 'Whoever keeps the tub',
      discovery: 'The broom is in a different position than you left it. So is the plug chain. The tarp stack has been restocked.',
      telling:
        'A pencilled note under the bench lists dates and one-word conditions — CLEAN, ALGAE, CLEAN, FROZEN, CLEAN — going back years, in one handwriting, with no name.',
      channels: ['notes', 'campsite-changes'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.5,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ab_thirty_second_stake',
      title: 'The thirty-second stake',
      discovery: 'Walk out past the last stake in the direction the line was going.',
      telling:
        'There is another one, out of sight of the rest, painted a different yellow and much older. Past it there is nothing at all, and the line does not continue.',
      channels: ['strange-objects'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.28,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ab_the_ground_breathes',
      title: 'The night the vents go quiet',
      discovery: 'All three fumaroles stop, together, for about ninety seconds.',
      telling:
        'The steam columns collapse, the midges scatter, the reverb of the whole environment changes because the hiss that was masking everything is gone — and you discover you can hear the fire from thirty metres. Then it comes back on, all three at once.',
      channels: ['distant-sounds', 'campsite-changes'],
      oneTime: true,
      leavesEvidence: 'Afterwards a thin new vent opens beside the tub, hissing quietly, and it is there on every future visit.',
      rarity: 0.1,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ab_ravens_shelf',
      title: 'The raven’s shelf',
      discovery: 'A ledge in the bent pine, above head height, reachable if you stand on the tub bench.',
      telling:
        'Wire, foil, a bottle cap, a small brass screw, and one item that belongs to your camp and was not missing.',
      channels: ['wildlife-behaviour', 'strange-objects'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.3,
      optional: true,
      gatesNothing: true,
    },
  ],
  machine: {
    quirkWeights: { 'early-frost': 3, 'flicker-segment': 2.5, 'long-hold': 2.5, 'double-relay': 2 },
    flavourNote:
      'Minerals from the steam have etched a permanent pale bloom across the machine’s windward panel, in a pattern like frost that never leaves. The unit sits on a bed of gravel someone levelled by hand, and the completion tone carries an absurd distance across the flats.',
    stickerHint: 'DEPT. OF PARKS · CLEARED, with a second stamp beneath it in a language nobody here reads. The game never translates it.',
    frostNote: 'Real frost lands on top of the mineral bloom and for about a minute you cannot tell which is which.',
  },
  procedural: {
    seedStreams: ['scatter', 'weather', 'wildlife', 'radio', 'vents', 'ash', 'machine'],
    variations: [
      { id: 'vent_intensity', label: 'Vent output', range: { min: 0.3, max: 1.2 }, unit: 'multiplier', note: 'Drives steam volume, the hiss level, warm-ground extent and how much of the site is visible.' },
      { id: 'ash_dune_shape', label: 'Ash dune profile', range: { min: 0, max: 1 }, unit: 'variant', note: 'The dunes are completely redrawn between visits. Your footprints from last time are gone; somebody else’s might not be.' },
      { id: 'tub_temperature', label: 'Water in the box', range: { min: 34, max: 44 }, unit: 'degrees C', note: 'Some nights it is perfect. Some nights you wait for it to cool.' },
      { id: 'geomagnetic', label: 'Geomagnetic activity', range: { min: 0, max: 1 }, unit: 'normalised', note: 'Couples aurora likelihood to radio band conditions, so the two systems agree.' },
      { id: 'moss_ring_extent', label: 'Thermal moss rings', range: { min: 0.5, max: 1.5 }, unit: 'multiplier', note: 'How much green there is in an otherwise entirely grey environment.' },
    ],
    invariants: [
      'Thirty-one yellow stakes.',
      'The bent pine and its lee.',
      'The cedar soaking box, the pipe, the plug chain and the broom.',
      'Three vents in a triangle.',
    ],
  },
  discovery: {
    weight: 7,
    affinities: { boreal: 2.2, highland: 1.7, 'maritime-west': 1.3, 'maritime-east': 1.2, unknown: 1, 'continental-interior': 0.8, mediterranean: 0.6, 'arid-interior': 0.7, 'humid-subtropical': 0.4 },
    note: 'One of the rarer, stranger sites. Weighted north and high, and — like everything here — eventually reachable from every region.',
  },
  performance: {
    cost: 'moderate',
    midTierDrawCalls: 61,
    midTierTriangles: 26000,
    dynamicLights: 4,
    lowTierCuts: [
      'Steam columns go from volumetric billboard stacks to three flat animated sprites — the biggest saving here by far.',
      'Midge columns become a single animated texture per vent.',
      'Thermal moss and lupine scatter drop to 30%.',
      'Ash footprint decals cap at 40 and fade oldest-first instead of persisting for the session.',
    ],
    note: 'Almost no geometry — nine trees and a wooden box. All of the cost is steam overdraw, and steam is the one thing that must survive the cut in some form.',
  },
};
