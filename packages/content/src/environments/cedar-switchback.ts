import type { EnvironmentManifest } from '../schema.js';

/**
 * Cedar Switchback — enormous trees, a loud creek in a slot, and the best
 * reverb in the product.
 *
 * The vertical environment. Everything else in the catalogue is about horizon;
 * this one is about looking up and about a canyon that answers you.
 */
export const CEDAR_SWITCHBACK: EnvironmentManifest = {
  id: 'cedar_switchback',
  name: 'Cedar Switchback',
  tagline: 'Trees like cathedral columns, a creek in a slot below, and an echo that takes its time.',
  inspiration:
    'A temperate rainforest canyon on a wet coastal range — old-growth cedar, moss on everything, a trail of cut-log stairs, and a plank bridge over water you can hear from four hundred metres away.',
  biomeTags: ['temperate-rainforest', 'old-growth', 'canyon', 'mossy'],
  character: {
    temperature: 'mild',
    moisture: 'wet',
    altitude: 'montane',
    treeCover: 'canopy',
    water: 'creek',
    eeriness: 2,
  },
  arrival: {
    approach:
      'Switchbacks cut into a slope so steep the trail has stairs made of split rounds pinned with rebar. Ferns at head height on the uphill side. It smells overwhelmingly green.',
    firstHeard:
      'The creek, and then the creek again from a completely different direction, because the canyon is throwing it back at you.',
    firstSeen:
      'A trunk. Just one, filling your entire view at three metres, with bark in vertical ribbons and moss growing on the moss.',
    underfoot:
      'Wet duff and cedar stairs with chicken wire stapled to them for grip, half of it lifted.',
    arrivalBeat:
      'The last switchback comes out onto a flat bench between two enormous cedars, and the fire is there, and the sound of the creek drops by half because the bench is out of the slot.',
    walkSeconds: { min: 38, max: 58 },
  },
  scene: {
    ground: 'moss-duff',
    groundNote:
      'Deep red-brown cedar litter under a continuous moss carpet that climbs everything vertical it touches. Absolutely silent to walk on and permanently damp.',
    vegetation: [
      { kitId: 'kit_old_cedar', label: 'Old-growth redcedar', density: 2.2, heightRange: { min: 35, max: 60 }, lowTierDrop: false, note: 'Four to six metres through at the base, fluted, going up out of the top of the frame. The whole environment is designed around not being able to see the tops.' },
      { kitId: 'kit_hemlock', label: 'Western hemlock', density: 8, heightRange: { min: 12, max: 30 }, lowTierDrop: false, note: 'The middle storey. Droopy leaders, dark, and the layer that actually closes the canopy.' },
      { kitId: 'kit_swordfern', label: 'Sword fern', density: 70, heightRange: { min: 0.6, max: 1.4 }, lowTierDrop: true, note: 'Wall to wall on the slope. Firelight through fern fronds is one of the best-looking things in the product.' },
      { kitId: 'kit_devils_club', label: 'Devil’s club', density: 10, heightRange: { min: 1.2, max: 2.5 }, lowTierDrop: true, note: 'Enormous maple-shaped leaves on spined stems along the wet seep. Visually striking; the trail carefully goes around it.' },
      { kitId: 'kit_nurse_log', label: 'Nurse logs', density: 3, heightRange: { min: 0.8, max: 2 }, lowTierDrop: false, note: 'Fallen giants with a straight line of young hemlock growing out of the top of each. The clearest visual statement of what this forest is doing.' },
    ],
    landmarks: [
      { id: 'the_two_cedars', label: 'The two cedars', kind: 'natural', handcrafted: true, note: 'The bench sits between them. One is hollow at the base — a burned-out cavity a person can stand inside, dry in any weather.' },
      { id: 'plank_bridge', label: 'The plank bridge', kind: 'built', handcrafted: true, note: 'Two planks and a hand cable across the slot, four metres above the water, with a section of the cable replaced in newer wire.' },
      { id: 'the_slot', label: 'The slot', kind: 'water', handcrafted: true, note: 'The creek in a narrow gorge of water-carved rock, with a pool at the bottom that holds a green light even at night.' },
      { id: 'trail_sign', label: 'The routed trail sign', kind: 'signage', handcrafted: true, note: 'Cedar, routed lettering, arrows, and distances in miles to places you will not be going. One arrow has been prised off. The game never shows those places.' },
      { id: 'the_cache_box', label: 'The trail cache', kind: 'built', handcrafted: false, note: 'An ammunition box wired to a stump with a logbook, a pencil stub, three lighters and a small ceramic bird in it.' },
    ],
    elevation: 'steep',
    elevationNote:
      'Everything is on an angle except the bench, and the bench is flat because somebody cut it flat a long time ago. Above and below, the slope goes on out of sight.',
    water: {
      kind: 'creek',
      label: 'The creek in the slot',
      widthM: 4,
      flow: 'rushing',
      clarity: 0.9,
      fishable: true,
      skippable: true,
      note: 'Loud, cold, and fast in the slot, with a deep still pool at the bottom of the last fall. The pool is the only quiet water and the only place a stone will skip.',
    },
    drawDistanceM: 42,
    fog: { colour: '#1d2620', density: 0.036, note: 'Green-grey and layered, sitting in bands between the trunks. It moves upward, which is unusual and correct.' },
    nightPalette: {
      zenith: '#060a0b',
      horizon: '#141d18',
      ground: '#2a2118',
      foliage: '#18291b',
      rock: '#3b4038',
      water: '#1b2a2a',
      fireGlow: '#ff9a4e',
      moonlight: '#7f9a95',
      shadow: '#040706',
    },
    skyOpenness: 0.08,
    walkableRadiusM: 30,
  },
  weather: {
    id: 'cedar-switchback',
    weights: { 'light-rain': 5, overcast: 5, rain: 4, fog: 4, 'high-cloud': 2, clear: 2, storm: 1 },
    baseTempC: 12,
    baseWind: 0.5,
    exposure: 0.15,
    skyEventChance: 0.05,
    skyEvents: ['meteor-shower'],
    transitionSeconds: 230,
  },
  weatherCharacter: {
    temperatureNote:
      'Mild and unchanging. The canopy is a lid: it is warmer here at 3am than it is a hundred metres up the slope, and you can feel that.',
    windNote:
      'You never feel wind at the bench. You hear it in the canopy sixty metres up as a distant sea, entirely disconnected from the still air around the fire.',
    exposureNote:
      'Heavy rain reaches the fire as an occasional large drop rather than as rain. The most sheltered site in the catalogue after Cicada Bottoms.',
    nightRangeC: { min: 7, max: 15 },
  },
  fuel: {
    sources: [
      { woodId: 'pine', weight: 4, foundAs: 'Hemlock deadfall from the slope, everywhere, and damp all the way through.', moistureBias: 0.22 },
      { woodId: 'birch', weight: 3, foundAs: 'Red alder from the creek bank, straight and easy to break.', moistureBias: 0.16 },
      { woodId: 'oak', weight: 2, foundAs: 'Split maple from a stack inside the hollow cedar, dry because the tree is a roof.', moistureBias: -0.12 },
      { woodId: 'driftwood', weight: 2, foundAs: 'Wedged in the slot by high water and dried out by wind funnelling through the gorge.', moistureBias: 0.02 },
    ],
    note:
      'Everything on the forest floor is wet. The stack inside the hollow cedar is the answer and it is the best-kept secret in the catalogue: a dry woodshed inside a living tree, restocked by nobody in particular. Cedar bark shredded off a trunk lights in one strike and smells like the entire coast.',
  },
  wildlife: [
    {
      id: 'varied_thrush',
      label: 'Varied thrush',
      shyness: 0.75,
      curiosity: 0.25,
      window: ['dusk', 'dawn'],
      attractedBy: ['quiet', 'stillness'],
      repelledBy: ['voices', 'footsteps'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['none'],
      note: 'A single long buzzing note on one pitch, then a long pause, then the same note a semitone away. Sounds like the forest itself is tuning up. The most unmistakable sound in the game.',
    },
    {
      id: 'pacific_wren',
      label: 'Pacific wren',
      shyness: 0.6,
      curiosity: 0.8,
      window: ['dusk', 'dawn'],
      attractedBy: ['stillness', 'crumbs'],
      repelledBy: ['sudden-movement'],
      canPersist: true,
      investigatesObjects: true,
      traces: ['moss pulled loose at the base of a nurse log'],
      note: 'The size of a walnut, with a song about eight seconds long and roughly forty notes in it. Investigates your boots at close range and takes offence at everything.',
    },
    {
      id: 'black_bear_sign',
      label: 'Black bear (sign only)',
      shyness: 1,
      curiosity: 0.4,
      window: ['deep-night'],
      attractedBy: ['food-smell', 'quiet'],
      repelledBy: ['firelight', 'voices', 'radio-music'],
      canPersist: true,
      investigatesObjects: false,
      traces: ['claw marks in the moss on a cedar', 'a rolled-over nurse log with the bark stripped', 'a print in the mud at the pool, filled with water'],
      note: 'Never appears. Never approaches. Never seen at any point, by design — the calibration rule means nothing here can read as a threat. You find its work in the morning and that is all.',
    },
    {
      id: 'rough_skinned_newt',
      label: 'Newts',
      shyness: 0.2,
      curiosity: 0.05,
      window: ['early-night', 'deep-night'],
      attractedBy: ['rain', 'water-edge'],
      repelledBy: ['cold-air'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['none'],
      note: 'Orange underneath, walking across the trail with total unconcern after rain at a pace that suggests they have all night. They do.',
    },
    {
      id: 'flying_squirrel_cedar',
      label: 'Flying squirrel',
      shyness: 0.9,
      curiosity: 0.6,
      window: ['deep-night'],
      attractedBy: ['stillness', 'quiet', 'crumbs'],
      repelledBy: ['flashlight', 'voices'],
      canPersist: true,
      investigatesObjects: true,
      traces: ['a soft landing thump on the cache box lid', 'claws on bark, above'],
      note: 'Comes down the trunk in short bursts, headfirst, and stops dead each time you look up. Takes a graham cracker corner off the log if you have been quiet for several minutes.',
    },
  ],
  ambience: {
    wind: { character: 'channelled', baseLevel: 0.18, gustiness: 0.35, material: 'canopy sixty metres up, heard and never felt' },
    insectDensity: 0.25,
    insectNote: 'Few, and mostly a single cranefly bouncing off things. Too wet and too cool for a chorus; the water does the work the insects do elsewhere.',
    waterPresence: 0.85,
    reverb: 'canyon',
    reverbNote:
      'The best space in the product. The slot returns a hard first reflection at about 0.4 seconds and the far canyon wall gives a second at 1.6, so a shout comes back twice, distinctly. The two cedars add a close wooden warmth on top. Everything recorded here sounds expensive.',
    distantEvents: [
      { id: 'canopy_drop', label: 'A canopy drop lands', weight: 6, minGapSeconds: 40, note: 'One very large drop hitting a fern from sixty metres up. It is not raining. It is never entirely not raining.' },
      { id: 'limb_fall', label: 'A limb comes down somewhere', weight: 3, minGapSeconds: 350, note: 'A long tearing crack and then a series of impacts. Always far. Always fine.' },
      { id: 'thrush_far', label: 'The thrush, further along the slope', weight: 5, minGapSeconds: 130, note: 'One note, and its echo off the far wall, arriving as a chord.' },
      { id: 'log_shift', label: 'A nurse log settles', weight: 4, minGapSeconds: 260, note: 'A slow wooden groan from a tree that fell over a century ago and is still going.' },
      { id: 'creek_stone', label: 'A stone moves in the slot', weight: 4, minGapSeconds: 180, note: 'A knock under the water sound, and the note of the whole creek changes slightly and stays changed.' },
    ],
    nightFloorDb: -40,
  },
  activities: [
    { id: 'fire-tending', label: 'Tend the fire', prominence: 'notable', note: 'Damp fuel and no wind. Airflow is the whole problem here — a smothered stack will smoke for twenty minutes and teach you more than any tutorial.' },
    { id: 'echo-calling', label: 'Call into the slot', prominence: 'signature', note: 'Two returns at different delays and different tones. Clap, shout, sing a note, hold it. This is the reason the audio engine has a canyon impulse response.' },
    { id: 'stone-skipping', label: 'Skip stones in the pool', prominence: 'available', note: 'One quiet pool at the bottom of the fall. Every skip comes back off the rock as a separate tap.' },
    { id: 'fishing', label: 'Fish the pool', prominence: 'available', note: 'Small cutthroat holding in the seam. Sight fishing by lantern light, which barely works and is lovely.' },
    { id: 'photography', label: 'Photograph', prominence: 'notable', note: 'Fern fronds and fog bands lit from below. The forest gives you a natural vignette in every direction.' },
    { id: 'radio', label: 'Radio', prominence: 'available', note: 'The worst reception in the catalogue. Two stations, both faint, both good.' },
    { id: 'flashlight', label: 'Flashlight', prominence: 'notable', note: 'Point it straight up. The beam disappears into canopy without ever finding a top, and that is the moment this environment lands.' },
    { id: 'wildlife-watching', label: 'Watch for wildlife', prominence: 'available', note: 'The wren finds you. Everything else has to be waited for.' },
    { id: 'foraging', label: 'Strip cedar bark for tinder', prominence: 'available', note: 'From a dead trunk only. Comes off in long fibrous ribbons that light instantly even soaked.' },
    { id: 'strange-objects', label: 'The trail cache', prominence: 'available', note: 'An ammo box on a stump with a logbook and a small ceramic bird in it.' },
  ],
  radio: {
    stations: [
      { id: 'kcdr_889', dial: 88.9, band: 'fm', name: 'KCDR — Community', character: 'lofi', reception: 0.3, note: 'A volunteer overnight show from a town down the valley. Somebody’s carefully sequenced two hours of quiet records, on a signal that keeps almost going away.' },
      { id: 'marine_wx_cedar', dial: 162.55, band: 'fm', name: 'Coastal forecast', character: 'weather-service', reception: 0.4, note: 'Inland waters, small craft advisory, and a list of buoys reporting. Comes in only from the bridge, where the slot opens west.' },
      { id: 'cb_19', dial: 27.185, band: 'shortwave', name: 'Channel 19', character: 'community', reception: 0.5, note: 'Trucks on the highway over the pass, in fragments, mid-conversation, gone.' },
      { id: 'the_slot_signal', dial: 1710, band: 'am', name: 'Something in the slot', character: 'strange', reception: 0.2, note: 'Only receivable standing on the plank bridge. A slow repeated four-note figure on something like a music box, with the creek audible in the background of the transmission — which would mean it is being transmitted from here.' },
    ],
    baseReception: 0.28,
    receptionNote: 'Six hundred metres of wet timber and rock in every direction. Reception is a place you walk to rather than a thing you tune for, which makes the radio a location activity here.',
    betweenStations: 'Deep, soft, almost pleasant static — the canopy attenuates the high end out of the noise itself.',
  },
  secrets: [
    {
      id: 'cs_hollow_cedar',
      title: 'Inside the hollow cedar',
      discovery: 'The burned-out cavity at the base of the north cedar is big enough to stand in.',
      telling:
        'Dry ground, a stack of split maple, a shelf cut into the living wood, and eleven candle stubs on it in a row. The wood is stacked by somebody who intends to come back and never seems to.',
      channels: ['strange-objects', 'campsite-changes'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.5,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'cs_cache_logbook',
      title: 'The cache logbook',
      discovery: 'Open the ammunition box wired to the stump.',
      telling:
        'Dates, weather, and one line each. Everyone writes about the trees. One entry, in pencil, just says: "heard it twice tonight. same as last year." and nothing else, and there is no entry above it explaining what.',
      channels: ['notes'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.4,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'cs_bridge_signal',
      title: 'The signal on the bridge',
      discovery: 'Stand on the plank bridge with the radio on, tuned to the very top of the AM band.',
      telling:
        'A four-note music-box figure with this creek audible behind it. Walk twenty metres off the bridge and it is gone. Nobody ever finds a transmitter, and the game never brings it up again.',
      channels: ['radio', 'distant-sounds'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.2,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'cs_missing_arrow',
      title: 'The prised-off arrow',
      discovery: 'One arrow is missing from the routed trail sign, leaving four clean screw holes.',
      telling:
        'It is nailed to a tree ninety metres up the wrong side of the slope, pointing back at the bench, and there is nothing else up there at all.',
      channels: ['strange-objects', 'campsite-changes'],
      oneTime: true,
      leavesEvidence: 'The arrow is afterwards back on the sign, screwed in with mismatched hardware, and the four old holes remain visible beside it.',
      rarity: 0.18,
      optional: true,
      gatesNothing: true,
    },
  ],
  machine: {
    quirkWeights: { 'rough-fan': 3, 'sticky-door': 2.5, 'early-frost': 2, 'double-relay': 2, 'flicker-segment': 1.5 },
    flavourNote:
      'Moss has started on the north side of this unit — a genuine green fuzz along the bottom of the panel that somebody scrapes off periodically and that always comes back. The compressor sounds enormous here because the canyon returns it.',
    stickerHint: 'PROPERTY OF SOME MORE, gone soft and slightly furry at the edges from permanent damp.',
    frostNote: 'The window frosts thickly and then immediately begins to bead in the wet air, so the reveal happens through running water rather than through frost.',
  },
  procedural: {
    seedStreams: ['scatter', 'weather', 'wildlife', 'radio', 'creek', 'canopy', 'machine'],
    variations: [
      { id: 'creek_volume', label: 'Creek flow', range: { min: 0.5, max: 1.8 }, unit: 'multiplier', note: 'Drives the entire audio bed, the echo tail length, and whether the pool is skippable.' },
      { id: 'fog_bands', label: 'Fog band count', range: { min: 0, max: 5 }, unit: 'layers', note: 'Horizontal fog layers between the trunks. At five the environment becomes almost abstract.' },
      { id: 'canopy_drip', label: 'Canopy drip rate', range: { min: 0.2, max: 2 }, unit: 'drops per second', note: 'Continues for hours after rain stops, which is the truest thing about a rainforest.' },
      { id: 'maple_stack', label: 'Split maple in the hollow', range: { min: 3, max: 12 }, unit: 'pieces', note: 'Never zero. Somebody restocks it.' },
      { id: 'candle_stubs', label: 'Candle stubs on the shelf', range: { min: 8, max: 14 }, unit: 'stubs', note: 'The count changes between visits. It has never gone down.' },
    ],
    invariants: [
      'The two cedars and the hollow in the north one.',
      'The plank bridge and its spliced cable.',
      'The routed trail sign with four empty screw holes.',
      'The slot, the fall, and the pool at the bottom.',
    ],
  },
  discovery: {
    weight: 10,
    affinities: { 'maritime-west': 2.3, 'maritime-east': 1.3, highland: 1.3, boreal: 1.1, unknown: 1.2, 'humid-subtropical': 0.9, 'continental-interior': 0.8, mediterranean: 0.8, 'arid-interior': 0.5 },
    note: 'The vertical, enclosed, acoustically spectacular one. A strong early environment for coastal players and a genuine destination for everyone else.',
  },
  performance: {
    cost: 'heavy',
    midTierDrawCalls: 88,
    midTierTriangles: 52000,
    dynamicLights: 4,
    lowTierCuts: [
      'Sword fern scatter 70 → 20 per 100m² and switches from two-sided alpha to a single quad — the largest saving in the environment.',
      'Devil’s club is cut entirely; the seep gets a moss decal instead.',
      'Hemlock middle storey halves and the canopy becomes a single alpha dome, which at 8% sky openness nobody can distinguish.',
      'Creek in the slot loses its foam particles and keeps the animated normal map and the sound.',
    ],
    note: 'The heaviest triangle count in the catalogue: two hero trunks with real silhouettes plus a great deal of alpha-tested foliage. The 42m draw distance and the near-total canopy are what make it affordable — almost nothing is ever visible at once.',
  },
};
