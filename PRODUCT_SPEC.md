# Some More — Product Specification

**Status:** living document · v0.2 · source of truth for product behaviour
**Companion documents:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (how) · [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (when)

---

## 1. What Some More is

Some More is a cross-platform interactive campfire world for mobile and web.

Its core ritual is:

> arrive at campsite → tend fire → roast a real marshmallow → physically assemble a traditional hot s'more → load it into the Some More **SM-01** transformation freezer → operate the machine → transform it into the real Some More roasted-marshmallow ice cream sandwich → inspect, photograph, share, save, eat, or order it.

The real product is: **graham cracker cookie → chocolate → roasted-marshmallow ice cream → chocolate → graham cracker cookie.**

The transformation from a hot campfire s'more into the finished frozen sandwich is the central product fantasy.

### 1.1 The one emotional goal

> *"I want to eat a Some More ice cream sandwich right now."*

Every system is judged by whether it strengthens **appetite, atmosphere, tactility, discovery, social presence, replayability,** or **Some More identity**. A system that strengthens none of these does not ship.

### 1.2 What it is not

Not a generic camping game. Not a survival game. Not an ecommerce funnel. Not an advergame. Not a quest-heavy RPG. Not a battle-pass product. Not a physics sandbox. Not a horror game. Not a retro-filter gimmick.

This is a **place people return to**, not an advertisement wrapped around a minigame.

### 1.3 The substitution ban (non-negotiable)

The interaction *is* the point. The following substitutions are forbidden at every stage of development, including prototypes:

| Forbidden | Required instead |
| --- | --- |
| A "Roast" button | Manual distance + rotation control over a thermally simulated marshmallow |
| A "Build" button | Freeform 3D placement of each component with magnetic assistance |
| Canned video of the machine | Fully interactive SM-01 ritual, every stage operable |
| Static images of environments | Real interactive 3D campsites |
| Generic dashboard cards | The Campfire Passport as a physical-feeling artifact |
| Purchase prompts before the reveal | Commerce only after the product reveal, entered diegetically |

---

## 2. Creative direction

### 2.1 Visual language

PS1-era low-poly with **selective** modern polish.

**Always PS1:** low-poly geometry · pixelated textures · low internal render resolution · vertex jitter (position snapping in screen space) · affine-style texture instability · ordered dithering · fog with short draw distance · crunchy hard-edged shadows · restrained animation with low keyframe rates.

**Modern where it earns it:** fire, lighting, food appeal, particles, tactile response curves, animation blending, accessibility, performance.

**The fidelity bump.** The finished Some More sandwich is the only object permitted a deliberate fidelity increase: higher texture resolution, chocolate sheen, visible graham structure, frost, crumbs, condensation, and improved local lighting — while remaining cohesive with the world. The bump is *earned by the ritual* and reads as the object being more real than its surroundings. Nothing else in the world gets it. (The SM-01 gets a *half* step: crisper decals and better specular response, because it is Some More technology.)

### 2.2 Mood

Cozy summer-night nostalgia + slightly eerie/liminal PS1 camping game.

**Calibration rule:** the eeriness is *liminal*, not threatening — the feeling of a campground at 2am, not a monster in the woods. Nothing may stalk, chase, jump-scare, or endanger the player. If a moment makes a player want to stop eating, it is wrong. Appetite always wins over atmosphere when the two conflict.

### 2.3 Audio direction

Restrained, physical, believable. Industrial sounds are mechanical rather than musical. The completion tone of the SM-01 is an *appliance finishing*, not a game jingle. Silence is used deliberately.

---

## 3. The SM-01

The Some More SM-01 transformation freezer is a major branded artifact, treated as a plausible industrial object that could inspire a real physical installation.

### 3.1 Design language

Late-1990s industrial refrigeration + early-Y2K technology + restrained Dieter-Rams-influenced functional minimalism.

**Materials:** silver aluminum · industrial white enamel · smoked/translucent Y2K plastics · dark rubber.

**Colour is functional, never decorative:**

| State | Colour | Meaning |
| --- | --- | --- |
| Idle | unlit / dim white | ready |
| Hot & processing | amber | the s'more is still warm; work is happening |
| Freezing & transforming | icy blue | the transformation |
| Fault | amber, slow pulse | attention needed, never punishing |

No RGB. No rainbow. No decorative light shows.

### 3.2 The signature ritual

Every stage is operable and every stage has a sound:

1. **Load** the s'more onto the tray, into the chamber
2. **Close** the heavy door (weighted, resists, settles)
3. **Engage** the latch (two-stage clunk)
4. **Set/confirm** controls (detented switches, a dial, a confirm)
5. **Pull** the lever (the commitment moment — physical throw with resistance)
6. **Amber processing** — the chamber works while still warm
7. **Relays / compressor / fans engage** — audible mechanical sequence
8. **Transition to blue** — the moment the transformation is real
9. **Frost develops** across the machine's surface and window
10. **Completion tone**
11. **Release latch**
12. **Cold vapour** falls out of the opening door
13. **Reveal** the sandwich

**Timing target:** the full run is ~45–75 seconds. Long enough to feel like real refrigeration work, short enough to want to do again. The player may watch through the window, walk away and tend the fire, or talk to friends during the run — the machine does not demand attention, it rewards it.

### 3.3 Serialization

Every campsite has its own SM-01 with:
- a canonical serial number (deterministic from campsite instance + environment)
- unique wear: scuffs, paint loss, decal fade, dents
- unique frost pattern history
- stickers: inspection tags, maintenance decals, campground stamps, occasional oddities
- a maintenance history readable through a service panel
- quirks: a relay that clicks twice, a fan that ramps rough, a display segment that flickers, a door that needs a second push

Quirks are cosmetic-plus-flavour, never a difficulty tax. They are how a player recognises *their* machine.

### 3.4 Future revisions

The machine model is data-driven so prototypes / SM-02 / event units can exist later. **Not a current priority.** Architecture only.

### 3.5 The SM-01 is not a mystery

The SM-01 is explicitly Some More technology. It is documented, serialized, maintained, branded. World mystery lives elsewhere (§8). The machine is the one thing that is *knowable*.

---

## 4. Core gameplay

### 4.1 Fire

The fire looks crunchy and PS1 but behaves systemically underneath.

**Modelled:** fuel mass · wood type · moisture · ember bed temperature · oxygen/airflow · fuel placement · wind · smoke · radiant heat zones.

**Behaviour:** wet wood smokes and steals heat before it burns. A stacked fire with airflow flares. A smothered fire drops to embers. Embers hold heat long after flames die and are the *better* roasting surface — not because they are gentler on any one moment, but because the window between golden and charred is wide enough to actually work in. Discovering this is a real skill expression.

**Forgiving.** The fire never goes out irrecoverably during a session; embers always allow recovery. There is no fuel scarcity pressure. This is not survival.

**Interactions:** add fuel · reposition logs · poke/rake embers · blow/fan air · adjust a windbreak.

### 4.2 Roasting

Roasting is the tactile heart of the game and must be systemic, not a timer.

**Control:** the player moves the marshmallow closer to / farther from the heat and rotates it manually. On touch: one continuous drag controls both axes (radial = distance, tangential = rotation) with direct manipulation. On desktop: pointer drag + scroll, or keyboard alternative.

**Model:** the marshmallow surface is divided into independently tracked patches (latitude × longitude). Each patch tracks temperature, moisture, sugar-browning progress, char progress, blister state, and melt/sag contribution.

**Factors:** radiant heat (inverse-square-ish, from flame and ember sources separately) · convection (rising column above the fire is hotter and less stable) · distance · orientation (patches facing the heat receive far more) · exposure time · rotation speed · moisture (must boil off before browning accelerates) · browning · blistering · melting · charring · ignition · wind (shifts the heat column and can gust).

**Outcomes are a spectrum, not pass/fail:** pale · lightly golden · evenly golden · deeply caramelised · blistered · patchy · one-sided · charred · flaming · fallen.

**Ignition** is a real event: the marshmallow catches, burns with its own light, and can be blown out (a real blow/puff input, or a shake/wave) leaving a black crackled shell that is genuinely delicious in the fiction and produces a distinct *Ember* class of sandwich.

**Falling off the stick** is possible when melt exceeds structural integrity. It is a *story*, not a failure: it lands, sizzles, and the player gets another marshmallow. There is no restart, no score, no "try again" screen.

**There is no hard failure. A burned marshmallow is a story.**

### 4.3 Assembly

The hot s'more is physically assembled in 3D: graham cracker → chocolate → roasted marshmallow → graham cracker.

**Method:** freeform placement with subtle magnetic assistance. Placement genuinely matters (offset, rotation, tilt are recorded and visible in the final sandwich) but never becomes fiddly on a phone. Assist strength is an accessibility setting.

**Materials respond:** chocolate softens and slumps against a hot marshmallow · marshmallow squishes when the top cracker presses down · graham crumbs shed at the edges · smears and drips appear where hot meets cool · a badly aligned stack leans and stays leaning.

**Every sandwich is slightly handmade.** The assembly record (offsets, squish, crumb pattern, smears) is persisted and reproduced on the finished frozen sandwich. Two players never get an identical object.

### 4.4 Transformation

Covered by §3.2. The transformation's inputs are the roast state and the assembly record; its output is a deterministic sandwich record (§4.5).

### 4.5 The sandwich

The finished object carries its history:

| Input | Effect on the finished sandwich |
| --- | --- |
| Browning evenness | Ice cream swirl colour and evenness |
| Char amount | Dark toasted flecks through the ice cream; at high char, the *Ember* class |
| Blistering | Surface texture of the ice cream layer |
| Assembly offsets | The sandwich's lean and layer alignment |
| Squish | Ice cream layer thickness and edge bulge |
| Crumbs/smears | Crumb pattern and chocolate smear on the finished object |
| Machine quirks/wear | Frost pattern, condensation, tiny finish variations |

**Classes** (descriptive, never scored): *Classic · Golden · Ember · Snowdrift · Lopsided · Immaculate* and rarer ones. Classes are named in the Passport, never ranked with stars or points.

### 4.6 Reveal and eating

**Reveal in world first.** The door opens, vapour falls, the sandwich is there on the tray, lit by the machine. The player picks it up. Only then is an optional hero inspection/photo view offered.

**Actions:** inspect (rotate, close look) · photograph · save to Passport · share · order · eat.

**Eating is tactile.** Bites are taken from a chosen side and actually remove geometry. Bites produce: subtle deformation, crumbs falling, chocolate fracturing along a real edge, graham crunch, cold cues (frost, breath vapour, a shiver of the camera), and haptics on capable devices. The sandwich gets smaller and messier. Eating the last bite is a small, quiet moment — not a fanfare.

**Keep it appetizing** is a hard constraint on every visual choice here.

---

## 5. The world

### 5.1 Shape of a session

The core ritual takes **~5–8 minutes**. The campsite is open-ended before and after — arriving early to explore and staying after to sit by the fire are both first-class.

Campsites are **compact but genuinely explorable**: a walkable area with real corners, not a corridor and not an open world.

### 5.2 Secondary activities

Fishing · skipping stones · stargazing · binoculars/telescope · photography · radio · flashlight play · strange objects · wildlife · fire tending.

**Rules:** some may be surprisingly deep. None may compete with making Some More. None generates currency, XP, or obligation.

### 5.3 Forbidden structures

No quest markers. No XP bars. No daily chores. No battle passes. No grind. No conventional level design. No checklists presented to the player.

### 5.4 Environments

Environments are **selected, not assumed** — 20+ concepts are generated and evaluated against: atmosphere · visual identity · fire behaviour · weather · exploration · wildlife · audio · side activities · mystery · SM-01 integration · replayability · product photography · technical feasibility · performance. The strongest **10–12** ship at launch. The full concept set, scoring, and selection live in [`packages/content/CONCEPTS.md`](./packages/content/CONCEPTS.md).

Each launch environment has its own systemic personality: soundscape · weather profile · wildlife roster · available fuels · props · activities · secrets · radio behaviour · arrival sequence · procedural rules · SM-01 quirks.

**Construction:** modular biome kits + data-driven scene manifests + procedural variation + handcrafted landmarks. An environment is *data*; adding one requires no engine change.

**Geography:** environments are fictional but inspired by recognisable landscapes. Approximate region may lightly weight which environments appear early. **Every player must eventually be able to discover every core environment** — region never locks content.

### 5.5 Weather, time, astronomy

With permission, real-world context may influence the world: time of day, season/date, approximate region, local weather. **Precise location is never required.** Denial or failure falls back gracefully to curated simulation, and the fallback must be as good as the real thing — never a degraded experience.

Weather evolves during a session and affects fire, visibility, sound, wildlife, exploration, and roasting. Rare dramatic events: fog, storms, meteor showers, snow squalls, heat lightning.

Real astronomy may drive moon phase/position, constellations, planets, and meteor showers — rendered through the PS1 art direction (dithered, low-res, beautiful).

**Never lock important content behind waiting for a real astronomical event.** Rare sky events are gifts, not gates.

---

## 6. Persistence and the Campfire Passport

### 6.1 Identity

**Instant anonymous play** — the world boots without an account. Later, seamless linking to Apple / Google / email magic link **without losing progress**. Linking is offered at emotionally correct moments (after a first sandwich, before a share, before an order), never as a wall.

### 6.2 The Passport

The persistent player identity is the **Campfire Passport**: a hybrid of field journal, campground registration booklet, disposable photo album, scrapbook, and PS1 memory-card interface.

**Contents:** Polaroids · stamps · weathered pages · handwritten notes · campsite metadata · sandwich records · receipts · patches · ticket stubs · strange discoveries.

**Explicitly not:** a card grid, a dashboard, a stats screen, a profile page with a completion percentage.

**Boot goes toward the world,** not toward the Passport. The Passport is opened, not landed on.

### 6.3 Persistent campsites

Campsites remember: moved objects · photos taken · discoveries · notes left · machine history · wildlife relationships · environmental traces · sandwich memories.

**The world evolves while players are gone.** Returning may reveal a dead fire, changed weather, tracks, shifted objects, leaves or snow, wildlife evidence, machine changes, or mysterious artifacts.

**Never punish absence.** Nothing decays into a worse state that must be repaired. Returning is always warm.

A campsite may accumulate history over months or years. **Most traces naturally fade.** Important memories survive in the Passport. A **tiny number** of especially meaningful moments become permanent landmarks in the world itself.

### 6.4 The significance model

An **invisible** model decides what persists, based on: rarity · firsts · repeated interaction · photography · social meaning · world events · explicit player preservation.

**Never expose a memory score.** No numbers, no "significance: 84%", no UI for it. Players experience it only as *the world remembered the right things.*

---

## 7. Wildlife

Lightweight ecosystem behaviour. Animals respond to sound, fire, food, flashlights, weather, and players.

- Persistent individual animals may recur at a campsite and be recognised by the world (and eventually by the player).
- **Quiet behaviour reveals rarer wildlife** — stillness is a mechanic.
- Animals may investigate or steal objects and leave tracks or unusual traces.
- **Not collectible pets.** No taming meter, no feeding quests, no compendium completion.

---

## 8. Mystery and radio

Environmental storytelling, never traditional quests.

**Channels:** radio · notes · serial numbers · diagnostics · strange objects · distant sounds · wildlife behaviour · recurring figures · campsite changes.

**Radio** carries original lo-fi/ambient stations, environmental programming, strange broadcasts, and optional codes and clues — including references to rare events and physical Some More activations. Tuning is analogue and tactile.

**Rules:**
- All mystery is optional. A player who never engages loses nothing functional.
- Some events occur **once** for a specific campsite/player and leave evidence afterward.
- **Essential functionality and major rewards must remain reachable by other paths.** A missed one-time event never strands anyone.
- The SM-01 is not part of the mystery (§3.5).

---

## 9. Multiplayer

Architected from the beginning.

**Target:** 2–4 players per campsite, with headroom for larger special-event fires later.

**Joining is diegetic and lobby-less.** A session may begin solo; friends arrive at any moment as distant footsteps, a moving flashlight, spatial voice approaching, a silhouette emerging from the trail.

**Join paths:** invite links · camp codes · QR joins · Passport friend invites.

Friends may join **during any stage** — roasting, assembly, machine operation, eating.

**Shared physics uses intelligent temporary ownership/hand-off** so objects never fight between clients.

**Shared interactions:** pass objects · hand off roasting sticks · tend fire together · move chairs · photograph one another · gesture · sit · high-five · fist-bump · toss sticks · share food.

**Mild physical silliness is allowed; griefing is not.** Ownership rules, no destructive actions on another player's in-progress work, and a short cooldown on repeated interference.

**Leaving:** both an immediate menu exit and a diegetic departure (walk off down the trail) are supported.

**Shared campsites persist. Privacy defaults to private.**

### 9.1 Voice

Spatial voice over a managed WebRTC solution behind a LiveKit-style abstraction.

Supported: open mic · push-to-talk · mute · block · report · per-player volume · proximity attenuation · mic indicators.

**Private voice is not recorded by default.**

---

## 10. Photo and sharing

A real photo mode: free camera · framing · zoom · focus where useful · PS1 treatment · disposable-camera treatment.

**Artifacts:** date stamps · grain · bloom · light leaks · slight misalignment.

**Subjects:** the sandwich · friends · wildlife · landscapes · strange events · the SM-01 · campsite traces.

Photos are saved in the Passport.

**Sharing prioritises the image, not branding.** Output formats: raw PS1 frame · disposable photo · retro save-card · product hero shot. Watermarking is small and tasteful or absent.

---

## 11. Commerce and loyalty

**Commerce is subordinate to the experience.** No purchase surface exists before the product reveal.

After the reveal, the player may choose something like **MAKE THIS REAL**. The fiction is maintained through a Some More terminal interface until conventional checkout UI is legally/practically required (address, payment sheet).

**Launch catalogue: the flagship roasted-marshmallow sandwich only.**

**Payments:** Stripe first, behind a provider abstraction so it can change. Apple Pay and Google Pay preferred, standard card as fallback. **Raw card data is never stored or transmitted through our systems.**

**Built for:** orders · inventory hooks · fulfillment states · promotions · reward redemption · tax/shipping boundaries · refunds/cancellations · idempotency.

**Rewards:** real purchases may grant Passport stamps, points, cosmetics, campsite props, environments, or collectibles. Gameplay may occasionally unlock real-world perks (discounts, free product). **High-value rewards are server validated and abuse-resistant.**

**No manipulative loyalty mechanics.** No streak anxiety, no expiring-points pressure, no artificial scarcity countdowns, no loot boxes.

**Modular future hooks** (architecture only, not blockers): package codes · event QR links · collaboration content · physical SM-01 ↔ digital serial pairing · AR.

---

## 12. Accessibility

Accessibility is part of the architecture, not a settings screen bolted on.

**Presentation:** subtitles · text scaling · reduced motion · reduced flicker · contrast options · colourblind-safe cues · adjustable dithering/effects intensity · camera-shake control · fire brightness control · haptic control · volume and ambience control.

**Gameplay assists:** automatic marshmallow rotation · simplified gestures · stronger assembly snapping · forgiving timing · alternate control schemes.

**Rules:**
- Assists never change what the player can achieve, only the dexterity required.
- No information is delivered through a single channel — anything audible has a visible counterpart and vice versa.
- The fire brightness and flicker controls must genuinely tame the fire without removing it.

---

## 13. Performance

**Target: 60 FPS on capable modern phones**, with adaptive quality tiers supporting roughly the previous 4–5 years of devices.

**Scaled per tier:** internal resolution · lighting · shadows · particles · texture quality · draw distance · physics complexity · post-processing · environment density.

**Rules:** profile real bottlenecks, never guess. **Responsiveness during tactile interactions is prioritised over visual fidelity** — if a frame must be dropped, drop it in the trees, never in the player's hands.

Budgets live in [`ARCHITECTURE.md`](./ARCHITECTURE.md#performance-budgets).

---

## 14. Content and live ops

**Asset pipeline:** Blender → glTF/GLB, with modular kits, atlases, compression, LODs, optimized meshes, metadata, and versioned schemas.

Content is authored so artists and operators can add environments, props, wildlife, weather profiles, radio, rewards, and events **without changing engine code**.

**CMS / live-ops** covers: environments · rarity weights · events · weather · rewards · radio · collaborations · QR campaigns · package codes · multiplayer limits — with scheduling, preview, rollback, audit history, and permissions.

---

## 15. The product decision rule

When two approaches conflict, ask in this order:

1. Which makes the Some More ritual stronger?
2. Which makes the sandwich more desirable?
3. Which makes the campsite feel more like a real place?
4. Which feels more tactile?
5. Which creates stronger social presence?
6. Which preserves discovery and mystery?
7. Which is more accessible and performant?
8. Which is more maintainable?
9. Is this merely additional complexity?

**If the primary argument for something is "more features," do not build it.**

---

## 16. Quality bar

A feature is complete only when it is: integrated · usable · tested · visually coherent · performant · accessible where relevant · documented · resilient to realistic failure.

**Compiling is not complete.**

### 16.1 The recurring evaluation

Asked repeatedly, out loud, against the running product:

- Does the campfire feel alive?
- Is roasting satisfying?
- Does assembly feel tactile?
- Does the SM-01 feel physical and iconic?
- Is the transformation rewarding?
- Does the final sandwich look delicious?
- Is mobile interaction comfortable?
- Does the world feel like Some More rather than a generic camping game?

Weak answers are defects. They are fixed, not deferred.

---

## 17. Priority order

| Priority | Goal | Contents |
| --- | --- | --- |
| **P1** | **Prove the magic** | boot → approach → fire → roast → assemble → SM-01 → transform → reveal. Real, tactile, visually convincing. |
| **P2** | **Make it a place** | exploration · first environments · weather · audio · wildlife · photography · Passport · persistent campsite memory · mystery/radio |
| **P3** | **Make it shared** | avatars · multiplayer · joining/leaving · shared interactions · persistent group campsites · spatial voice |
| **P4** | **Connect digital and physical** | ordering · loyalty/rewards · CMS/live ops · event/QR architecture · physical/digital bridges |

Future systems (AR, large events, advanced collaboration tooling, expanded catalogues) are architected cleanly but never take effort from the core experience.

---

## 18. Deviations from the original brief

Recorded honestly, with reasoning, as permitted by the brief's creative authority clause.

| # | Deviation | Reasoning |
| --- | --- | --- |
| D1 | **All assets are procedurally generated at runtime** (textures via canvas, geometry via code, audio via WebAudio synthesis) instead of a Blender → glTF pipeline. | No art assets exist and none can be authored in this environment. Procedural generation produces a *real, complete, working* product now. The glTF pipeline and asset schemas are architected and documented so authored content can replace procedural content per-object without engine changes. This is a build-order decision, not a design change. |
| D2 | **Rapier is deferred behind a physics abstraction**; the shipped loop uses purpose-built deterministic solvers. | Every P1 interaction (roasting, assembly, machine, eating) needs *deterministic, tuned, networkable* behaviour, which general rigid-body physics makes harder, not easier. Rapier's real value is secondary props (tossed sticks, skipped stones, crumbs). Adding a WASM physics engine before it is needed costs bundle size and startup time against zero P1 benefit. See ADR-0004. |
| D3 | **Eating removes real geometry** rather than swapping bite-state meshes. | Directly serves "eating should be tactile" and costs little. |
| D4 | The **ember bed is the superior roasting surface**, discoverable rather than taught. | Gives roasting genuine skill depth without a tutorial, and rewards fire tending — linking two systems that would otherwise be independent. Measured: over coals there is a wide window between golden and charred; in the flame column there is almost none. |
| D5 | **The SM-01 lights its own chamber and control panel.** | Not in the original design language, but a real freezer does exactly this, and without it the machine is unreadable in a dark campsite. Functional lighting, consistent with §3.1 — it is not decorative. |
| D6 | **The sandwich carries its own key/fill/rim lighting.** | The spec permits "improved local lighting" as part of the fidelity bump. Without it the finished product rendered as a black silhouette, which is the one thing this object may never be. |
| D7 | **The night has a light floor that is not physically justified.** Ambient and hemisphere terms sit well above what moonlight alone would give. | The PS1 pipeline quantises to 5 bits per channel, so anything under about 8/255 renders as pure black rather than as very dark. A physically honest moonless night therefore renders as a black rectangle, not a dark wood. The floor stands for dark adaptation, which the renderer has no model of and a person sitting by a fire for ten minutes genuinely has. Everything above the floor is still the real moon: altitude, azimuth and illuminated fraction for the date, attenuated by the weather's own cloud cover, so the *difference* between nights remains physical. |
| D8 | **The order terminal asks the service what it can take, rather than knowing.** | The client reads `paymentsConfigured` and the provider name off `/v1/meta` and shows what that implies. It means a deployment with no processor says so truthfully instead of the client guessing, and the day credentials are configured the terminal starts taking payments with no client change. |
| D9 | **Radio station names are truncated to their leading token on the dial face, and a crowded station is not printed at all.** | Three names centred on the same few millimetres of glass print as an unreadable smear — on a real dial and on this one. A set from 1974 has three local stations screened onto the glass and bare scale everywhere else, which is both what happens here and what the fiction wants. |
