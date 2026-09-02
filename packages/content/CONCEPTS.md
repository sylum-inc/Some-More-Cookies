# Some More — Environment concepts, scoring and selection

**Status:** living document · v1.0
**Owns:** the answer to spec [§5.4](../../PRODUCT_SPEC.md) — "Environments are *selected, not assumed*."
**Result:** 26 concepts generated · **12 selected** for launch · 14 cut, with reasons and salvage notes.

The shipped manifests live in [`src/environments/`](./src/environments/) and are validated by
[`src/validate.ts`](./src/validate.ts). This document is the reasoning behind them; it is not the data.

---

## 1. How these were judged

### 1.1 The criteria

Fourteen, taken verbatim from spec §5.4, scored 1–5. Maximum 70.

| Column | Criterion | What a 5 means |
| --- | --- | --- |
| **Atm** | Atmosphere | You would sit here after the sandwich is gone. |
| **Vis** | Visual identity | One frame, no HUD, and you know which place it is. |
| **Fire** | Fire behaviour | The fuels, wind and shelter here make the fire a different animal. |
| **Wx** | Weather | Weather changes what the place *is*, not just what it looks like. |
| **Expl** | Exploration | Real corners in a compact area. Something to walk to. |
| **Wild** | Wildlife | A roster with distinct behaviour, including something worth being still for. |
| **Aud** | Audio | The soundscape alone would carry a minute of black screen. |
| **Side** | Side activities | At least one thing only possible here, and one that could go surprisingly deep. |
| **Myst** | Mystery | Environmental storytelling that never becomes a quest. |
| **SM-01** | SM-01 integration | The machine belongs here and the site changes how it reads. |
| **Repl** | Replayability | Two visits differ meaningfully; a tenth visit still rewards attention. |
| **Photo** | Product photography | The sandwich looks *delicious* in this light, against this ground. |
| **Feas** | Technical feasibility | Buildable from procedural kits with no new engine capability. |
| **Perf** | Performance | Fits the mid-tier budget with a low-tier path that does not gut it. |

### 1.2 The two hard filters applied before scoring

Both are from the spec and neither is a matter of taste.

1. **The mood calibration (§2.2).** Cozy summer-night nostalgia plus a *liminal* PS1 strangeness — a
   campground at 2am, never a monster in the woods. Nothing stalks, chases, jump-scares or endangers.
   **If a moment would make a player want to stop eating, it is wrong.** Several otherwise strong
   concepts were cut on this line alone, and it is the single most common reason for a cut below.
2. **Appetite outranks atmosphere.** Every environment must be somewhere a person would happily eat
   an ice cream sandwich. Sites that were evocative but faintly unappetising — anything that read as
   dirty, stagnant, industrial-toxic, or cold-in-a-miserable-way — lost points on Photo and Atm even
   where they scored well elsewhere.

### 1.3 What "selected" had to add up to

The launch set is judged as a *set*, not as twelve individual winners. It had to span:

- **Climate:** hot / warm / mild / cool / cold, and arid / dry / balanced / damp / wet.
- **Altitude:** sea level to alpine.
- **Water:** none, creek, river, lake, tarn, sea, blackwater, hot spring, and one that is barely water at all.
- **Tree cover:** none, sparse, open, moderate, dense, full canopy.
- **Ground material:** nine distinct surfaces, because ground is 40% of what a low-poly world looks like.
- **Eeriness:** 2 to 5, weighted toward the cozy end.

A concept that scored 58 but duplicated a coverage slot already filled lost to one that scored 55 and
opened a new one. That trade is made explicitly in §4.

---

## 2. The concepts

Environments are fictional but inspired by recognisable landscapes. Each entry gives the pitch and
then its **systemic personality** — the thing it would contribute that no other concept would.

### Selected

