import type { EnvironmentManifest } from '../schema.js';

/**
 * Copperline Halt — an abandoned rail siding, and the radio environment.
 *
 * The most human-made place in the catalogue and the one carrying the heaviest
 * mystery load: notes, objects, recurring figures and the strangest broadcasts
 * in the product. It is entirely benign — an old industrial place at 2am with
 * nobody in it, which is a specific and very cozy kind of strange.
 */
export const COPPERLINE_HALT: EnvironmentManifest = {
  id: 'copperline_halt',
  name: 'Copperline Halt',
  tagline: 'A concrete platform, four hundred metres of rail going both ways, and a radio that gets things it should not.',
  inspiration:
    'A disused halt on a single-track branch line across dry scrub country — a name board, a lamp post with no lamp, a stock tank, and aspens that have grown in where the sidings used to be.',
  biomeTags: ['abandoned-infrastructure', 'dry-scrub', 'aspen-invasion', 'railway'],
  character: {
    temperature: 'mild',
    moisture: 'dry',
    altitude: 'lowland',
    treeCover: 'open',
    water: 'none',
    eeriness: 4,
  },
  arrival: {
    approach:
      'You walk in along the rails themselves, on the sleepers, because it is easier than the ballast and because everybody does. Ballast crunches, sleepers thud, and the spacing forces your stride into somebody else’s.',
    firstHeard:
      'Wind through a signal gantry — a specific hollow whistle through a steel lattice, and under it a very faint radio, already playing, from the direction of the platform.',
    firstSeen:
      'The name board. White letters on a dark ground, catching your light from a long way off, and unreadable until you are close.',
    underfoot:
      'Ballast, then sleeper, then ballast, in a rhythm you cannot help matching. Then concrete.',
    arrivalBeat:
      'The platform is a metre high, forty metres long, and completely empty. The fire is in a ring of ballast stones at the far end, the SM-01 is standing under the lamp post as if it is waiting for a train, and the radio somebody left on is still going.',
    walkSeconds: { min: 28, max: 46 },
  },
  scene: {
    ground: 'gravel-pad',
    groundNote:
      'Grey angular ballast with weeds coming through it, going to compacted dust and cinders off the formation. The platform itself is cracked concrete with a worn yellow line still visible along the edge.',
    vegetation: [
      { kitId: 'kit_aspen_invasion', label: 'Aspen', density: 16, heightRange: { min: 5, max: 13 }, lowTierDrop: false, note: 'Grown up through the old sidings in one connected clone. Leaves that never stop moving, even when there is no wind — the most animated thing in the catalogue.' },
      { kitId: 'kit_rabbitbrush', label: 'Rabbitbrush and sage', density: 40, heightRange: { min: 0.4, max: 1.1 }, lowTierDrop: true, note: 'Filling the space between the rails and the fence line. Grey-green, resinous, and it smells extraordinary when the fire warms it.' },
      { kitId: 'kit_track_weed', label: 'Weeds in the ballast', density: 55, heightRange: { min: 0.1, max: 0.4 }, lowTierDrop: true, note: 'Growing through the sleeper gaps in a perfectly straight line for four hundred metres, which is the single most effective piece of storytelling in the environment.' },
    ],
    landmarks: [
      { id: 'name_board', label: 'The name board', kind: 'signage', handcrafted: true, note: 'COPPERLINE HALT in white on dark green, on two posts, with one corner bent. Repainted at some point by somebody who matched the lettering carefully and got the spacing slightly wrong.' },
      { id: 'the_platform', label: 'The platform', kind: 'built', handcrafted: true, note: 'Forty metres of concrete with a yellow edge line, three benches’ worth of bolt holes and no benches, and a drain that still drains.' },
      { id: 'lamp_post', label: 'The lamp post', kind: 'built', handcrafted: true, note: 'Cast iron, fluted, with the lamp and the glass gone and the bracket still there. The SM-01 stands directly beneath it.' },
      { id: 'signal_gantry', label: 'The signal gantry', kind: 'abandoned', handcrafted: true, note: 'A steel lattice over the track with both arms down and the spectacle glass intact — one red, one green, catching firelight from four hundred metres away.' },
      { id: 'stock_tank', label: 'The stock tank', kind: 'built', handcrafted: false, note: 'A corrugated steel tank, half full of rainwater, with a float valve that has not worked in years and a skin of duckweed and one very determined frog.' },
      { id: 'the_hut', label: 'The permanent way hut', kind: 'abandoned', handcrafted: true, note: 'A brick hut the size of a shed with a fireplace, a stove pipe, a bench, and a door that does not lock.' },
    ],
    elevation: 'flat',
    elevationNote:
      'Dead level, because a railway made it level. The formation is raised a metre above the surrounding scrub and that metre is the only topography for kilometres.',
    drawDistanceM: 150,
    fog: { colour: '#22201c', density: 0.009, note: 'Thin dust haze that pools along the formation in the early hours and makes the rails visible as two converging lines of dull light.' },
    nightPalette: {
      zenith: '#070810',
      horizon: '#1e1c1a',
      ground: '#35322c',
      foliage: '#2b301f',
      rock: '#43413c',
      water: null,
      fireGlow: '#ff9c46',
      moonlight: '#b4b6b0',
      shadow: '#0a0908',
    },
    skyOpenness: 0.82,
    walkableRadiusM: 65,
  },
  weather: {
    id: 'copperline-halt',
    weights: { clear: 5, 'high-cloud': 4, wind: 4, overcast: 3, 'light-rain': 2, storm: 1, fog: 2 },
    baseTempC: 14,
    baseWind: 2.4,
    exposure: 0.55,
    skyEventChance: 0.2,
    skyEvents: ['heat-lightning', 'meteor-shower', 'aurora'],
    transitionSeconds: 210,
  },
  weatherCharacter: {
    temperatureNote:
      'Mild and dry, with the concrete and the rails giving back the day’s heat for hours. Sitting on the platform edge is warm long after the air is not.',
    windNote: 'Steady across the scrub, and the gantry turns it into a note. The aspens move constantly whether there is wind or not.',
    exposureNote: 'Open, but the hut is a real windbreak and there is a fire ring both inside and outside it — the player chooses which fire to have.',
    nightRangeC: { min: 6, max: 20 },
  },
  fuel: {
    sources: [
      { woodId: 'aspen', weight: 6, foundAs: 'Deadfall from the clone, everywhere, light and dry and snapping cleanly.', moistureBias: -0.08 },
      { woodId: 'oak', weight: 3, foundAs: 'A stack of condemned hardwood sleeper offcuts behind the hut, cut short and stacked square by somebody methodical.', moistureBias: -0.14 },
      { woodId: 'pine', weight: 2, foundAs: 'Broken fencing from the stock pen, still with staples in it.', moistureBias: -0.05 },
    ],
    note:
      'The sleeper offcuts are the good stuff and they burn hot, slow and slightly strangely — old preservative in the wood puts a green fringe on the flame edges for the first few minutes and makes the coals sit an unusually deep orange. Aspen alone is a bright, fast, disposable fire; the offcuts are what make an ember bed here.',
  },
  wildlife: [
    {
      id: 'barn_owl',
      label: 'Barn owl',
      shyness: 0.7,
      curiosity: 0.5,
      window: ['early-night', 'deep-night'],
      attractedBy: ['quiet', 'stillness', 'moonlight'],
      repelledBy: ['flashlight', 'voices', 'compressor-noise'],
      canPersist: true,
      investigatesObjects: false,
      traces: ['pellets under the gantry', 'white streaking down one lattice leg', 'a heart-shaped face reflecting your light for half a second'],
      note: 'Roosts in the gantry. Goes out along the formation at head height, silent, white underneath, and comes back the same way an hour later. Screams exactly once a night, which is startling and then very quickly funny.',
    },
    {
      id: 'pack_rat',
      label: 'Pack rat',
      shyness: 0.55,
      curiosity: 1,
      window: ['early-night', 'deep-night'],
      attractedBy: ['crumbs', 'food-smell', 'machine-hum'],
      repelledBy: ['sudden-movement', 'flashlight'],
      canPersist: true,
      investigatesObjects: true,
      traces: ['a nest in the hut wall full of foil, wire, a spoon and a rail spike', 'a small bright object swapped for a different small bright object'],
      note: 'Trades. It takes something shiny and leaves something else shiny in its place, every time, without fail. Players work this out on their own and then start bringing things deliberately.',
    },
    {
      id: 'nighthawk_halt',
      label: 'Nighthawks',
      shyness: 0.3,
      curiosity: 0.4,
      window: ['dusk', 'early-night'],
      attractedBy: ['firelight', 'open-sky', 'warmth'],
      repelledBy: ['rain'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['a bird sitting lengthways along the top of the name board, invisible until it moves'],
      note: 'Work the insects over the warm ballast. Sit lengthways on the rails, which is an unmistakable silhouette and one of the best small sights in the game.',
    },
    {
      id: 'stock_tank_frog',
      label: 'The frog in the tank',
      shyness: 0.4,
      curiosity: 0.2,
      window: ['early-night', 'deep-night'],
      attractedBy: ['water-edge', 'warmth'],
      repelledBy: ['splashing', 'flashlight'],
      canPersist: true,
      investigatesObjects: false,
      traces: ['a single ring in the duckweed'],
      note: 'One frog, in a steel tank, in the middle of dry scrub, kilometres from any other water. It has been there every visit for as long as anyone has been coming here and nobody knows how it got there.',
    },
    {
      id: 'pronghorn',
      label: 'Pronghorn',
      shyness: 0.85,
      curiosity: 0.35,
      window: ['pre-dawn', 'dawn'],
      attractedBy: ['quiet', 'open-sky'],
      repelledBy: ['footsteps', 'firelight', 'voices'],
      canPersist: false,
      investigatesObjects: false,
      traces: ['a line of prints crossing the ballast at ninety degrees and not deviating'],
      note: 'Four of them, a long way out, moving fast in the grey before dawn. They cross the line and do not look at it.',
    },
  ],
  ambience: {
    wind: { character: 'steady', baseLevel: 0.42, gustiness: 0.5, material: 'steel lattice, aspen leaves and a loose sheet of corrugated iron' },
    insectDensity: 0.5,
    insectNote: 'A dry, sparse, evenly spaced cricket field over the warm ballast, with one very loud individual under the platform edge that is closer than everything else.',
    waterPresence: 0.04,
    reverb: 'clearing',
    reverbNote:
      'Mostly open, with one hard flat return off the platform face and a completely different, tight, brick-and-plaster room the moment you step inside the hut. Walking in and out of the hut is an audible event.',
    distantEvents: [
      { id: 'rail_tick', label: 'The rails tick', weight: 6, minGapSeconds: 60, note: 'Steel contracting as it cools, arriving as single sharp taps from a long way up the line and travelling toward you.' },
      { id: 'gantry_moan', label: 'The gantry finds a note', weight: 5, minGapSeconds: 100, note: 'The lattice whistles a clean pitch when the wind hits the right speed, and holds it, and stops.' },
      { id: 'iron_sheet', label: 'The loose sheet lifts', weight: 4, minGapSeconds: 200, note: 'A bang and a rattle from the hut roof, twice, and then nothing.' },
      { id: 'far_horn', label: 'A horn, far up the line', weight: 2, minGapSeconds: 600, note: 'Two long, one short, one long, from a very long way away, on a line that has not carried traffic in decades. The rails do not tick afterwards. Nothing comes.' },
      { id: 'aspen_rush', label: 'The aspens all at once', weight: 5, minGapSeconds: 90, note: 'A sound exactly like heavy rain arriving, for four seconds, with no rain.' },
    ],
    nightFloorDb: -50,
  },
  activities: [
    { id: 'radio', label: 'Radio', prominence: 'signature', note: 'The reference radio site. A long-wire aerial is already strung between the lamp post and the gantry, and the rails themselves are four hundred metres of ground plane. The dial is crowded and half of what is on it is unaccounted for.' },
    { id: 'fire-tending', label: 'Tend the fire', prominence: 'notable', note: 'Two fireplaces: a ballast ring on the platform, and a real brick fireplace in the hut with a stove pipe that draws beautifully. They behave completely differently.' },
    { id: 'rail-walking', label: 'Walk the line', prominence: 'signature', note: 'Balance on a rail and see how far you get. The record is kept in your head and nowhere else. Four hundred metres of it in either direction, and the far end is out past the fog and worth reaching.' },
    { id: 'stargazing', label: 'Stargaze', prominence: 'notable', note: 'Lie on the platform. The concrete is warm and the sky is wide and the rails converge to a point at both ends of your vision.' },
    { id: 'binoculars', label: 'Binoculars', prominence: 'available', note: 'For the gantry spectacle glass, the far end of the line, and the owl.' },
    { id: 'photography', label: 'Photograph', prominence: 'notable', note: 'Hard industrial geometry with one warm light source. The sandwich on the platform edge above the yellow line is the composition.' },
    { id: 'flashlight', label: 'Flashlight', prominence: 'notable', note: 'Down the line, along the rails, until the beam gives up. The rails carry the light further than the beam does.' },
    { id: 'wildlife-watching', label: 'Watch for wildlife', prominence: 'available', note: 'The pack rat is the entire show and it will happen whether you watch or not.' },
    { id: 'strange-objects', label: 'The hut', prominence: 'notable', note: 'A bench, a shelf, a stove, a nest in the wall, and things left by everybody who has ever sheltered here.' },
  ],
  radio: {
    stations: [
      { id: 'kchl_1073', dial: 107.3, band: 'fm', name: 'KCHL — The Long Night', character: 'lofi', reception: 0.74, note: 'Six hours of slow instrumentals with no adverts and no idents except a single spoken station name at the top of each hour, by someone who sounds like they are enjoying themselves.' },
      { id: 'dispatch_1608', dial: 1608, band: 'am', name: 'Rail dispatch, archived', character: 'environmental', reception: 0.66, note: 'Track warrants, mileposts, and crew names, in the clipped rhythm of the job — and every so often the milepost for this halt, read out for a train that is not coming.' },
      { id: 'sw_9330', dial: 9330, band: 'shortwave', name: '9330 kHz', character: 'strange', reception: 0.46, note: 'A very loud station in an unidentifiable language, brass instruments, and a man who laughs once at something. Present every night at exactly the same time.' },
      { id: 'kwea_1625', dial: 162.4, band: 'fm', name: 'Regional forecast', character: 'weather-service', reception: 0.7, note: 'Zone forecasts for counties in a line, in order, which happens to be the order the railway goes.' },
      { id: 'the_halt_carrier', dial: 1440, band: 'am', name: 'The carrier that hums', character: 'strange', reception: 0.52, note: 'A carrier with a 50 Hz hum and, underneath, a room tone. Occasionally a chair. Occasionally, faintly, a radio playing KCHL — a few seconds behind yours.' },
      { id: 'kgrs_945', dial: 94.5, band: 'fm', name: 'Automated country', character: 'community', reception: 0.6, note: 'From a town seventy kilometres up the line. Adverts for a feed store, a tyre place, and a fair that was three months ago.' },
    ],
    baseReception: 0.82,
    receptionNote:
      'The best reception in the catalogue. A long-wire aerial already strung, kilometres of steel rail acting as a ground plane, no terrain, and no local noise floor whatsoever. Everything gets in.',
    betweenStations: 'A busy, layered static full of half-signals, with the 50 Hz hum from the carrier bleeding faintly across two channels either side of it.',
  },
  secrets: [
    {
      id: 'ch_the_hut_shelf',
      title: 'The shelf in the hut',
      discovery: 'A plank shelf above the bench, at head height, in the dark.',
      telling:
        'A tin of tea gone to dust, a candle, a paperback with the cover missing, and a notebook of shift entries — weather, work done, times — that stops mid-sentence on a page, with the pencil still in the fold.',
      channels: ['notes', 'strange-objects'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.5,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ch_the_trade',
      title: 'The trade',
      discovery: 'Leave something small and shiny on the platform edge and go and do something else for a while.',
      telling:
        'It is gone, and something else is there. A brass button. A ring pull. Once, a rail spike with a date stamped in the head that is older than the line.',
      channels: ['wildlife-behaviour', 'strange-objects'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.6,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ch_the_carrier_delay',
      title: 'The radio behind the radio',
      discovery: 'Tune to the humming carrier while KCHL is playing on the other set in the hut.',
      telling:
        'The carrier is carrying KCHL too, about four seconds late, from a room with someone in it. If you turn your radio off, the one in the carrier keeps playing. That is the whole of it and it is never explained.',
      channels: ['radio'],
      oneTime: false,
      leavesEvidence: null,
      rarity: 0.22,
      optional: true,
      gatesNothing: true,
    },
    {
      id: 'ch_the_lamp_lights',
      title: 'The night the lamp is lit',
      discovery: 'You come up the line and there is a light on the lamp post, which has had no lamp for decades.',
      telling:
        'It is a hurricane lantern, hung on the bracket, burning steadily, with a fresh wick and a full reservoir. Nobody is there. It burns all night and it is genuinely the warmest the environment ever looks.',
      channels: ['campsite-changes', 'recurring-figures'],
      oneTime: true,
      leavesEvidence: 'The lantern stays on the bracket afterwards, unlit, and the glass is clean on every visit no matter how long you leave it.',
      rarity: 0.1,
      optional: true,
      gatesNothing: true,
    },
  ],
  machine: {
    quirkWeights: { 'double-relay': 3.5, 'flicker-segment': 3, 'long-hold': 2.5, 'proud-badge': 2, 'loud-compressor': 1.5 },
    flavourNote:
      'Standing under a lamp post on a station platform, this unit looks more like railway equipment than catering equipment, and it has been treated as such: there is a chalked mark on the side in the same hand as the sleeper stack, and somebody has wired a spare fuse to the handle with copper wire in case it is ever needed. It never has been.',
    stickerHint: 'LOT 14 and a rail-company property transfer label, both of them older than the unit.',
    frostNote: 'The frost picks out the chalk mark as a dark line and then erases it as it thaws, and the mark is always back next visit.',
  },
  procedural: {
    seedStreams: ['scatter', 'weather', 'wildlife', 'radio', 'objects', 'traces', 'machine'],
    variations: [
      { id: 'band_conditions', label: 'Band conditions', range: { min: 0.3, max: 1 }, unit: 'normalised', note: 'How crowded the dial is tonight, and whether the shortwave stations are audible at all.' },
      { id: 'traded_object', label: 'What the pack rat leaves', range: { min: 0, max: 1 }, unit: 'variant', note: 'From a table of small found objects that grows very slightly with the number of visits.' },
      { id: 'tank_level', label: 'Water in the stock tank', range: { min: 0.15, max: 0.9 }, unit: 'normalised', note: 'The frog is present at every level.' },
      { id: 'aspen_leaf_fall', label: 'Leaf litter on the platform', range: { min: 0, max: 1 }, unit: 'normalised', note: 'Drifts into the same two corners every time, which is how you know the wind here has a shape.' },
      { id: 'hut_condition', label: 'How the hut was left', range: { min: 0, max: 1 }, unit: 'variant', note: 'Door open or shut, ash in the grate or swept, candle burned down or not. Somebody was here.' },
    ],
    invariants: [
      'The name board and its bent corner.',
      'The lamp post with no lamp.',
      'The gantry with both arms down and the glass intact.',
      'The frog in the stock tank.',
      'The notebook that stops mid-sentence.',
    ],
  },
  discovery: {
    weight: 8,
    affinities: { 'continental-interior': 1.9, 'arid-interior': 1.7, mediterranean: 1.2, unknown: 1.2, highland: 1, 'humid-subtropical': 0.9, boreal: 0.8, 'maritime-east': 0.9, 'maritime-west': 0.8 },
    note: 'Carries most of the catalogue’s radio and mystery weight. Deliberately not one of the first environments a new player is likely to see, and reachable from everywhere.',
  },
  performance: {
    cost: 'moderate',
    midTierDrawCalls: 71,
    midTierTriangles: 31000,
    dynamicLights: 4,
    lowTierCuts: [
      'Aspen leaf animation drops from per-leaf cards to a two-layer canopy shear; the sound layer is untouched, which preserves most of the effect.',
      'The gantry drops from lattice geometry to an alpha-cut silhouette card at distances over 60m.',
      'Ballast becomes a parallax texture rather than instanced stones beyond 15m.',
      'Rails keep their specular highlight at every tier — two converging lines of light is the entire image of this place.',
    ],
    note: 'Built almost entirely from repeated modular pieces — sleeper, rail section, ballast, fence panel — so instancing does nearly all the work. The aspen canopy is the only meaningful cost.',
  },
};