**1 · Pine Hollow** — A numbered site in a bowl of second-growth pine, one bar of a creek running
behind it, a steel bear box with the paint worn off the latch.
*Systemic personality:* the baseline and the teacher. Sheltered on three sides, easy fuel, and two
heavy oak pieces someone left behind that quietly demonstrate the whole ember-bed lesson. Highest
wildlife-per-square-metre in the catalogue and the lowest strangeness.

**2 · Longlight Shore** — A fire in the lee of a drift log the size of a bus, with a light on the
point turning once every nine seconds and the tide somewhere out in the dark.
*Systemic personality:* wind. The most exposed pit in the set, with a windbreak that genuinely works
and a still pocket you have to find. Salt-laden driftwood spits and throws coloured flame. Sea-path
radio propagation after midnight.

**3 · Lantern Mesa** — Slickrock still giving back the day's heat, a dry wash below, and a sky with
no floor to it.
*Systemic personality:* the ember bed and the sky. Mesquite makes the longest-lived coals in the
catalogue; there is no canopy, no damp and no fog, so the flame-versus-ember difference is at its
most legible. Also the dark-sky reference environment and the only site with a UV flashlight mode.

**4 · Meltwater Cirque** — A tarn like a held breath, three snowfields above it, and a fire that has
to be argued with.
*Systemic personality:* the hardest fire. Katabatic wind draining off the snow in slow pushes, only
small dense krummholz fuel, and a dry-stacked shelter wall that is the difference between a fire and
a smoke signal. Glass-still water that turns stone skipping into a musical instrument.

**5 · Sweetgrass Coulee** — Grass to the edge of the world, a slow brown river, and a windmill
turning for no reason and connected to nothing.
*Systemic personality:* horizon and weather-at-a-distance. You watch a storm be enormous somewhere
else for twenty minutes. Sheltered pit under a prairie sky, the best AM skip in the product, and the
densest insect chorus with real near/far fields.

**6 · Cicada Bottoms** — A boardwalk over black water, air like a warm towel, and about ten thousand
insects doing one thing.
*Systemic personality:* enclosure and volume. Shortest draw distance in the set, warmest air, and the
only place where the fire is for light rather than heat. Everything is damp, so every fire starts
with a steamy sulk until you find the fat lighter in the coffee can.

**7 · Ashfall Barrens** — Black ground, white steam, and a wooden soaking box somebody keeps clean
for no reason anyone can name.
*Systemic personality:* warm ground under cold air. Fumaroles that dry your fuel for you if you think
ahead, a dead acoustic space where the ground hiss does the job reverb normally does, and geomagnetic
activity that couples the aurora to the radio band.

**8 · Mirror Flats** — Two centimetres of water over a hundred square kilometres of salt, holding the
whole sky upside down.
*Systemic personality:* emptiness, handled carefully. The most liminal site in the catalogue and the
proof that liminal ≠ threatening: nothing approaches, the water is blood-warm, and there is a picnic
table bolted to a concrete pad because somebody decided this should exist.

**9 · Foxglove Fells** — A sheepfold on open moor, a beck you can hear but not see, and fog that
comes and goes like it has somewhere to be.
*Systemic personality:* visibility as a system. The fastest weather transitions in the set; fog can
close the world to six metres and open it again inside a single roasting session. Peat burns like
nothing else in the product, and the drystone wall is the only place where you can *hear* yourself
enter shelter.

**10 · Cedar Switchback** — Trees like cathedral columns, a creek in a slot below, and an echo that
takes its time.
*Systemic personality:* verticality and reverb. The only environment that is about looking up. Two
distinct canyon returns at 0.4s and 1.6s make this the reference space for the audio engine.
Everything on the floor is soaked, and the dry wood is stacked inside a living tree.

**11 · Copperline Halt** — A concrete platform, four hundred metres of rail going both ways, and a
radio that gets things it should not.
*Systemic personality:* radio and human trace. A long-wire aerial already strung and kilometres of
steel rail as a ground plane give it the best reception in the catalogue and the most crowded dial.
Carries most of the set's mystery load. Two fireplaces — a ballast ring outside and a brick hearth
in the hut — that behave completely differently.

**12 · Loonwater Narrows** — A shield-rock point between two lakes, birch behind, and something out
on the water calling every few minutes.
*Systemic personality:* the answering bird and the doubled world. Birch bark makes lighting trivial
and holding a bed hard — the inverse of most of the catalogue. Best aurora odds, a lake that mirrors
everything, and an echo off an island 2.5 seconds away that regulars wait for after the completion tone.

### Cut

**13 · Aspen Bowl** — A grove of quaking aspen in a Rocky Mountain bowl, white trunks with old
carved initials, leaves moving constantly.
*Systemic personality:* leaf sound as the entire ambience; a fire that is bright, fast and gone.

**14 · Sequoia Colonnade** — Camping between trunks so large the game cannot show you one whole.
*Systemic personality:* scale shock; a fire that looks tiny by design.

**15 · Vacancy Lot** — The gravel overflow lot behind a closed motel, one sodium lamp, a fire pit
somebody made from a wheel rim.
*Systemic personality:* maximum liminality on minimum geometry; a fire with nothing natural in it.

**16 · Bluewater Quarry** — A flooded limestone quarry with cut walls going straight into
impossibly clear water.
*Systemic personality:* vertical rock reflected in still water; swimming as the signature.

**17 · Windfall Orchard** — An abandoned orchard gone feral, ladders still in trees, fruit on the ground.
*Systemic personality:* smell and small harvest; wasps at dusk, moths at night, deer at dawn.

**18 · Whistle Dunes** — Barrier-island dunes with marram grass, sand that squeaks and, in the right
wind, hums.
*Systemic personality:* a singing landscape and a ground surface that records every footstep.

**19 · Tarpon Key** — A mangrove key reachable only at low water, with a fire on a shell beach.
*Systemic personality:* bioluminescence in the water, and a tide that changes the shape of the site.

**20 · Hardwater Shack** — An ice-fishing shack on a frozen lake, with a stove inside and a fire
outside on the ice.
*Systemic personality:* the ice itself — booming, singing, cracking — and an interior space.

**21 · Steppe Caravanserai** — A walled roadside shelter on an open steppe, centuries old, still in
occasional use.
*Systemic personality:* architecture as windbreak; a courtyard with real acoustics.

**22 · Mile 61 Rest Area** — A highway rest area at 3am. Vending machines, a lawn, a picnic shelter,
trucks idling.
*Systemic personality:* the purest liminal space available and the strongest sodium-light palette.

**23 · Draft Cave** — A fire at a cave mouth, with cold air pouring out of the dark behind you.
*Systemic personality:* a directional cold draught that fights the fire; extraordinary reverb.

**24 · Anvil Ridge** — A bare ridge during a dry thunderstorm, with lightning working the valley below.
*Systemic personality:* the most dramatic weather in the product by a wide margin.

**25 · Sphagnum Halt** — A raised bog with a boardwalk, cotton grass, and pools that reflect like mirrors.
*Systemic personality:* a floor that moves under you; preserved things in the peat.

**26 · Dome Road** — The access road below a working observatory, with red lights and a dome that
moves and clicks all night.
*Systemic personality:* an institution operating nearby, indifferent to you; strict red-light discipline.

---

## 3. Scoring

Scored 1–5 on each criterion, maximum 70. `✅` = selected for launch.

| # | Concept | Atm | Vis | Fire | Wx | Expl | Wild | Aud | Side | Myst | SM-01 | Repl | Photo | Feas | Perf | **Total** | |
| ---: | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | ---: | :-: |
| 1 | Pine Hollow | 4 | 3 | 5 | 3 | 4 | 5 | 4 | 4 | 3 | 4 | 4 | 4 | 5 | 4 | **56** | ✅ |
| 2 | Longlight Shore | 5 | 5 | 4 | 5 | 4 | 4 | 5 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | **63** | ✅ |
| 3 | Lantern Mesa | 5 | 5 | 5 | 3 | 4 | 4 | 4 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | **63** | ✅ |
| 4 | Meltwater Cirque | 5 | 4 | 5 | 5 | 4 | 4 | 5 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | **59** | ✅ |
| 5 | Sweetgrass Coulee | 4 | 4 | 3 | 5 | 4 | 5 | 5 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | **57** | ✅ |
| 6 | Cicada Bottoms | 5 | 5 | 3 | 4 | 3 | 5 | 5 | 4 | 4 | 3 | 4 | 5 | 3 | 2 | **55** | ✅ |
| 7 | Ashfall Barrens | 5 | 5 | 4 | 4 | 3 | 3 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | **56** | ✅ |
| 8 | Mirror Flats | 5 | 5 | 3 | 3 | 3 | 3 | 4 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | **57** | ✅ |
| 9 | Foxglove Fells | 5 | 4 | 5 | 5 | 4 | 4 | 5 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | **60** | ✅ |
| 10 | Cedar Switchback | 4 | 5 | 4 | 3 | 5 | 4 | 5 | 4 | 4 | 3 | 4 | 4 | 3 | 2 | **54** | ✅ |
| 11 | Copperline Halt | 5 | 5 | 3 | 3 | 5 | 4 | 5 | 5 | 5 | 4 | 5 | 4 | 5 | 4 | **62** | ✅ |
| 12 | Loonwater Narrows | 5 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | 4 | 4 | 5 | 5 | 4 | 4 | **62** | ✅ |
| 13 | Aspen Bowl | 3 | 2 | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 3 | 3 | 5 | 4 | **43** | — |
| 14 | Sequoia Colonnade | 4 | 4 | 3 | 2 | 3 | 3 | 4 | 2 | 3 | 3 | 3 | 3 | 2 | 2 | **41** | — |
| 15 | Vacancy Lot | 4 | 4 | 1 | 2 | 2 | 2 | 3 | 2 | 4 | 2 | 2 | 3 | 4 | 5 | **40** | — |
| 16 | Bluewater Quarry | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 4 | **43** | — |
| 17 | Windfall Orchard | 4 | 3 | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 3 | 3 | 4 | 4 | 4 | **48** | — |
| 18 | Whistle Dunes | 3 | 3 | 2 | 4 | 2 | 2 | 4 | 2 | 2 | 3 | 2 | 3 | 4 | 5 | **41** | — |
| 19 | Tarpon Key | 4 | 4 | 2 | 3 | 3 | 4 | 4 | 3 | 3 | 3 | 3 | 4 | 3 | 2 | **45** | — |
| 20 | Hardwater Shack | 4 | 4 | 2 | 4 | 2 | 2 | 4 | 3 | 3 | 4 | 3 | 3 | 3 | 4 | **45** | — |
| 21 | Steppe Caravanserai | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | **41** | — |
| 22 | Mile 61 Rest Area | 5 | 4 | 1 | 2 | 2 | 2 | 4 | 2 | 4 | 2 | 2 | 3 | 5 | 5 | **43** | — |
| 23 | Draft Cave | 3 | 3 | 3 | 1 | 2 | 2 | 4 | 2 | 3 | 2 | 2 | 2 | 3 | 4 | **36** | — |
| 24 | Anvil Ridge | 4 | 4 | 2 | 5 | 2 | 2 | 4 | 2 | 2 | 2 | 2 | 4 | 3 | 4 | **42** | — |
| 25 | Sphagnum Halt | 3 | 3 | 3 | 4 | 3 | 3 | 4 | 3 | 3 | 3 | 3 | 3 | 4 | 3 | **45** | — |
| 26 | Dome Road | 4 | 3 | 2 | 3 | 2 | 2 | 3 | 4 | 3 | 3 | 3 | 4 | 4 | 4 | **44** | — |

Selected range **54–63**. Cut range **36–48**. The gap is clean, which is a good sign that the
criteria were doing work rather than being retrofitted to a decision already made.

---

## 4. The selection, and why

### 4.1 The set, as a set

Twelve is the top of the spec's 10–12 band. It was taken deliberately: the twelfth slot is what buys
*Mirror Flats*, and losing the salt pan would have cost the catalogue its most distinctive image for
the sake of an arbitrary round number.

| Environment | Temp | Moisture | Altitude | Trees | Water | Ground | Eerie |
| --- | --- | --- | --- | --- | --- | --- | :-: |
| Pine Hollow | mild | damp | upland | dense | creek | pine duff | 2 |
| Longlight Shore | cool | wet | sea level | sparse | sea | fine sand | 3 |
| Lantern Mesa | hot | arid | upland | none | none | red dust | 2 |
| Meltwater Cirque | cold | balanced | alpine | none | tarn | granite slab | 3 |
| Sweetgrass Coulee | warm | dry | lowland | open | river | grass thatch | 2 |
| Cicada Bottoms | hot | wet | lowland | canopy | blackwater | boardwalk plank | 4 |
| Ashfall Barrens | cool | damp | montane | sparse | hot spring | volcanic ash | 4 |
| Mirror Flats | warm | arid | lowland | none | ephemeral sheet | salt crust | 5 |
| Foxglove Fells | cool | wet | upland | none | creek | peat moss | 4 |
| Cedar Switchback | mild | wet | montane | canopy | creek | moss duff | 2 |
| Copperline Halt | mild | dry | lowland | open | none | gravel pad | 4 |
| Loonwater Narrows | cool | damp | upland | moderate | lake | shield rock | 3 |

Every axis is covered, twelve ground materials are distinct, eeriness runs 2–5 with a mean of 3.2,
and two environments have no water at all. The draw distance range runs from 34m (Cicada Bottoms)
to 400m (Mirror Flats), which is a bigger perceptual difference than any amount of prop variation.

The **fire** deserves its own note, because it is the one system every environment touches. The set
was tuned so no two sites present the same fire problem:

| Fire problem | Where |
| --- | --- |
| None — just enjoy it | Mirror Flats, Sweetgrass Coulee |
| Everything is damp; find the dry thing | Cicada Bottoms, Cedar Switchback, Foxglove Fells |
| Fuel is small and the wind steals it | Meltwater Cirque |
| Wind is constant; find the pocket | Longlight Shore |
| Patience is rewarded with the best coals in the game | Lantern Mesa |
| Pre-dry your fuel on warm ground | Ashfall Barrens |
| Easy to light, hard to hold a bed | Loonwater Narrows |
| Two hearths that behave differently | Copperline Halt |
| The teacher | Pine Hollow |

### 4.2 The cuts

Each cut names what the concept *lacked*, not merely that it lost.

**Aspen Bowl (43)** — lacked a distinct identity. Everything it does well, Pine Hollow already does
(sheltered conifer-adjacent bowl, small water, tame wildlife) or Copperline Halt does better (aspen
leaf sound, carved initials as human trace). Cheap and pretty is not enough; it would have been a
twelfth environment that made the catalogue feel *smaller*.
*Salvaged:* the aspen clone and the constant leaf-rush that sounds exactly like rain arriving both
went into **Copperline Halt**, where they contrast with steel and concrete instead of blending into
more forest.

**Sequoia Colonnade (41)** — lacked feasibility at the render budget and, more fundamentally, lacked
a *mechanic*. Its whole idea is scale, and scale is the one thing a 320×240 internal resolution with
vertex jitter cannot sell — the trunks would clip the near plane and the tops would be fog. It also
duplicated Cedar Switchback's coverage slot.
*Salvaged:* the burned-out hollow at the base of a living giant, which became the dry woodshed inside
the north cedar at **Cedar Switchback** and is now one of the better-kept secrets in the catalogue.

**Vacancy Lot (40)** — lacked a fire and lacked appetite. A wheel-rim fire pit on gravel has no fuel
story, no wind story and no ember story, which strands the product's deepest system. More decisively,
it fails the appetite test: a closed motel car park is a place you would eat *at*, resentfully, not a
place you would want an ice cream sandwich. Atmosphere without appetite loses (§1.2).
*Salvaged:* the single sodium lamp as the only warm light in an otherwise cold-lit frame, reused as
the lamp post at **Copperline Halt** — where a real fire and real fuel give it something to be
warm *against*.

**Bluewater Quarry (43)** — lacked a reason to exist alongside Loonwater Narrows and Meltwater
Cirque, which between them already own "still clear water reflecting rock". Its differentiator was
depth and cliff-jumping, and cliff-jumping is exactly the kind of danger the calibration rule keeps
out. Strip that and it is a worse tarn.

**Windfall Orchard (48) — the closest cut.** Scored highest of the rejected concepts and was genuinely
hard to lose. What it lacked was a coverage slot: mild, damp, lowland, moderate tree cover, small
water is Pine Hollow with fruit. It also created a quiet problem with the product's one emotional
goal — an environment full of ripe fruit puts a second food in the player's mouth, and *nothing*
should compete with the sandwich (§1.1).
*Salvaged, heavily:* the moth sheet — a pale sheet on a line with a light behind it that accumulates
moths, a lacewing and one beetle that will not leave — is now the signature activity at
**Pine Hollow**, and is one of the best small things in the catalogue. The ladders left in the trees
informed the "somebody stopped mid-job" register of **Foxglove Fells**' peat cutting.

**Whistle Dunes (41)** — lacked exploration and lacked corners. Dunes are beautiful and completely
undifferentiated: there is nowhere to walk *to*, so a compact walkable area becomes a compact
featureless one. It also overlapped Longlight Shore's coastal slot while being weaker on every axis
except performance.
*Salvaged:* the wind-carved arcs that dune grass scribes around each clump, now a detail on the sand
at **Longlight Shore**.

**Tarpon Key (45)** — lacked fire and had a tide problem. A site only reachable at low water either
strands the player (unacceptable — nothing may gate the ritual) or has a tide that is decorative,
which wastes the idea. Bioluminescence was the strongest thing here and it duplicated the firefly
beat at Cicada Bottoms, which already owned the warm-wet slot and did more with it.
*Salvaged:* the tide that advances only *between* visits and never during one, which is exactly how
**Longlight Shore** now handles the sea — atmosphere, never threat.

**Hardwater Shack (45)** — lacked an outdoor fire, which is close to lacking the product. Its best
idea is the interior, and an interior fights the whole shape of a session: you cannot tend a fire, sit
by it, and be inside. Ice also carries an unavoidable danger reading that the calibration rule rules
out. Meltwater Cirque covers cold better while keeping the fire outdoors where it belongs.
*Salvaged:* the `indoorSmall` reverb space it was designed around now belongs to **Cicada Bottoms**,
where a low canopy over still water makes an outdoor place that sounds indoors — a better use of the
idea than a shack was.

**Steppe Caravanserai (41)** — lacked fictional distance. Every version of this that was good was
recognisably a specific real building type belonging to specific living cultures, and the spec's rule
is *fictional but inspired by recognisable landscapes* — landscapes, not other people's heritage
architecture. Doing it respectfully is a bigger art and research job than one of twelve slots
justifies, and doing it carelessly is not an option. Cut on judgement, not on score.

**Mile 61 Rest Area (43)** — lacked a fire, and had a commerce conflict. Tied with the strongest
liminal atmosphere in the whole exercise, and cut anyway: there is nowhere to build a fire at a rest
area, and vending machines put a purchase surface into the world *before* the reveal, which §11
forbids outright. The idea is genuinely good and belongs somewhere that is not this product's core loop.
*Salvaged:* the idling-truck-at-the-edge-of-hearing and the far highway that is audible for four
minutes and never arrives, now distant sound events at **Mirror Flats** and **Copperline Halt**.

**Draft Cave (36) — the lowest score, and correctly so.** Lacked sky, lacked weather, and failed the
calibration rule three separate ways. A cave mouth means no astronomy, no weather system worth
running, and cold air pouring out of a dark opening behind the player — which is the definition of a
moment that makes someone want to stop eating. The reverb was excellent and that is all it had.
*Salvaged:* the reverb ambition went into **Cedar Switchback**'s slot, which gets two distinct canyon
returns without anything dark behind you.

**Anvil Ridge (42)** — lacked permission to exist. Scored 5 on weather and 2 on almost everything to
do with being a place, and its central premise — an exposed ridge during a lightning storm — is
danger as content, which the spec bans without qualification. There is no version of this that is
both dramatic and safe-feeling.
*Salvaged:* the storm that builds for forty minutes, lights itself from the inside, and passes north
without a drop reaching you is now a recurring discovery at **Sweetgrass Coulee**. It is the whole
spectacle with none of the threat, and it is better for the distance.

**Sphagnum Halt (45)** — lacked separation from two selected environments at once. Peat, cotton grass
and reflective pools is Foxglove Fells; a boardwalk over water is Cicada Bottoms. It sat exactly
between two stronger concepts and would have blurred both.
*Salvaged:* cotton grass, whose white seed heads are the only pale thing on a night moor, is now a
protected-from-low-tier-cuts scatter kit at **Foxglove Fells**.

**Dome Road (44)** — lacked its own ground to stand on. Its stargazing is Lantern Mesa's, only worse,
because a working observatory imposes red-light discipline that would fight the player's flashlight
and the fire's own glow. An institution operating nearby was a lovely idea attached to a site that
was otherwise a car park.
*Salvaged:* the observatory net — two people who work nights reading seeing conditions and humidity
to each other at 3am — is a radio station at **Lantern Mesa**, and is one of the most companionable
things on any dial in the catalogue.

### 4.3 Three selections that need defending

**Cedar Switchback (54)** is the lowest-scoring selection and scores 2 on performance. It is in
because it is the only environment that is *vertical*, the only one with a genuine canopy over your
head, and the reference implementation for the audio engine's canyon space. The performance cost is
real and is addressed with an aggressive documented low-tier path (see its `performance.lowTierCuts`)
rather than by pretending it is cheap.

**Cicada Bottoms (55)** also scores 2 on performance — transparent Spanish moss, alpha foliage, a
reflective plane and hundreds of firefly lights. It is in because it owns the entire warm-wet corner
of the climate space and because a 34m draw distance buys most of the cost back. Its low-tier plan
explicitly *protects* the Spanish moss and cuts elsewhere, because the moss is the environment.

**Pine Hollow (56)** scores only 3 on visual identity, which is the point. It is the default
environment and the one most players meet first; it is supposed to look like the campground you
half-remember rather than like a striking image. It earns its place on fire behaviour (5) and
wildlife (5), and on being the safest possible first thirty seconds of the product.

---

## 5. How this document stays true

Everything asserted here about the shipped set is checked by tests in [`test/`](./test/), not by
review:

- `catalogue.test.ts` asserts the 10–12 size, unique ids, the climate/altitude/water/tree-cover/ground
  spread claimed in §4.1, the eeriness range and mean, the draw-distance spread, and the per-environment
  minimums (≥2 secrets, ≥1 wildlife entry, ≥1 fuel, ≥1 radio station, a signature activity).
- `reachability.test.ts` proves the no-lock guarantee three ways, including an exhaustive draw across
  every region and a hostile-data case.
- `validate.ts` rejects, at runtime, any manifest with a wood id outside `WOOD_TYPES`, a weather kind
  outside `WeatherKind`, a reverb space outside the allowed set, a quirk outside `QUIRK_POOL`, a
  non-positive discovery weight, a regional affinity outside the clamp band, a secret that claims to
  gate something, or a one-time secret that leaves no evidence.

If a future edit contradicts this document, the tests fail first.
